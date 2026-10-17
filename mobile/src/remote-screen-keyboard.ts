/**
 * Soft keyboard for the Bot Screen (remote desktop) on a phone.
 *
 * The screen is noVNC drawing into a <canvas> (upstream plugins/hermes-bots/screen-pane.tsx);
 * noVNC reads keys from keydown events on that canvas. A canvas is not editable, so Android never
 * opens its keyboard there and nothing could be typed into the bot's desktop after Take over.
 *
 * While the human holds control, a keyboard button floats over the screen. It focuses a hidden
 * textarea, which opens the system keyboard. What the keyboard does to the textarea is diffed and
 * replayed on the canvas as synthetic keydowns: noVNC treats a keydown without a physical `code`
 * as a virtual-keyboard key and sends press + release (core/input/keyboard.js). Diffing the value
 * (instead of reading key events) is what works with Android IMEs, which report most keys as
 * keyCode 229 and commit whole words through composition and autocorrect.
 *
 * A key bar adds what phone keyboards lack: Esc, Tab, a sticky Ctrl and arrows.
 * Input sent while watching is dropped by noVNC (viewOnly) and by the gateway's lease filter, so
 * the button only appears in control as a UX cue, never as the security boundary.
 */

const SCREEN_HOST = '[data-remote-screen]'
const NARROW_OVERLAY = '[data-narrow-overlay]'
/** screen-pane.tsx rings the screen in red only while this viewer holds the lease (`iHold`). */
const IN_CONTROL_RING = 'ring-red-500'
/** Kept in the textarea so Backspace on an "empty" field still produces an input event. */
export const SENTINEL = ' '
/** Past this many characters the textarea is reset between compositions. */
const MAX_BUFFER = 64

export interface InputDiff {
  backspaces: number
  text: string
}

/** What changed between two textarea values, as backspaces then typed text. Pure, unit tested. */
export function diffInput(previous: string, next: string): InputDiff {
  let common = 0

  while (common < previous.length && common < next.length && previous[common] === next[common]) {
    common += 1
  }

  return { backspaces: previous.length - common, text: next.slice(common) }
}

/** The KeyboardEvent `key` noVNC should see for one typed character. */
export function keyForChar(char: string): string {
  if (char === '\n' || char === '\r') {
    return 'Enter'
  }

  if (char === '\t') {
    return 'Tab'
  }

  return char === SENTINEL ? ' ' : char
}

/** Keys a textarea keydown forwards directly (hardware keyboards, IMEs with arrow / tab keys). */
const DIRECT_KEYS = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Delete',
  'End',
  'Escape',
  'Home',
  'PageDown',
  'PageUp',
  'Tab'
])

export interface DirectKeyLike {
  altKey: boolean
  ctrlKey: boolean
  key: string
  keyCode: number
  metaKey: boolean
}

/** True when a textarea keydown is forwarded as-is instead of through the value diff. Pure. */
export function isDirectKey(event: DirectKeyLike): boolean {
  if (event.keyCode === 229 || event.key === 'Unidentified') {
    return false
  }

  const combo = (event.ctrlKey || event.metaKey || event.altKey) && event.key.length === 1

  return DIRECT_KEYS.has(event.key) || combo
}

/** Sends one key to noVNC; `ctrl` wraps it in a tracked Control press. */
export function sendKey(canvas: HTMLElement, key: string, ctrl = false): void {
  const fire = (type: 'keydown' | 'keyup', init: KeyboardEventInit) =>
    canvas.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))

  if (ctrl) {
    fire('keydown', { code: 'ControlLeft', ctrlKey: true, key: 'Control' })
  }

  fire('keydown', { ctrlKey: ctrl, key })

  if (ctrl) {
    fire('keyup', { code: 'ControlLeft', key: 'Control' })
  }
}

const BAR_KEYS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'Escape', label: 'Esc' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Control', label: 'Ctrl' },
  { key: 'ArrowLeft', label: '←' },
  { key: 'ArrowUp', label: '↑' },
  { key: 'ArrowDown', label: '↓' },
  { key: 'ArrowRight', label: '→' }
]

const BUTTON_SIZE = 44
const BAR_HEIGHT = 44

function styled<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, css: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag)
  el.style.cssText = css

  return el
}

/** The visible screen host whose viewer holds control, if any. */
function activeScreen(doc: Document): { canvas: HTMLCanvasElement; host: HTMLElement } | null {
  if (doc.querySelector(NARROW_OVERLAY)) {
    return null
  }

  for (const host of doc.querySelectorAll<HTMLElement>(SCREEN_HOST)) {
    const canvas = host.querySelector('canvas')
    const rect = host.getBoundingClientRect()

    if (canvas && rect.width > 0 && rect.height > 0 && host.parentElement?.className.includes(IN_CONTROL_RING)) {
      return { canvas, host }
    }
  }

  return null
}

export function installRemoteScreenKeyboard(doc: Document = document, win: Window = window): () => void {
  const root = styled(doc, 'div', 'position:fixed;inset:0;pointer-events:none;z-index:45')
  root.dataset.remoteScreenKeyboard = ''

  const input = styled(
    doc,
    'textarea',
    'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;resize:none;pointer-events:none'
  )
  input.setAttribute('aria-label', 'Remote screen keyboard input')
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('enterkeyhint', 'enter')
  input.spellcheck = false
  // Same keyboard-ownership marker the screen host carries: app shortcuts leave these keys alone.
  input.dataset.terminal = ''

  const button = styled(
    doc,
    'button',
    `position:fixed;display:none;width:${BUTTON_SIZE}px;height:${BUTTON_SIZE}px;border-radius:22px;border:0;` +
      'background:rgba(20,20,20,.78);color:#fff;font-size:22px;line-height:1;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,.4)'
  )
  button.type = 'button'
  button.textContent = '⌨'
  button.setAttribute('aria-label', 'Show keyboard')

  const bar = styled(
    doc,
    'div',
    `position:fixed;left:0;right:0;display:none;height:${BAR_HEIGHT}px;gap:4px;padding:4px;box-sizing:border-box;` +
      'background:rgba(20,20,20,.92);pointer-events:auto'
  )
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Remote screen keys')

  let ctrlLatched = false
  let composing = false
  let lastValue = SENTINEL
  let screen: ReturnType<typeof activeScreen> = null

  const ctrlButton = (): HTMLButtonElement | null => bar.querySelector('[data-key="Control"]')

  const setCtrl = (on: boolean) => {
    ctrlLatched = on
    const el = ctrlButton()

    if (el) {
      el.style.background = on ? '#2563eb' : 'rgba(255,255,255,.12)'
      el.setAttribute('aria-pressed', String(on))
    }
  }

  for (const { key, label } of BAR_KEYS) {
    const keyButton = styled(
      doc,
      'button',
      'flex:1;min-width:0;border:0;border-radius:6px;background:rgba(255,255,255,.12);color:#fff;font-size:14px'
    )
    keyButton.type = 'button'
    keyButton.textContent = label
    keyButton.dataset.key = key
    // pointerdown default would move focus off the textarea and close the system keyboard.
    keyButton.addEventListener('pointerdown', event => event.preventDefault())
    keyButton.addEventListener('click', () => {
      if (key === 'Control') {
        setCtrl(!ctrlLatched)

        return
      }

      if (screen) {
        sendKey(screen.canvas, key, ctrlLatched)
      }

      setCtrl(false)
    })
    bar.append(keyButton)
  }

  setCtrl(false)

  const resetBuffer = () => {
    input.value = SENTINEL
    lastValue = SENTINEL
    input.setSelectionRange(SENTINEL.length, SENTINEL.length)
  }

  const replay = ({ backspaces, text }: InputDiff) => {
    if (!screen) {
      return
    }

    for (let i = 0; i < backspaces; i += 1) {
      sendKey(screen.canvas, 'Backspace')
    }

    for (const char of text) {
      sendKey(screen.canvas, keyForChar(char), ctrlLatched)
      setCtrl(false)
    }
  }

  input.addEventListener('compositionstart', () => {
    composing = true
  })
  input.addEventListener('compositionend', () => {
    composing = false
  })
  input.addEventListener('input', () => {
    replay(diffInput(lastValue, input.value))
    lastValue = input.value

    if (!composing && (input.value.length === 0 || input.value.length > MAX_BUFFER || !input.value.startsWith(SENTINEL))) {
      resetBuffer()
    }
  })
  input.addEventListener('keydown', event => {
    if (!screen || !isDirectKey(event)) {
      return
    }

    event.preventDefault()
    sendKey(screen.canvas, event.key, event.ctrlKey || ctrlLatched)
    setCtrl(false)
  })

  const layout = () => {
    screen = activeScreen(doc)
    const keyboardOpen = doc.activeElement === input

    if (!screen) {
      button.style.display = 'none'
      bar.style.display = 'none'

      if (keyboardOpen) {
        input.blur()
      }

      return
    }

    const rect = screen.host.getBoundingClientRect()
    const viewport = win.visualViewport
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : win.innerHeight
    const bottom = Math.min(rect.bottom, viewportBottom)
    // The pane can be wider than a phone (its header overflows), so keep the button on screen.
    const right = Math.min(rect.right, viewport ? viewport.offsetLeft + viewport.width : win.innerWidth)

    bar.style.display = keyboardOpen ? 'flex' : 'none'
    bar.style.top = `${viewportBottom - BAR_HEIGHT}px`

    button.style.display = 'block'
    button.style.left = `${right - BUTTON_SIZE - 12}px`
    button.style.top = `${bottom - BUTTON_SIZE - 12 - (keyboardOpen ? BAR_HEIGHT : 0)}px`
    button.setAttribute('aria-label', keyboardOpen ? 'Hide keyboard' : 'Show keyboard')
  }

  button.addEventListener('pointerdown', event => event.preventDefault())
  button.addEventListener('click', () => {
    if (doc.activeElement === input) {
      input.blur()
    } else {
      resetBuffer()
      input.focus()
    }

    layout()
  })
  input.addEventListener('focus', layout)
  input.addEventListener('blur', () => {
    setCtrl(false)
    layout()
  })

  root.append(input, button, bar)
  doc.body.append(root)

  let frame = 0
  const schedule = () => {
    if (!frame) {
      frame = win.requestAnimationFrame(() => {
        frame = 0
        layout()
      })
    }
  }

  // The screen pane mounts, re-attaches and changes control state by re-rendering: watch the DOM
  // (class flips included) rather than polling.
  const observer = new MutationObserver(schedule)
  observer.observe(doc.body, { attributeFilter: ['class'], attributes: true, childList: true, subtree: true })
  win.addEventListener('resize', schedule)
  win.visualViewport?.addEventListener('resize', schedule)
  win.visualViewport?.addEventListener('scroll', schedule)
  layout()

  return () => {
    observer.disconnect()
    win.removeEventListener('resize', schedule)
    win.visualViewport?.removeEventListener('resize', schedule)
    win.visualViewport?.removeEventListener('scroll', schedule)
    win.cancelAnimationFrame(frame)
    root.remove()
  }
}
