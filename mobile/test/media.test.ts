import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({ deleteFiles: vi.fn(), download: vi.fn(), fetchPublicText: vi.fn() }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { convertFileSrc: (uri: string) => `http://localhost/_capacitor_file_${uri.slice('file://'.length)}` },
  registerPlugin: () => plugin
}))

import type { AuthSession } from '../src/bridge/auth'
import { HttpStatusError } from '../src/bridge/http'
import {
  createMediaResolver,
  MAX_MEDIA_BYTES,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_MAX_ENTRIES,
  type MediaElementLike,
  resumeParkedMedia
} from '../src/bridge/media'

/** The real `withBearer` contract: a 401 HttpStatusError refreshes the token and retries once. */
const auth = {
  withBearer: async (run: (token: string, baseUrl: string) => Promise<unknown>) => {
    try {
      return await run('tok', 'http://gw')
    } catch (error) {
      if (error instanceof HttpStatusError && error.statusCode === 401) {
        return run('fresh', 'http://gw')
      }

      throw error
    }
  }
} as unknown as AuthSession

const mediaUrl = (name: string) => `hermes-media://remote/${encodeURIComponent(`/files/${name}.mp3`)}`

const nativeError = (code: string) => Object.assign(new Error(code), { code })

const fakeBlob = (size: number, type = 'audio/mpeg') => ({ size, type }) as Blob

type Download = { directory: string; fileName: string; headers: Record<string, string>; maxBytes: number; url: string }

/** Scripts the native side: every download "writes" a file, and fetching it yields a Blob of `size` bytes. */
function gateway({ size = 11, type = 'audio/mpeg', contentType = 'audio/mpeg' as null | string } = {}) {
  plugin.download.mockImplementation(async ({ fileName }: Download) => ({
    bytes: size,
    contentDisposition: null,
    contentType,
    errorBody: null,
    path: `/cache/media/${fileName}`,
    status: 200,
    uri: `file:///cache/media/${fileName}`
  }))
  fetchFile.mockImplementation(async () => ({ blob: async () => fakeBlob(size, type) }))
}

const fetchFile = vi.fn()
const downloads = (): Download[] => plugin.download.mock.calls.map(([options]) => options as Download)

interface FakeMedia extends MediaElementLike {
  getAttribute: ReturnType<typeof vi.fn>
  removeAttribute: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
  dispatchEvent: ReturnType<typeof vi.fn>
  readyState: number
}

function fakeMedia(over: Partial<FakeMedia> = {}): FakeMedia {
  return {
    addEventListener: vi.fn(),
    currentSrc: '',
    currentTime: 0,
    dispatchEvent: vi.fn(),
    ended: false,
    getAttribute: vi.fn(() => null),
    load: vi.fn(),
    pause: vi.fn(),
    paused: true,
    play: vi.fn(async () => undefined),
    readyState: 0,
    removeAttribute: vi.fn(),
    src: '',
    ...over
  }
}

let counter = 0
let createObjectURL: ReturnType<typeof vi.spyOn>
let revokeObjectURL: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  plugin.download.mockReset()
  plugin.deleteFiles.mockReset().mockResolvedValue({ deleted: 1 })
  fetchFile.mockReset()
  vi.stubGlobal('fetch', fetchFile)
  counter = 0
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${(counter += 1)}`)
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('media download', () => {
  it('downloads natively with the bearer, the hard cap and the media cache directory', async () => {
    gateway()

    const url = await createMediaResolver(auth)(mediaUrl('a'))

    expect(url).toBe('blob:test/1')
    expect(plugin.download).toHaveBeenCalledTimes(1)

    const [call] = downloads()

    expect(call).toMatchObject({
      directory: 'media',
      headers: { Authorization: 'Bearer tok' },
      maxBytes: MAX_MEDIA_BYTES,
      url: expect.stringMatching(/^http:\/\/gw\/api\/files\/stream\?path=/)
    })
    expect(call.fileName).toMatch(/^m-[0-9a-f]+-\d+-\d+$/)
    expect(MAX_MEDIA_BYTES).toBe(64 * 1024 * 1024)
  })

  it('loads the finished file through the local file server instead of Base64', async () => {
    gateway()

    await createMediaResolver(auth)(mediaUrl('a'))

    expect(fetchFile).toHaveBeenCalledTimes(1)
    expect(fetchFile.mock.calls[0][0]).toMatch(/^http:\/\/localhost\/_capacitor_file_\/cache\/media\/m-/)
  })

  it('types an untyped blob with the gateway Content-Type, and keeps a typed one', async () => {
    gateway({ type: '' })
    await createMediaResolver(auth)(mediaUrl('untyped'))
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe('audio/mpeg')

    gateway({ type: 'audio/ogg' })
    await createMediaResolver(auth)(mediaUrl('typed'))
    expect((createObjectURL.mock.calls[1][0] as Blob).type).toBe('audio/ogg')
  })

  it('deletes the temp file once the blob exists, and also when loading it fails', async () => {
    gateway()
    await createMediaResolver(auth)(mediaUrl('a'))

    expect(plugin.deleteFiles).toHaveBeenCalledTimes(1)
    expect(plugin.deleteFiles).toHaveBeenCalledWith({ directory: 'media', names: [downloads()[0].fileName] })

    plugin.deleteFiles.mockClear()
    fetchFile.mockRejectedValue(new Error('webview gone'))

    await expect(createMediaResolver(auth)(mediaUrl('b'))).rejects.toThrow('webview gone')
    expect(plugin.deleteFiles).toHaveBeenCalledWith({ directory: 'media', names: [downloads()[1].fileName] })
  })

  it('ignores a failing temp-file delete', async () => {
    gateway()
    plugin.deleteFiles.mockRejectedValue(nativeError('network'))

    await expect(createMediaResolver(auth)(mediaUrl('a'))).resolves.toBe('blob:test/1')
  })

  it('refuses a file over the cap natively: friendly error, no blob, nothing cached', async () => {
    plugin.download.mockRejectedValue(nativeError('too_large'))
    const resolve = createMediaResolver(auth)

    await expect(resolve(mediaUrl('big'))).rejects.toThrow(/too large/)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(fetchFile).not.toHaveBeenCalled()

    // A failed attempt is not cached: the next call asks again.
    await expect(resolve(mediaUrl('big'))).rejects.toThrow(/too large/)
    expect(plugin.download).toHaveBeenCalledTimes(2)
  })

  it('lets other native failures through untouched', async () => {
    plugin.download.mockRejectedValue(nativeError('timeout'))

    await expect(createMediaResolver(auth)(mediaUrl('slow'))).rejects.toMatchObject({ code: 'timeout' })
  })

  it('surfaces a 401 so the session refreshes the token and retries once', async () => {
    plugin.download
      .mockResolvedValueOnce({ bytes: 0, contentDisposition: null, contentType: null, errorBody: 'expired', path: null, status: 401, uri: '' })
      .mockImplementationOnce(async ({ fileName }: Download) => ({
        bytes: 11,
        contentDisposition: null,
        contentType: 'audio/mpeg',
        errorBody: null,
        path: `/cache/media/${fileName}`,
        status: 200,
        uri: `file:///cache/media/${fileName}`
      }))
    fetchFile.mockResolvedValue({ blob: async () => fakeBlob(11) })

    await expect(createMediaResolver(auth)(mediaUrl('auth'))).resolves.toBe('blob:test/1')
    expect(downloads().map(d => d.headers.Authorization)).toEqual(['Bearer tok', 'Bearer fresh'])
  })

  it('reports other HTTP errors with their status', async () => {
    plugin.download.mockResolvedValue({ bytes: 0, contentDisposition: null, contentType: null, errorBody: 'nope', path: null, status: 404, uri: '' })

    const error = await createMediaResolver(auth)(mediaUrl('gone')).catch(e => e)

    expect(error).toBeInstanceOf(HttpStatusError)
    expect(error).toMatchObject({ body: 'nope', statusCode: 404 })
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('uses the blob: URL the web fallback returns as is, without fetching or deleting', async () => {
    plugin.download.mockResolvedValue({
      bytes: 11,
      contentDisposition: null,
      contentType: 'audio/mpeg',
      errorBody: null,
      path: 'blob:http://harness/abc',
      status: 200,
      uri: 'blob:http://harness/abc'
    })

    await expect(createMediaResolver(auth)(mediaUrl('web'))).resolves.toBe('blob:http://harness/abc')
    expect(fetchFile).not.toHaveBeenCalled()
    expect(plugin.deleteFiles).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('reuses a finished download', async () => {
    gateway()
    const resolve = createMediaResolver(auth)

    const [first, second] = [await resolve(mediaUrl('a')), await resolve(mediaUrl('a'))]

    expect(second).toBe(first)
    expect(plugin.download).toHaveBeenCalledTimes(1)
  })
})

describe('media blob cache', () => {
  it('evicts least-recently-used entries past the entry cap and revokes their blobs', async () => {
    gateway()
    const resolve = createMediaResolver(auth, { mediaElements: () => [] })

    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    expect(revokeObjectURL).not.toHaveBeenCalled()

    // Touch the oldest entry so the second oldest becomes the eviction victim.
    await resolve(mediaUrl('0'))
    await resolve(mediaUrl('new'))

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/2')
  })

  it('bounds the cache by bytes as well', async () => {
    // 60 MB per file (under the 64 MB per-file cap).
    gateway({ size: 60 * 1024 * 1024 })
    const resolve = createMediaResolver(auth, { mediaElements: () => [] })

    expect(MEDIA_CACHE_MAX_BYTES).toBe(128 * 1024 * 1024)
    await resolve(mediaUrl('a'))
    await resolve(mediaUrl('b'))
    expect(revokeObjectURL).not.toHaveBeenCalled()

    // A third file pushes the total past 128 MB: the oldest goes, the newest stays.
    await resolve(mediaUrl('c'))

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })

  it('never evicts a blob whose element is playing right now, and releases it once playback stops', async () => {
    gateway()
    const detach = vi.fn()
    const player = fakeMedia({ currentTime: 12, ended: false, paused: false, src: 'blob:test/1' })
    const resolve = createMediaResolver(auth, { detach, mediaElements: () => [player] })

    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    // blob:test/1 (oldest) is playing, so the next victim is blob:test/2.
    await resolve(mediaUrl('extra-1'))

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/2')
    expect(detach).not.toHaveBeenCalled()

    // Playback stops (paused): the next eviction releases it, detaching the element first.
    ;(player as { paused: boolean }).paused = true
    await resolve(mediaUrl('extra-2'))

    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:test/1')
    expect(detach).toHaveBeenCalledWith(player, mediaUrl('0'), 12)
  })

  it('still evicts the cache past its limits when everything evictable is idle, even if elements reference it', async () => {
    gateway()
    const detach = vi.fn()
    // Idle elements reference the oldest two blobs: one paused, one ended (currentSrc match).
    const paused = fakeMedia({ currentTime: 3, paused: true, src: 'blob:test/1' })
    const ended = fakeMedia({ currentSrc: 'blob:test/2', currentTime: 40, ended: true, paused: false })
    const resolve = createMediaResolver(auth, { detach, mediaElements: () => [paused, ended] })

    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    await resolve(mediaUrl('x'))
    await resolve(mediaUrl('y'))

    expect(revokeObjectURL.mock.calls.map(([url]: [string]) => url)).toEqual(['blob:test/1', 'blob:test/2'])
    expect(detach).toHaveBeenCalledTimes(2)
    expect(detach).toHaveBeenNthCalledWith(1, paused, mediaUrl('0'), 3)
    expect(detach).toHaveBeenNthCalledWith(2, ended, mediaUrl('1'), 40)
  })

  it('detaches every idle element that shares an evicted blob, and keeps the blob if one of them is playing', async () => {
    gateway()
    const detach = vi.fn()
    const idle = fakeMedia({ src: 'blob:test/1' })
    const playing = fakeMedia({ paused: false, src: 'blob:test/1' })
    const elements = [idle, playing]
    const resolve = createMediaResolver(auth, { detach, mediaElements: () => elements })

    for (let i = 0; i <= MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:test/1')
    expect(detach).not.toHaveBeenCalledWith(idle, expect.anything(), expect.anything())

    elements.pop()
    await resolve(mediaUrl('again'))

    expect(detach).toHaveBeenCalledWith(idle, mediaUrl('0'), 0)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })

  it('keeps going when detaching an element throws', async () => {
    gateway()
    const idle = fakeMedia({ src: 'blob:test/1' })
    const resolve = createMediaResolver(auth, {
      detach: () => {
        throw new Error('detached already')
      },
      mediaElements: () => [idle]
    })

    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    for (let i = 0; i <= MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })

  it('by default parks an evicted idle element natively so it can resume later', async () => {
    gateway()
    const idle = fakeMedia({ currentTime: 7, src: 'blob:test/1' })
    const resolve = createMediaResolver(auth, { mediaElements: () => [idle] })

    for (let i = 0; i <= MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    expect(idle.removeAttribute).toHaveBeenCalledWith('src')
    expect(idle.load).toHaveBeenCalledTimes(1)

    // The next `play` brings it back from a fresh download.
    const applyBlob = vi.fn()
    const resolveAgain = vi.fn(async () => 'blob:test/fresh')

    await resumeParkedMedia(idle, resolveAgain, applyBlob)

    expect(resolveAgain).toHaveBeenCalledWith(mediaUrl('0'))
    expect(applyBlob).toHaveBeenCalledWith(idle, 'blob:test/fresh')
  })
})

describe('resuming a parked element on play', () => {
  /** Parks `element` through a real eviction and returns the URL it was parked on. */
  async function park(element: FakeMedia): Promise<string> {
    gateway()
    const resolve = createMediaResolver(auth, { mediaElements: () => [element] })

    element.src = 'blob:test/1'

    for (let i = 0; i <= MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    return mediaUrl('0')
  }

  it('ignores elements that were never parked', async () => {
    const resolve = vi.fn()
    const element = fakeMedia()

    await resumeParkedMedia(element, resolve, vi.fn())
    await resumeParkedMedia(null, resolve, vi.fn())
    await resumeParkedMedia({}, resolve, vi.fn())

    expect(resolve).not.toHaveBeenCalled()
    expect(element.pause).not.toHaveBeenCalled()
  })

  it('pauses, resolves the media again, restores the position after loadedmetadata, then plays', async () => {
    const element = fakeMedia({ currentTime: 42 })
    const url = await park(element)
    const order: string[] = []
    const resolve = vi.fn(async () => 'blob:test/fresh')

    element.pause.mockImplementation(() => order.push('pause'))
    element.play.mockImplementation(async () => void order.push('play'))

    const applyBlob = vi.fn(() => order.push('apply'))

    await resumeParkedMedia(element, resolve, applyBlob)

    expect(resolve).toHaveBeenCalledWith(url)
    expect(order).toEqual(['pause', 'apply', 'play'])

    // Metadata is not there yet (the element just got a new source): the seek waits for it.
    expect(element.currentTime).toBe(42)
    const [event, seek, options] = element.addEventListener.mock.calls[0]

    expect(event).toBe('loadedmetadata')
    expect(options).toEqual({ once: true })

    element.currentTime = 0
    seek()
    expect(element.currentTime).toBe(42)
  })

  it('seeks immediately when metadata is already there', async () => {
    const element = fakeMedia({ currentTime: 9 })
    await park(element)

    element.currentTime = 0
    element.readyState = 1

    await resumeParkedMedia(element, async () => 'blob:test/fresh', vi.fn())

    expect(element.currentTime).toBe(9)
    expect(element.addEventListener).not.toHaveBeenCalled()
    expect(element.play).toHaveBeenCalledTimes(1)
  })

  it('resumes only once per eviction', async () => {
    const element = fakeMedia()
    await park(element)
    const resolve = vi.fn(async () => 'blob:test/fresh')

    await Promise.all([resumeParkedMedia(element, resolve, vi.fn()), resumeParkedMedia(element, resolve, vi.fn())])

    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejected play()', async () => {
    const element = fakeMedia()
    await park(element)
    element.play.mockRejectedValue(new Error('NotAllowedError'))

    await expect(resumeParkedMedia(element, async () => 'blob:test/fresh', vi.fn())).resolves.toBeUndefined()
    expect(element.dispatchEvent).not.toHaveBeenCalled()
  })

  it('reports a failed reload as an error event instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const element = fakeMedia()
    await park(element)
    const applyBlob = vi.fn()

    await resumeParkedMedia(element, async () => Promise.reject(new Error('offline')), applyBlob)

    expect(applyBlob).not.toHaveBeenCalled()
    expect(element.dispatchEvent).toHaveBeenCalledTimes(1)
    expect(element.play).not.toHaveBeenCalled()
  })

  it('leaves an element alone that got a new source after the eviction', async () => {
    const element = fakeMedia()
    await park(element)
    element.getAttribute.mockReturnValue('blob:something-else')
    const resolve = vi.fn()

    await resumeParkedMedia(element, resolve, vi.fn())

    expect(resolve).not.toHaveBeenCalled()
    expect(element.pause).not.toHaveBeenCalled()
  })
})
