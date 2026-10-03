/**
 * Mobile entry point.
 *
 * Order matters: the desktop renderer reads `window.hermesDesktop` at import time
 * (stores subscribe to it during module evaluation), so the bridge is installed
 * and the user is signed in BEFORE `@/main` (upstream/apps/desktop/src/main.tsx)
 * is imported. The renderer itself is not modified.
 */

import { Capacitor } from '@capacitor/core'

import { installBridge } from './bridge/install'
import { installMediaProtocolShim } from './bridge/media'
import { ConnectionStore } from './bridge/connection'
import {
  createCapacitorTransport,
  createFetchTransport
} from './bridge/http'
import {
  createLocalStorageStore,
  createPlainSecretBox,
  createPreferencesStore,
  createSecretBox
} from './bridge/storage'
import { buildInfo } from './build-info'
import { installCompatNotice } from './compat-notice'
import { installNoAutofocusKeyboard, installTouchComposer } from './composer-touch'
import { createConnectUi } from './connect-screen'
import { wireNativeLifecycle } from './lifecycle'

function showFatal(message: string) {
  document.body.innerHTML = ''

  const box = document.createElement('pre')
  box.style.cssText =
    'margin:0;padding:24px;white-space:pre-wrap;word-break:break-word;background:#0a0a0a;color:#ff9a9a;font:13px/1.5 ui-monospace,monospace;min-height:100vh'
  box.textContent = `Mono Hermes could not start.\n\n${message}`
  document.body.append(box)
}

/**
 * First launch only: rows in the sessions list default to "compact" (a 28px desktop row). Phones
 * start on "comfortable" (taller rows with a second line), which is what a fingertip needs.
 * It stays a normal preference afterwards (Settings > Window & layout > Session list density).
 */
function seedPhoneDefaults() {
  try {
    const key = 'hermes.desktop.sessionListDensity'

    if (window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(key, 'comfortable')
    }
  } catch {
    // storage unavailable: renderer defaults apply
  }
}

async function start() {
  const native = Capacitor.isNativePlatform()

  const store = new ConnectionStore(
    native ? createPreferencesStore() : createLocalStorageStore(),
    native ? createSecretBox() : createPlainSecretBox()
  )

  const ui = createConnectUi()
  // Native HTTP on device (no CORS, controllable redirects); plain fetch for browser dev.
  const transport = native ? createCapacitorTransport() : createFetchTransport()

  const runtime = installBridge({
    appVersion: buildInfo.appVersion,
    promptLogin: request => ui.prompt(request),
    store,
    transport
  })

  ui.bind(runtime.auth)

  if (native) {
    installMediaProtocolShim(runtime.auth)
    await wireNativeLifecycle(runtime)
  }

  if (!(await store.isSignedIn())) {
    await ui.prompt()
  }

  seedPhoneDefaults()
  await import('@/main')
  await import('./mobile.css')
  installTouchComposer()
  installNoAutofocusKeyboard()
  installCompatNotice(store, transport)
}

start().catch(error => {
  console.error(error)
  showFatal(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
