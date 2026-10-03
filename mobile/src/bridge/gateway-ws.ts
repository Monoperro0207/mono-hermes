/**
 * Gateway WebSocket URL minting.
 *
 * `apps/shared` JsonRpcGatewayClient opens a plain browser WebSocket on whatever
 * URL `getGatewayWsUrl()` returns, so the phone only has to supply that URL. In
 * gated mode the credential is a single-use 30 second ticket from
 * `POST /api/auth/ws-ticket` (bearer-authenticated), appended as `?ticket=`. A
 * fresh ticket is minted per dial and never cached or reused.
 *
 * Origin: Android WebView sends `Origin: http://localhost` (androidScheme http).
 * The gateway accepts that when it is bound to 0.0.0.0 (host/origin guard), which
 * is what the README tells the user to run.
 */

import type { GatewayWsUrlResult } from '@hermes/shared'

import { type AuthSession, NeedsLoginError } from './auth'
import { type HttpTransport, HttpStatusError } from './http'
import { buildGatewayWsUrlWithTicket, errorMessage, sleep } from './util'

export interface GatewayWsDeps {
  auth: AuthSession
  transport: HttpTransport
}

const MINT_ATTEMPTS = 3
const MINT_RETRY_DELAYS_MS = [250, 750]

/** Mint one ticket. Auth rejections surface immediately; transport/5xx errors retry briefly. */
export async function mintWsTicket({ auth, transport }: GatewayWsDeps): Promise<string> {
  let lastError: unknown

  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
    try {
      return await auth.withBearer(async (token, baseUrl) => {
        const response = await transport.request({
          headers: { Authorization: `Bearer ${token}` },
          method: 'POST',
          timeoutMs: 8_000,
          url: `${baseUrl}/api/auth/ws-ticket`
        })

        if (response.status >= 400) {
          throw new HttpStatusError(response.status, response.body)
        }

        let ticket: unknown

        try {
          ticket = JSON.parse(response.body)?.ticket
        } catch {
          ticket = null
        }

        if (!ticket || typeof ticket !== 'string') {
          throw new Error('Gateway did not return a WS ticket.')
        }

        return ticket
      })
    } catch (error) {
      lastError = error

      const authRejection =
        error instanceof NeedsLoginError ||
        (error instanceof HttpStatusError && (error.statusCode === 401 || error.statusCode === 403))

      if (authRejection || attempt === MINT_ATTEMPTS - 1) {
        throw error
      }

      await sleep(MINT_RETRY_DELAYS_MS[Math.min(attempt, MINT_RETRY_DELAYS_MS.length - 1)])
    }
  }

  throw lastError
}

/** `getGatewayWsUrl` result contract (see apps/shared websocket-url.ts GatewayWsUrlResult). */
export async function getGatewayWsUrl(deps: GatewayWsDeps): Promise<Extract<GatewayWsUrlResult, object>> {
  try {
    const baseUrl = await deps.auth.requireBaseUrl()
    const ticket = await mintWsTicket(deps)

    return { ok: true, wsUrl: buildGatewayWsUrlWithTicket(baseUrl, ticket) }
  } catch (error) {
    const authRejection =
      error instanceof NeedsLoginError ||
      (error instanceof HttpStatusError && (error.statusCode === 401 || error.statusCode === 403))

    return {
      error: errorMessage(error),
      ...(authRejection ? { needsOauthLogin: true as const } : {}),
      ok: false
    }
  }
}
