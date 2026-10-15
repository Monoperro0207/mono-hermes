/**
 * Keeps each native guest view glued to its shim's on-screen box.
 *
 * The guest is a real Android WebView laid OVER the web layer, so it knows nothing about the DOM's
 * stacking: the renderer's tabs, menus, toasts and drags have to be mirrored by hiding it. One shared
 * loop (rAF, only when something may have changed, plus a ~10 Hz safety poll) measures every shim and
 * hands it the verdict from layout-math.ts; the shim sends native calls only when that changed.
 */

import { type Rect, shouldShowGuest, snapRect } from './layout-math'

export interface GuestHost {
  readonly backAvailable: boolean
  readonly element: HTMLElement
  /** Whether the native view is currently shown (what the last applyLayout asked for). */
  readonly shown: boolean
  applyLayout(show: boolean, rect: Rect): void
  goBack(): void
}

const POLL_MS = 100
const MAX_ANCESTORS = 64
const WATCHED_ATTRS = ['class', 'style', 'data-state', 'inert', 'data-pane-hidden', 'hidden']

const guests = new Set<GuestHost>()
let dirty = false
let frame = 0
let poll: ReturnType<typeof setInterval> | undefined
let resizeObserver: ResizeObserver | undefined
let mutationObserver: MutationObserver | undefined

function hasHiddenAncestor(el: HTMLElement): boolean {
  let node: Element | null = el

  for (let depth = 0; node && depth < MAX_ANCESTORS; depth++, node = node.parentElement) {
    if (node.hasAttribute('data-pane-hidden') || node.hasAttribute('inert')) {
      return true
    }

    const style = getComputedStyle(node)

    // visibility is inherited, so the shim's own value already reflects its ancestors. The host div
    // uses opacity-0 for a load error or a non-web preview; display:none ancestors have no box.
    if (style.display === 'none' || style.opacity === '0' || (node === el && style.visibility !== 'visible')) {
      return true
    }
  }

  return false
}

function measure(host: GuestHost): { rect: Rect; show: boolean } {
  const el = host.element
  const rect = snapRect(el.getBoundingClientRect())
  const owner = el.parentElement

  const show = shouldShowGuest({
    connected: el.isConnected,
    foreground: document.visibilityState === 'visible',
    hiddenAncestor: el.isConnected && hasHiddenAncestor(el),
    pointerLocked: document.body.classList.contains('guest-pointer-lock'),
    probe: (x, y) => {
      const top = document.elementFromPoint(x, y)

      return top && (top === el || el.contains(top) || owner?.contains(top)) ? 'own' : 'other'
    },
    rect,
    viewport: { height: window.innerHeight, width: window.innerWidth }
  })

  return { rect, show }
}

function run() {
  frame = 0

  if (!dirty) {
    return
  }

  dirty = false

  for (const host of guests) {
    const { rect, show } = measure(host)

    host.applyLayout(show, rect)
  }
}

/** Ask for a layout pass on the next frame. */
export function requestLayout() {
  dirty = true

  if (!frame && guests.size > 0) {
    frame = requestAnimationFrame(run)
  }
}

/** No rAF while the app is backgrounded, so hide synchronously. */
function onVisibility() {
  dirty = true
  run()
}

function start() {
  resizeObserver = new ResizeObserver(requestLayout)
  mutationObserver = new MutationObserver(requestLayout)
  mutationObserver.observe(document.body, { attributeFilter: WATCHED_ATTRS, attributes: true, childList: true, subtree: true })

  const root = document.getElementById('root')

  if (root) {
    resizeObserver.observe(root)
  }

  window.addEventListener('resize', requestLayout)
  window.addEventListener('orientationchange', requestLayout)
  window.addEventListener('scroll', requestLayout, true)
  window.visualViewport?.addEventListener('resize', requestLayout)
  document.addEventListener('visibilitychange', onVisibility)
  poll = setInterval(requestLayout, POLL_MS)
}

function stop() {
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  resizeObserver = mutationObserver = undefined
  window.removeEventListener('resize', requestLayout)
  window.removeEventListener('orientationchange', requestLayout)
  window.removeEventListener('scroll', requestLayout, true)
  window.visualViewport?.removeEventListener('resize', requestLayout)
  document.removeEventListener('visibilitychange', onVisibility)
  clearInterval(poll)
  poll = undefined
  cancelAnimationFrame(frame)
  frame = 0
}

export function registerGuest(host: GuestHost) {
  if (guests.size === 0) {
    start()
  }

  guests.add(host)
  resizeObserver?.observe(host.element)
  requestLayout()
}

export function unregisterGuest(host: GuestHost) {
  guests.delete(host)
  resizeObserver?.unobserve(host.element)

  if (guests.size === 0) {
    stop()
  }
}

/** Android back: step the visible guest back first, when it has somewhere to go. */
export function goBackOnVisibleGuest(): boolean {
  for (const host of guests) {
    if (host.shown && host.backAvailable) {
      host.goBack()

      return true
    }
  }

  return false
}
