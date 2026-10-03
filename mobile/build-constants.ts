/**
 * Build-time constants shared by vite.config.ts and the vitest configs.
 *
 * Single sources of truth:
 *  - app version  -> mobile/package.json "version" (Gradle reads the same file)
 *  - pinned Hermes -> mobile/upstream-pin.json (commit + backend version), kept in
 *    sync with the upstream/ submodule by scripts/update-upstream.* and verified by
 *    scripts/upstream-pin.mjs
 *
 * They reach the app as the globals declared in src/types/build-info.d.ts and are
 * surfaced through src/build-info.ts.
 */
import fs from 'node:fs'
import path from 'node:path'

const mobileRoot = import.meta.dirname

const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(mobileRoot, file), 'utf8')) as Record<string, unknown>

export function buildConstants(): Record<string, string> {
  const pkg = readJson('package.json')
  const pin = readJson('upstream-pin.json')

  return {
    __HERMES_MOBILE_VERSION__: JSON.stringify(String(pkg.version)),
    __HERMES_PINNED_BACKEND_VERSION__: JSON.stringify(String(pin.backendVersion)),
    __HERMES_PINNED_COMMIT__: JSON.stringify(String(pin.commit))
  }
}
