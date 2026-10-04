import { describe, expect, it } from 'vitest'

import type { Contribution } from '@/contrib/types'

import { disableDesktopOnlyPanes, installDesktopOnlyPanes, type PaneRegistry } from '../src/desktop-only-panes'

/** Minimal stand-in for upstream's ContributionRegistry: replace-by-id, `enabled: false` filtered out, global listeners. */
function fakeRegistry(initial: Contribution[]) {
  let entries = [...initial]
  const listeners = new Set<() => void>()
  let notifications = 0

  const registry: PaneRegistry = {
    getArea: area => entries.filter(c => c.area === area && c.enabled !== false),
    register: c => {
      entries = [...entries.filter(e => e.id !== c.id), c]
      notifications++
      listeners.forEach(l => l())

      return () => undefined
    },
    subscribe: fn => {
      listeners.add(fn)

      return () => listeners.delete(fn)
    }
  }

  return { registry, all: () => entries, notifications: () => notifications }
}

const pane = (id: string, data: object = {}): Contribution => ({ area: 'panes', data, id })

describe('desktop-only panes', () => {
  it('soft-disables the terminal and keeps every other pane', () => {
    const { registry } = fakeRegistry([pane('workspace'), pane('terminal', { placement: 'bottom' }), pane('files')])

    expect(disableDesktopOnlyPanes(registry)).toEqual(['terminal'])
    expect(registry.getArea('panes').map(p => p.id)).toEqual(['workspace', 'files'])
  })

  it('keeps the original contribution data (only `enabled` changes)', () => {
    const { registry, all } = fakeRegistry([pane('terminal', { placement: 'bottom', height: '20vh' })])

    disableDesktopOnlyPanes(registry)

    expect(all()).toEqual([{ area: 'panes', data: { height: '20vh', placement: 'bottom' }, enabled: false, id: 'terminal' }])
  })

  it('disables a terminal the renderer registers (again) later, without looping', () => {
    const { registry, notifications } = fakeRegistry([pane('workspace')])
    const dispose = installDesktopOnlyPanes(registry)

    registry.register(pane('terminal'))

    expect(registry.getArea('panes').map(p => p.id)).toEqual(['workspace'])
    // the renderer's register + our one disabling register
    expect(notifications()).toBe(2)

    dispose()
    registry.register(pane('terminal'))
    expect(registry.getArea('panes').map(p => p.id)).toEqual(['workspace', 'terminal'])
  })

  it('is a no-op when nothing desktop-only is registered', () => {
    const { registry, notifications } = fakeRegistry([pane('workspace'), pane('files')])

    expect(disableDesktopOnlyPanes(registry)).toEqual([])
    expect(notifications()).toBe(0)
  })
})
