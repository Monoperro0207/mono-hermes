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
 * seeking), which suits TTS replies and short clips. A HEAD request first reads the
 * file size, so anything above MAX_MEDIA_BYTES is refused before any body is
 * downloaded (the size is re-checked after download as a backstop). Finished Blob
 * URLs are kept in a small LRU and revoked once evicted and no longer in use.
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

/** Blob URLs kept for replay: bounded by decoded bytes and by entry count (least recently used goes first). */
export const MEDIA_CACHE_MAX_BYTES = 128 * 1024 * 1024
export const MEDIA_CACHE_MAX_ENTRIES = 24

interface CacheEntry {
  promise: Promise<string>
  /** Decoded size; 0 until the download settles. */
  bytes: number
  blobUrl: string | null
}

export interface MediaResolverOptions {
  /** Live media elements, used to avoid revoking a Blob URL that is still playing. Defaults to the document's audio/video. */
  mediaElements?: () => Iterable<Pick<HTMLMediaElement, 'currentSrc' | 'src'>>
}

const documentMediaElements = (): Iterable<HTMLMediaElement> =>
  typeof document === 'undefined' ? [] : document.querySelectorAll<HTMLMediaElement>('audio,video')

function headerMap(headers: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]))
}

export function createMediaResolver(auth: AuthSession, options: MediaResolverOptions = {}) {
  const mediaElements = options.mediaElements ?? documentMediaElements
  const cache = new Map<string, CacheEntry>()

  const inUse = (blobUrl: string): boolean => {
    for (const element of mediaElements()) {
      if (element.src === blobUrl || element.currentSrc === blobUrl) {
        return true
      }
    }

    return false
  }

  /** Drops least-recently-used entries until both limits hold. Entries still attached to an element stay and are retried on the next eviction. */
  const evict = (keep: string) => {
    let total = 0

    for (const entry of cache.values()) {
      total += entry.bytes
    }

    for (const [key, entry] of cache) {
      if (total <= MEDIA_CACHE_MAX_BYTES && cache.size <= MEDIA_CACHE_MAX_ENTRIES) {
        return
      }

      if (key === keep || !entry.blobUrl || inUse(entry.blobUrl)) {
        continue
      }

      URL.revokeObjectURL(entry.blobUrl)
      cache.delete(key)
      total -= entry.bytes
    }
  }

  return (mediaUrl: string): Promise<string> => {
    const cached = cache.get(mediaUrl)

    if (cached) {
      // Refresh recency (Map keeps insertion order).
      cache.delete(mediaUrl)
      cache.set(mediaUrl, cached)

      return cached.promise
    }

    const entry: CacheEntry = { blobUrl: null, bytes: 0, promise: Promise.resolve('') }

    entry.promise = (async () => {
      const { CapacitorHttp } = await import('@capacitor/core')
      const path = mediaRequestPath(mediaUrl)

      const response = await auth.withBearer(async (token, baseUrl) => {
        const headers = { Authorization: `Bearer ${token}` }
        const url = `${baseUrl}${path}`

        // Pre-flight: refuse an oversized file before a single body byte is downloaded.
        // Any HEAD problem other than an expired token falls through to the GET below,
        // whose post-download check stays as the backstop.
        const head = await CapacitorHttp.request({ headers, method: 'HEAD', url }).catch(() => null)

        if (head?.status === 401) {
          throw new HttpStatusError(401, '')
        }

        const length = Number(headerMap(head?.headers as Record<string, unknown> | undefined)['content-length'])

        if (head && head.status < 400 && Number.isFinite(length) && length > MAX_MEDIA_BYTES) {
          throw new Error('This media file is too large to play on the phone.')
        }

        const result = await CapacitorHttp.request({ headers, method: 'GET', responseType: 'blob', url })

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

      const blob = base64ToBlob(base64, headerMap(response.headers)['content-type'] ?? 'application/octet-stream')
      const blobUrl = URL.createObjectURL(blob)

      entry.blobUrl = blobUrl
      entry.bytes = blob.size
      evict(mediaUrl)

      return blobUrl
    })()

    cache.set(mediaUrl, entry)

    entry.promise.catch(() => {
      if (cache.get(mediaUrl) === entry) {
        cache.delete(mediaUrl)
      }
    })

    return entry.promise
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
