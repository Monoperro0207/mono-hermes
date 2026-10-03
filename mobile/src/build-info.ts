/**
 * What this build is: the app version and the Hermes release its UI was frozen on.
 * The values are generated at build time from mobile/package.json and
 * mobile/upstream-pin.json (see build-constants.ts).
 */

export interface BuildInfo {
  /** Mono Hermes version (mobile/package.json). */
  appVersion: string
  /** Full commit of NousResearch/hermes-agent the bundled UI was built from. */
  pinnedCommit: string
  /** Hermes backend release that commit belongs to, e.g. "0.21.5". */
  pinnedBackendVersion: string
}

export const buildInfo: BuildInfo = {
  appVersion: __HERMES_MOBILE_VERSION__,
  pinnedBackendVersion: __HERMES_PINNED_BACKEND_VERSION__,
  pinnedCommit: __HERMES_PINNED_COMMIT__
}
