/**
 * Touch-screen composer behaviour.
 *
 * The desktop composer sends on Enter and inserts a newline only on Shift+Enter
 * (upstream app/chat/composer/index.tsx handleEditorKeyDown). A phone keyboard has no Shift+Enter
 * (and a send button right next to the field), so on touch devices a multi-line message could
 * not be typed at all. Like every mobile chat app, Enter inserts a newline there and the send
 * button sends. Hardware keyboards keep working: Ctrl/Meta+Enter still sends.
 *
 * Installed as a capture-phase listener so it runs before React's handler and stops it for the
 * plain-Enter case only. Everything else (IME composition, the slash / @ completion drawer,
 * modified Enter, any other element) is left to the renderer.
 */

export interface EnterKeyContext {
  /** `(pointer: coarse)` matches. */
  coarsePointer: boolean
  /** The `/` `@` completion drawer is open: Enter must pick the highlighted item. */
  completionOpen: boolean
  /** The key event happened inside the composer's contenteditable. */
  inComposer: boolean
}

export interface EnterKeyLike {
  altKey: boolean
  ctrlKey: boolean
  isComposing: boolean
  key: string
  keyCode: number
  metaKey: boolean
  shiftKey: boolean
}

/** True when this keydown should become a newline instead of a send. Pure, unit tested. */
export function shouldInsertNewline(event: EnterKeyLike, ctx: EnterKeyContext): boolean {
  return (
    ctx.coarsePointer &&
    ctx.inComposer &&
    !ctx.completionOpen &&
    event.key === 'Enter' &&
    // 229 = legacy VK_PROCESSKEY: an IME commit, handled upstream as "not a send"
    event.keyCode !== 229 &&
    !event.isComposing &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  )
}

const COMPOSER_EDITOR = '[data-slot="composer-root"] [contenteditable="true"]'
const COMPLETION_DRAWER = '[data-slot="composer-completion-drawer"]'

export function installTouchComposer(doc: Document = document, win: Window = window): () => void {
  const coarse = win.matchMedia('(pointer: coarse)')

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null

    const ctx: EnterKeyContext = {
      coarsePointer: coarse.matches,
      completionOpen: Boolean(doc.querySelector(COMPLETION_DRAWER)),
      inComposer: Boolean(target?.closest(COMPOSER_EDITOR))
    }

    if (!shouldInsertNewline(event, ctx)) {
      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()

    // Same DOM edit the browser performs for Shift+Enter in a contenteditable; fires `input`
    // so the renderer's draft state follows.
    if (!doc.execCommand('insertLineBreak')) {
      doc.execCommand('insertParagraph')
    }
  }

  doc.addEventListener('keydown', onKeyDown, true)

  return () => doc.removeEventListener('keydown', onKeyDown, true)
}

export interface AutofocusContext {
  coarsePointer: boolean
  /** The focused element is the composer's contenteditable. */
  inComposer: boolean
  /** Milliseconds since the last pointer / touch / key event, `null` if none happened yet. */
  msSinceGesture: number | null
}

/** A tap or key press this recent is taken as the cause of a focus; older / none = the app focused it by itself. */
export const GESTURE_WINDOW_MS = 700

/**
 * The desktop renderer focuses the composer whenever a chat opens (launch, new session, session
 * switch, closing an overlay). With a physical keyboard that is handy; on a phone it pops the
 * soft keyboard over the conversation every single time. Programmatic focus on a touch screen is
 * therefore undone, while a focus that follows the user's own tap (on the composer, or on send,
 * which refocuses it to keep the keyboard open) is kept.
 */
export function shouldSuppressAutofocus(ctx: AutofocusContext, windowMs: number = GESTURE_WINDOW_MS): boolean {
  return ctx.coarsePointer && ctx.inComposer && (ctx.msSinceGesture === null || ctx.msSinceGesture > windowMs)
}

export function installNoAutofocusKeyboard(doc: Document = document, win: Window = window): () => void {
  const coarse = win.matchMedia('(pointer: coarse)')
  let lastGesture: null | number = null

  const mark = () => {
    lastGesture = win.performance.now()
  }

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null

    const ctx: AutofocusContext = {
      coarsePointer: coarse.matches,
      inComposer: Boolean(target?.closest(COMPOSER_EDITOR)),
      msSinceGesture: lastGesture === null ? null : win.performance.now() - lastGesture
    }

    if (target && shouldSuppressAutofocus(ctx)) {
      target.blur()
    }
  }

  doc.addEventListener('pointerdown', mark, true)
  doc.addEventListener('touchstart', mark, true)
  doc.addEventListener('keydown', mark, true)
  doc.addEventListener('focusin', onFocusIn, true)

  return () => {
    doc.removeEventListener('pointerdown', mark, true)
    doc.removeEventListener('touchstart', mark, true)
    doc.removeEventListener('keydown', mark, true)
    doc.removeEventListener('focusin', onFocusIn, true)
  }
}
