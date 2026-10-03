import { describe, expect, it } from 'vitest'

import { type EnterKeyContext, type EnterKeyLike, GESTURE_WINDOW_MS, shouldInsertNewline, shouldSuppressAutofocus } from '../src/composer-touch'

const enter: EnterKeyLike = { altKey: false, ctrlKey: false, isComposing: false, key: 'Enter', keyCode: 13, metaKey: false, shiftKey: false }
const touch: EnterKeyContext = { coarsePointer: true, completionOpen: false, inComposer: true }

describe('touch composer Enter', () => {
  it('turns a plain Enter into a newline on touch devices', () => {
    expect(shouldInsertNewline(enter, touch)).toBe(true)
  })

  it('leaves desktop pointers alone', () => {
    expect(shouldInsertNewline(enter, { ...touch, coarsePointer: false })).toBe(false)
  })

  it('keeps Enter for the slash / @ completion drawer', () => {
    expect(shouldInsertNewline(enter, { ...touch, completionOpen: true })).toBe(false)
  })

  it('ignores keys outside the composer', () => {
    expect(shouldInsertNewline(enter, { ...touch, inComposer: false })).toBe(false)
  })

  it('keeps modified Enter (Ctrl/Meta/Alt/Shift) as upstream handles it', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(shouldInsertNewline({ ...enter, [mod]: true }, touch)).toBe(false)
    }
  })

  it('never interferes with IME composition', () => {
    expect(shouldInsertNewline({ ...enter, isComposing: true }, touch)).toBe(false)
    expect(shouldInsertNewline({ ...enter, keyCode: 229 }, touch)).toBe(false)
  })

  it('ignores other keys', () => {
    expect(shouldInsertNewline({ ...enter, key: 'a', keyCode: 65 }, touch)).toBe(false)
  })
})

describe('touch composer autofocus', () => {
  const ctx = { coarsePointer: true, inComposer: true, msSinceGesture: null as null | number }

  it('undoes programmatic focus (no gesture yet, or a stale one)', () => {
    expect(shouldSuppressAutofocus(ctx)).toBe(true)
    expect(shouldSuppressAutofocus({ ...ctx, msSinceGesture: GESTURE_WINDOW_MS + 1 })).toBe(true)
  })

  it('keeps a focus that follows the user tap / key press', () => {
    expect(shouldSuppressAutofocus({ ...ctx, msSinceGesture: 20 })).toBe(false)
    expect(shouldSuppressAutofocus({ ...ctx, msSinceGesture: GESTURE_WINDOW_MS })).toBe(false)
  })

  it('only touches the composer on touch screens', () => {
    expect(shouldSuppressAutofocus({ ...ctx, inComposer: false })).toBe(false)
    expect(shouldSuppressAutofocus({ ...ctx, coarsePointer: false })).toBe(false)
  })
})
