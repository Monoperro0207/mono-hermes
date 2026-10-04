import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())

vi.mock('@capacitor/core', () => ({ CapacitorHttp: { get } }))

import { fetchLinkTitle } from '../src/bridge/platform'

type Reply = { data?: string; headers?: Record<string, string>; status?: number }

const html = (title: string): Reply => ({
  data: `<html><head><title> ${title} </title></head></html>`,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  status: 200
})

const redirect = (location: string, status = 302): Reply => ({ headers: { Location: location }, status })

/** Answers requests from a URL -> reply table; anything else is a test failure. */
function serve(table: Record<string, Reply>) {
  get.mockImplementation(async ({ url }: { url: string }) => {
    const reply = table[url]

    if (!reply) {
      throw new Error(`unexpected request to ${url}`)
    }

    return { data: '', headers: {}, status: 200, url, ...reply }
  })
}

const requested = () => get.mock.calls.map(([options]) => options.url as string)

beforeEach(() => {
  get.mockReset()
})

describe('fetchLinkTitle', () => {
  it('reads the title of a public page', async () => {
    serve({ 'https://example.com/a': html('Hello   world') })

    expect(await fetchLinkTitle('https://example.com/a')).toBe('Hello world')
  })

  it('refuses non-web schemes, private hosts and IPv6 literals without sending a request', async () => {
    const refused = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/x',
      'not a url',
      'http://127.0.0.1:9119/',
      'http://localhost/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://192.168.1.1/',
      'http://10.0.2.2:9119/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.1.1/',
      'http://printer.local/',
      'http://nas/',
      'http://my-pc.tail1234.ts.net/',
      'http://[::1]/',
      'http://[2001:db8::1]/',
      'https://user:secret@example.com/'
    ]

    for (const url of refused) {
      expect(await fetchLinkTitle(url), url).toBe('')
    }

    expect(get).not.toHaveBeenCalled()
  })

  it('bounds the download: Range header, no automatic redirects, text only', async () => {
    serve({ 'https://example.com/': html('T') })

    await fetchLinkTitle('https://example.com/')

    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toMatchObject({
      disableRedirects: true,
      headers: { Accept: 'text/html', Range: 'bytes=0-65535' },
      responseType: 'text'
    })
  })

  it('ignores responses that are not text/html or are errors', async () => {
    serve({
      'https://example.com/bin': { data: '<title>x</title>', headers: { 'content-type': 'application/octet-stream' } },
      'https://example.com/none': { data: '<title>x</title>', headers: {} },
      'https://example.com/gone': { ...html('Gone'), status: 404 }
    })

    expect(await fetchLinkTitle('https://example.com/bin')).toBe('')
    expect(await fetchLinkTitle('https://example.com/none')).toBe('')
    expect(await fetchLinkTitle('https://example.com/gone')).toBe('')
  })

  it('follows public -> public redirects, resolving relative Locations', async () => {
    serve({
      'https://a.example.com/start': redirect('/next'),
      'https://a.example.com/next': redirect('https://b.example.org/final', 301),
      'https://b.example.org/final': html('Final')
    })

    expect(await fetchLinkTitle('https://a.example.com/start')).toBe('Final')
    expect(requested()).toEqual(['https://a.example.com/start', 'https://a.example.com/next', 'https://b.example.org/final'])
  })

  it('aborts on the first redirect into a private network', async () => {
    for (const target of ['http://192.168.1.1/admin', 'http://127.0.0.1:9119/api/status', 'http://[::1]/', 'file:///etc/passwd', 'http://nas/']) {
      get.mockReset()
      serve({ 'https://example.com/r': redirect(target), [target]: html('SECRET') })

      expect(await fetchLinkTitle('https://example.com/r'), target).toBe('')
      expect(requested(), target).toEqual(['https://example.com/r'])
    }
  })

  it('aborts when a later hop turns private', async () => {
    serve({
      'https://example.com/1': redirect('https://example.org/2'),
      'https://example.org/2': redirect('http://10.0.0.5/3'),
      'http://10.0.0.5/3': html('SECRET')
    })

    expect(await fetchLinkTitle('https://example.com/1')).toBe('')
    expect(requested()).toEqual(['https://example.com/1', 'https://example.org/2'])
  })

  it('gives up after three redirects and on a redirect without Location', async () => {
    serve({
      'https://example.com/0': redirect('/1'),
      'https://example.com/1': redirect('/2'),
      'https://example.com/2': redirect('/3'),
      'https://example.com/3': redirect('/4'),
      'https://example.com/4': html('Too far'),
      'https://example.com/loc': { status: 302 }
    })

    expect(await fetchLinkTitle('https://example.com/0')).toBe('')
    expect(requested()).toHaveLength(4)
    expect(await fetchLinkTitle('https://example.com/loc')).toBe('')
  })

  it('returns an empty title when the request fails', async () => {
    get.mockRejectedValue(new Error('timeout'))

    expect(await fetchLinkTitle('https://example.com/')).toBe('')
  })
})
