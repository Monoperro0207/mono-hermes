/**
 * Android lifecycle glue.
 *
 * - App resume  -> `onPowerResume`: the renderer re-validates the gateway and
 *   re-dials its WebSocket (the OS freezes sockets while the app is backgrounded,
 *   exactly like a laptop waking from sleep).
 * - Hardware back -> step the visible in-app browser back first, then walk the renderer's router history, then minimise the app
 *   instead of killing it (the gateway keeps running; killing loses the live view).
 */

import type { BridgeRuntime } from './bridge/install'
import { goBackOnVisibleGuest } from './guest-browser/layout'

export async function wireNativeLifecycle(runtime: BridgeRuntime): Promise<void> {
  const { App } = await import('@capacitor/app')

  await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      runtime.log('app resumed')
      runtime.announcePowerResume()
    }
  })

  await App.addListener('backButton', ({ canGoBack }) => {
    if (goBackOnVisibleGuest()) {
      return
    }

    const hashRoute = window.location.hash.replace(/^#\/?/, '')

    if (canGoBack && hashRoute) {
      window.history.back()

      return
    }

    void App.minimizeApp()
  })
}
