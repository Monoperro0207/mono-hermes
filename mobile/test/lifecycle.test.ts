import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  appListeners: {} as Record<string, (event: never) => void>,
  closeNarrowOverlay: vi.fn<() => boolean>(),
  goBackOnVisibleGuest: vi.fn<() => boolean>(),
  holdConnection: vi.fn<() => Promise<void>>(),
  minimizeApp: vi.fn<() => Promise<void>>()
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: async (name: string, listener: (event: never) => void) => {
      h.appListeners[name] = listener
    },
    minimizeApp: h.minimizeApp
  }
}))
vi.mock('../src/narrow-overlay-touch', () => ({ closeNarrowOverlay: h.closeNarrowOverlay }))
vi.mock('../src/guest-browser/layout', () => ({ goBackOnVisibleGuest: h.goBackOnVisibleGuest }))
vi.mock('../src/bridge/background-connection', () => ({ holdConnection: h.holdConnection }))

import { wireNativeLifecycle } from '../src/lifecycle'

const runtime = { announcePowerResume: vi.fn(), log: vi.fn() }

const back = (canGoBack: boolean) => h.appListeners.backButton({ canGoBack } as never)

describe('wireNativeLifecycle', () => {
  const historyBack = vi.fn()
  const location = { hash: '' }

  beforeEach(async () => {
    vi.clearAllMocks()
    location.hash = ''
    h.closeNarrowOverlay.mockReturnValue(false)
    h.goBackOnVisibleGuest.mockReturnValue(false)
    h.holdConnection.mockResolvedValue(undefined)
    h.minimizeApp.mockResolvedValue(undefined)
    // Node environment: lifecycle.ts only reads window.location.hash and calls window.history.back().
    vi.stubGlobal('window', { history: { back: historyBack }, location })
    await wireNativeLifecycle(runtime as never)
  })

  it('announces a power resume only when the app becomes active', () => {
    h.appListeners.appStateChange({ isActive: false } as never)
    expect(runtime.announcePowerResume).not.toHaveBeenCalled()

    h.appListeners.appStateChange({ isActive: true } as never)
    expect(runtime.announcePowerResume).toHaveBeenCalledTimes(1)
  })

  describe('hardware Back', () => {
    it('closes the narrow overlay first and does nothing else', () => {
      h.closeNarrowOverlay.mockReturnValue(true)
      location.hash = '#/chat/1'
      back(true)

      expect(h.goBackOnVisibleGuest).not.toHaveBeenCalled()
      expect(historyBack).not.toHaveBeenCalled()
      expect(h.minimizeApp).not.toHaveBeenCalled()
    })

    it('steps the visible guest browser back when there is no overlay', () => {
      h.goBackOnVisibleGuest.mockReturnValue(true)
      location.hash = '#/chat/1'
      back(true)

      expect(historyBack).not.toHaveBeenCalled()
      expect(h.holdConnection).not.toHaveBeenCalled()
      expect(h.minimizeApp).not.toHaveBeenCalled()
    })

    it('walks the router history when it can go back on a hash route', () => {
      location.hash = '#/chat/1'
      back(true)

      expect(historyBack).toHaveBeenCalledTimes(1)
      expect(h.holdConnection).not.toHaveBeenCalled()
      expect(h.minimizeApp).not.toHaveBeenCalled()
    })

    it('minimises when the webview cannot go back', async () => {
      location.hash = '#/chat/1'
      back(false)

      await vi.waitFor(() => expect(h.minimizeApp).toHaveBeenCalledTimes(1))
      expect(historyBack).not.toHaveBeenCalled()
    })

    it('minimises at the root route, holding the connection first', async () => {
      back(true)

      await vi.waitFor(() => expect(h.minimizeApp).toHaveBeenCalledTimes(1))
      expect(historyBack).not.toHaveBeenCalled()
      expect(h.holdConnection.mock.invocationCallOrder[0]).toBeLessThan(h.minimizeApp.mock.invocationCallOrder[0])
    })
  })
})
