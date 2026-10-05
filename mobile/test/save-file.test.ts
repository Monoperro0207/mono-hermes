import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({ deleteFiles: vi.fn(), download: vi.fn(), fetchPublicText: vi.fn() }))
const share = vi.hoisted(() => vi.fn())
const rename = vi.hoisted(() => vi.fn())
const writeFile = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: (uri: string) => uri }, registerPlugin: () => plugin }))
vi.mock('@capacitor/share', () => ({ Share: { share } }))
vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: { rename, writeFile } }))

import type { AuthSession } from '../src/bridge/auth'
import { HttpStatusError } from '../src/bridge/http'
import { createGatewayFileSaver, MAX_SAVE_BYTES, saveImageFromUrl } from '../src/bridge/platform'

/** The real `withBearer` contract: a 401 HttpStatusError refreshes the token and retries once. */
const auth = {
  requireBaseUrl: async () => 'http://gw:9119',
  withBearer: async (run: (token: string, baseUrl: string) => Promise<unknown>) => {
    try {
      return await run('tok', 'http://gw:9119')
    } catch (error) {
      if (error instanceof HttpStatusError && error.statusCode === 401) {
        return run('fresh', 'http://gw:9119')
      }

      throw error
    }
  }
} as unknown as AuthSession

const nativeError = (code: string) => Object.assign(new Error(code), { code })

type Download = { directory: string; fileName: string; headers?: Record<string, string>; maxBytes: number; publicOnly?: boolean; url: string }

const finished = (fileName: string, over: Record<string, unknown> = {}) => ({
  bytes: 5,
  contentDisposition: null,
  contentType: null,
  errorBody: null,
  path: `/cache/downloads/${fileName}`,
  status: 200,
  uri: `file:///cache/downloads/${fileName}`,
  ...over
})

const download = (over: Record<string, unknown> = {}) =>
  plugin.download.mockImplementation(async ({ fileName }: Download) => finished(fileName, over))

const lastDownload = (): Download => plugin.download.mock.calls.at(-1)![0]

beforeEach(() => {
  plugin.download.mockReset()
  plugin.deleteFiles.mockReset().mockResolvedValue({ deleted: 0 })
  share.mockReset().mockResolvedValue({ activityType: 'x' })
  rename.mockReset().mockResolvedValue(undefined)
  writeFile.mockReset().mockResolvedValue({ uri: 'file:///cache/downloads/written' })
})

describe('saveGatewayFile', () => {
  const save = createGatewayFileSaver({ auth, transport: {} as never })

  it('downloads natively with the 1 GB cap into the downloads folder, then shares the file', async () => {
    download()

    const result = await save({ path: '/home/me/report.pdf', suggestedName: 'report.pdf' })

    expect(MAX_SAVE_BYTES).toBe(1024 * 1024 * 1024)
    expect(plugin.download).toHaveBeenCalledTimes(1)
    expect(lastDownload()).toEqual({
      directory: 'downloads',
      fileName: 'report.pdf',
      headers: { Authorization: 'Bearer tok' },
      maxBytes: MAX_SAVE_BYTES,
      url: 'http://gw:9119/api/fs/download?path=%2Fhome%2Fme%2Freport.pdf'
    })
    expect(share).toHaveBeenCalledWith({ dialogTitle: 'Save or share', title: 'report.pdf', url: 'file:///cache/downloads/report.pdf' })
    expect(result).toEqual({ path: 'file:///cache/downloads/report.pdf', saved: true })
    // No Base64 detour for a streamed file.
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('cleans up earlier share copies before downloading', async () => {
    const order: string[] = []

    plugin.deleteFiles.mockImplementation(async () => void order.push('sweep'))
    plugin.download.mockImplementation(async ({ fileName }: Download) => (order.push('download'), finished(fileName)))

    await save({ path: '/a/b.txt' })

    expect(plugin.deleteFiles).toHaveBeenCalledWith({ directory: 'downloads', olderThanMs: 60 * 60 * 1000 })
    expect(order).toEqual(['sweep', 'download'])
  })

  it('still saves when the cleanup fails', async () => {
    plugin.deleteFiles.mockRejectedValue(nativeError('network'))
    download()

    await expect(save({ path: '/a/b.txt' })).resolves.toMatchObject({ saved: true })
  })

  it('scopes the request to the profile and session like before', async () => {
    download()

    await save({ path: '/a/b.txt', profile: 'work', sessionId: 's 1' })

    expect(lastDownload().url).toBe('http://gw:9119/api/fs/download?path=%2Fa%2Fb.txt&session_id=s+1&profile=work')
  })

  it('returns canceled when the share sheet is dismissed', async () => {
    download()
    share.mockRejectedValue(new Error('Share canceled'))

    await expect(save({ path: '/a/b.txt' })).resolves.toEqual({ canceled: true, saved: false })
  })

  it('rethrows other share failures', async () => {
    download()
    share.mockRejectedValue(new Error('no activity'))

    await expect(save({ path: '/a/b.txt' })).rejects.toThrow('no activity')
  })

  it('words a size-cap refusal for the user and shares nothing', async () => {
    plugin.download.mockRejectedValue(nativeError('too_large'))

    await expect(save({ path: '/a/huge.bin' })).rejects.toThrow('This file is too large to save on the phone (over 1 GB).')
    expect(share).not.toHaveBeenCalled()
  })

  it('words a full disk for the user', async () => {
    plugin.download.mockRejectedValue(nativeError('insufficient_space'))

    await expect(save({ path: '/a/huge.bin' })).rejects.toThrow('Not enough free space on the phone to save this file.')
  })

  it('refreshes the token on a 401 and retries', async () => {
    plugin.download
      .mockResolvedValueOnce({ ...finished('x'), errorBody: 'expired', path: null, status: 401, uri: '' })
      .mockImplementationOnce(async ({ fileName }: Download) => finished(fileName))

    await expect(save({ path: '/a/b.txt' })).resolves.toMatchObject({ saved: true })
    expect(plugin.download.mock.calls.map(([o]) => (o as Download).headers!.Authorization)).toEqual(['Bearer tok', 'Bearer fresh'])
  })

  it('surfaces a persistent HTTP error as HttpStatusError', async () => {
    plugin.download.mockResolvedValue({ ...finished('x'), errorBody: 'missing', path: null, status: 404, uri: '' })

    const error = await save({ path: '/a/b.txt' }).catch(e => e)

    expect(error).toBeInstanceOf(HttpStatusError)
    expect(error).toMatchObject({ body: 'missing', statusCode: 404 })
  })

  it('rejects a missing path without touching the network', async () => {
    await expect(save({ path: '  ' })).rejects.toThrow('Missing gateway file path')
    expect(plugin.download).not.toHaveBeenCalled()
  })

  it('sanitizes the file name: no path separators or control characters, bounded length', async () => {
    download()

    const cases: [string, (name: string) => void][] = [
      ['../../etc/passwd', name => expect(name).toBe('_.._etc_passwd')],
      ['a\\b\\c.txt', name => expect(name).toBe('a_b_c.txt')],
      ['bad\u0000na\nme.txt', name => expect(name).toBe('bad_na_me.txt')],
      ['..', name => expect(name).toBe('download')],
      ['.hidden', name => expect(name).toBe('hidden')],
      [`${'x'.repeat(300)}.pdf`, name => {
        expect(name).toHaveLength(120)
        expect(name.endsWith('.pdf')).toBe(true)
      }]
    ]

    for (const [suggestedName, check] of cases) {
      await save({ path: '/p/q.bin', suggestedName })

      const { fileName } = lastDownload()

      expect(fileName, suggestedName).not.toMatch(/[\\/\u0000-\u001f]/)
      expect(fileName).not.toMatch(/^\.+$/)
      check(fileName)
    }
  })

  it('takes the name from the path when no name is suggested', async () => {
    download()

    await save({ path: 'C:\\Users\\me\\notes.md' })

    expect(lastDownload().fileName).toBe('notes.md')
  })

  it('adds the extension the server reports when the name has none, by renaming the finished file', async () => {
    download({ contentDisposition: 'attachment; filename="export.csv"' })

    const result = await save({ path: '/a/export' })

    expect(rename).toHaveBeenCalledWith({ directory: 'CACHE', from: 'downloads/export', to: 'downloads/export.csv' })
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: 'export.csv', url: 'file:///cache/downloads/export.csv' }))
    expect(result.path).toBe('file:///cache/downloads/export.csv')
  })

  it('falls back to the Content-Type for the extension and keeps the original name if the rename fails', async () => {
    download({ contentType: 'application/pdf' })
    rename.mockRejectedValue(new Error('exists'))

    const result = await save({ path: '/a/invoice' })

    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ to: 'downloads/invoice.pdf' }))
    expect(result).toEqual({ path: 'file:///cache/downloads/invoice', saved: true })
  })

  it('does not rename a file that already has an extension', async () => {
    download({ contentDisposition: 'attachment; filename="other.zip"' })

    await save({ path: '/a/data.json' })

    expect(rename).not.toHaveBeenCalled()
  })
})

describe('saveImageFromUrl', () => {
  it('shares a data: image from memory', async () => {
    const saved = await saveImageFromUrl('data:image/png;base64,AAAA', auth)

    expect(saved).toBe(true)
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ data: 'AAAA', directory: 'CACHE', path: expect.stringMatching(/^downloads\/\d+-image\.png$/) }))
    expect(plugin.download).not.toHaveBeenCalled()
  })

  it('refuses a malformed data: URL', async () => {
    expect(await saveImageFromUrl('data:nonsense', auth)).toBe(false)
  })

  it('downloads an image of the connected gateway with the bearer and a 32 MB cap', async () => {
    download({ contentType: 'image/jpeg' })

    const saved = await saveImageFromUrl('http://gw:9119/api/files/stream?path=%2Fimg.jpg', auth)

    expect(saved).toBe(true)
    expect(lastDownload()).toMatchObject({
      directory: 'downloads',
      headers: { Authorization: 'Bearer tok' },
      maxBytes: 32 * 1024 * 1024,
      url: 'http://gw:9119/api/files/stream?path=%2Fimg.jpg'
    })
    expect(lastDownload().publicOnly).toBeUndefined()
    // The extension comes from the response since the URL has none to offer.
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ to: expect.stringMatching(/\.jpg$/) }))
    expect(share).toHaveBeenCalledTimes(1)
  })

  it('downloads any other host public-only and never sends the bearer', async () => {
    download({ contentType: 'image/png' })

    await saveImageFromUrl('https://cdn.example.com/cat.png', auth)

    expect(lastDownload()).toMatchObject({
      directory: 'downloads',
      maxBytes: 32 * 1024 * 1024,
      publicOnly: true,
      url: 'https://cdn.example.com/cat.png'
    })
    expect(lastDownload().headers).toBeUndefined()
  })

  it('treats a same-host URL on another port as a foreign host', async () => {
    download()

    await saveImageFromUrl('http://gw:8080/x.png', auth)

    expect(lastDownload().publicOnly).toBe(true)
  })

  it('works without a configured gateway', async () => {
    download()
    const signedOut = { ...auth, requireBaseUrl: async () => Promise.reject(new Error('no server')) } as unknown as AuthSession

    await expect(saveImageFromUrl('https://cdn.example.com/cat.png', signedOut)).resolves.toBe(true)
    expect(lastDownload().publicOnly).toBe(true)
  })

  it('throws a readable error for an oversized image, a blocked host and a server error', async () => {
    plugin.download.mockRejectedValueOnce(nativeError('too_large'))
    await expect(saveImageFromUrl('https://cdn.example.com/big.png', auth)).rejects.toThrow('This image is too large to save on the phone (over 32 MB).')

    plugin.download.mockRejectedValueOnce(nativeError('blocked_host'))
    await expect(saveImageFromUrl('https://rebind.example.com/a.png', auth)).rejects.toThrow(/public web or from your Hermes server/)

    plugin.download.mockResolvedValueOnce({ ...finished('x'), path: null, status: 500, uri: '' })
    await expect(saveImageFromUrl('https://cdn.example.com/a.png', auth)).rejects.toThrow('answered 500')

    expect(share).not.toHaveBeenCalled()
  })

  it('refuses URLs that are neither data, blob nor http(s)', async () => {
    await expect(saveImageFromUrl('file:///sdcard/a.png', auth)).rejects.toThrow(/file:/)
    await expect(saveImageFromUrl('not a url', auth)).rejects.toThrow(/not a valid URL/)
    expect(plugin.download).not.toHaveBeenCalled()
  })

  it('returns false when the share sheet is canceled', async () => {
    download({ contentType: 'image/png' })
    share.mockRejectedValue(new Error('canceled'))

    expect(await saveImageFromUrl('https://cdn.example.com/cat.png', auth)).toBe(false)
  })
})
