// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  diffInput,
  installRemoteScreenKeyboard,
  isDirectKey,
  keyForChar,
  SENTINEL,
  sendKey
} from '../src/remote-screen-keyboard'
import type { ScreenControl } from '../src/remote-screen-control'

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

/** A ScreenControl the test flips by hand, like the lease changing upstream. */
function fakeControl() {
  const listeners = new Set<() => void>()
  let held = false

  const control: ScreenControl = {
    inControl: () => held,
    subscribe: listener => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  }

  return {
    control,
    listenerCount: () => listeners.size,
    set(next: boolean) {
      held = next
      listeners.forEach(listener => listener())
    }
  }
}

describe('installRemoteScreenKeyboard', () => {
  let uninstall: () => void
  let canvas: HTMLCanvasElement
  let seen: string[]
  let fake: ReturnType<typeof fakeControl>
  let frames: FrameRequestCallback[]

  const mountScreen = (inControl: boolean) => {
    document.body.innerHTML = '<div class="relative"><div data-remote-screen=""><canvas></canvas></div></div>'
    const host = document.querySelector<HTMLElement>('[data-remote-screen]')!
    host.getBoundingClientRect = () => new DOMRect(0, 100, 400, 300)
    canvas = host.querySelector('canvas')!
    seen = recordKeys(canvas)
    fake.set(inControl)
  }

  const textarea = () => document.querySelector<HTMLTextAreaElement>('[data-remote-screen-keyboard] textarea')!
  const button = () => document.querySelector<HTMLButtonElement>('[data-remote-screen-keyboard] > button')!
  const barKey = (key: string) => document.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)!

  const type = (value: string) => {
    textarea().value = value
    textarea().dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** Runs the layout the keyboard scheduled for the next animation frame. */
  const flushFrames = () => {
    const pending = frames
    frames = []
    pending.forEach(callback => callback(0))
  }

  const keydown = (init: KeyboardEventInit) =>
    textarea().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

  beforeEach(() => {
    fake = fakeControl()
    frames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => frames.push(callback))
  })

  afterEach(() => {
    uninstall()
    vi.restoreAllMocks()
  })

  describe('while in control', () => {
    beforeEach(() => {
      mountScreen(true)
      uninstall = installRemoteScreenKeyboard(fake.control, document, window)
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
      barKey('Control').click()
      type(`${SENTINEL}cv`)

      expect(seen).toEqual(['keydown:Control/ControlLeft', 'keydown:c', 'keyup:Control/ControlLeft', 'keydown:v'])
    })

    it('hides the button when control is lost and shows it again when it returns', () => {
      fake.set(false)
      flushFrames()
      expect(button().style.display).toBe('none')

      fake.set(true)
      flushFrames()
      expect(button().style.display).toBe('block')
    })

    it('closes the keyboard and blurs the field when control is lost', () => {
      button().click()
      expect(document.activeElement).toBe(textarea())

      fake.set(false)
      flushFrames()

      expect(document.activeElement).not.toBe(textarea())
      expect(button().style.display).toBe('none')
    })

    it('hides the button while the screen pane is kept alive but not shown', () => {
      // keep-alive-panes.tsx keeps a hidden pane mounted at full size, only inert and aria-hidden.
      document.querySelector('[data-remote-screen]')!.parentElement!.setAttribute('inert', '')
      fake.set(true)
      flushFrames()

      expect(button().style.display).toBe('none')
    })

    it('closes the keyboard when a narrow overlay mounts over the screen', async () => {
      button().click()
      expect(document.activeElement).toBe(textarea())

      document.body.insertAdjacentHTML('beforeend', '<div data-narrow-overlay="sessions"></div>')
      // MutationObserver callbacks run as a microtask; the layout they schedule runs on the next frame.
      await Promise.resolve()
      flushFrames()

      expect(document.activeElement).not.toBe(textarea())
      expect(button().style.display).toBe('none')
    })

    it('forwards direct keys from the textarea to the canvas', () => {
      button().click()
      keydown({ key: 'ArrowLeft' })
      keydown({ key: 'Tab' })

      expect(seen).toEqual(['keydown:ArrowLeft', 'keydown:Tab'])
    })

    it('applies Ctrl to a direct key when the event carries it', () => {
      button().click()
      keydown({ ctrlKey: true, key: 'ArrowLeft' })

      expect(seen).toEqual(['keydown:Control/ControlLeft', 'keydown:ArrowLeft', 'keyup:Control/ControlLeft'])
    })

    it('applies a latched Ctrl to a direct key, once', () => {
      button().click()
      barKey('Control').click()
      keydown({ key: 'Tab' })
      keydown({ key: 'Tab' })

      expect(seen).toEqual(['keydown:Control/ControlLeft', 'keydown:Tab', 'keyup:Control/ControlLeft', 'keydown:Tab'])
    })

    it('key bar Esc, Tab and arrows reach the canvas', () => {
      button().click()
      barKey('Escape').click()
      barKey('Tab').click()
      barKey('ArrowLeft').click()

      expect(seen).toEqual(['keydown:Escape', 'keydown:Tab', 'keydown:ArrowLeft'])
    })

    it('a key bar key consumes the latched Ctrl', () => {
      button().click()
      barKey('Control').click()
      expect(barKey('Control').getAttribute('aria-pressed')).toBe('true')

      barKey('Escape').click()
      barKey('Tab').click()

      expect(seen).toEqual(['keydown:Control/ControlLeft', 'keydown:Escape', 'keyup:Control/ControlLeft', 'keydown:Tab'])
      expect(barKey('Control').getAttribute('aria-pressed')).toBe('false')
    })
  })

  it('stays hidden while only watching', () => {
    mountScreen(false)
    uninstall = installRemoteScreenKeyboard(fake.control, document, window)

    expect(button().style.display).toBe('none')
  })

  it('unsubscribes from the control on teardown', () => {
    mountScreen(true)
    uninstall = installRemoteScreenKeyboard(fake.control, document, window)
    expect(fake.listenerCount()).toBe(1)

    uninstall()
    expect(fake.listenerCount()).toBe(0)
    uninstall = () => {}
  })
})
