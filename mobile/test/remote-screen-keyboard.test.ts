// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  diffInput,
  installRemoteScreenKeyboard,
  isDirectKey,
  keyForChar,
  SENTINEL,
  sendKey
} from '../src/remote-screen-keyboard'

describe('diffInput', () => {
  it('reports typed text', () => {
    expect(diffInput(SENTINEL, `${SENTINEL}hi`)).toEqual({ backspaces: 0, text: 'hi' })
  })

  it('reports deletions as backspaces', () => {
    expect(diffInput(`${SENTINEL}hi`, SENTINEL)).toEqual({ backspaces: 2, text: '' })
    expect(diffInput(SENTINEL, '')).toEqual({ backspaces: 1, text: '' })
  })

  it('turns an autocorrect replacement into backspaces then the new word', () => {
    expect(diffInput(`${SENTINEL}teh`, `${SENTINEL}the `)).toEqual({ backspaces: 2, text: 'he ' })
  })
})

describe('keyForChar / isDirectKey', () => {
  it('maps newline and tab to their keys', () => {
    expect(keyForChar('\n')).toBe('Enter')
    expect(keyForChar('\t')).toBe('Tab')
    expect(keyForChar('a')).toBe('a')
  })

  const key = { altKey: false, ctrlKey: false, key: 'a', keyCode: 65, metaKey: false }

  it('forwards navigation keys and modifier combos directly', () => {
    expect(isDirectKey({ ...key, key: 'ArrowLeft', keyCode: 37 })).toBe(true)
    expect(isDirectKey({ ...key, ctrlKey: true })).toBe(true)
  })

  it('leaves text, Enter, Backspace and IME keys to the value diff', () => {
    expect(isDirectKey(key)).toBe(false)
    expect(isDirectKey({ ...key, key: 'Backspace', keyCode: 8 })).toBe(false)
    expect(isDirectKey({ ...key, key: 'Enter', keyCode: 13 })).toBe(false)
    expect(isDirectKey({ ...key, key: 'Unidentified', keyCode: 229 })).toBe(false)
  })
})

function recordKeys(canvas: HTMLElement): string[] {
  const seen: string[] = []
  const record = (event: KeyboardEvent) => seen.push(`${event.type}:${event.key}${event.code ? `/${event.code}` : ''}`)
  canvas.addEventListener('keydown', record)
  canvas.addEventListener('keyup', record)

  return seen
}

describe('sendKey', () => {
  it('sends a code-less keydown (noVNC virtual-keyboard path)', () => {
    const canvas = document.createElement('canvas')
    const seen = recordKeys(canvas)
    sendKey(canvas, 'x')

    expect(seen).toEqual(['keydown:x'])
  })

  it('wraps the key in a tracked Control press for Ctrl', () => {
    const canvas = document.createElement('canvas')
    const seen = recordKeys(canvas)
    sendKey(canvas, 'c', true)

    expect(seen).toEqual(['keydown:Control/ControlLeft', 'keydown:c', 'keyup:Control/ControlLeft'])
  })
})

describe('installRemoteScreenKeyboard', () => {
  let uninstall: () => void
  let canvas: HTMLCanvasElement
  let seen: string[]

  const mountScreen = (inControl: boolean) => {
    document.body.innerHTML = `<div class="relative ${inControl ? 'ring-2 ring-red-500/70' : ''}"><div data-remote-screen=""><canvas></canvas></div></div>`
    const host = document.querySelector<HTMLElement>('[data-remote-screen]')!
    host.getBoundingClientRect = () => new DOMRect(0, 100, 400, 300)
    canvas = host.querySelector('canvas')!
    seen = recordKeys(canvas)
  }

  const textarea = () => document.querySelector<HTMLTextAreaElement>('[data-remote-screen-keyboard] textarea')!
  const button = () => document.querySelector<HTMLButtonElement>('[data-remote-screen-keyboard] > button')!

  const type = (value: string) => {
    textarea().value = value
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  }

  afterEach(() => uninstall())

  describe('while in control', () => {
    beforeEach(() => {
      mountScreen(true)
      uninstall = installRemoteScreenKeyboard(document, window)
    })

    it('shows the keyboard button', () => {
      expect(button().style.display).toBe('block')
    })

    it('replays typed text and deletions on the canvas', () => {
      button().click()
      type(`${SENTINEL}ok`)
      type(`${SENTINEL}o`)

      expect(seen).toEqual(['keydown:o', 'keydown:k', 'keydown:Backspace'])
    })

    it('sends Backspace when the field looks empty', () => {
      button().click()
      type('')

      expect(seen).toEqual(['keydown:Backspace'])
      expect(textarea().value).toBe(SENTINEL)
    })

    it('applies the sticky Ctrl from the key bar to the next key only', () => {
      button().click()
      document.querySelector<HTMLButtonElement>('[data-key="Control"]')!.click()
      type(`${SENTINEL}cv`)

      expect(seen).toEqual(['keydown:Control/ControlLeft', 'keydown:c', 'keyup:Control/ControlLeft', 'keydown:v'])
    })
  })

  it('stays hidden while only watching', () => {
    mountScreen(false)
    uninstall = installRemoteScreenKeyboard(document, window)

    expect(button().style.display).toBe('none')
  })
})
