import { describe, expect, it } from 'vitest'

import { isWebviewTag, patchCreateElement, shouldShimWebview } from '../src/guest-browser/create-element'

describe('createElement interception', () => {
  it('recognises the webview tag in any case', () => {
    expect(isWebviewTag('webview')).toBe(true)
    expect(isWebviewTag('WebView')).toBe(true)
    expect(isWebviewTag('iframe')).toBe(false)
    expect(isWebviewTag(undefined)).toBe(false)
  })

  it('shims only on the device with the plugin present', () => {
    expect(shouldShimWebview(true, true)).toBe(true)
    expect(shouldShimWebview(true, false)).toBe(false)
    expect(shouldShimWebview(false, true)).toBe(false)
    expect(shouldShimWebview(false, false)).toBe(false)
  })

  it('returns the shim for webview and the original element for everything else', () => {
    const calls: string[] = []

    const host = {
      createElement(name: string) {
        calls.push(name)

        return { tag: name }
      }
    }

    const shim = { shim: true }
    const restore = patchCreateElement(host, () => shim)

    expect(host.createElement('webview')).toBe(shim)
    expect(host.createElement('WEBVIEW')).toBe(shim)
    expect(host.createElement('div')).toEqual({ tag: 'div' })
    expect(calls).toEqual(['div'])

    restore()

    expect(host.createElement('webview')).toEqual({ tag: 'webview' })
  })

  it('keeps `this` for the original implementation', () => {
    const host = {
      createElement(this: { owner: string }, name: string) {
        return `${this.owner}:${name}`
      },
      owner: 'doc'
    }

    patchCreateElement(host, () => 'shim')

    expect(host.createElement('p')).toBe('doc:p')
  })
})
