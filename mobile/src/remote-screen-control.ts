/**
 * Who holds the Bot Screen lease, read from upstream's own state instead of its markup.
 *
 * The screen pane keeps a per-bot cache (`$screenState`: lease + this window's viewer identity)
 * and decides `iHold` with `leaseHeldBy` (plugins/hermes-bots/screen-pane.tsx). Reading the same
 * atom and the same predicate keeps the keyboard button in step with the pane without depending on
 * a Tailwind class. The logic here is injected so it tests without the renderer.
 */

/** Minimal structural view of upstream's DisplayLease. */
export interface LeaseLike {
  holder: string
  viewer_hash?: string | null
}

/** Minimal structural view of upstream's ScreenViewer. */
export interface ViewerLike {
  hash: string
}

/** Minimal structural view of upstream's BotScreenState. */
export interface ScreenStateLike<L extends LeaseLike = LeaseLike, V extends ViewerLike = ViewerLike> {
  lease?: L | null
  status?: { lease?: L | null } | null
  viewer?: V | null
}

export interface ScreenControl {
  /** True when this viewer holds the lease of the screen rendered in `host`. */
  inControl(host: Element): boolean
  /** Calls `listener` whenever any bot's screen state changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

/** Pane id prefix of a bot screen (screen-open.tsx `screenPaneId`); the rest is the state key. */
export const SCREEN_PANE_PREFIX = 'plugin-workspace:hermes-bots:screen:'

/** The `$screenState` key of the screen pane that contains `host`, or null when it cannot be told. */
export function screenKeyForHost(host: Element): string | null {
  const id = host.closest('[data-pane-host]')?.getAttribute('data-pane-host')

  return id?.startsWith(SCREEN_PANE_PREFIX) ? id.slice(SCREEN_PANE_PREFIX.length) : null
}

/** Generic over upstream's lease and viewer types so tsc checks `leaseHeldBy` against them, no cast. */
export interface ScreenControlDeps<L extends LeaseLike, V extends ViewerLike> {
  getAll: () => Record<string, ScreenStateLike<L, V>>
  listen: (fn: () => void) => () => void
  heldBy: (lease: L | null, viewer: V | null) => boolean
}

export function createScreenControl<L extends LeaseLike, V extends ViewerLike>(
  deps: ScreenControlDeps<L, V>
): ScreenControl {
  // Mirrors screen-pane.tsx `iHold`: the lease event wins over the one inside the last status.
  const held = (state: ScreenStateLike<L, V> | undefined): boolean =>
    Boolean(state) && deps.heldBy(state?.lease ?? state?.status?.lease ?? null, state?.viewer ?? null)

  return {
    inControl(host) {
      const all = deps.getAll()
      const key = screenKeyForHost(host)

      if (key !== null) {
        return held(all[key])
      }

      // No pane wrapper to name the bot: any screen this viewer holds will do. The gateway's lease
      // filter is the security boundary; this only decides whether to show the keyboard button.
      return Object.values(all).some(held)
    },
    subscribe: listener => deps.listen(listener)
  }
}

/**
 * The real thing. Same module instances as the renderer (one Vite graph), like entry.ts's registry
 * import; a renamed upstream export fails tsc here rather than silently hiding the keyboard.
 */
export async function upstreamScreenControl(): Promise<ScreenControl> {
  const { $screenState } = await import('@/plugins/hermes-bots/screen-state')
  const { leaseHeldBy } = await import('@/plugins/hermes-bots/screen-connection')

  return createScreenControl({
    getAll: () => $screenState.get(),
    heldBy: leaseHeldBy,
    listen: fn => $screenState.listen(() => fn())
  })
}
