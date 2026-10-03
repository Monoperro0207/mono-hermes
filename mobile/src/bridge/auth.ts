/**
 * Native (RFC 8252 style) bearer login against a gated `hermes serve` gateway.
 *
 * Desktop opens the system browser and runs a loopback listener. A phone cannot
 * do either, but the gateway's broker makes that unnecessary for password
 * providers:
 *
 *   1. GET  /auth/native/authorize?provider=..&code_challenge=..&redirect_uri=<loopback>&state=..
 *        -> 302 /login + a PKCE cookie holding the server-side broker handle
 *   2. POST /auth/password-login {provider, username, password}   (cookie attached)
 *        -> {ok, next}; `next` is the loopback redirect carrying ?code=..&state=..
 *           (never followed - we only read code/state out of it)
 *   3. POST /auth/native/token {code, code_verifier}  -> {access_token, refresh_token, expires_at}
 *   4. POST /auth/native/refresh {refresh_token, provider} rotates the pair.
 *
 * The cookie only has to survive between step 1 and 2, so a tiny in-memory jar
 * is enough and no browser session cookie is ever stored. REST then uses
 * `Authorization: Bearer`, and WebSockets use single-use tickets (gateway-ws.ts).
 *
 * Mirrors electron/native-oauth.ts + native-auth-decisions.ts; the pure helpers
 * keep the same names so upstream drift is easy to diff.
 */

import { type ConnectionStore, type TokenSet } from './connection'
import { CookieJar, type HttpTransport, HttpStatusError, type RawResponse } from './http'
import { assertTransportAllowed, errorMessage, normalizeBaseUrl, randomBase64url, s256Challenge } from './util'

/** Syntactically valid loopback redirect; nothing listens on it and it is never fetched. */
export const NATIVE_REDIRECT_URI = 'http://127.0.0.1:47321/hermes-mobile/callback'

const PASSWORD_PROVIDER_NAMES = new Set(['basic'])

export interface AuthProviderInfo {
  name: string
  displayName: string
  supportsPassword: boolean
}

export interface ServerProbe {
  baseUrl: string
  version: string | null
  authRequired: boolean
  nativeFlow: boolean
  providers: AuthProviderInfo[]
}

/** Raised whenever the user has to type credentials again. Carries the flags the renderer keys on. */
export class NeedsLoginError extends Error {
  readonly needsOauthLogin = true
  readonly statusCode = 401

  constructor(message = 'Your session has expired. Sign in again.') {
    super(message)
    this.name = 'NeedsLoginError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor(message = 'Invalid username or password.') {
    super(message)
    this.name = 'InvalidCredentialsError'
  }
}

export function normalizeProviders(raw: unknown): AuthProviderInfo[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const out: AuthProviderInfo[] = []

  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push({
        displayName: item.trim(),
        name: item.trim(),
        supportsPassword: PASSWORD_PROVIDER_NAMES.has(item.trim())
      })

      continue
    }

    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : ''

      if (name) {
        out.push({
          displayName: typeof record.display_name === 'string' ? record.display_name : name,
          name,
          supportsPassword:
            typeof record.supports_password === 'boolean'
              ? record.supports_password
              : PASSWORD_PROVIDER_NAMES.has(name)
        })
      }
    }
  }

  return out
}

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function describeFailure(response: RawResponse, fallback: string): string {
  const body = parseJson(response.body)
  const detail = typeof body?.detail === 'string' ? body.detail : typeof body?.error === 'string' ? body.error : ''

  return `${fallback} (${response.status}${detail ? `: ${detail}` : ''})`
}

/** Public, credential-free reachability + capability probe (/api/status, /api/auth/providers). */
export async function probeServer(transport: HttpTransport, rawUrl: string): Promise<ServerProbe> {
  const baseUrl = normalizeBaseUrl(rawUrl)
  assertTransportAllowed(baseUrl)

  let status: RawResponse

  try {
    status = await transport.request({ timeoutMs: 8_000, url: `${baseUrl}/api/status` })
  } catch (error) {
    throw new Error(`Could not reach ${baseUrl}. Is Tailscale connected and "hermes serve" running? (${errorMessage(error)})`)
  }

  const body = parseJson(status.body)

  if (status.status >= 400 || !body || typeof body !== 'object' || /^\s*</.test(status.body)) {
    throw new Error(
      `${baseUrl} answered ${status.status} but does not look like a Hermes gateway (expected JSON from /api/status).`
    )
  }

  const authRequired = Boolean(body.auth_required)
  const flows: unknown = body.auth_flows
  let providers = normalizeProviders(body.auth_providers)

  if (authRequired) {
    try {
      const response = await transport.request({ timeoutMs: 8_000, url: `${baseUrl}/api/auth/providers` })

      if (response.status < 400) {
        const detailed = normalizeProviders(parseJson(response.body)?.providers)

        if (detailed.length > 0) {
          providers = detailed
        }
      }
    } catch {
      // /api/status already named the providers; the detailed list is best-effort.
    }
  }

  return {
    authRequired,
    baseUrl,
    nativeFlow: Array.isArray(flows) && flows.includes('native_pkce'),
    providers,
    version: typeof body.version === 'string' ? body.version : null
  }
}

export function parseTokenResponse(body: any): TokenSet {
  const accessToken = String(body?.access_token || '')

  if (!accessToken) {
    throw new Error('Gateway token response missing access_token')
  }

  const expiresAt = Number(body?.expires_at)

  return {
    accessToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    provider: String(body?.provider || ''),
    refreshToken: String(body?.refresh_token || ''),
    userId: String(body?.user_id || '')
  }
}

/** True when the token is at/near expiry (unknown expiry counts as expired). */
export function tokenNeedsRefresh(tokens: Pick<TokenSet, 'expiresAt'>, nowSeconds: number, skewSeconds = 60): boolean {
  if (!Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= 0) {
    return true
  }

  return nowSeconds >= tokens.expiresAt - skewSeconds
}

export function buildNativeAuthorizeUrl(
  baseUrl: string,
  params: { challenge: string; redirectUri: string; state: string; provider?: string }
): string {
  const query = new URLSearchParams({
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    redirect_uri: params.redirectUri,
    state: params.state
  })

  if (params.provider) {
    query.set('provider', params.provider)
  }

  return `${baseUrl}/auth/native/authorize?${query.toString()}`
}

/** Read code/state out of the loopback URL the gateway returns; verifies `state` (CSRF). */
export function parseLoopbackCallback(url: string, expectedState: string): { code: string } {
  const parsed = new URL(url, 'http://127.0.0.1')
  const error = parsed.searchParams.get('error')

  if (error) {
    const description = parsed.searchParams.get('error_description') || ''

    throw new Error(`Gateway rejected sign-in: ${error}${description ? ` (${description})` : ''}`)
  }

  const code = parsed.searchParams.get('code') || ''

  if (!code) {
    throw new Error('Sign-in response is missing the authorization code.')
  }

  if (!expectedState || parsed.searchParams.get('state') !== expectedState) {
    throw new Error('Sign-in response state mismatch (possible CSRF); try again.')
  }

  return { code }
}

export interface PasswordLoginInput {
  username: string
  password: string
  /** Provider to use; defaults to the first password provider the gateway advertises. */
  provider?: string
}

/** Runs the full password login and returns the bearer token set. */
export async function passwordLogin(
  transport: HttpTransport,
  probe: ServerProbe,
  input: PasswordLoginInput
): Promise<TokenSet> {
  const { baseUrl } = probe

  if (!probe.authRequired) {
    throw new Error(
      'This Hermes server is not running in gated mode, so a phone cannot sign in. ' +
        'Start it with: hermes serve --host 0.0.0.0 --port 9119'
    )
  }

  const provider = input.provider || probe.providers.find(p => p.supportsPassword)?.name

  if (!provider || !probe.nativeFlow) {
    throw new Error(
      'This Hermes server does not offer username/password sign-in for native apps. ' +
        'Update Hermes on the PC (hermes update) and run "hermes serve --host 0.0.0.0" so it prompts for credentials.'
    )
  }

  const verifier = randomBase64url(32)
  const state = randomBase64url(24)
  const challenge = await s256Challenge(verifier)
  const jar = new CookieJar()

  // 1. Start the native authorization; keep the broker cookie, do not follow /login.
  const authorize = await transport.request({
    followRedirects: false,
    timeoutMs: 15_000,
    url: buildNativeAuthorizeUrl(baseUrl, { challenge, provider, redirectUri: NATIVE_REDIRECT_URI, state })
  })

  jar.store(authorize.setCookie)

  if (authorize.status < 300 || authorize.status >= 400 || jar.size === 0) {
    throw new Error(describeFailure(authorize, 'The gateway did not start a native sign-in'))
  }

  // 2. Submit credentials against the broker handle.
  const login = await transport.request({
    headers: { Cookie: jar.header() },
    json: { next: '', password: input.password, provider, username: input.username },
    method: 'POST',
    timeoutMs: 20_000,
    url: `${baseUrl}/auth/password-login`
  })

  if (login.status === 401) {
    throw new InvalidCredentialsError()
  }

  if (login.status === 429) {
    throw new Error('Too many sign-in attempts. Wait a minute and try again.')
  }

  const loginBody = parseJson(login.body)

  if (login.status >= 400 || !loginBody?.ok || typeof loginBody.next !== 'string') {
    throw new Error(describeFailure(login, 'Sign-in failed'))
  }

  const { code } = parseLoopbackCallback(loginBody.next, state)

  // 3. Redeem the one-time code with the PKCE verifier.
  const token = await transport.request({
    json: { code, code_verifier: verifier },
    method: 'POST',
    timeoutMs: 15_000,
    url: `${baseUrl}/auth/native/token`
  })

  if (token.status >= 400) {
    throw new Error(describeFailure(token, 'Could not exchange the sign-in code'))
  }

  return parseTokenResponse(parseJson(token.body))
}

/** Rotate the token pair. Throws NeedsLoginError when the refresh token is rejected. */
export async function refreshTokens(transport: HttpTransport, baseUrl: string, tokens: TokenSet): Promise<TokenSet> {
  if (!tokens.refreshToken) {
    throw new NeedsLoginError()
  }

  const response = await transport.request({
    json: { provider: tokens.provider, refresh_token: tokens.refreshToken },
    method: 'POST',
    timeoutMs: 15_000,
    url: `${baseUrl}/auth/native/refresh`
  })

  if (response.status === 401 || response.status === 403 || response.status === 400) {
    throw new NeedsLoginError()
  }

  if (response.status >= 400) {
    // 503 provider outage etc.: transient, keep the stored tokens.
    throw new HttpStatusError(response.status, response.body)
  }

  const next = parseTokenResponse(parseJson(response.body))

  return { ...next, provider: next.provider || tokens.provider, userId: next.userId || tokens.userId }
}

/**
 * Owns the stored session: hands out a fresh access token, refreshes on demand
 * (single-flight - the gateway rotates refresh tokens with reuse detection, so two
 * concurrent refreshes would revoke the session) and signs out when refresh fails.
 */
export class AuthSession {
  private refreshing: Promise<TokenSet> | null = null

  constructor(
    readonly store: ConnectionStore,
    private readonly transport: HttpTransport,
    private readonly nowSeconds: () => number = () => Date.now() / 1000
  ) {}

  async requireBaseUrl(): Promise<string> {
    const connection = await this.store.getConnection()

    if (!connection) {
      throw new NeedsLoginError('No Hermes server configured. Connect to your PC first.')
    }

    return connection.baseUrl
  }

  /** Probe, log in and persist both the connection descriptor and the tokens. */
  async login(rawUrl: string, input: PasswordLoginInput): Promise<ServerProbe> {
    const probe = await probeServer(this.transport, rawUrl)
    const tokens = await passwordLogin(this.transport, probe, input)
    const provider = tokens.provider || input.provider || probe.providers.find(p => p.supportsPassword)?.name || ''

    await this.store.setConnection({
      baseUrl: probe.baseUrl,
      provider,
      username: input.username,
      version: probe.version ?? undefined
    })
    await this.store.setTokens({ ...tokens, provider })

    return probe
  }

  async accessToken(): Promise<string> {
    const tokens = await this.store.getTokens()

    if (!tokens?.accessToken) {
      throw new NeedsLoginError()
    }

    if (tokenNeedsRefresh(tokens, this.nowSeconds())) {
      return (await this.refresh(tokens.accessToken)).accessToken
    }

    return tokens.accessToken
  }

  /**
   * Refresh unless another caller already replaced `staleAccessToken`. The in-flight
   * promise is published synchronously (before any await) so concurrent callers
   * always share a single request.
   */
  refresh(staleAccessToken?: string): Promise<TokenSet> {
    if (this.refreshing) {
      return this.refreshing
    }

    const run = (async () => {
      try {
        const current = await this.store.getTokens()

        if (!current) {
          throw new NeedsLoginError()
        }

        if (staleAccessToken && current.accessToken !== staleAccessToken) {
          // Someone else already rotated while we were waiting; use their result.
          return current
        }

        const next = await refreshTokens(this.transport, await this.requireBaseUrl(), current)
        await this.store.setTokens(next)

        return next
      } catch (error) {
        if (error instanceof NeedsLoginError) {
          await this.store.signOut()
        }

        throw error
      } finally {
        this.refreshing = null
      }
    })()

    this.refreshing = run

    return run
  }

  /** Run `request` with a bearer token; on a 401 refresh once and retry. */
  async withBearer<T>(request: (token: string, baseUrl: string) => Promise<T>): Promise<T> {
    const baseUrl = await this.requireBaseUrl()
    const token = await this.accessToken()

    try {
      return await request(token, baseUrl)
    } catch (error) {
      if (!(error instanceof HttpStatusError) || error.statusCode !== 401) {
        throw error
      }

      const refreshed = await this.refresh(token)

      try {
        return await request(refreshed.accessToken, baseUrl)
      } catch (retryError) {
        if (retryError instanceof HttpStatusError && retryError.statusCode === 401) {
          await this.store.signOut()

          throw new NeedsLoginError()
        }

        throw retryError
      }
    }
  }

  /** Bearer sessions have no server-side logout endpoint; dropping the tokens ends the session on this device. */
  async signOut(): Promise<void> {
    await this.store.signOut()
  }
}
