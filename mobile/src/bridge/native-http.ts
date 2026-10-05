/**
 * Typed access to the native `BoundedHttp` Capacitor plugin (Java, `android/.../net`).
 *
 * Why it exists: `CapacitorHttp` buffers the whole response (and Base64-encodes binary bodies)
 * before JavaScript sees a single byte, so a size limit applied afterwards limits nothing.
 * `BoundedHttp` streams with a hard byte cap, writes downloads straight to the app cache, and,
 * for public fetches, resolves DNS itself and connects only to addresses it validated (no
 * DNS-rebinding window between "check" and "connect").
 *
 * The web fallback below is for the browser UI harness and desktop dev only. It enforces the
 * same caps while reading, but a WebView cannot pin DNS answers, so it is never the production path.
 */

import { registerPlugin } from '@capacitor/core'

import type { AuthSession } from './auth'
import { HttpStatusError } from './http'

export type CacheDirectory = 'downloads' | 'media'

export interface FetchPublicTextOptions {
  url: string
  /** Hard cap on bytes read from the socket. */
  maxBytes: number
  maxRedirects?: number
  accept?: string
}

export interface FetchPublicTextResult {
  status: number
  url: string
  contentType: string
  /** Empty for non-HTML, status >= 400 or too many redirects. */
  text: string
  truncated: boolean
}

export interface DownloadOptions {
  url: string
  headers?: Record<string, string>
  maxBytes: number
  directory: CacheDirectory
  /** Plain file name inside `directory`: no separators, NUL, `.` or `..`. */
  fileName: string
  /** Refuse any host that does not resolve to a public address. */
  publicOnly?: boolean
}

export interface DownloadResult {
  status: number
  /** Absolute path of the finished file; null when the server answered >= 400. */
  path: null | string
  /** `file://<path>` ('' when `path` is null). A `blob:` URL in the web fallback. */
  uri: string
  bytes: number
  contentType: null | string
  contentDisposition: null | string
  /** First 4 KB of an error body, for status >= 400. */
  errorBody: null | string
}

export interface DeleteFilesOptions {
  directory: CacheDirectory
  /** Delete files not modified for at least this long (default 0 = all). Ignored when `names` is set. */
  olderThanMs?: number
  names?: string[]
}

export interface BoundedHttpPlugin {
  fetchPublicText(options: FetchPublicTextOptions): Promise<FetchPublicTextResult>
  download(options: DownloadOptions): Promise<DownloadResult>
  deleteFiles(options: DeleteFilesOptions): Promise<{ deleted: number }>
}

export type NativeHttpErrorCode =
  | 'blocked_host'
  | 'insufficient_space'
  | 'invalid_request'
  | 'network'
  | 'timeout'
  | 'too_large'
  | (string & {})

/** Capacitor rejects with a plain error carrying `code`; this gives it a type. */
export class NativeHttpError extends Error {
  readonly code: NativeHttpErrorCode

  constructor(message: string, code: NativeHttpErrorCode) {
    super(message)
    this.name = 'NativeHttpError'
    this.code = code
  }
}

export function isTooLarge(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'too_large'
}

const WEB_TIMEOUT_MS = 15_000
const ERROR_BODY_BYTES = 4096

/**
 * Reads `response` into chunks, never holding more than `maxBytes`. `overflow` decides what
 * happens past the cap: 'throw' (downloads) or 'truncate' (text previews).
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  overflow: 'throw' | 'truncate',
  abort: () => void
): Promise<{ chunks: Uint8Array[]; total: number; truncated: boolean }> {
  const chunks: Uint8Array[] = []
  const reader = response.body?.getReader()
  let total = 0

  if (!reader) {
    return { chunks, total, truncated: false }
  }

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      return { chunks, total, truncated: false }
    }

    if (total + value.byteLength > maxBytes) {
      abort()

      if (overflow === 'throw') {
        throw new NativeHttpError('Response is larger than the allowed size.', 'too_large')
      }

      chunks.push(value.subarray(0, maxBytes - total))

      return { chunks, total: maxBytes, truncated: true }
    }

    chunks.push(value)
    total += value.byteLength
  }
}

async function webFetch(url: string, init: RequestInit): Promise<{ abort: () => void; response: Response; done: () => void }> {
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, WEB_TIMEOUT_MS)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })

    return { abort: () => controller.abort(), done: () => clearTimeout(timer), response }
  } catch (error) {
    clearTimeout(timer)

    throw new NativeHttpError(error instanceof Error ? error.message : 'Network error', timedOut ? 'timeout' : 'network')
  }
}

export const webBoundedHttp: BoundedHttpPlugin = {
  async deleteFiles() {
    return { deleted: 0 }
  },

  async download({ headers, maxBytes, url }) {
    const { abort, done, response } = await webFetch(url, { headers })

    try {
      const contentType = response.headers.get('content-type')
      const contentDisposition = response.headers.get('content-disposition')

      if (response.status >= 400) {
        const { chunks } = await readCapped(response, ERROR_BODY_BYTES, 'truncate', abort)

        return {
          bytes: 0,
          contentDisposition,
          contentType,
          errorBody: new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer()),
          path: null,
          status: response.status,
          uri: ''
        }
      }

      const declared = Number(response.headers.get('content-length'))

      if (Number.isFinite(declared) && declared > maxBytes) {
        abort()

        throw new NativeHttpError('Response is larger than the allowed size.', 'too_large')
      }

      const { chunks, total } = await readCapped(response, maxBytes, 'throw', abort)
      const uri = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: contentType ?? '' }))

      // No filesystem on the web: the blob URL stands in for the file.
      return { bytes: total, contentDisposition, contentType, errorBody: null, path: uri, status: response.status, uri }
    } catch (error) {
      if (error instanceof NativeHttpError) {
        throw error
      }

      throw new NativeHttpError(error instanceof Error ? error.message : 'Network error', 'network')
    } finally {
      done()
    }
  },

  async fetchPublicText({ accept = 'text/html', maxBytes, url }) {
    const { abort, done, response } = await webFetch(url, { headers: { Accept: accept } })

    try {
      const contentType = response.headers.get('content-type') ?? ''
      const empty = { contentType, status: response.status, text: '', truncated: false, url: response.url || url }

      if (response.status >= 400 || !/\btext\/html\b/i.test(contentType)) {
        abort()

        return empty
      }

      const { chunks, truncated } = await readCapped(response, maxBytes, 'truncate', abort)

      return { ...empty, text: new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer()), truncated }
    } catch (error) {
      throw error instanceof NativeHttpError ? error : new NativeHttpError(error instanceof Error ? error.message : 'Network error', 'network')
    } finally {
      done()
    }
  }
}

const plugin = registerPlugin<BoundedHttpPlugin>('BoundedHttp', { web: webBoundedHttp })

/** Normalises whatever the plugin rejected with into a {@link NativeHttpError}. */
async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof NativeHttpError) {
      throw error
    }

    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }

    throw new NativeHttpError(typeof message === 'string' ? message : 'Native request failed', typeof code === 'string' ? code : 'network')
  }
}

export const fetchPublicText = (options: FetchPublicTextOptions) => call(() => plugin.fetchPublicText(options))
export const downloadToCache = (options: DownloadOptions) => call(() => plugin.download(options))
export const deleteCacheFiles = (options: DeleteFilesOptions) => call(() => plugin.deleteFiles(options))

/**
 * Downloads a gateway path with the bearer, capped natively. A 4xx/5xx answer becomes an
 * {@link HttpStatusError} so `withBearer` can refresh the token on a 401 and retry once.
 * Cap violations surface as a NativeHttpError (`isTooLarge`) for the caller to word.
 */
export function downloadWithBearer(
  auth: Pick<AuthSession, 'withBearer'>,
  path: string,
  options: Pick<DownloadOptions, 'directory' | 'fileName' | 'maxBytes'>
): Promise<DownloadResult> {
  return auth.withBearer(async (token, baseUrl) => {
    const result = await downloadToCache({ ...options, headers: { Authorization: `Bearer ${token}` }, url: `${baseUrl}${path}` })

    if (result.status >= 400) {
      throw new HttpStatusError(result.status, result.errorBody ?? '')
    }

    if (!result.uri) {
      throw new Error('The download did not produce a file.')
    }

    return result
  })
}
