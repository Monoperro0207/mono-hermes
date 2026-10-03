/**
 * HTTP transport abstraction.
 *
 * The auth flow needs two things a WebView `fetch` cannot give us: control over
 * redirects (the authorize step answers 302 and must not be followed) and the raw
 * Set-Cookie header (the gateway keeps the native-login broker handle in a PKCE
 * cookie). Capacitor's native HTTP layer provides both, so production uses
 * {@link createCapacitorTransport}. The Node-based end-to-end test injects
 * {@link createFetchTransport} instead, which exercises the very same auth code.
 */

export interface RawRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  /** JSON-serialisable body (sent as application/json). */
  json?: unknown
  /** Pre-encoded string body. */
  body?: string
  timeoutMs?: number
  /** When false the 3xx response is returned as-is. Default true. */
  followRedirects?: boolean
}

export interface RawResponse {
  status: number
  /** Lower-cased header names (Set-Cookie is reported separately in `setCookie`). */
  headers: Record<string, string>
  /** Individual Set-Cookie header values when the transport can see them. */
  setCookie: string[]
  body: string
}

export interface HttpTransport {
  request(req: RawRequest): Promise<RawResponse>
}

export const DEFAULT_TIMEOUT_MS = 30_000

/** Error carrying the HTTP status, mirroring the `<status>: <text>` messages Electron's fetchJson throws. */
export class HttpStatusError extends Error {
  readonly statusCode: number
  readonly body: string

  constructor(statusCode: number, body: string, statusText = '') {
    super(`${statusCode}: ${body || statusText}`)
    this.name = 'HttpStatusError'
    this.statusCode = statusCode
    this.body = body
  }
}

/**
 * Split a combined Set-Cookie header (values joined with ", " by Android's
 * HttpURLConnection) into individual cookies. A comma only separates cookies
 * when what follows looks like `name=`, which keeps `Expires=Wed, 21 Oct ...` intact.
 */
export function splitSetCookie(joined: string): string[] {
  if (!joined) {
    return []
  }

  const parts: string[] = []
  let current = ''

  for (const piece of joined.split(/,\s*/)) {
    if (current && /^[^=;\s]+=/.test(piece)) {
      parts.push(current)
      current = piece
    } else {
      current = current ? `${current}, ${piece}` : piece
    }
  }

  if (current) {
    parts.push(current)
  }

  return parts
}

export function createFetchTransport(fetchImpl: typeof fetch = fetch): HttpTransport {
  return {
    async request(req) {
      const controller = new AbortController()
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const headers: Record<string, string> = { ...(req.headers ?? {}) }
      let body = req.body

      if (req.json !== undefined) {
        body = JSON.stringify(req.json)
        headers['Content-Type'] ??= 'application/json'
      }

      try {
        const response = await fetchImpl(req.url, {
          body,
          headers,
          method: req.method ?? 'GET',
          redirect: req.followRedirects === false ? 'manual' : 'follow',
          signal: controller.signal
        })

        const outHeaders: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') {
            outHeaders[key.toLowerCase()] = value
          }
        })

        const withCookies = response.headers as Headers & { getSetCookie?: () => string[] }

        return {
          body: await response.text(),
          headers: outHeaders,
          setCookie: withCookies.getSetCookie ? withCookies.getSetCookie() : [],
          status: response.status
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Timed out connecting to the Hermes server after ${timeoutMs}ms`)
        }

        throw error
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/** Native HTTP (java.net.HttpURLConnection): no CORS, controllable redirects, raw headers. */
export function createCapacitorTransport(): HttpTransport {
  return {
    async request(req) {
      const { CapacitorHttp } = await import('@capacitor/core')
      const headers: Record<string, string> = { ...(req.headers ?? {}) }
      let data: unknown = req.body

      if (req.json !== undefined) {
        data = req.json
        headers['Content-Type'] ??= 'application/json'
      }

      const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS

      const response = await CapacitorHttp.request({
        connectTimeout: Math.min(timeout, 15_000),
        data,
        disableRedirects: req.followRedirects === false,
        headers,
        method: req.method ?? 'GET',
        readTimeout: timeout,
        responseType: 'text',
        url: req.url
      })

      const outHeaders: Record<string, string> = {}
      let setCookie: string[] = []

      for (const [key, value] of Object.entries(response.headers ?? {})) {
        if (key.toLowerCase() === 'set-cookie') {
          setCookie = splitSetCookie(String(value))
        } else {
          outHeaders[key.toLowerCase()] = String(value)
        }
      }

      // The native layer pre-parses JSON bodies into objects.
      const body =
        typeof response.data === 'string' ? response.data : response.data == null ? '' : JSON.stringify(response.data)

      return { body, headers: outHeaders, setCookie, status: response.status }
    }
  }
}

/** Minimal cookie jar for a single login transaction: name=value pairs only. */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  store(setCookie: string[]): void {
    for (const raw of setCookie) {
      const first = raw.split(';', 1)[0]
      const eq = first.indexOf('=')

      if (eq <= 0) {
        continue
      }

      const name = first.slice(0, eq).trim()
      const value = first.slice(eq + 1).trim()
      const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(raw)

      if (value === '' || (maxAge && Number(maxAge[1]) <= 0)) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, value)
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get size(): number {
    return this.cookies.size
  }
}
