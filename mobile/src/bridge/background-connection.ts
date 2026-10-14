/**
 * Background connection (android/.../background/ConnectionService.java).
 *
 * Android 15+ cuts a backgrounded app's network after a few seconds, which drops the gateway
 * WebSocket on every app switch. MainActivity starts a foreground service on the way out and stops
 * it on return; this module only tells it whether a turn is in flight (the service then stays up for
 * the whole turn and counts its grace window from the turn's end) and, for the hardware back button,
 * asks for it before the app minimises itself.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'

import { errorMessage } from './util'

interface BackgroundConnectionPlugin {
  hold(): Promise<void>
  setWorking(options: { working: boolean }): Promise<void>
}

const plugin = registerPlugin<BackgroundConnectionPlugin>('BackgroundConnection')

function warn(error: unknown) {
  console.warn('[hermes-mobile] background connection unavailable:', errorMessage(error))
}

/** Reports only transitions between "some turn in flight" and "none". */
export function createWorkReporter(report: (working: boolean) => Promise<void>) {
  let working: boolean | null = null

  return (activeTurns: number) => {
    const next = activeTurns > 0

    if (next !== working) {
      working = next
      void report(next).catch(warn)
    }
  }
}

const native = () => Capacitor.isNativePlatform()

export const reportBackgroundWork = createWorkReporter(async working => {
  if (native()) {
    await plugin.setWorking({ working })
  }
})

/** Start the service now (the app is about to minimise itself). */
export async function holdConnection(): Promise<void> {
  if (native()) {
    await plugin.hold().catch(warn)
  }
}
