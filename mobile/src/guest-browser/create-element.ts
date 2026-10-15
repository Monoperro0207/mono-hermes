/**
 * `document.createElement('webview')` interception (pure wiring, so it is unit-tested).
 *
 * The preview pane builds its Browser with `document.createElement('webview')`, an Electron-only tag.
 * On the phone that call returns the guest shim instead. Everywhere else (the Playwright ui-audit
 * harness, desktop Chromium) it is left alone, so those keep today's behaviour.
 */

export const SHIM_TAG = 'hermes-guest-webview'

export const isWebviewTag = (name: unknown): boolean => typeof name === 'string' && name.toLowerCase() === 'webview'

/** Only on the device, and only when the native plugin is there to back the shim. */
export const shouldShimWebview = (native: boolean, pluginAvailable: boolean): boolean => native && pluginAvailable

interface CreateElementHost {
  createElement(name: string, options?: unknown): unknown
}

/** Patches `host.createElement`; returns the restore function. */
export function patchCreateElement(host: CreateElementHost, makeShim: () => unknown): () => void {
  const original = host.createElement

  host.createElement = function (this: unknown, name: string, options?: unknown) {
    return isWebviewTag(name) ? makeShim() : original.call(this, name, options)
  }

  return () => {
    host.createElement = original
  }
}
