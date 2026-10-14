import { describe, expect, it } from 'vitest'

import { checkGuestUrl, REASON_CREDENTIALS, REASON_PLAIN_HTTP, REASON_SCHEME } from '../src/guest-browser/policy'

describe('guest URL policy', () => {
  it.each([
    'https://example.com/a?b=1#c',
    'HTTPS://Example.com',
    'https://[2606:4700::1111]/',
    'http://localhost:3000/',
    'http://dev.localhost/',
    'http://127.0.0.1:8080',
    'http://[::1]:5173/',
    'http://100.64.0.1/',
    'http://my-pc.tail1234.ts.net:9119/',
    'http://my-pc/',
    'http://192.168.1.20/x',
    'http://10.0.0.5',
    'http://172.16.0.1',
    'http://printer.local/',
    'about:blank'
  ])('allows %s', url => {
    expect(checkGuestUrl(url)).toEqual({ ok: true, url })
  })

  it.each([
    'http://example.com/',
    'http://8.8.8.8/',
    'http://100.128.0.1/',
    'http://172.32.0.1/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/'
  ])('refuses plain http to public host %s', url => {
    expect(checkGuestUrl(url)).toEqual({ ok: false, reason: REASON_PLAIN_HTTP })
  })

  it('normalises numeric IPv4 forms before classifying', () => {
    // 134744072 is 8.8.8.8, 2130706433 is 127.0.0.1.
    expect(checkGuestUrl('http://134744072/').ok).toBe(false)
    expect(checkGuestUrl('http://2130706433/').ok).toBe(true)
    expect(checkGuestUrl('http://0x7f.1/').ok).toBe(true)
  })

  it.each([
    'file:///etc/passwd',
    'content://media/external/images',
    'intent://scan/#Intent;scheme=zxing;end',
    'market://details?id=x',
    'javascript:alert(1)',
    'data:text/html,hi',
    'blob:https://example.com/uuid',
    'ftp://example.com/',
    'chrome://version',
    'view-source:https://example.com',
    'about:srcdoc',
    'ws://localhost:1/'
  ])('refuses %s', url => {
    expect(checkGuestUrl(url).ok).toBe(false)
  })

  it('names the scheme problem', () => {
    expect(checkGuestUrl('ftp://example.com/')).toEqual({ ok: false, reason: REASON_SCHEME })
  })

  it('refuses credentials, blanks and control characters', () => {
    expect(checkGuestUrl('https://user:pw@example.com/')).toEqual({ ok: false, reason: REASON_CREDENTIALS })
    expect(checkGuestUrl('http://localhost@example.com/').ok).toBe(false)
    expect(checkGuestUrl('').ok).toBe(false)
    expect(checkGuestUrl('   ').ok).toBe(false)
    expect(checkGuestUrl('https://exa\tmple.com/').ok).toBe(false)
    expect(checkGuestUrl('not a url').ok).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    expect(checkGuestUrl('  https://example.com/  ')).toEqual({ ok: true, url: 'https://example.com/' })
  })
})
