import { describe, expect, it } from 'vitest'

import { type OverlayTapContext, shouldDismissOnTap } from '../src/narrow-overlay-touch'

const outsideTap: OverlayTapContext = { coarsePointer: true, insideOverlay: false, layerAbove: false, overlayOpen: true }

describe('narrow overlay tap-outside', () => {
  it('closes the revealed overlay on a tap beside it', () => {
    expect(shouldDismissOnTap(outsideTap)).toBe(true)
  })

  it('keeps taps on the overlay itself (rows, SESSIONS | BOTS tabs)', () => {
    expect(shouldDismissOnTap({ ...outsideTap, insideOverlay: true })).toBe(false)
  })

  it('does nothing while no overlay is revealed', () => {
    expect(shouldDismissOnTap({ ...outsideTap, overlayOpen: false })).toBe(false)
  })

  it('leaves a menu, popover or dialog above the overlay to dismiss itself', () => {
    expect(shouldDismissOnTap({ ...outsideTap, layerAbove: true })).toBe(false)
  })

  it('leaves desktop pointers to the renderer (hover / Escape)', () => {
    expect(shouldDismissOnTap({ ...outsideTap, coarsePointer: false })).toBe(false)
  })
})
