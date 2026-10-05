import { beforeEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => ({ deleteFiles: vi.fn(), download: vi.fn(), fetchPublicText: vi.fn() }))

vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: (uri: string) => uri }, registerPlugin: () => plugin }))

import { fetchLinkTitle } from '../src/bridge/platform'

const page = (text: string) => ({ contentType: 'text/html', status: 200, text, truncated: false, url: 'https://example.com/' })
const html = (title: string) => page(`<html><head><title> ${title} </title></head></html>`)

/** Rejects the way Capacitor does: a plain Error carrying `code`. */
const nativeError = (code: string) => Object.assign(new Error(code), { code })

beforeEach(() => {
  plugin.fetchPublicText.mockReset()
})

describe('fetchLinkTitle', () => {
  it('reads the title of a public page', async () => {
    plugin.fetchPublicText.mockResolvedValue(html('Hello   world'))

    expect(await fetchLinkTitle('https://example.com/a')).toBe('Hello world')
  })

  it('refuses non-web schemes, private hosts and IPv6 literals without calling native', async () => {
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
      'http://100.64.0.1/',
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

    expect(plugin.fetchPublicText).not.toHaveBeenCalled()
  })

  it('bounds the download natively: 64 KB, three redirects, html only', async () => {
    plugin.fetchPublicText.mockResolvedValue(html('T'))

    await fetchLinkTitle('https://example.com/')

    expect(plugin.fetchPublicText).toHaveBeenCalledTimes(1)
    expect(plugin.fetchPublicText).toHaveBeenCalledWith({
      accept: 'text/html',
      maxBytes: 65536,
      maxRedirects: 3,
      url: 'https://example.com/'
    })
  })

  it('trims and collapses whitespace, matches the tag case-insensitively and with attributes', async () => {
    plugin.fetchPublicText.mockResolvedValue(page('<HTML><TITLE lang="en">\n  A &amp; \n\t B  </TITLE>'))

    // Entities are left as the page wrote them, like before the native fetch.
    expect(await fetchLinkTitle('https://example.com/')).toBe('A &amp; B')
  })

  it('returns an empty title for an empty body, a missing tag or an empty tag', async () => {
    plugin.fetchPublicText.mockResolvedValueOnce(page(''))
    expect(await fetchLinkTitle('https://example.com/empty')).toBe('')

    plugin.fetchPublicText.mockResolvedValueOnce(page('<html><body>no title</body></html>'))
    expect(await fetchLinkTitle('https://example.com/none')).toBe('')

    plugin.fetchPublicText.mockResolvedValueOnce(page('<title>   </title>'))
    expect(await fetchLinkTitle('https://example.com/blank')).toBe('')
  })

  it('returns an empty title when native refuses the host (DNS answer not public, redirect into a LAN)', async () => {
    plugin.fetchPublicText.mockRejectedValue(nativeError('blocked_host'))

    expect(await fetchLinkTitle('https://rebind.example.com/')).toBe('')
    expect(plugin.fetchPublicText).toHaveBeenCalledTimes(1)
  })

  it.each(['timeout', 'network', 'invalid_request'])('returns an empty title on a native %s error', async code => {
    plugin.fetchPublicText.mockRejectedValue(nativeError(code))

    expect(await fetchLinkTitle('https://example.com/')).toBe('')
  })
})
