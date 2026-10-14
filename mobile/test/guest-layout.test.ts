import { describe, expect, it } from 'vitest'

import { isUsableRect, type Probe, sameRect, samplePoints, shouldShowGuest, snapRect } from '../src/guest-browser/layout-math'

const viewport = { height: 800, width: 400 }
const own: Probe = () => 'own'

const base = {
  connected: true,
  foreground: true,
  hiddenAncestor: false,
  pointerLocked: false,
  probe: own,
  rect: { height: 300, width: 300, x: 50, y: 100 },
  viewport
}

describe('rect math', () => {
  it('snaps outward to whole CSS pixels', () => {
    expect(snapRect({ bottom: 200.2, left: 10.6, right: 110.4, top: 50.5 })).toEqual({ height: 151, width: 101, x: 10, y: 50 })
  })

  it('keeps an integer rect unchanged', () => {
    expect(snapRect({ bottom: 120, left: 0, right: 80, top: 20 })).toEqual({ height: 100, width: 80, x: 0, y: 20 })
  })

  it('rejects empty, tiny and non-finite rects', () => {
    expect(isUsableRect({ height: 100, width: 100, x: 0, y: 0 })).toBe(true)
    expect(isUsableRect({ height: 0, width: 100, x: 0, y: 0 })).toBe(false)
    expect(isUsableRect({ height: 1, width: 100, x: 0, y: 0 })).toBe(false)
    expect(isUsableRect({ height: NaN, width: 100, x: 0, y: 0 })).toBe(false)
  })

  it('compares rects', () => {
    expect(sameRect({ height: 1, width: 2, x: 3, y: 4 }, { height: 1, width: 2, x: 3, y: 4 })).toBe(true)
    expect(sameRect({ height: 1, width: 2, x: 3, y: 4 }, { height: 1, width: 2, x: 3, y: 5 })).toBe(false)
  })
})

describe('occlusion sampling', () => {
  it('samples a 3x3 grid at cell centres', () => {
    const points = samplePoints({ height: 300, width: 300, x: 0, y: 0 }, viewport)

    expect(points).toHaveLength(9)
    expect(points[0]).toEqual([50, 50])
    expect(points[4]).toEqual([150, 150])
    expect(points[8]).toEqual([250, 250])
  })

  it('drops samples outside the viewport', () => {
    // Part of the rect is off the right edge.
    const points = samplePoints({ height: 300, width: 300, x: 250, y: 0 }, viewport)

    expect(points.every(([x]) => x < viewport.width)).toBe(true)
    expect(points.length).toBeLessThan(9)
    expect(points.length).toBeGreaterThan(0)
  })

  it('has no samples when fully off screen', () => {
    expect(samplePoints({ height: 300, width: 300, x: 500, y: 0 }, viewport)).toEqual([])
  })
})

describe('shouldShowGuest', () => {
  it('shows an unobstructed foreground guest', () => {
    expect(shouldShowGuest(base)).toBe(true)
  })

  it.each([
    ['disconnected', { connected: false }],
    ['backgrounded', { foreground: false }],
    ['inside a hidden pane', { hiddenAncestor: true }],
    ['during a sash drag', { pointerLocked: true }],
    ['without a rect', { rect: null }],
    ['with an empty rect', { rect: { height: 0, width: 0, x: 0, y: 0 } }],
    ['fully off screen', { rect: { height: 300, width: 300, x: 500, y: 0 } }]
  ])('hides %s', (_name, patch) => {
    expect(shouldShowGuest({ ...base, ...patch })).toBe(false)
  })

  it('hides when any sample is covered by something else', () => {
    // A toast over the bottom-right corner only.
    const probe: Probe = (x, y) => (x > 250 && y > 300 ? 'other' : 'own')

    expect(shouldShowGuest({ ...base, probe })).toBe(false)
  })

  it('shows when the covered part falls between sample points', () => {
    // A thin sliver at the very left edge is not under any sample centre.
    const probe: Probe = x => (x < 52 ? 'other' : 'own')

    expect(shouldShowGuest({ ...base, probe })).toBe(true)
  })

  it('hides when the whole rect is covered', () => {
    expect(shouldShowGuest({ ...base, probe: () => 'other' })).toBe(false)
  })
})
