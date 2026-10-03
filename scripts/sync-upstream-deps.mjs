#!/usr/bin/env node
// Mirrors the desktop renderer's npm dependencies into mobile/package.json.
//
// The renderer source is compiled straight out of upstream/apps/desktop/src, so
// every bare import inside it has to resolve from mobile/node_modules (see
// link-upstream-modules.mjs). This script keeps the versions in lock-step with
// whatever commit the `upstream/` submodule is pinned to, without ever editing
// upstream. Which packages are needed is discovered by scanning the renderer
// sources for imports, so Electron/Node-only dependencies are left out
// automatically and newly added renderer dependencies are picked up.
//
// Usage: node scripts/sync-upstream-deps.mjs [--check]
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upstreamPkgPath = path.join(root, 'upstream/apps/desktop/package.json')
const mobilePkgPath = path.join(root, 'mobile/package.json')
const contractPath = path.join(root, 'mobile/upstream-contract.json')
const check = process.argv.includes('--check')

// Safety net against a stray renderer import of a Node/Electron-only package.
const SKIP = new Set([
  '@electron/rebuild',
  '@playwright/test',
  'concurrently',
  'cross-env',
  'dbus-native',
  'electron',
  'electron-builder',
  'electron-updater',
  'get-windows',
  'https-proxy-agent',
  'node-pty',
  'proxy-from-env',
  'rcedit',
  'simple-git',
  'tsx',
  'wait-on'
])

// Needed by the build even though no source file imports them by name: CSS-level
// imports/plugins, vite-config-only packages and compile-time tooling.
const ALWAYS = new Set([
  '@babel/core',
  '@rolldown/plugin-babel',
  '@tailwindcss/typography',
  '@tailwindcss/vite',
  '@vitejs/plugin-react',
  'babel-plugin-react-compiler',
  'driver.js',
  'emojibase-data',
  'react',
  'react-dom',
  'tailwindcss',
  'tw-shimmer',
  'typescript',
  'vite',
  'vitest'
])

const upstream = JSON.parse(fs.readFileSync(upstreamPkgPath, 'utf8'))
const upstreamRoot = JSON.parse(fs.readFileSync(path.join(root, 'upstream/package.json'), 'utf8'))
const mobile = JSON.parse(fs.readFileSync(mobilePkgPath, 'utf8'))

const IMPORT_RE = /(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)['"]([^'"]+)['"]/g
const CSS_RE = /@(?:import|plugin)\s+['"]([^'"]+)['"]/g
// Assets referenced by path ("url(../../node_modules/@nous-research/ui/dist/fonts/x.woff2)").
const NODE_MODULES_PATH_RE = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/g

function toPackage(spec) {
  if (/^(\.|\/|@\/|node:|@hermes\/)/.test(spec)) return null

  const parts = spec.split('/')

  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Bare package names imported (JS/TS) or @import/@plugin-ed (CSS) by the renderer + shared sources. */
function scanImportedPackages() {
  const found = new Set()

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(full)
        continue
      }

      if (!/\.(tsx?|css)$/.test(entry.name) || /\.(test|spec)\./.test(entry.name) || entry.name.endsWith('.d.ts')) continue

      const re = entry.name.endsWith('.css') ? CSS_RE : IMPORT_RE

      const text = fs.readFileSync(full, 'utf8')

      for (const match of text.matchAll(re)) {
        const pkg = toPackage(match[1])
        if (pkg) found.add(pkg)
      }

      for (const match of text.matchAll(NODE_MODULES_PATH_RE)) {
        found.add(match[1])
      }
    }
  }

  walk(path.join(root, 'upstream/apps/desktop/src'))
  walk(path.join(root, 'upstream/apps/shared/src'))

  return found
}

const imported = scanImportedPackages()
const isNeeded = name => imported.has(name) || ALWAYS.has(name)

const wanted = { dependencies: {}, devDependencies: {} }

for (const [name, version] of Object.entries(upstream.dependencies ?? {})) {
  if (SKIP.has(name) || name === '@hermes/shared' || !isNeeded(name)) continue
  wanted.dependencies[name] = version
}

for (const [name, version] of Object.entries(upstream.devDependencies ?? {})) {
  if (SKIP.has(name)) continue

  // @types/* follow the package they describe (plus react/node, which tsc always needs).
  const described = name.startsWith('@types/') ? name.slice(7).replace('__', '/') : ''
  const typed = described && (isNeeded(described) || ['node', 'react', 'react-dom'].includes(described))

  if (ALWAYS.has(name) || typed) wanted.devDependencies[name] = version
}

const previouslyManaged = new Set(mobile.hermesMobile?.managed ?? [])
const managed = [...Object.keys(wanted.dependencies), ...Object.keys(wanted.devDependencies)].sort()

for (const section of ['dependencies', 'devDependencies']) {
  mobile[section] ??= {}

  for (const stale of previouslyManaged) {
    if (!managed.includes(stale)) delete mobile[section][stale]
  }

  Object.assign(mobile[section], wanted[section])
  mobile[section] = Object.fromEntries(Object.entries(mobile[section]).sort(([a], [b]) => a.localeCompare(b)))
}

// Upstream pins transitive security fixes through root-level overrides; keep the same floor.
mobile.overrides = upstreamRoot.overrides ?? {}
mobile.hermesMobile = { managed, upstreamDesktopVersion: upstream.version }

const sha = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex').slice(0, 16)

// Files mobile/ mirrors by hand (vite config, index.html) or is typed against
// (global.d.ts). When one changes upstream, review the mirror, then re-run this
// script without --check to record the new hashes.
const contract = {
  files: Object.fromEntries(
    [
      'upstream/apps/desktop/vite.config.ts',
      'upstream/apps/desktop/index.html',
      'upstream/apps/desktop/src/global.d.ts'
    ].map(f => [f, sha(f)])
  ),
  note: 'Hashes of upstream files that mobile/ mirrors by hand. Run scripts/sync-upstream-deps.mjs --check to detect drift.'
}

/**
 * Reproduce upstream's EXACT dependency tree.
 *
 * Declared versions are exact for direct dependencies, but ~700 transitive packages
 * float with semver ranges, and drift matters: a newer @assistant-ui/tap than the
 * one upstream locked makes the chat view loop forever ("getSnapshot should be
 * cached"). So the lockfile is seeded from upstream/package-lock.json: every
 * resolved package (workspace-nested copies of apps/desktop promoted to the top
 * level, exactly as npm would install apps/desktop on its own) overlays whatever
 * mobile/ already locked. `npm install` then keeps those versions, prunes what the
 * renderer does not need (electron, node-pty, ...) and adds the Capacitor packages.
 */
function seedLockfile() {
  const lockPath = path.join(root, 'mobile/package-lock.json')
  const upstreamLock = JSON.parse(fs.readFileSync(path.join(root, 'upstream/package-lock.json'), 'utf8'))
  const existing = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : null
  const packages = { ...(existing?.packages ?? {}) }
  const nestedPrefix = 'apps/desktop/node_modules/'

  for (const [key, entry] of Object.entries(upstreamLock.packages)) {
    if (entry.link) continue

    if (key.startsWith('node_modules/')) {
      packages[key] = entry
    }
  }

  // Applied last: the desktop workspace's own copies win over the hoisted ones.
  for (const [key, entry] of Object.entries(upstreamLock.packages)) {
    if (key.startsWith(nestedPrefix) && !entry.link) {
      packages[`node_modules/${key.slice(nestedPrefix.length)}`] = entry
    }
  }

  packages[''] = {
    dependencies: mobile.dependencies,
    devDependencies: mobile.devDependencies,
    engines: mobile.engines,
    name: mobile.name,
    version: mobile.version
  }

  const sorted = Object.fromEntries(Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)))

  fs.writeFileSync(
    lockPath,
    `${JSON.stringify({ lockfileVersion: 3, name: mobile.name, packages: sorted, requires: true, version: mobile.version }, null, 2)}
`
  )
}

if (check) {
  const recorded = fs.existsSync(contractPath) ? JSON.parse(fs.readFileSync(contractPath, 'utf8')) : { files: {} }
  const drift = Object.entries(contract.files).filter(([f, h]) => recorded.files?.[f] !== h)

  if (drift.length === 0) {
    console.log('upstream contract unchanged')
  } else {
    console.log('upstream files changed since mobile/ was last reviewed:')
    for (const [f] of drift) console.log(`  - ${f}`)
    console.log('Review the mirrors in mobile/, then run: node scripts/sync-upstream-deps.mjs')
    process.exitCode = 1
  }
} else {
  fs.writeFileSync(mobilePkgPath, `${JSON.stringify(mobile, null, 2)}\n`)
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`)
  seedLockfile()
  console.log(`synced ${managed.length} packages from upstream desktop ${upstream.version}; lockfile seeded from upstream/package-lock.json`)
  console.log('Next: cd mobile && npm install')
}
