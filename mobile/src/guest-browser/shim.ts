/**
 * `<hermes-guest-webview>`: the stand-in for Electron's `<webview>` tag.
 *
 * The preview pane drives the guest through the tag's method and event surface (preview-pane.tsx,
 * `PreviewWebview`); this element implements that surface on top of a native Android WebView that
 * the GuestBrowser plugin keeps laid over the element's on-screen box (layout.ts). Methods the
 * pane treats as optional (DevTools, inspectElement, spellcheck, the edit verbs) are deliberately
 * left undefined, and `context-menu` is never fired.
 */

import { loadFailureMessage, mapConsoleLevel, mapLoadError, PREVIEW_EXTERNAL_CHANNEL } from './events'
import { type GuestHost, registerGuest, requestLayout, unregisterGuest } from './layout'
import { type Rect, sameRect } from './layout-math'
import { type GuestNativeEvent, type GuestNavigateAction, type GuestState, guestBrowser } from './plugin'
import { ABOUT_BLANK, checkGuestUrl } from './policy'

/** Longest a script may run: the annotate overlay long-polls for the user's next gesture. */
const EVAL_TIMEOUT_MS = 10 * 60 * 1000

let nextId = 1
const live = new Map<number, GuestWebview>()
let listening = false

/** One native listener for every guest; events are routed by id. */
function ensureListener() {
  if (listening) {
    return
  }

  listening = true
  void guestBrowser().addListener('guest', event => live.get(event.id)?.onNative(event))
}

type Sent = { rect: Rect; visible: true } | { visible: false }

export class GuestWebview extends HTMLElement implements GuestHost {
  readonly #id = nextId++
  #state: GuestState = { canGoBack: false, canGoForward: false, title: '', url: '' }
  #created = false
  #creation: null | Promise<null | string> = null
  /** After a crash the guest is rebuilt only by an explicit load/reload, never by layout (no crash loops). */
  #crashed = false
  #ready = false
  #muted = false
  #sent: null | Sent = null
  #pending: null | { reject: (error: Error) => void; resolve: () => void } = null

  get element(): HTMLElement {
    return this
  }

  get backAvailable(): boolean {
    return this.#state.canGoBack
  }

  get shown(): boolean {
    return this.#sent?.visible === true
  }

  connectedCallback() {
    live.set(this.#id, this)
    ensureListener()
    registerGuest(this)
    void this.#create(this.getAttribute('src') || ABOUT_BLANK).catch(() => undefined)
  }

  disconnectedCallback() {
    // A move re-connects within the same task; only a real removal tears the guest down.
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.#dispose()
      }
    })
  }

  // --- Electron webview surface ---------------------------------------------------------------

  /** Electron throws before attach + dom-ready; the pane wraps these in try/catch (guestPage). */
  #requireReady() {
    if (!this.#ready) {
      throw new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
    }
  }

  getURL(): string {
    this.#requireReady()

    return this.#state.url
  }

  getTitle(): string {
    this.#requireReady()

    return this.#state.title
  }

  canGoBack(): boolean {
    return this.#state.canGoBack
  }

  canGoForward(): boolean {
    return this.#state.canGoForward
  }

  getWebContentsId(): number {
    return this.#id
  }

  getZoomFactor(): number {
    return 1
  }

  isAudioMuted(): boolean {
    return this.#muted
  }

  setAudioMuted(muted: boolean) {
    this.#muted = muted

    if (this.#created) {
      void guestBrowser().setMuted({ id: this.#id, muted }).catch(() => undefined)
    }
  }

  loadURL(url: string): Promise<void> {
    const verdict = checkGuestUrl(url)

    if (!verdict.ok) {
      return Promise.reject(new Error(verdict.reason))
    }

    this.#settle(new Error(`ERR_ABORTED (-3) loading '${url}'`))

    return new Promise<void>((resolve, reject) => {
      this.#pending = { reject, resolve }
      this.#crashed = false

      const load = this.#create(url).then(built => (built === url ? undefined : guestBrowser().loadUrl({ id: this.#id, url })))

      void load.catch((error: unknown) => this.#settle(error instanceof Error ? error : new Error(String(error))))
    })
  }

  reload() {
    this.#navigate('reload')
  }

  reloadIgnoringCache() {
    this.#navigate('reloadIgnoringCache')
  }

  goBack() {
    this.#navigate('back')
  }

  goForward() {
    this.#navigate('forward')
  }

  async executeJavaScript(code: string): Promise<unknown> {
    if (!this.#created) {
      throw new Error('The page is not available.')
    }

    const result = await guestBrowser().evaluate({ code, id: this.#id, timeoutMs: EVAL_TIMEOUT_MS })

    if (!result.ok) {
      throw new Error(result.message || 'Script failed.')
    }

    return result.json == null ? undefined : JSON.parse(result.json)
  }

  /** Real input: native MotionEvents / KeyEvents, coordinates in the guest's CSS px. */
  sendInputEvent(event: Record<string, unknown>) {
    if (!this.#created) {
      throw new Error('The page is not available.')
    }

    void guestBrowser().injectInput({ event, id: this.#id }).catch(() => undefined)
  }

  override focus() {
    if (this.#created) {
      void guestBrowser().focus({ id: this.#id }).catch(() => undefined)
    }
  }

  // --- layout (GuestHost) ---------------------------------------------------------------------

  applyLayout(show: boolean, rect: Rect) {
    if (!this.#created) {
      // Evicted (or not built yet): rebuild from the last known URL once it has to be seen.
      if (show && !this.#crashed && !this.#creation) {
        void this.#create(this.#state.url || this.getAttribute('src') || ABOUT_BLANK).catch(() => undefined)
      }

      return
    }

    const prev = this.#sent

    if (prev && (prev.visible && show ? sameRect(prev.rect, rect) : prev.visible === show)) {
      return
    }

    this.#sent = show ? { rect, visible: true } : { visible: false }
    void guestBrowser()
      .setBounds(show ? { ...rect, id: this.#id, visible: true } : { id: this.#id, visible: false })
      .catch(() => {
        this.#sent = null
      })
  }

  // --- native events --------------------------------------------------------------------------

  /** @internal Called by the shared listener. */
  onNative(event: GuestNativeEvent) {
    // A failed load reports the URL that failed; the page URL stays the last good one (it is what a rebuild reloads).
    this.#state = {
      canGoBack: event.canGoBack,
      canGoForward: event.canGoForward,
      title: event.title,
      url: event.type === 'fail' ? this.#state.url : event.url
    }

    switch (event.type) {
      case 'start':
        this.#emit('did-start-loading')

        break
      case 'navigate':
        this.#emit(event.inPage ? 'did-navigate-in-page' : 'did-navigate', { url: event.url })

        break
      case 'title':
        this.#emit('page-title-updated', { explicitSet: true, title: event.title })

        break
      case 'domReady':
        this.#ready = true
        this.#emit('dom-ready')

        break
      case 'stop':
        this.#ready = true
        this.#emit('did-stop-loading')
        this.#settle()

        break
      case 'fail': {
        const error = mapLoadError({
          androidCode: event.androidCode ?? -1,
          description: event.description ?? '',
          reason: event.reason ?? 'load'
        })

        this.#emit('did-fail-load', { ...error, isMainFrame: true, validatedURL: event.url })
        this.#settle(new Error(loadFailureMessage(error, event.url)))

        break
      }

      case 'console':
        this.#emit('console-message', {
          level: mapConsoleLevel(event.level ?? ''),
          line: event.line ?? 0,
          message: event.message ?? '',
          sourceId: event.sourceId ?? ''
        })

        break
      case 'external':
        this.#emit('ipc-message', { args: [event.target ?? ''], channel: PREVIEW_EXTERNAL_CHANNEL })

        break
      case 'evicted':
        // Native dropped this view to stay under the live-guest cap; layout rebuilds it when shown.
        this.#created = false
        this.#sent = null
        requestLayout()

        break
      case 'gone': {
        this.#created = false
        this.#crashed = true
        this.#sent = null

        const error = mapLoadError({ androidCode: 0, description: '', reason: 'crash' })

        this.#emit('did-fail-load', { ...error, isMainFrame: true, validatedURL: this.#state.url })
        this.#settle(new Error(loadFailureMessage(error, this.#state.url)))

        break
      }
    }
  }

  // --- internals ------------------------------------------------------------------------------

  #emit(name: string, fields: Record<string, unknown> = {}) {
    this.dispatchEvent(Object.assign(new Event(name), fields))
  }

  #settle(error?: Error) {
    const pending = this.#pending

    this.#pending = null

    if (error) {
      pending?.reject(error)
    } else {
      pending?.resolve()
    }
  }

  /** Builds the native view loading `url`. Resolves to the URL it was built with, or null when it already existed. */
  #create(url: string): Promise<null | string> {
    if (this.#created) {
      return Promise.resolve(null)
    }

    this.#creation ??= (async () => {
      try {
        await guestBrowser().create({ id: this.#id, url })
        this.#created = true
        this.#sent = null

        if (this.#muted) {
          this.setAudioMuted(true)
        }

        requestLayout()

        return url
      } finally {
        this.#creation = null
      }
    })()

    return this.#creation
  }

  #navigate(action: GuestNavigateAction) {
    if (this.#created) {
      void guestBrowser().navigate({ action, id: this.#id }).catch(() => undefined)
    } else if (!this.#creation) {
      // Evicted or crashed: a reload is a fresh build of the last URL.
      this.#crashed = false
      void this.#create(this.#state.url || this.getAttribute('src') || ABOUT_BLANK).catch(() => undefined)
    }
  }

  #dispose() {
    unregisterGuest(this)
    live.delete(this.#id)
    this.#settle(new Error('The webview was removed.'))

    if (this.#created || this.#creation) {
      void guestBrowser().destroy({ id: this.#id }).catch(() => undefined)
    }

    this.#created = false
  }
}
