import { describe, expect, it } from 'vitest'

import { isBackendUpdateApplyPath, isBackendUpdateCheckPath, maskBackendUpdateCheck, pathWithProfileScope, parseApiResponse } from '../src/bridge/api'
import { isMediaProtocolUrl, mediaRequestPath } from '../src/bridge/media'
import {
  AuthSession,
  buildNativeAuthorizeUrl,
  InvalidCredentialsError,
  NeedsLoginError,
  parseLoopbackCallback,
  passwordLogin,
  type ServerProbe,
  tokenNeedsRefresh
} from '../src/bridge/auth'
import { ConnectionStore } from '../src/bridge/connection'
import { CookieJar, type HttpTransport, type RawRequest, type RawResponse, splitSetCookie } from '../src/bridge/http'
import { createMemoryStore, createPlainSecretBox } from '../src/bridge/storage'
import {
  assertTransportAllowed,
  classifyHost,
  isCleartextHostAllowed,
  LanCleartextConsentRequired,
  normalizeBaseUrl,
  s256Challenge
} from '../src/bridge/util'

const probe: ServerProbe = {
  authRequired: true,
  baseUrl: 'http://100.64.1.2:9119',
  nativeFlow: true,
  providers: [{ displayName: 'Username & Password', name: 'basic', supportsPassword: true }],
  version: '1.0'
}

function scripted(handler: (req: RawRequest, seen: RawRequest[]) => Partial<RawResponse>) {
  const seen: RawRequest[] = []

  const transport: HttpTransport = {
    async request(req) {
      seen.push(req)

      return { body: '', headers: {}, setCookie: [], status: 200, ...handler(req, seen) }
    }
  }

  return { seen, transport }
}

describe('url + transport policy', () => {
  it('normalizes scheme-less host:port like the desktop does', () => {
    expect(normalizeBaseUrl('100.64.0.1:9119')).toBe('http://100.64.0.1:9119')
    expect(normalizeBaseUrl(' https://my-pc.tail1234.ts.net/ ')).toBe('https://my-pc.tail1234.ts.net')
    expect(normalizeBaseUrl('http://host:9119/prefix/')).toBe('http://host:9119/prefix')
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(/http/)
    expect(() => normalizeBaseUrl('')).toThrow()
  })

  it('classifies hosts by how far their traffic travels', () => {
    const table: Record<string, string> = {
      '100.64.0.1': 'tailnet',
      '100.127.255.254': 'tailnet',
      '100.63.0.1': 'public',
      '100.128.0.1': 'public',
      '10.0.0.2': 'lan',
      '127.0.0.1': 'loopback',
      '169.254.10.20': 'lan',
      '172.16.0.9': 'lan',
      '172.32.0.1': 'public',
      '192.168.1.5': 'lan',
      '8.8.8.8': 'public',
      '::1': 'loopback',
      '[::1]': 'loopback',
      '[2001:db8::1]': 'public',
      'desktop-pc': 'lan',
      'example.com': 'public',
      'localhost': 'loopback',
      'my-pc.tail1234.ts.net': 'tailnet',
      'printer.local': 'lan',
      'app.localhost': 'loopback'
    }

    for (const [host, expected] of Object.entries(table)) {
      expect(classifyHost(host), host).toBe(expected)
    }

    // The URL parser canonicalises numeric / hex IPv4 forms before they reach the classifier.
    expect(classifyHost(new URL('http://2130706433').hostname)).toBe('loopback')
    expect(classifyHost(new URL('http://0x7f.1').hostname)).toBe('loopback')
    expect(classifyHost(new URL('http://3232235777').hostname)).toBe('lan')
    expect(classifyHost(new URL('http://[::1]:9119').hostname)).toBe('loopback')
  })

  it('accepts cleartext without consent only for Tailscale and loopback', () => {
    for (const host of ['100.64.0.1', '100.127.255.254', 'my-pc.tail1234.ts.net', '127.0.0.1', 'localhost']) {
      expect(isCleartextHostAllowed(host), host).toBe(true)
    }

    for (const host of ['192.168.1.5', '10.0.0.2', '172.16.0.9', 'desktop-pc', 'printer.local', '100.63.0.1', '100.128.0.1', '8.8.8.8', 'example.com', '172.32.0.1']) {
      expect(isCleartextHostAllowed(host), host).toBe(false)
    }
  })

  it('requires consent for http:// to a LAN address and never allows public http://', () => {
    expect(() => assertTransportAllowed('http://100.64.0.1:9119')).not.toThrow()
    expect(() => assertTransportAllowed('http://127.0.0.1:9119')).not.toThrow()
    expect(() => assertTransportAllowed('https://example.com')).not.toThrow()
    expect(() => assertTransportAllowed('https://192.168.1.5')).not.toThrow()

    for (const url of ['http://192.168.1.5:9119', 'http://10.0.2.2:9119', 'http://desktop-pc:9119', 'http://printer.local']) {
      expect(() => assertTransportAllowed(url), url).toThrow(LanCleartextConsentRequired)
      expect(() => assertTransportAllowed(url, { allowLanCleartext: false }), url).toThrow(LanCleartextConsentRequired)
      expect(() => assertTransportAllowed(url, { allowLanCleartext: true }), url).not.toThrow()
    }

    // The consent flag never widens the policy beyond the LAN class.
    expect(() => assertTransportAllowed('http://example.com:9119', { allowLanCleartext: true })).toThrow(/https/)
    expect(() => assertTransportAllowed('http://example.com:9119')).toThrow(/https/)
  })

  it('records the accepted LAN URL on login, and only for LAN cleartext', async () => {
    const login = async (url: string, policy?: { allowLanCleartext?: boolean }) => {
      const store = new ConnectionStore(createMemoryStore(), createPlainSecretBox())
      let state = ''

      const { transport } = scripted(req => {
        const { pathname, searchParams } = new URL(req.url)

        if (pathname === '/api/status') {
          return { body: JSON.stringify({ auth_flows: ['native_pkce'], auth_providers: ['basic'], auth_required: true, version: '1.0' }) }
        }

        if (pathname === '/auth/native/authorize') {
          state = searchParams.get('state')!

          return { headers: { location: '/login' }, setCookie: ['hermes_session_pkce=h; Path=/'], status: 302 }
        }

        if (pathname === '/auth/password-login') {
          return { body: JSON.stringify({ next: `http://127.0.0.1:47321/hermes-mobile/callback?code=GW&state=${state}`, ok: true }) }
        }

        return { body: JSON.stringify({ access_token: 'AT', expires_at: 4102444800, provider: 'basic', refresh_token: 'RT', user_id: 'u' }) }
      })

      await new AuthSession(store, transport).login(url, { password: 'p', username: 'u' }, policy)

      return (await store.getConnection())?.lanCleartextAcceptedFor
    }

    await expect(login('http://192.168.1.5:9119')).rejects.toBeInstanceOf(LanCleartextConsentRequired)
    await expect(login('http://192.168.1.5:9119', { allowLanCleartext: true })).resolves.toBe('http://192.168.1.5:9119')
    await expect(login('http://100.64.1.2:9119', { allowLanCleartext: true })).resolves.toBeUndefined()
    await expect(login('http://100.64.1.2:9119')).resolves.toBeUndefined()
  })

  it('computes RFC 7636 S256 challenges', async () => {
    // Test vector from RFC 7636 appendix B.
    expect(await s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
  })
})

describe('cookies', () => {
  it('splits a joined Set-Cookie header without breaking Expires dates', () => {
    expect(splitSetCookie('a=1; Path=/; HttpOnly, b=2; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/')).toEqual([
      'a=1; Path=/; HttpOnly',
      'b=2; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Path=/'
    ])
  })

  it('keeps name=value only and drops deleted cookies', () => {
    const jar = new CookieJar()
    jar.store(['hermes_session_pkce=abc; Path=/; HttpOnly; Max-Age=600', 'other=1'])
    expect(jar.header()).toBe('hermes_session_pkce=abc; other=1')

    jar.store(['other=; Max-Age=0'])
    expect(jar.header()).toBe('hermes_session_pkce=abc')
  })
})

describe('native login helpers', () => {
  it('builds the authorize URL the gateway validates', () => {
    const url = new URL(
      buildNativeAuthorizeUrl('http://h:9119/p', {
        challenge: 'c',
        provider: 'basic',
        redirectUri: 'http://127.0.0.1:47321/cb',
        state: 's'
      })
    )

    expect(url.pathname).toBe('/p/auth/native/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('provider')).toBe('basic')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:47321/cb')
  })

  it('verifies state on the loopback callback (CSRF)', () => {
    expect(parseLoopbackCallback('http://127.0.0.1:1/cb?code=abc&state=xyz', 'xyz')).toEqual({ code: 'abc' })
    expect(() => parseLoopbackCallback('http://127.0.0.1:1/cb?code=abc&state=evil', 'xyz')).toThrow(/state/)
    expect(() => parseLoopbackCallback('http://127.0.0.1:1/cb?error=access_denied', 'xyz')).toThrow(/access_denied/)
    expect(() => parseLoopbackCallback('http://127.0.0.1:1/cb?state=xyz', 'xyz')).toThrow(/code/)
  })

  it('refreshes tokens at or near expiry, and when expiry is unknown', () => {
    expect(tokenNeedsRefresh({ expiresAt: 1000 }, 900)).toBe(false)
    expect(tokenNeedsRefresh({ expiresAt: 1000 }, 941)).toBe(true)
    expect(tokenNeedsRefresh({ expiresAt: 0 }, 1)).toBe(true)
  })
})

describe('passwordLogin', () => {
  it('follows authorize -> password-login -> token, forwarding the broker cookie', async () => {
    let state = ''

    const { seen, transport } = scripted((req, calls) => {
      const url = new URL(req.url)

      if (url.pathname === '/auth/native/authorize') {
        state = url.searchParams.get('state')!

        return { headers: { location: '/login' }, setCookie: ['hermes_session_pkce=handle; Path=/; HttpOnly'], status: 302 }
      }

      if (url.pathname === '/auth/password-login') {
        expect(req.headers?.Cookie).toBe('hermes_session_pkce=handle')
        expect(req.json).toMatchObject({ provider: 'basic', username: 'u' })

        return { body: JSON.stringify({ next: `http://127.0.0.1:47321/hermes-mobile/callback?code=GW&state=${state}`, ok: true }) }
      }

      expect(url.pathname).toBe('/auth/native/token')
      expect(calls.length).toBe(3)
      expect(req.json).toMatchObject({ code: 'GW' })
      expect((req.json as any).code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)

      return { body: JSON.stringify({ access_token: 'AT', expires_at: 4102444800, provider: 'basic', refresh_token: 'RT', user_id: 'u' }) }
    })

    const tokens = await passwordLogin(transport, probe, { password: 'p', username: 'u' })

    expect(tokens).toMatchObject({ accessToken: 'AT', provider: 'basic', refreshToken: 'RT' })
    expect(seen[0].followRedirects).toBe(false)
  })

  it('maps 401 to InvalidCredentialsError and refuses ungated servers', async () => {
    const { transport } = scripted(req =>
      req.url.includes('/authorize')
        ? { headers: { location: '/login' }, setCookie: ['hermes_session_pkce=h'], status: 302 }
        : { status: 401 }
    )

    await expect(passwordLogin(transport, probe, { password: 'bad', username: 'u' })).rejects.toBeInstanceOf(InvalidCredentialsError)
    await expect(passwordLogin(transport, { ...probe, authRequired: false }, { password: 'p', username: 'u' })).rejects.toThrow(/gated/)
  })
})

describe('AuthSession', () => {
  async function session(handler: Parameters<typeof scripted>[0], tokens: Partial<import('../src/bridge/connection').TokenSet> = {}) {
    const store = new ConnectionStore(createMemoryStore(), createPlainSecretBox())
    await store.setConnection({ baseUrl: 'http://100.64.1.2:9119', provider: 'basic', username: 'u' })
    await store.setTokens({ accessToken: 'AT1', expiresAt: 0, provider: 'basic', refreshToken: 'RT1', userId: 'u', ...tokens })
    const { seen, transport } = scripted(handler)

    return { auth: new AuthSession(store, transport, () => 1000), seen, store }
  }

  it('shares one refresh between concurrent callers and rotates the stored pair', async () => {
    let refreshes = 0

    const { auth, store } = await session(req => {
      refreshes += 1
      expect(req.json).toMatchObject({ provider: 'basic', refresh_token: 'RT1' })

      return { body: JSON.stringify({ access_token: 'AT2', expires_at: 9999999999, refresh_token: 'RT2' }) }
    })

    const tokens = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()])

    expect(tokens).toEqual(['AT2', 'AT2', 'AT2'])
    expect(refreshes).toBe(1)
    expect(await store.getTokens()).toMatchObject({ accessToken: 'AT2', provider: 'basic', refreshToken: 'RT2', userId: 'u' })
  })

  it('signs out and throws NeedsLoginError when the refresh token is rejected', async () => {
    const { auth, store } = await session(() => ({ body: '{"error":"session_expired"}', status: 401 }))

    await expect(auth.accessToken()).rejects.toBeInstanceOf(NeedsLoginError)
    expect(await store.getTokens()).toBeNull()
  })

  it('keeps the session on a transient refresh failure (provider outage)', async () => {
    const { auth, store } = await session(() => ({ status: 503 }))

    await expect(auth.accessToken()).rejects.toThrow(/^503/)
    expect((await store.getTokens())?.refreshToken).toBe('RT1')
  })
})

describe('api helpers', () => {
  it('scopes a path with ?profile= like pathWithProfileScope in electron/connection-config.ts', () => {
    expect(pathWithProfileScope('/api/config', 'work')).toBe('/api/config?profile=work')
    expect(pathWithProfileScope('/api/x?a=1', 'work')).toBe('/api/x?a=1&profile=work')
    expect(pathWithProfileScope('/api/x?profile=other', 'work')).toBe('/api/x?profile=other')
    expect(pathWithProfileScope('/api/x', null)).toBe('/api/x')
  })

  it('parses JSON, empty and error responses like fetchJson', () => {
    expect(parseApiResponse('u', 200, 'application/json', '{"a":1}')).toEqual({ a: 1 })
    expect(parseApiResponse('u', 204, '', '')).toBeNull()
    expect(() => parseApiResponse('u', 404, 'application/json', '{"detail":"nope"}')).toThrow(/^404: /)
    expect(() => parseApiResponse('u', 200, 'text/html', '<!doctype html><html>')).toThrow(/got HTML/)
  })
})

describe('media protocol shim', () => {
  it('maps hermes-media://remote URLs to the gateway stream endpoint', () => {
    expect(isMediaProtocolUrl('hermes-media://remote/%2Ftmp%2Fa.mp3')).toBe(true)
    expect(isMediaProtocolUrl('https://x/a.mp3')).toBe(false)
    expect(isMediaProtocolUrl('hermes-media://stream/x')).toBe(false)
    expect(mediaRequestPath('hermes-media://remote/%2Ftmp%2Fa%20b.mp3?profile=work&connectionId=c')).toBe(
      '/api/files/stream?path=%2Ftmp%2Fa+b.mp3&profile=work'
    )
    expect(mediaRequestPath('hermes-media://remote/%2Ftmp%2Fa.mp3')).toBe('/api/files/stream?path=%2Ftmp%2Fa.mp3')
  })
})

describe('backend update masking', () => {
  it('recognises the update probe and apply paths only', () => {
    expect(isBackendUpdateCheckPath('/api/hermes/update/check')).toBe(true)
    expect(isBackendUpdateCheckPath('/api/hermes/update/check?force=true&profile=default')).toBe(true)
    expect(isBackendUpdateCheckPath('/api/hermes/update/checkpoint')).toBe(false)
    expect(isBackendUpdateApplyPath('/api/hermes/update')).toBe(true)
    expect(isBackendUpdateApplyPath('/api/hermes/update?x=1')).toBe(true)
    expect(isBackendUpdateApplyPath('/api/hermes/update/check')).toBe(false)
  })

  it('keeps the real version but never reports an available update', () => {
    const real = { behind: 13, can_apply: true, commits: [{ sha: 'a' }], current_version: '0.21.5', install_method: 'git', message: null, update_available: true, update_command: 'hermes update' }
    const masked = maskBackendUpdateCheck(real)
    expect(masked.current_version).toBe('0.21.5')
    expect(masked.update_available).toBe(false)
    expect(masked.behind).toBe(0)
    expect(masked.can_apply).toBe(false)
    expect(masked.commits).toEqual([])
    expect(maskBackendUpdateCheck(null)).toBeNull()
  })
})
