/**
 * End-to-end proof against a REAL (throwaway, isolated, gated) `hermes serve`:
 *
 *   /api/status -> /auth/native/authorize -> /auth/password-login -> /auth/native/token
 *   -> bearer GET /api/sessions -> /api/auth/ws-ticket -> WebSocket /api/ws -> JSON-RPC.
 *
 * Everything runs through the production bridge modules (auth.ts, api.ts,
 * gateway-ws.ts, install.ts); only the HTTP transport differs (node fetch instead
 * of Capacitor native HTTP) and the WebSocket comes from `ws` so the browser's
 * `Origin: http://localhost` can be reproduced exactly.
 */
import fs from 'node:fs'
import path from 'node:path'

import { JsonRpcGatewayClient } from '@hermes/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { InvalidCredentialsError, NeedsLoginError, probeServer } from '../../src/bridge/auth'
import { buildBridge, type BridgeRuntime } from '../../src/bridge/install'
import { ConnectionStore } from '../../src/bridge/connection'
import { createFetchTransport, type HttpTransport } from '../../src/bridge/http'
import { createMemoryStore, createPlainSecretBox } from '../../src/bridge/storage'
import { readTestEnv } from '../support/env'
import { throwawayHome } from '../support/throwaway-server'

const env = readTestEnv()
const base = createFetchTransport()
const requests: string[] = []

/** Records every request path so tests can assert how many refreshes actually hit the wire. */
const transport: HttpTransport = {
  request(req) {
    requests.push(`${req.method ?? 'GET'} ${new URL(req.url).pathname}`)

    return base.request(req)
  }
}

function newRuntime(): { runtime: BridgeRuntime; store: ConnectionStore } {
  const store = new ConnectionStore(createMemoryStore(), createPlainSecretBox())

  return { runtime: buildBridge({ store, transport }), store }
}

describe('gated hermes serve', () => {
  const { runtime, store } = newRuntime()

  beforeAll(async () => {
    const probe = await runtime.auth.login(env.url, { password: env.password, username: env.username })
    expect(probe.authRequired).toBe(true)
  })

  it('advertises the native flow and a password provider', async () => {
    const probe = await probeServer(transport, env.url)

    expect(probe.authRequired).toBe(true)
    expect(probe.nativeFlow).toBe(true)
    expect(probe.providers.some(p => p.supportsPassword)).toBe(true)
    expect(probe.version).toBeTruthy()
  })

  it('rejects wrong credentials without storing anything', async () => {
    const other = newRuntime()

    await expect(
      other.runtime.auth.login(env.url, { password: 'definitely-wrong', username: env.username })
    ).rejects.toBeInstanceOf(InvalidCredentialsError)

    expect(await other.store.isSignedIn()).toBe(false)
  })

  it('stored a bearer session after login', async () => {
    const tokens = await store.getTokens()

    expect(tokens?.accessToken).toBeTruthy()
    expect(tokens?.refreshToken).toBeTruthy()
    expect(tokens!.expiresAt).toBeGreaterThan(Date.now() / 1000)
    expect((await store.getConnection())?.baseUrl).toBe(env.url)
  })

  it('REST through window.hermesDesktop.api() carries the bearer', async () => {
    const sessions = await runtime.bridge.api<{ sessions?: unknown[] } | unknown[]>({ path: '/api/sessions' })

    expect(sessions).toBeTruthy()
    expect(typeof sessions).toBe('object')
  })

  it('surfaces HTTP errors as "<status>: <body>" like the Electron bridge', async () => {
    await expect(runtime.bridge.api({ path: '/api/definitely-not-a-route' })).rejects.toThrow(/^404:/)
  })

  it('describes the connection as a remote oauth gateway for the renderer', async () => {
    const connection = await runtime.bridge.getConnection()

    expect(connection.mode).toBe('remote')
    expect(connection.authMode).toBe('oauth')
    expect(connection.baseUrl).toBe(env.url)
    expect(connection.token).toBe('')
  })

  it('refreshes an expired access token transparently (single-flight) and keeps working', async () => {
    const before = (await store.getTokens())!
    await store.setTokens({ ...before, expiresAt: Math.floor(Date.now() / 1000) - 10 })
    requests.length = 0

    // Fire two calls at once: they must share one refresh (refresh tokens rotate with reuse detection).
    const [a, b] = await Promise.all([
      runtime.bridge.api({ path: '/api/sessions' }),
      runtime.bridge.api({ path: '/api/sessions' })
    ])

    expect(a).toBeTruthy()
    expect(b).toBeTruthy()

    expect(requests.filter(r => r === 'POST /auth/native/refresh')).toHaveLength(1)

    const after = (await store.getTokens())!
    expect(after.expiresAt).toBeGreaterThan(Date.now() / 1000)
    expect(after.refreshToken).toBeTruthy()
  })

  it('recovers from a 401 by refreshing once and retrying', async () => {
    const before = (await store.getTokens())!
    await store.setTokens({ ...before, accessToken: `${before.accessToken}-tampered` })

    expect(await runtime.bridge.api({ path: '/api/sessions' })).toBeTruthy()
  })

  it('signals needsOauthLogin when the refresh token is dead', async () => {
    const dead = newRuntime()
    await dead.store.setConnection({ baseUrl: env.url, provider: 'basic', username: env.username })
    await dead.store.setTokens({
      accessToken: 'garbage',
      expiresAt: 0,
      provider: 'basic',
      refreshToken: 'garbage',
      userId: ''
    })

    await expect(dead.runtime.bridge.api({ path: '/api/sessions' })).rejects.toBeInstanceOf(NeedsLoginError)

    const ws = await dead.runtime.bridge.getGatewayWsUrl()

    expect(typeof ws === 'object' && !ws.ok && ws.needsOauthLogin).toBe(true)
  })

  it('answers HEAD /api/files/stream with the Content-Length the media pre-flight relies on', async () => {
    // A small audio file inside the throwaway HERMES_HOME (never the user's real one).
    const dir = path.join(throwawayHome(), 'e2e-media')
    const file = path.join(dir, 'clip.mp3')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, Buffer.alloc(2048, 1))

    const headers = { Authorization: `Bearer ${await runtime.auth.accessToken()}` }
    const url = `${env.url}/api/files/stream?path=${encodeURIComponent(file)}`

    const head = await fetch(url, { headers, method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('2048')
    expect((await head.arrayBuffer()).byteLength).toBe(0)

    // Same answer without credentials would be a hole: the pre-flight must stay behind the gate.
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(401)

    const get = await fetch(url, { headers })

    expect(get.headers.get('content-length')).toBe('2048')
    expect((await get.arrayBuffer()).byteLength).toBe(2048)
  })

  it('mints single-use WS tickets, never reusing one', async () => {
    const first = await runtime.bridge.getGatewayWsUrl()
    const second = await runtime.bridge.getGatewayWsUrl()

    expect(typeof first === 'object' && first.ok).toBe(true)
    expect(typeof second === 'object' && second.ok).toBe(true)

    const urlOf = (r: typeof first) => (typeof r === 'string' ? r : r.ok ? r.wsUrl : '')

    expect(urlOf(first)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/ws\?ticket=/)
    expect(urlOf(first)).not.toBe(urlOf(second))
  })

  it('opens /api/ws with the WebView Origin and answers JSON-RPC', async () => {
    const minted = await runtime.bridge.getGatewayWsUrl()
    const wsUrl = typeof minted === 'string' ? minted : minted.ok ? minted.wsUrl : ''

    const gateway = new JsonRpcGatewayClient({
      closedErrorMessage: 'closed',
      connectErrorMessage: 'connect failed',
      createRequestId: next => next,
      notConnectedErrorMessage: 'not connected',
      requestTimeoutMs: 20_000,
      // Android WebView (androidScheme http) presents Origin http://localhost.
      socketFactory: url => new WebSocket(url, { headers: { Origin: 'http://localhost' } }) as unknown as globalThis.WebSocket
    })

    try {
      await gateway.connect(wsUrl)
      expect(gateway.connectionState).toBe('open')

      await gateway.request('ping', {})
      const result = await gateway.request<{ sessions?: unknown[] }>('session.list', { limit: 5 })

      expect(Array.isArray(result?.sessions)).toBe(true)
    } finally {
      gateway.close()
    }
  })

  it('refuses a reused ticket', async () => {
    const minted = await runtime.bridge.getGatewayWsUrl()
    const wsUrl = typeof minted === 'string' ? minted : minted.ok ? minted.wsUrl : ''

    const open = (url: string) =>
      new Promise<'open' | 'rejected'>(resolve => {
        const socket = new WebSocket(url, { headers: { Origin: 'http://localhost' } })
        socket.on('open', () => {
          socket.close()
          resolve('open')
        })
        socket.on('close', () => resolve('rejected'))
        socket.on('error', () => resolve('rejected'))
      })

    expect(await open(wsUrl)).toBe('open')
    expect(await open(wsUrl)).toBe('rejected')
  })

  afterAll(async () => {
    await runtime.auth.signOut()
    expect(await store.isSignedIn()).toBe(false)
  })
})
