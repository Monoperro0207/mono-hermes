/**
 * Server/app compatibility check.
 *
 * The UI inside this app is frozen on one Hermes release (mobile/upstream-pin.json) while
 * the user's `hermes serve` updates freely on the PC. When the server drifts far enough
 * from what this build was tested with, a small dismissible notice suggests checking for
 * an app update. It is advisory only: nothing is blocked.
 */

export type CompatVerdict = 'compatible' | 'server-newer' | 'server-older' | 'unknown'

export interface SemVer {
  major: number
  minor: number
  patch: number
}

/**
 * Parses "0.21.5", "v0.21.5", "0.21.5+5683.g10c6188" or "0.21.5-rc.1".
 * Anything that does not start with major.minor.patch (e.g. "unknown") yields null.
 */
export function parseVersion(raw: string | null | undefined): SemVer | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?![\d.])/.exec(String(raw ?? ''))

  if (!match) {
    return null
  }

  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * - server NEWER by at least a minor (or major) version  -> "server-newer"
 * - server OLDER than the pinned version (any component)  -> "server-older"
 * - same release, or only a newer patch                    -> "compatible"
 * - either side unparseable                                -> "unknown" (stay quiet)
 */
export function assessCompat(serverVersion: string | null | undefined, pinnedVersion: string): CompatVerdict {
  const server = parseVersion(serverVersion)
  const pinned = parseVersion(pinnedVersion)

  if (!server || !pinned) {
    return 'unknown'
  }

  if (server.major !== pinned.major) {
    return server.major > pinned.major ? 'server-newer' : 'server-older'
  }

  if (server.minor !== pinned.minor) {
    return server.minor > pinned.minor ? 'server-newer' : 'server-older'
  }

  return server.patch < pinned.patch ? 'server-older' : 'compatible'
}

/** The user-facing sentence, or null when nothing should be shown. */
export function compatMessage(verdict: CompatVerdict, serverVersion: string, pinnedVersion: string): string | null {
  const server = parseVersion(serverVersion)
  const shown = server ? `${server.major}.${server.minor}.${server.patch}` : serverVersion

  if (verdict === 'server-newer') {
    return `Your Hermes server (v${shown}) is newer than this app was tested with (v${pinnedVersion}). If something misbehaves, check for a Mono Hermes update.`
  }

  if (verdict === 'server-older') {
    return `Your Hermes server (v${shown}) is older than this app was built for (v${pinnedVersion}). It may still work fine; if something misbehaves, update Hermes on your PC or install an older Mono Hermes release.`
  }

  return null
}

/** Minimal storage surface (Storage-compatible) so the dismissal logic is testable. */
export interface DismissStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DISMISSED_KEY = 'hermes.mobile.compat.dismissed.v1'

function readDismissed(store: DismissStore): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(DISMISSED_KEY) ?? '[]')

    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** Dismissal is remembered per exact server version (and per the app's pinned version). */
const dismissalId = (serverVersion: string, pinnedVersion: string) => `${serverVersion}@${pinnedVersion}`

export function isDismissed(store: DismissStore, serverVersion: string, pinnedVersion: string): boolean {
  return readDismissed(store).includes(dismissalId(serverVersion, pinnedVersion))
}

export function rememberDismissal(store: DismissStore, serverVersion: string, pinnedVersion: string): void {
  try {
    const next = new Set(readDismissed(store))
    next.add(dismissalId(serverVersion, pinnedVersion))
    store.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-20)))
  } catch {
    // storage unavailable: the notice simply reappears next launch
  }
}

/** What to show for a server version right now, or null. Pure; the DOM lives in compat-notice.ts. */
export function pendingNotice(
  store: DismissStore,
  serverVersion: string | null | undefined,
  pinnedVersion: string
): { message: string; serverVersion: string } | null {
  if (!serverVersion) {
    return null
  }

  const message = compatMessage(assessCompat(serverVersion, pinnedVersion), serverVersion, pinnedVersion)

  if (!message || isDismissed(store, serverVersion, pinnedVersion)) {
    return null
  }

  return { message, serverVersion }
}
