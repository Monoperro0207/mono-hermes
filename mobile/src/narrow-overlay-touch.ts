/**
 * Touch dismissal for the narrow-viewport side overlay.
 *
 * Below the sidebar-collapse breakpoint (every phone) the renderer shows the sessions / bots
 * column as a pinned overlay (upstream components/pane-shell/tree/renderer/narrow-overlays.tsx).
 * It was built for a mouse: it closes on the titlebar toggle, on Escape, or when the pointer
 * leaves an unpinned reveal. A phone has no Escape key and no hover, and the overlay has no
 * backdrop, so a tap beside it did nothing and it looked stuck open.
 *
 * Both touch gestures reuse the renderer's own Escape path (a window `keydown`), so the overlay
 * keeps its single owner of the reveal state:
 * - a tap outside the overlay closes it; the tap is consumed, like a modal scrim, so it cannot
 *   also press what was underneath (the titlebar toggle would reopen it at once);
 * - hardware Back closes it before anything else (see lifecycle.ts).
 */

const OVERLAY = '[data-narrow-overlay]'
/** The overlay's chrome and its keep-alive guest are DOM siblings; both count as inside. */
const OVERLAY_PARTS = '[data-narrow-overlay], [data-pane-overlay]'
/** A menu, popover or dialog above the overlay owns its own outside-tap dismissal. */
const LAYER_ABOVE = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]'
/** How long after a consumed tap its trailing click is still swallowed. */
export const CLICK_SWALLOW_MS = 600

export interface OverlayTapContext {
  /** `(pointer: coarse)` matches. */
  coarsePointer: boolean
  /** The tap landed on the overlay itself. */
  insideOverlay: boolean
  /** A menu, popover or dialog is open above the overlay. */
  layerAbove: boolean
  /** The narrow overlay is revealed. */
  overlayOpen: boolean
}

/** True when this tap should close the overlay instead of reaching its target. Pure, unit tested. */
export function shouldDismissOnTap(ctx: OverlayTapContext): boolean {
  return ctx.coarsePointer && ctx.overlayOpen && !ctx.insideOverlay && !ctx.layerAbove
}

/** A mounted-but-hidden menu or dialog must not disable tap-outside for good: only rendered ones count. */
function hasVisibleLayerAbove(doc: Document): boolean {
  return [...doc.querySelectorAll(LAYER_ABOVE)].some(
    el => el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0
  )
}

/**
 * Closes the revealed overlay through the renderer's Escape handler. True only when that handler took the
 * Escape (it calls preventDefault as it closes). An overlay that is mounted but not the top Escape layer
 * ignores it, and reporting it closed anyway would leave hardware Back doing nothing.
 */
export function closeNarrowOverlay(doc: Document = document, win: Window = window): boolean {
  if (!doc.querySelector(OVERLAY)) {
    return false
  }

  return !win.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }))
}

export function installNarrowOverlayTouch(doc: Document = document, win: Window = window): () => void {
  const coarse = win.matchMedia('(pointer: coarse)')
  let swallowClickUntil = 0

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null

    const ctx: OverlayTapContext = {
      coarsePointer: coarse.matches,
      insideOverlay: Boolean(target?.closest(OVERLAY_PARTS)),
      layerAbove: hasVisibleLayerAbove(doc),
      overlayOpen: Boolean(doc.querySelector(OVERLAY))
    }

    if (!shouldDismissOnTap(ctx)) {
      // A new ordinary tap ends any pending swallow: only the consumed tap's own click is eaten.
      swallowClickUntil = 0

      return
    }

    event.preventDefault()
    event.stopImmediatePropagation()
    swallowClickUntil = win.performance.now() + CLICK_SWALLOW_MS
    closeNarrowOverlay(doc, win)
  }

  const onClick = (event: MouseEvent) => {
    if (win.performance.now() > swallowClickUntil) {
      return
    }

    swallowClickUntil = 0
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  // A consumed tap that turns into a scroll or is cancelled never produces its click.
  const onPointerCancel = () => {
    swallowClickUntil = 0
  }

  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('pointercancel', onPointerCancel, true)
  doc.addEventListener('click', onClick, true)

  return () => {
    doc.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('pointercancel', onPointerCancel, true)
    doc.removeEventListener('click', onClick, true)
  }
}
