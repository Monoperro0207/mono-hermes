// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the runtime names screen-connection.ts pulls in at import time; the real state and predicate run.
vi.mock('@hermes/plugin-sdk', () => ({ host: {}, resolveSiblingWsUrl: () => '' }))
vi.mock('@/plugins/hermes-bots/routing', () => ({ resolveBotConnectionRoute: () => null }))
vi.mock('@/plugins/hermes-bots/data', () => ({ botSelectionKey: (bot: { name: string }) => bot.name }))

import { $screenState, setScreenLease, setScreenStatus, setScreenViewer } from '@/plugins/hermes-bots/screen-state'

import {
  SCREEN_PANE_PREFIX,
  screenKeyForHost,
  type ScreenControl,
  upstreamScreenControl
} from '../src/remote-screen-control'

const ops = { name: 'ops' }
const web = { name: 'web' }
const me = { hash: 'aaaaaaaaaaaa', id: 'viewer-me' }
const lease = (holder: string, viewer_hash: string | null, epoch = 1) => ({
  epoch,
  holder,
  reason: '',
  since: 1,
  viewer_hash,
  viewer_id: null
})

const status = (l: ReturnType<typeof lease>) => ({ lease: l, running: true }) as never

function mountHost(botName?: string): HTMLElement {
  const wrapper = botName ? `<div data-pane-host="${SCREEN_PANE_PREFIX}${botName}">` : '<div>'
  document.body.insertAdjacentHTML('beforeend', `${wrapper}<div data-remote-screen=""></div></div>`)

  return document.body.lastElementChild!.querySelector('[data-remote-screen]')!
}

describe('screenKeyForHost', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('strips the screen pane prefix from the nearest pane host', () => {
    expect(screenKeyForHost(mountHost('ops'))).toBe('ops')
  })

  it('is null without a wrapper or for another pane kind', () => {
    document.body.innerHTML = '<div data-pane-host="plugin-workspace:other:thing:x"><div id="h"></div></div>'

    expect(screenKeyForHost(mountHost())).toBeNull()
    expect(screenKeyForHost(document.querySelector('#h')!)).toBeNull()
  })
})

describe('upstreamScreenControl on the real upstream state', () => {
  let control: ScreenControl

  // The production wiring itself: the same $screenState and leaseHeldBy the screen pane uses.
  beforeEach(async () => {
    $screenState.set({})
    document.body.innerHTML = ''
    control = await upstreamScreenControl()
  })

  it('is in control when a human lease carries this viewer hash', () => {
    setScreenViewer(ops, me as never)
    setScreenLease(ops, lease('human', me.hash) as never)

    expect(control.inControl(mountHost('ops'))).toBe(true)
  })

  it('is not in control when another viewer holds it', () => {
    setScreenViewer(ops, me as never)
    setScreenLease(ops, lease('human', 'bbbbbbbbbbbb') as never)

    expect(control.inControl(mountHost('ops'))).toBe(false)
  })

  it('is not in control when the agent holds it', () => {
    setScreenViewer(ops, me as never)
    setScreenLease(ops, lease('agent', null) as never)

    expect(control.inControl(mountHost('ops'))).toBe(false)
  })

  it('is not in control without a viewer identity', () => {
    setScreenLease(ops, lease('human', me.hash) as never)

    expect(control.inControl(mountHost('ops'))).toBe(false)
  })

  it('falls back to the lease carried by the status', () => {
    setScreenViewer(ops, me as never)
    $screenState.set({
      ops: { lease: null, status: status(lease('human', me.hash)), viewer: me as never }
    })

    expect(control.inControl(mountHost('ops'))).toBe(true)

    setScreenStatus(ops, status(lease('human', me.hash)))
    expect(control.inControl(mountHost('ops'))).toBe(true)
  })

  it('resolves the bot from the pane wrapper: only the matching screen counts', () => {
    setScreenViewer(ops, me as never)
    setScreenLease(ops, lease('human', me.hash) as never)
    setScreenViewer(web, me as never)
    setScreenLease(web, lease('agent', null) as never)

    expect(control.inControl(mountHost('ops'))).toBe(true)
    expect(control.inControl(mountHost('web'))).toBe(false)
  })

  it('falls back to any held screen when the host has no pane wrapper', () => {
    expect(control.inControl(mountHost())).toBe(false)

    setScreenViewer(web, me as never)
    setScreenLease(web, lease('human', me.hash) as never)

    expect(control.inControl(mountHost())).toBe(true)
  })

  it('notifies on a lease change until unsubscribed', () => {
    const listener = vi.fn()
    const off = control.subscribe(listener)

    setScreenLease(ops, lease('human', me.hash, 1) as never)
    expect(listener).toHaveBeenCalledTimes(1)

    off()
    setScreenLease(ops, lease('agent', null, 2) as never)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
