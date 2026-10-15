/**
 * URL policy for the in-app browser (guest WebView). The native side (GuestUrlPolicy.java) is
 * authoritative and enforces it on every load, redirect and popup; this mirror only lets the
 * renderer refuse early with the same wording. Keep the two in step.
 *
 *  - only http(s) (plus the internal `about:blank`);
 *  - no credentials in the URL;
 *  - plain http only for loopback, tailnet and private-network hosts (same buckets as the
 *    gateway transport rule, util.ts `classifyHost`); public hosts must use https.
 */

import { classifyHost } from '../bridge/util'

export type GuestUrlVerdict = { ok: true; url: string } | { ok: false; reason: string }

export const ABOUT_BLANK = 'about:blank'

export const REASON_SCHEME = 'Only http and https pages can be opened in the in-app browser.'
export const REASON_CREDENTIALS = 'URLs with embedded credentials are not allowed.'
export const REASON_PLAIN_HTTP =
  'Plain http:// is only allowed for localhost, Tailscale and private-network hosts. Use https:// for public sites.'

export function checkGuestUrl(raw: string): GuestUrlVerdict {
  const url = raw.trim()

  if (url === ABOUT_BLANK) {
    return { ok: true, url }
  }

  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u0020\u007f]/.test(url)) {
    return { ok: false, reason: 'Not a valid URL.' }
  }

  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'Not a valid URL.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: REASON_SCHEME }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: REASON_CREDENTIALS }
  }

  if (parsed.protocol === 'http:' && classifyHost(parsed.hostname) === 'public') {
    return { ok: false, reason: REASON_PLAIN_HTTP }
  }

  return { ok: true, url }
}
