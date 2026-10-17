// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import { closeNarrowOverlay, installNarrowOverlayTouch } from '../src/narrow-overlay-touch'

const touch = (target: Element, type: string) =>
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))

describe('narrow overlay touch wiring', () => {
  let uninstall: () => void
  let escape: Mock<(event: KeyboardEvent) => void>
  let outside: HTMLButtonElement
  let outsideClicks: Mock<() => void>

  beforeEach(() => {
    document.body.innerHTML =
      '<div data-narrow-overlay="sessions"><button id="row">row</button></div><button id="gear">gear</button>'
    outside = document.querySelector('#gear')!
    outsideClicks = vi.fn<() => void>()
    outside.addEventListener('click', outsideClicks)
    // The renderer's own Escape handler (narrow-overlays.tsx) unmounts the overlay.
    escape = vi.fn<(event: KeyboardEvent) => void>(event => {
      if (event.key === 'Escape') {
        document.querySelector('[data-narrow-overlay]')?.remove()
      }
    })
    window.addEventListener('keydown', escape)
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia
    uninstall = installNarrowOverlayTouch(document, window)
  })

  afterEach(() => {
    uninstall()
    window.removeEventListener('keydown', escape)
  })

  it('closes the overlay on a tap outside and eats that tap', () => {
    touch(outside, 'pointerdown')
    outside.click()

    expect(escape).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-narrow-overlay]')).toBeNull()
    expect(outsideClicks).not.toHaveBeenCalled()
  })

  it('lets the next tap through after the overlay closed', () => {
    touch(outside, 'pointerdown')
    outside.click()
    touch(outside, 'pointerdown')
    outside.click()

    expect(outsideClicks).toHaveBeenCalledTimes(1)
  })

  it('does not eat a later tap when the consumed one was cancelled (scroll)', () => {
    touch(outside, 'pointerdown')
    touch(outside, 'pointercancel')
    outside.click()

    expect(outsideClicks).toHaveBeenCalledTimes(1)
  })

  it('keeps the overlay for taps on it', () => {
    touch(document.querySelector('#row')!, 'pointerdown')

    expect(escape).not.toHaveBeenCalled()
    expect(document.querySelector('[data-narrow-overlay]')).not.toBeNull()
  })

  it('ignores a mounted but hidden dialog', () => {
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-hidden="true"></div>')
    touch(outside, 'pointerdown')

    expect(escape).toHaveBeenCalledTimes(1)
  })

  it('leaves a visible dialog above the overlay to dismiss itself', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList
    document.body.append(dialog)
    touch(outside, 'pointerdown')

    expect(escape).not.toHaveBeenCalled()
  })

  it('closeNarrowOverlay reports whether there was an overlay to close (hardware Back)', () => {
    expect(closeNarrowOverlay(document, window)).toBe(true)
    expect(closeNarrowOverlay(document, window)).toBe(false)
  })
})
