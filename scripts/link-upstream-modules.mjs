#!/usr/bin/env node
// Makes `upstream/node_modules` resolve to `mobile/node_modules`.
//
// The desktop renderer is compiled from upstream/apps/desktop/src. Node/Vite
// resolve bare imports ("react", "tailwindcss", "@plugin '@tailwindcss/typography'")
// by walking up from the importing FILE, so upstream sources can only see
// packages installed above them. Rather than running `npm ci` inside the
// submodule (which would pull Electron and native builds), mobile/ installs the
// renderer's dependencies itself and this link exposes them to the submodule.
//
// `node_modules` is git-ignored by upstream (pattern also matches symlinks), so the
// submodule stays clean. Idempotent; safe to run on every build.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join(root, 'mobile/node_modules')
const link = path.join(root, 'upstream/node_modules')

if (!fs.existsSync(target)) {
  console.error('mobile/node_modules is missing. Run: cd mobile && npm install')
  process.exit(1)
}

let existing = null

try {
  existing = fs.lstatSync(link)
} catch {
  // not there yet
}

if (existing) {
  if (existing.isSymbolicLink()) {
    const resolved = fs.realpathSync(link)

    if (resolved === fs.realpathSync(target)) {
      console.log('upstream/node_modules already linked to mobile/node_modules')
      process.exit(0)
    }

    fs.unlinkSync(link)
  } else {
    console.warn(
      'upstream/node_modules is a real directory (someone ran npm install inside the submodule).\n' +
        'Leaving it alone; the mobile build aliases react/react-dom to mobile/node_modules to avoid duplicates.'
    )
    process.exit(0)
  }
}

// "junction" needs no elevated rights on Windows and is ignored elsewhere.
fs.symlinkSync(target, link, 'junction')
console.log('linked upstream/node_modules -> mobile/node_modules')
