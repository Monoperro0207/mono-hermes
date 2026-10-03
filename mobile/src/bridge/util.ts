/** Small, dependency-free helpers shared by the bridge modules (browser + node safe). */

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding (RFC 7636 section 4). */
export function base64url(bytes: Uint8Array): string {
  let out = ''
  let i = 0

  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += BASE64URL_ALPHABET[(n >> 18) & 63] + BASE64URL_ALPHABET[(n >> 12) & 63]
    out += BASE64URL_ALPHABET[(n >> 6) & 63] + BASE64URL_ALPHABET[n & 63]
  }

  const rest = bytes.length - i

  if (rest === 1) {
    const n = bytes[i] << 16
    out += BASE64URL_ALPHABET[(n >> 18) & 63] + BASE64URL_ALPHABET[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += BASE64URL_ALPHABET[(n >> 18) & 63] + BASE64URL_ALPHABET[(n >> 12) & 63] + BASE64URL_ALPHABET[(n >> 6) & 63]
  }

  return out
}

export function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)

  return base64url(bytes)
}

/** S256 code challenge: base64url(sha256(ascii(verifier))). */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))

  return base64url(new Uint8Array(digest))
}

/**
 * Mirrors electron/connection-config.ts normalizeRemoteBaseUrl: users paste
 * scheme-less "100.64.0.1:9119"; only a real `scheme://` opts out of the http
 * default. Strips query/hash and trailing slashes but keeps a reverse-proxy
 * sub-path.
 */
export function normalizeBaseUrl(rawUrl: string): string {
  let value = String(rawUrl ?? '').trim()

  if (!value) {
    throw new Error('Server URL is required.')
  }

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `http://${value}`
  }

  let parsed: URL

  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Server URL is not valid: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Server URL must be http:// or https://, got ${parsed.protocol}`)
  }

  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${parsed.protocol}//${parsed.host}${prefix}`
}

function ipv4Octets(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)

  if (!match) {
    return null
  }

  const octets = match.slice(1).map(Number)

  return octets.every(n => n >= 0 && n <= 255) ? octets : null
}

/**
 * Plain-HTTP policy. Android has to permit cleartext traffic globally (the
 * network security config cannot express 100.64.0.0/10), so the app enforces the
 * real boundary itself: cleartext is accepted only toward Tailscale (CGNAT range
 * or *.ts.net), loopback and RFC 1918 private addresses. Anything else must use
 * https.
 */
export function isCleartextHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return true
  }

  if (host.endsWith('.ts.net') || host.endsWith('.local')) {
    return true
  }

  const o = ipv4Octets(host)

  if (!o) {
    // Single-label hostnames (Tailscale MagicDNS short names such as "my-pc").
    return /^[a-z0-9][a-z0-9-]*$/.test(host)
  }

  const [a, b] = o

  return (
    a === 127 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}

/** Throws a user-readable error when `baseUrl` would send credentials in clear text off-network. */
export function assertTransportAllowed(baseUrl: string): void {
  const parsed = new URL(baseUrl)

  if (parsed.protocol === 'https:') {
    return
  }

  if (!isCleartextHostAllowed(parsed.hostname)) {
    throw new Error(
      'Plain http:// is only allowed for Tailscale (100.x.y.z, *.ts.net), LAN or localhost addresses. ' +
        `Use https:// for ${parsed.hostname}.`
    )
  }
}

export function wsBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl)
  const scheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${scheme}://${parsed.host}${prefix}`
}

/** Same shape as electron/connection-config.ts buildGatewayWsUrlWithTicket. */
export function buildGatewayWsUrlWithTicket(baseUrl: string, ticket: string): string {
  return `${wsBaseUrl(baseUrl)}/api/ws?ticket=${encodeURIComponent(ticket)}`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
