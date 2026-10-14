/**
 * Typed access to the native `GuestBrowser` Capacitor plugin (Java, `android/.../guest`).
 *
 * Registered lazily on first use, like native-http.ts. There is no web fallback: the shim is only
 * installed on the device, where the plugin exists.
 */

import { type PluginListenerHandle, registerPlugin } from '@capacitor/core'

import type { FailReason } from './events'

export interface GuestState {
  canGoBack: boolean
  canGoForward: boolean
  title: string
  url: string
}

/** One native -> JS event. The state fields (url, title, history flags) ride on every event so the shim can answer getURL() synchronously. */
export type GuestNativeEvent = GuestState & {
  /** Fail: WebViewClient.ERROR_* / SslError.SSL_*. */
  androidCode?: number
  description?: string
  level?: string
  line?: number
  message?: string
  sourceId?: string
  /** External: the popup or _blank target to hand to the system browser. The url above stays the page URL. */
  target?: string
  id: number
  /** Navigate: true for pushState / hash changes. */
  inPage?: boolean
  reason?: FailReason
  type: 'console' | 'domReady' | 'evicted' | 'external' | 'fail' | 'gone' | 'navigate' | 'start' | 'stop' | 'title'
}

export interface GuestBoundsOptions {
  height?: number
  id: number
  visible: boolean
  width?: number
  x?: number
  y?: number
}

export type GuestNavigateAction = 'back' | 'forward' | 'reload' | 'reloadIgnoringCache'

export interface GuestEvalResult {
  /** JSON text of the settled value; null for `undefined`. */
  json?: null | string
  message?: string
  ok: boolean
}

export interface GuestBrowserPlugin {
  addListener(event: 'guest', listener: (event: GuestNativeEvent) => void): Promise<PluginListenerHandle>
  create(options: { id: number; url: string }): Promise<void>
  destroy(options: { id: number }): Promise<void>
  evaluate(options: { code: string; id: number; timeoutMs: number }): Promise<GuestEvalResult>
  focus(options: { id: number }): Promise<void>
  injectInput(options: { event: Record<string, unknown>; id: number }): Promise<void>
  loadUrl(options: { id: number; url: string }): Promise<void>
  navigate(options: { action: GuestNavigateAction; id: number }): Promise<void>
  setBounds(options: GuestBoundsOptions): Promise<void>
  setMuted(options: { id: number; muted: boolean }): Promise<void>
}

let plugin: GuestBrowserPlugin | undefined

export function guestBrowser(): GuestBrowserPlugin {
  plugin ??= registerPlugin<GuestBrowserPlugin>('GuestBrowser')

  return plugin
}
