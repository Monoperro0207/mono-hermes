/**
 * Desktop-only panes leave the layout tree.
 *
 * The Terminal pane needs a node-pty PTY on the machine running the renderer; the phone has
 * none. mobile.css used to hide only its DOM (`[data-tree-group='grp-terminal']`), but the
 * renderer's layout tree still counted the pane: it is NOT `collapsible`, so below the 640px
 * sidebar breakpoint it stays in the grid while the files / review panes beside it turn into
 * edge overlays. Once "Show right sidebar" restores the terminal zone (it does that in
 * landscape), rotating back to portrait left the right column alive with nothing visible in it:
 * a blank 111px strip squeezing the chat (main 301 of 412px), or a 28px one while the zone is
 * minimized, until the app was restarted (GitHub issue #2).
 *
 * The fix is to tell the renderer the truth: the terminal contribution is soft-disabled
 * (`enabled: false`, the registry's own switch), so every tree split treats its zone as gone
 * (tree-split.tsx `paneGone`: "a pane leaves the grid when its contribution isn't registered")
 * and the neighbours absorb its space at every size and orientation. Re-registrations by the
 * renderer are disabled again as they happen.
 */

import type { Contribution } from '@/contrib/types'

export const DESKTOP_ONLY_PANES: readonly string[] = ['terminal']

/** The slice of upstream's ContributionRegistry (contrib/registry.ts) this needs. */
export interface PaneRegistry {
  /** Enabled entries only (the registry filters `enabled: false` out). */
  getArea(area: string): readonly Contribution[]
  register(contribution: Contribution): () => void
  subscribe(listener: () => void): () => void
}

/** Soft-disable every enabled desktop-only pane. Returns the ids it disabled. */
export function disableDesktopOnlyPanes(registry: PaneRegistry, ids: readonly string[] = DESKTOP_ONLY_PANES): string[] {
  const live = registry.getArea('panes').filter(pane => ids.includes(pane.id))

  for (const pane of live) {
    registry.register({ ...pane, enabled: false })
  }

  return live.map(pane => pane.id)
}

/** Disable now and whenever the renderer (re-)registers one of them. Returns a disposer. */
export function installDesktopOnlyPanes(registry: PaneRegistry, ids: readonly string[] = DESKTOP_ONLY_PANES): () => void {
  disableDesktopOnlyPanes(registry, ids)

  // Our own register() call notifies again; by then the pane is filtered out, so this settles.
  return registry.subscribe(() => {
    disableDesktopOnlyPanes(registry, ids)
  })
}
