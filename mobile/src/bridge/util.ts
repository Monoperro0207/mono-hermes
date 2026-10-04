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

export type HostClass = 'loopback' | 'tailnet' | 'lan' | 'public'

/**
 * Buckets a hostname by how far its traffic is likely to travel:
 *
 *  - `loopback`: localhost, *.localhost, 127/8, 0/8, ::1 (never leaves the device);
 *  - `tailnet`: Tailscale CGNAT range 100.64.0.0/10 or *.ts.net (WireGuard encrypts the hop);
 *  - `lan`: RFC 1918, link-local 169.254/16, multicast/reserved, *.local and single-label names.
 *    Single-label names are ambiguous between a MagicDNS short name and a NetBIOS/LAN name,
 *    so they get the safe default;
 *  - `public`: everything else, including every IPv6 literal other than ::1.
 *
 * Callers that pass a URL hostname get WHATWG-normalised IPv4 forms (decimal, hex, short),
 * so `http://2130706433` already arrives here as 127.0.0.1.
 */
export function classifyHost(hostname: string): HostClass {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return 'loopback'
  }

  if (host.endsWith('.ts.net')) {
    return 'tailnet'
  }

  if (host.endsWith('.local')) {
    return 'lan'
  }

  const o = ipv4Octets(host)

  if (!o) {
    // Single-label hostnames (Tailscale MagicDNS short names such as "my-pc", or NetBIOS names).
    return /^[a-z0-9][a-z0-9-]*$/.test(host) ? 'lan' : 'public'
  }

  const [a, b] = o

  if (a === 127 || a === 0) {
    return 'loopback'
  }

  if (a === 100 && b >= 64 && b <= 127) {
    return 'tailnet'
  }

  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224) {
    return 'lan'
  }

  return 'public'
}

/**
 * True when plain http:// to `hostname` needs no consent: Tailscale and loopback only.
 * LAN addresses are cleartext on shared Wi-Fi, so they are allowed only after the user
 * explicitly accepts the risk (see {@link assertTransportAllowed}).
 */
export function isCleartextHostAllowed(hostname: string): boolean {
  const kind = classifyHost(hostname)

  return kind === 'loopback' || kind === 'tailnet'
}

/** Thrown for plain http:// to a LAN address until the user explicitly accepts the risk. */
export class LanCleartextConsentRequired extends Error {
  readonly hostname: string

  constructor(hostname: string) {
    super(
      `${hostname} is on your local network, not Tailscale. Over http:// your password and session token ` +
        "travel unencrypted and anyone on this Wi-Fi can read them. Use your PC's Tailscale address (100.x.y.z) instead, or confirm to connect anyway."
    )
    this.name = 'LanCleartextConsentRequired'
    this.hostname = hostname
  }
}

export interface TransportPolicyOptions {
  /** The user explicitly accepted plain http:// to a LAN address for this server. */
  allowLanCleartext?: boolean
}

/**
 * Plain-HTTP policy. Android has to permit cleartext traffic globally (the network
 * security config cannot express 100.64.0.0/10), so the app enforces the real boundary
 * itself: https always passes; http passes silently only toward Tailscale and loopback;
 * LAN addresses need `allowLanCleartext` (otherwise {@link LanCleartextConsentRequired});
 * any other host must use https.
 */
export function assertTransportAllowed(baseUrl: string, options: TransportPolicyOptions = {}): void {
  const parsed = new URL(baseUrl)

  if (parsed.protocol === 'https:') {
    return
  }

  const kind = classifyHost(parsed.hostname)

  if (kind === 'loopback' || kind === 'tailnet') {
    return
  }

  if (kind === 'lan') {
    if (options.allowLanCleartext) {
      return
    }

    throw new LanCleartextConsentRequired(parsed.hostname)
  }

  throw new Error(
    'Plain http:// is only allowed for Tailscale (100.x.y.z, *.ts.net), local-network or localhost addresses. ' +
      `Use https:// for ${parsed.hostname}.`
  )
}

/** True when `baseUrl` is plain http:// to a LAN host (the case that needs recorded consent). */
export function isLanCleartext(baseUrl: string): boolean {
  const parsed = new URL(baseUrl)

  return parsed.protocol === 'http:' && classifyHost(parsed.hostname) === 'lan'
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
