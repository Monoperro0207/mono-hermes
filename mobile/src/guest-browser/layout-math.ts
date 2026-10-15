/**
 * Pure geometry and visibility rules for the native guest view (no DOM, so they are unit-tested).
 * layout.ts feeds these with measurements; the decision itself lives here.
 */

export interface Rect {
  height: number
  width: number
  x: number
  y: number
}

export interface Viewport {
  height: number
  width: number
}

/** What owns the pixel under a sample point: the guest (or its host) or something drawn over it. */
export type Probe = (x: number, y: number) => 'other' | 'own'

/** Smallest rect worth a native view; also filters the 0x0 box of a display:none ancestor. */
const MIN_SIDE = 2

/** Samples per axis for the occlusion check (3 -> a 3x3 grid). */
export const SAMPLE_GRID = 3

/** Whole CSS pixels, rounded OUTWARD so the native view never leaves a hairline gap. */
export function snapRect(r: { bottom: number; left: number; right: number; top: number }): Rect {
  const x = Math.floor(r.left)
  const y = Math.floor(r.top)

  return { height: Math.ceil(r.bottom) - y, width: Math.ceil(r.right) - x, x, y }
}

export function isUsableRect(r: Rect): boolean {
  return [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= MIN_SIDE && r.height >= MIN_SIDE
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Centres of an n x n grid over `rect`, keeping only the points that fall inside the viewport. */
export function samplePoints(rect: Rect, viewport: Viewport, n = SAMPLE_GRID): Array<[number, number]> {
  const points: Array<[number, number]> = []

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const x = rect.x + (rect.width * (col + 0.5)) / n
      const y = rect.y + (rect.height * (row + 0.5)) / n

      if (x >= 0 && y >= 0 && x < viewport.width && y < viewport.height) {
        points.push([x, y])
      }
    }
  }

  return points
}

export interface LayoutInputs {
  /** The pane is mounted-but-hidden (`data-pane-hidden`, `inert`, visibility/opacity/display). */
  hiddenAncestor: boolean
  connected: boolean
  foreground: boolean
  /** `body.guest-pointer-lock`: a sash drag is live and the guest must not eat the pointer. */
  pointerLocked: boolean
  probe: Probe
  /** The shim's rect in CSS px, snapped; null when it has no box. */
  rect: Rect | null
  viewport: Viewport
}

/**
 * The native view is shown only when the shim is on screen, nothing hides its pane, the app is in
 * the foreground and no UI is drawn over it (the native view floats above the whole web layer, so
 * a menu, toast or slide-over over the guest must hide it). Any foreign sample means occluded.
 */
export function shouldShowGuest(input: LayoutInputs): boolean {
  const { connected, foreground, hiddenAncestor, pointerLocked, probe, rect, viewport } = input

  if (!connected || !foreground || hiddenAncestor || pointerLocked || !rect || !isUsableRect(rect)) {
    return false
  }

  const points = samplePoints(rect, viewport)

  return points.length > 0 && points.every(([x, y]) => probe(x, y) === 'own')
}
