/**
 * Installs the in-app browser: `document.createElement('webview')` (the Electron-only tag the
 * preview pane builds its Browser from) starts returning the native-backed shim.
 *
 * Must run before `@/main` is imported. Off the device (the Playwright ui-audit harness, desktop
 * Chromium) nothing is patched and `webview` stays the inert, hidden element it always was.
 */

import { Capacitor } from '@capacitor/core'

import { patchCreateElement, SHIM_TAG, shouldShimWebview } from './create-element'
import { GuestWebview } from './shim'

export function installGuestBrowser(): boolean {
  if (!shouldShimWebview(Capacitor.isNativePlatform(), Capacitor.isPluginAvailable('GuestBrowser'))) {
    return false
  }

  if (!customElements.get(SHIM_TAG)) {
    customElements.define(SHIM_TAG, GuestWebview)
  }

  patchCreateElement(document, () => new GuestWebview())

  return true
}
