import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { request } }))

import type { AuthSession } from '../src/bridge/auth'
import { HttpStatusError } from '../src/bridge/http'
import {
  createMediaResolver,
  MAX_MEDIA_BYTES,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_MAX_ENTRIES
} from '../src/bridge/media'

const auth = { withBearer: (run: (token: string, baseUrl: string) => Promise<unknown>) => run('tok', 'http://gw') } as unknown as AuthSession

const mediaUrl = (name: string) => `hermes-media://remote/${encodeURIComponent(`/files/${name}.mp3`)}`
const SMALL = btoa('hello audio')

interface Wire {
  head?: { headers?: Record<string, string>; status?: number } | Error
  data?: string
}

/** Scripts the gateway: one HEAD answer and one GET body for every path. */
function gateway({ data = SMALL, head = { headers: { 'Content-Length': '11' } } }: Wire = {}) {
  request.mockImplementation(async (options: { method: string; url: string }) => {
    if (options.method === 'HEAD') {
      if (head instanceof Error) {
        throw head
      }

      return { data: '', headers: {}, status: 200, url: options.url, ...head }
    }

    return { data, headers: { 'Content-Type': 'audio/mpeg' }, status: 200, url: options.url }
  })
}

const methods = () => request.mock.calls.map(([options]) => options.method as string)

let counter = 0
let createObjectURL: ReturnType<typeof vi.spyOn>
let revokeObjectURL: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  request.mockReset()
  counter = 0
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${(counter += 1)}`)
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('media pre-flight', () => {
  it('sends the bearer on a HEAD before the GET', async () => {
    gateway()

    const url = await createMediaResolver(auth)(mediaUrl('a'))

    expect(url).toBe('blob:test/1')
    expect(methods()).toEqual(['HEAD', 'GET'])
    expect(request.mock.calls[0][0]).toMatchObject({
      headers: { Authorization: 'Bearer tok' },
      url: expect.stringMatching(/^http:\/\/gw\/api\/files\/stream\?path=/)
    })
  })

  it('refuses a file whose Content-Length is over the cap without issuing the GET', async () => {
    gateway({ head: { headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) } } })
    const resolve = createMediaResolver(auth)

    await expect(resolve(mediaUrl('big'))).rejects.toThrow(/too large/)
    expect(methods()).toEqual(['HEAD'])
    expect(createObjectURL).not.toHaveBeenCalled()

    // A failed attempt is not cached: the next call asks again.
    await expect(resolve(mediaUrl('big'))).rejects.toThrow(/too large/)
    expect(methods()).toEqual(['HEAD', 'HEAD'])
  })

  it('accepts a file exactly at the cap', async () => {
    gateway({ head: { headers: { 'Content-Length': String(MAX_MEDIA_BYTES) } } })

    await expect(createMediaResolver(auth)(mediaUrl('edge'))).resolves.toBe('blob:test/1')
    expect(methods()).toEqual(['HEAD', 'GET'])
  })

  it('falls back to the GET when HEAD has no length, fails, or is rejected', async () => {
    const heads: Wire['head'][] = [{ headers: {} }, new Error('network'), { status: 405 }, { headers: { 'Content-Length': 'abc' } }]

    for (const head of heads) {
      request.mockReset()
      gateway({ head })

      await expect(createMediaResolver(auth)(mediaUrl('x')), JSON.stringify(head)).resolves.toMatch(/^blob:/)
      expect(methods()).toEqual(['HEAD', 'GET'])
    }
  })

  it('keeps the post-download size check as a backstop', async () => {
    gateway({ data: 'A'.repeat(Math.ceil(((MAX_MEDIA_BYTES + 3) * 4) / 3)), head: { headers: {} } })

    await expect(createMediaResolver(auth)(mediaUrl('liar'))).rejects.toThrow(/too large/)
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('surfaces a 401 on HEAD so the session can refresh and retry', async () => {
    gateway({ head: { status: 401 } })

    await expect(createMediaResolver(auth)(mediaUrl('auth'))).rejects.toBeInstanceOf(HttpStatusError)
    expect(methods()).toEqual(['HEAD'])
  })

  it('reuses a finished download', async () => {
    gateway()
    const resolve = createMediaResolver(auth)

    const [first, second] = [await resolve(mediaUrl('a')), await resolve(mediaUrl('a'))]

    expect(second).toBe(first)
    expect(methods()).toEqual(['HEAD', 'GET'])
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

  it('never revokes a blob that an audio/video element still uses, and retries on the next eviction', async () => {
    gateway()
    const playing: { currentSrc: string; src: string }[] = []
    const resolve = createMediaResolver(auth, { mediaElements: () => playing })

    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    // blob:test/1 (oldest) is playing; blob:test/2 is merely loaded.
    playing.push({ currentSrc: '', src: 'blob:test/1' })
    await resolve(mediaUrl('extra-1'))

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/2')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:test/1')

    // Playback stops: the next eviction can finally release the oldest blob.
    playing.length = 0
    await resolve(mediaUrl('extra-2'))

    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:test/1')
  })

  it('also matches an element by currentSrc', async () => {
    gateway()
    const resolve = createMediaResolver(auth, { mediaElements: () => [{ currentSrc: 'blob:test/1', src: '' }] })

    for (let i = 0; i <= MEDIA_CACHE_MAX_ENTRIES; i += 1) {
      await resolve(mediaUrl(String(i)))
    }

    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test/2')
  })

  it('bounds the cache by decoded bytes as well', async () => {
    // ~60 MB decoded per file (under the 64 MB per-file cap).
    gateway({ data: 'A'.repeat(80 * 1024 * 1024), head: { headers: {} } })
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
})
