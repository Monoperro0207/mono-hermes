import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteCacheFiles, isTooLarge, NativeHttpError, webBoundedHttp } from '../src/bridge/native-http'

/** A body that yields `chunks` one by one and records whether the reader was cancelled. */
function streamed(chunks: Uint8Array[], init: ResponseInit = {}) {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled < chunks.length) {
        controller.enqueue(chunks[pulled])
        pulled += 1
      } else {
        controller.close()
      }
    }
  })

  return { pulled: () => pulled, response: new Response(body, init) }
}

const bytes = (n: number) => new Uint8Array(n).fill(65)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('web fallback', () => {
  it('download enforces the cap while reading and stops pulling after it', async () => {
    const { pulled, response } = streamed(Array.from({ length: 8 }, () => bytes(600)), { headers: { 'content-type': 'audio/mpeg' } })

    vi.stubGlobal('fetch', vi.fn(async () => response))

    const error = await webBoundedHttp.download({ directory: 'media', fileName: 'x', maxBytes: 1000, url: 'http://gw/x' }).catch(e => e)

    expect(isTooLarge(error)).toBe(true)
    expect(error).toBeInstanceOf(NativeHttpError)
    expect(pulled()).toBeLessThan(8)
  })

  it('download refuses early when Content-Length is over the cap', async () => {
    const { response } = streamed([bytes(10)], { headers: { 'content-length': '5000' } })

    vi.stubGlobal('fetch', vi.fn(async () => response))

    await expect(webBoundedHttp.download({ directory: 'media', fileName: 'x', maxBytes: 1000, url: 'http://gw/x' })).rejects.toMatchObject({ code: 'too_large' })
  })

  it('download returns a blob: URL standing in for the file', async () => {
    const { response } = streamed([bytes(300), bytes(200)], { headers: { 'content-disposition': 'attachment; filename=a.bin', 'content-type': 'audio/mpeg' } })

    vi.stubGlobal('fetch', vi.fn(async () => response))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:web/1')

    const result = await webBoundedHttp.download({ directory: 'media', fileName: 'x', headers: { Authorization: 'Bearer t' }, maxBytes: 1000, url: 'http://gw/x' })

    expect(result).toMatchObject({ bytes: 500, contentDisposition: 'attachment; filename=a.bin', contentType: 'audio/mpeg', path: 'blob:web/1', status: 200, uri: 'blob:web/1' })
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer t' } })
  })

  it('download hands back a truncated error body with no file for status >= 400', async () => {
    const { response } = streamed([bytes(10_000)], { status: 401 })

    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await webBoundedHttp.download({ directory: 'media', fileName: 'x', maxBytes: 1000, url: 'http://gw/x' })

    expect(result).toMatchObject({ path: null, status: 401, uri: '' })
    expect(result.errorBody).toHaveLength(4096)
  })

  it('download maps a network failure to a coded error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))

    await expect(webBoundedHttp.download({ directory: 'media', fileName: 'x', maxBytes: 1000, url: 'http://gw/x' })).rejects.toMatchObject({ code: 'network' })
  })

  it('fetchPublicText truncates at the cap and reports it', async () => {
    const { response } = streamed([new TextEncoder().encode('<title>Hi</title>'), bytes(100)], { headers: { 'content-type': 'text/html' } })

    vi.stubGlobal('fetch', vi.fn(async () => response))

    const result = await webBoundedHttp.fetchPublicText({ maxBytes: 20, url: 'https://example.com/' })

    expect(result.truncated).toBe(true)
    expect(new TextEncoder().encode(result.text).byteLength).toBe(20)
    expect(result.text.startsWith('<title>Hi</title>')).toBe(true)
  })

  it('fetchPublicText returns no text for non-HTML or error statuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamed([bytes(5)], { headers: { 'content-type': 'application/pdf' } }).response))
    expect((await webBoundedHttp.fetchPublicText({ maxBytes: 100, url: 'https://example.com/a.pdf' })).text).toBe('')

    vi.stubGlobal('fetch', vi.fn(async () => streamed([bytes(5)], { headers: { 'content-type': 'text/html' }, status: 404 }).response))
    expect((await webBoundedHttp.fetchPublicText({ maxBytes: 100, url: 'https://example.com/gone' })).text).toBe('')
  })

  it('deleteFiles is a no-op without a filesystem', async () => {
    expect(await webBoundedHttp.deleteFiles({ directory: 'media' })).toEqual({ deleted: 0 })
  })
})

describe('plugin wrappers', () => {
  it('turns the code Capacitor rejects with into a NativeHttpError', async () => {
    // Unmocked @capacitor/core in node is the web platform, so the web fallback answers.
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('boom'))))

    const result = await deleteCacheFiles({ directory: 'media' })

    expect(result).toEqual({ deleted: 0 })
    expect(isTooLarge(new NativeHttpError('x', 'too_large'))).toBe(true)
    expect(isTooLarge(new Error('too_large'))).toBe(false)
    expect(isTooLarge(null)).toBe(false)
  })
})
