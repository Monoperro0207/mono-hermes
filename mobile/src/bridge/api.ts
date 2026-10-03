/**
 * `window.hermesDesktop.api()` for the phone.
 *
 * Electron's `hermes:api` handler (main.ts handleHermesApiRequest -> fetchJson)
 * resolves a backend, sends the REST call with credentials and throws
 * `<status>: <body>` on failure. This reproduces that contract for the single
 * remote gateway: bearer auth with refresh-on-401, `?profile=` scoping the way
 * the desktop scopes a global remote, JSON in/out, HTML-fallthrough detection.
 *
 * Transport: Capacitor native HTTP rather than WebView fetch. The gateway's CORS
 * policy only allows localhost origins and its auth gate answers a credential-less
 * preflight with 401, so a cross-origin `fetch` carrying an Authorization header
 * cannot work against a gated server. Native HTTP has no CORS and no mixed-content
 * rules, which makes REST behave exactly like Electron's node http client.
 */

import type { HermesApiRequest } from '@/global'

import { type AuthSession } from './auth'
import { DEFAULT_TIMEOUT_MS, type HttpTransport, HttpStatusError } from './http'

/** Mirror of electron/connection-config.ts pathWithProfileScope. */
export function pathWithProfileScope(path: string, profile: null | string | undefined): string {
  const scoped = String(profile ?? '').trim()

  if (!scoped || !path) {
    return path
  }

  let parsed: URL

  try {
    parsed = new URL(path, 'http://hermes.local')
  } catch {
    return path
  }

  if (parsed.searchParams.has('profile')) {
    return path
  }

  parsed.searchParams.set('profile', scoped)

  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function toRequestPath(path: string): string {
  const value = String(path || '')

  return value.startsWith('/') ? value : `/${value}`
}

/** `GET /api/hermes/update/check[?force=true]` - the desktop's "remote backend update" probe. */
const UPDATE_CHECK_PATH = /^\/api\/hermes\/update\/check(?:\?|$)/
const UPDATE_APPLY_PATH = /^\/api\/hermes\/update(?:\?|$)/

/**
 * The phone cannot (and must not) update the PC's Hermes: the desktop renderer would otherwise
 * show an "Update ready" toast, a "(+13)" badge on the backend version and an Install button
 * that restarts the shared server. Keep the real version string, report "nothing to do, this
 * client cannot apply updates" (`can_apply: false` renders the renderer's own "unsupported" copy).
 */
export function maskBackendUpdateCheck<T>(body: T): T {
  if (!body || typeof body !== 'object') {
    return body
  }

  return {
    ...(body as object),
    behind: 0,
    can_apply: false,
    commits: [],
    message: 'Update Hermes on the PC with "hermes update"; update this app by installing a newer APK.',
    update_available: false,
    update_command: null
  } as T
}

export function isBackendUpdateCheckPath(path: string): boolean {
  return UPDATE_CHECK_PATH.test(path)
}

export function isBackendUpdateApplyPath(path: string): boolean {
  return UPDATE_APPLY_PATH.test(path)
}

export interface ApiDeps {
  auth: AuthSession
  transport: HttpTransport
}

export function createApi({ auth, transport }: ApiDeps) {
  return async function api<T>(request: HermesApiRequest): Promise<T> {
    const path = pathWithProfileScope(toRequestPath(request.path), request.profile)
    const method = (request.method || 'GET').toUpperCase()
    const timeoutMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS

    // Same limitation as the desktop's OAuth path (main.ts handleHermesApiRequest): multipart
    // uploads exist only for token-mode backends. A WebView fetch cannot stand in - the gateway
    // answers the credential-less CORS preflight of an authenticated route with 401.
    if (request.upload) {
      throw new Error('File uploads are not supported against OAuth-gated remote backends yet.')
    }

    if (method !== 'GET' && isBackendUpdateApplyPath(path)) {
      throw new Error('Updating the PC from the phone is not supported: run "hermes update" on the PC.')
    }

    return auth.withBearer(async (token, baseUrl) => {
      const url = `${baseUrl}${path}`

      const response = await transport.request({
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        json: request.body,
        method,
        timeoutMs,
        url
      })

      const parsed = parseApiResponse<T>(url, response.status, response.headers['content-type'] ?? '', response.body)

      return method === 'GET' && isBackendUpdateCheckPath(path) ? maskBackendUpdateCheck(parsed) : parsed
    })
  }
}

export function parseApiResponse<T>(url: string, status: number, contentType: string, text: string): T {
  if (status >= 400) {
    throw new HttpStatusError(status, text)
  }

  if (!text) {
    return null as T
  }

  // A 2xx HTML body means the request fell through to the SPA index (unknown /api path).
  if (/^\s*<(?:!doctype|html)/i.test(text) || contentType.includes('text/html')) {
    throw new Error(
      `Expected JSON from ${url} but got HTML (status ${status}). The endpoint is likely missing on the Hermes backend.`
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Invalid JSON from ${url} (status ${status}): ${text.slice(0, 200)}`)
  }
}
