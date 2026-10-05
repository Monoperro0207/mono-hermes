/**
 * `hermes-media://` for the phone.
 *
 * Electron registers a custom protocol that proxies remote audio/video through the
 * main process so the bearer never appears in a renderer URL. Android WebView has no
 * such hook and `<audio>/<video>` cannot send an Authorization header, so the shim
 * intercepts the element's `src`, downloads the file natively with the bearer
 * (`GET /api/files/stream?path=`), and plays it from a Blob URL.
 *
 * Trade-off: the whole file is downloaded before playback starts (no Range
 * seeking), which suits TTS replies and short clips. The native `BoundedHttp` plugin
 * streams the body to a cache file and aborts at MAX_MEDIA_BYTES while reading (also
 * when Content-Length already exceeds it), so an oversized file never lands in memory
 * or on disk. The file is then turned into a Blob without Base64 (one copy in memory)
 * and the cache file is deleted.
 *
 * Finished Blob URLs sit in a strict LRU (see {@link createMediaResolver}); an evicted
 * entry that an idle element still references is detached and re-downloaded when that
 * element plays again.
 */

import { Capacitor } from '@capacitor/core'

import { pathWithProfileScope } from './api'
import { type AuthSession } from './auth'
import { deleteCacheFiles, downloadWithBearer, isTooLarge } from './native-http'

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

/** Blob URLs kept for replay: bounded by bytes and by entry count (least recently used goes first). */
export const MEDIA_CACHE_MAX_BYTES = 128 * 1024 * 1024
export const MEDIA_CACHE_MAX_ENTRIES = 24

/** Leftover temp files (crash mid-download) older than this are swept when the shim installs. */
const STALE_TEMP_FILE_MS = 60 * 60 * 1000

interface CacheEntry {
  promise: Promise<string>
  /** Blob size; 0 until the download settles. */
  bytes: number
  blobUrl: string | null
}

/** What the resolver needs to know about an element to decide whether its Blob may be released. */
export type MediaElementLike = Pick<HTMLMediaElement, 'currentSrc' | 'currentTime' | 'ended' | 'paused' | 'src'>

export interface MediaResolverOptions {
  /** Live media elements. Defaults to the document's audio/video. */
  mediaElements?: () => Iterable<MediaElementLike>
  /**
   * Called for every idle element whose Blob is being evicted, before the URL is revoked.
   * The default parks the element (see {@link resumeParkedMedia}) and clears its `src`.
   */
  detach?: (element: MediaElementLike, mediaUrl: string, currentTime: number) => void
}

const documentMediaElements = (): Iterable<HTMLMediaElement> =>
  typeof document === 'undefined' ? [] : document.querySelectorAll<HTMLMediaElement>('audio,video')

interface ParkedMedia {
  mediaUrl: string
  currentTime: number
}

/** Elements whose Blob was evicted while idle: what they were playing and where they stopped. */
const parked = new WeakMap<object, ParkedMedia>()

/** Clears the element with the native `removeAttribute` (not the shimmed setters) and remembers how to resume it. */
function parkAndDetach(element: MediaElementLike, mediaUrl: string, currentTime: number): void {
  const media = element as HTMLMediaElement

  parked.set(media, { currentTime, mediaUrl })
  media.removeAttribute('src')
  media.load()
}

const isPlaying = (element: MediaElementLike): boolean => !element.paused && !element.ended

/** Short stable tag so a temp file name says which media it belongs to. */
function hashOf(value: string): string {
  let hash = 5381

  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
  }

  return hash.toString(16)
}

let tempSequence = 0

/**
 * Resolves `hermes-media://` URLs to Blob URLs.
 *
 * Cache bound: total Blob bytes <= MEDIA_CACHE_MAX_BYTES and entries <= MEDIA_CACHE_MAX_ENTRIES,
 * with two exceptions that are both bounded: (a) a file that is playing at that instant (an
 * element with `!paused && !ended` uses its URL) is never revoked, each such file is <=
 * MAX_MEDIA_BYTES; (b) the entry that was just added. Every other entry, including one that an
 * idle/paused/ended element still references, is evicted: the element is detached first and
 * resumes through a fresh download on its next `play`. Downloads still in flight count as entries
 * but weigh 0 bytes until they settle. Elements outside the document (`new Audio()`) are not
 * visible to the default `mediaElements`, so they are treated as idle.
 */
export function createMediaResolver(auth: Pick<AuthSession, 'withBearer'>, options: MediaResolverOptions = {}) {
  const mediaElements = options.mediaElements ?? documentMediaElements
  const detach = options.detach ?? parkAndDetach
  const cache = new Map<string, CacheEntry>()

  /** Drops least-recently-used entries until both limits hold; only entries that are playing right now stay. */
  const evict = (keep: string) => {
    let total = 0

    for (const entry of cache.values()) {
      total += entry.bytes
    }

    for (const [key, entry] of cache) {
      if (total <= MEDIA_CACHE_MAX_BYTES && cache.size <= MEDIA_CACHE_MAX_ENTRIES) {
        return
      }

      if (key === keep || !entry.blobUrl) {
        continue
      }

      const users = [...mediaElements()].filter(element => element.src === entry.blobUrl || element.currentSrc === entry.blobUrl)

      if (users.some(isPlaying)) {
        continue
      }

      for (const element of users) {
        try {
          detach(element, key, element.currentTime)
        } catch (error) {
          console.warn('[hermes-mobile] could not detach idle media:', error)
        }
      }

      URL.revokeObjectURL(entry.blobUrl)
      cache.delete(key)
      total -= entry.bytes
    }
  }

  /** Downloads to a temp cache file, then loads it as a Blob (no Base64) and removes the file. */
  const download = async (mediaUrl: string): Promise<{ blobUrl: string; bytes: number }> => {
    const fileName = `m-${hashOf(mediaUrl)}-${Date.now()}-${(tempSequence += 1)}`

    let result: Awaited<ReturnType<typeof downloadWithBearer>>

    try {
      result = await downloadWithBearer(auth, mediaRequestPath(mediaUrl), { directory: 'media', fileName, maxBytes: MAX_MEDIA_BYTES })
    } catch (error) {
      throw isTooLarge(error) ? new Error('This media file is too large to play on the phone.') : error
    }

    // Web fallback: there is no file, `uri` already is a Blob URL.
    if (result.uri.startsWith('blob:')) {
      return { blobUrl: result.uri, bytes: result.bytes }
    }

    try {
      const loaded = await (await fetch(Capacitor.convertFileSrc(result.uri))).blob()
      const type = result.contentType ?? ''
      // The local file server often cannot type an extension-less file; the gateway's answer wins then.
      const blob = type && (!loaded.type || loaded.type === 'application/octet-stream') ? new Blob([loaded], { type }) : loaded

      return { blobUrl: URL.createObjectURL(blob), bytes: blob.size }
    } finally {
      try {
        await deleteCacheFiles({ directory: 'media', names: [fileName] })
      } catch {
        // The stale-file sweep at startup is the backstop.
      }
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
      const { blobUrl, bytes } = await download(mediaUrl)

      entry.blobUrl = blobUrl
      entry.bytes = bytes
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

/**
 * `play` listener for elements parked by an eviction: fetch the media again, put the Blob back
 * with `applyBlob` (the native `src` setter), restore the playback position and resume.
 * Resolves once the element is playing again (or failed); no-op for any other element.
 */
export async function resumeParkedMedia(
  target: unknown,
  resolve: (mediaUrl: string) => Promise<string>,
  applyBlob: (element: HTMLMediaElement, blobUrl: string) => void
): Promise<void> {
  const element = target as HTMLMediaElement | null
  const state = element ? parked.get(element) : undefined

  if (!element || !state) {
    return
  }

  parked.delete(element)

  // Something else gave the element a source since the eviction: that wins.
  if (element.getAttribute('src')) {
    return
  }

  // `play` fires while the element has no source; stop that attempt, it is restarted below.
  element.pause()

  try {
    const blobUrl = await resolve(state.mediaUrl)

    if (element.getAttribute('src')) {
      return
    }

    applyBlob(element, blobUrl)

    const seek = () => {
      try {
        element.currentTime = state.currentTime
      } catch {
        // Not seekable yet; playing from the start beats failing.
      }
    }

    if (element.readyState >= 1) {
      seek()
    } else {
      element.addEventListener('loadedmetadata', seek, { once: true })
    }

    await element.play().catch(() => undefined)
  } catch (error) {
    console.warn('[hermes-mobile] media reload failed:', error)
    element.dispatchEvent(new Event('error'))
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

  // Temp files from a download that was cut short by the process dying; best effort.
  void deleteCacheFiles({ directory: 'media', olderThanMs: STALE_TEMP_FILE_MS }).catch(() => undefined)

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

  // `play` does not bubble, so listen in the capture phase to see every element's.
  document.addEventListener(
    'play',
    event => void resumeParkedMedia(event.target, resolve, (element, blobUrl) => nativeSet.call(element, blobUrl)),
    true
  )
}
