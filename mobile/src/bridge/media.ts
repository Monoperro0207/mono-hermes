/**
 * `hermes-media://` for the phone.
 *
 * Electron registers a custom protocol that proxies remote audio/video through the
 * main process so the bearer never appears in a renderer URL. Android WebView has no
 * such hook and `<audio>/<video>` cannot send an Authorization header, so the shim
 * intercepts the element's `src`, fetches the file natively with the bearer
 * (`GET /api/files/stream?path=`), and plays it from a Blob URL.
 *
 * Trade-off: the whole file is downloaded before playback starts (no Range
 * seeking), which suits TTS replies and short clips; anything above
 * MAX_MEDIA_BYTES is refused rather than risking an out-of-memory crash.
 */

import { type AuthSession } from './auth'
import { HttpStatusError } from './http'
import { pathWithProfileScope } from './api'

const MEDIA_SCHEME = 'hermes-media://'
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024

export function isMediaProtocolUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${MEDIA_SCHEME}remote/`)
}

/** `hermes-media://remote/<encoded path>?profile=x` -> gateway request path. */
export function mediaRequestPath(mediaUrl: string): string {
  const rest = mediaUrl.slice(`${MEDIA_SCHEME}remote/`.length)
  const [rawPath, query = ''] = rest.split('?', 2)
  const profile = new URLSearchParams(query).get('profile')
  const filePath = decodeURIComponent(rawPath)

  return pathWithProfileScope(`/api/files/stream?path=${encodeURIComponent(filePath)}`, profile)
}

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }

  return new Blob([bytes], { type })
}

export function createMediaResolver(auth: AuthSession) {
  const cache = new Map<string, Promise<string>>()

  return (mediaUrl: string): Promise<string> => {
    const cached = cache.get(mediaUrl)

    if (cached) {
      return cached
    }

    const pending = (async () => {
      const { CapacitorHttp } = await import('@capacitor/core')
      const path = mediaRequestPath(mediaUrl)

      const response = await auth.withBearer(async (token, baseUrl) => {
        const result = await CapacitorHttp.request({
          headers: { Authorization: `Bearer ${token}` },
          method: 'GET',
          responseType: 'blob',
          url: `${baseUrl}${path}`
        })

        if (result.status >= 400) {
          throw new HttpStatusError(result.status, typeof result.data === 'string' ? result.data : '')
        }

        return result
      })

      const base64 = String(response.data ?? '')

      // base64 inflates by 4/3; check before decoding.
      if ((base64.length * 3) / 4 > MAX_MEDIA_BYTES) {
        throw new Error('This media file is too large to play on the phone.')
      }

      const headers = Object.fromEntries(
        Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
      )

      return URL.createObjectURL(base64ToBlob(base64, headers['content-type'] ?? 'application/octet-stream'))
    })()

    cache.set(mediaUrl, pending)
    pending.catch(() => cache.delete(mediaUrl))

    return pending
  }
}

/** Patch `HTMLMediaElement.src` and `setAttribute('src')` so media URLs resolve before reaching the element. */
export function installMediaProtocolShim(auth: AuthSession): void {
  const resolve = createMediaResolver(auth)
  const proto = HTMLMediaElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'src')

  if (!descriptor?.set || !descriptor.get) {
    return
  }

  const nativeSet = descriptor.set
  const nativeSetAttribute = Element.prototype.setAttribute

  const assign = (element: HTMLMediaElement, mediaUrl: string, apply: (value: string) => void) => {
    // Show the protocol URL while loading (callers read `src` back), then swap in the blob.
    apply(mediaUrl)
    void resolve(mediaUrl)
      .then(blobUrl => {
        // Only swap if the element still points at the same request.
        if (element.getAttribute('src') === mediaUrl || element.src === mediaUrl) {
          nativeSet.call(element, blobUrl)
        }
      })
      .catch(error => {
        console.warn('[hermes-mobile] media load failed:', error)
        element.dispatchEvent(new Event('error'))
      })
  }

  Object.defineProperty(proto, 'src', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set(this: HTMLMediaElement, value: string) {
      if (isMediaProtocolUrl(value)) {
        assign(this, value, v => nativeSet.call(this, v))

        return
      }

      nativeSet.call(this, value)
    }
  })

  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (name.toLowerCase() === 'src' && this instanceof HTMLMediaElement && isMediaProtocolUrl(value)) {
      assign(this, value, v => nativeSetAttribute.call(this, 'src', v))

      return
    }

    nativeSetAttribute.call(this, name, value)
  }
}
