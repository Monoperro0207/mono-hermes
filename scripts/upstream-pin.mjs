#!/usr/bin/env node
// Keeps mobile/upstream-pin.json (the Hermes release the UI is frozen on) in step with the
// upstream/ submodule.
//
//   node scripts/upstream-pin.mjs check                         exit 1 if the pin != submodule HEAD
//   node scripts/upstream-pin.mjs print [--env]                 print the pin (JSON, or KEY=VALUE lines)
//   node scripts/upstream-pin.mjs set --commit <sha> --backend <x.y.z>
//
// The backend version cannot be derived from the (shallow) submodule, so it is recorded
// explicitly: scripts/update-upstream.* read it from the installed Hermes (`hermes --version`
// or its install-stamp.json) and call `set`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pinFile = path.join(root, 'mobile/upstream-pin.json')

const readPin = () => JSON.parse(fs.readFileSync(pinFile, 'utf8'))

function submoduleHead() {
  return execFileSync('git', ['-C', path.join(root, 'upstream'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)

  return i > 0 ? process.argv[i + 1] : undefined
}

const [command = 'check'] = process.argv.slice(2)

if (command === 'check') {
  const pin = readPin()
  const head = submoduleHead()

  if (!/^[0-9a-f]{40}$/.test(pin.commit) || !/^\d+\.\d+\.\d+$/.test(pin.backendVersion)) {
    console.error(`mobile/upstream-pin.json is malformed: ${JSON.stringify(pin)}`)
    process.exit(1)
  }

  if (pin.commit !== head) {
    console.error(
      `mobile/upstream-pin.json pins ${pin.commit} but upstream/ is at ${head}.\n` +
        'Run scripts/update-upstream.* (it records both together).'
    )
    process.exit(1)
  }

  console.log(`pin ok: Hermes ${pin.backendVersion} (${pin.commit.slice(0, 7)})`)
} else if (command === 'print') {
  const pin = readPin()

  if (process.argv.includes('--env')) {
    console.log(`HERMES_PINNED_COMMIT=${pin.commit}\nHERMES_PINNED_VERSION=${pin.backendVersion}`)
  } else {
    console.log(JSON.stringify(pin, null, 2))
  }
} else if (command === 'set') {
  const commit = arg('commit')
  const backend = arg('backend')

  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    console.error('--commit must be a full 40-character SHA')
    process.exit(1)
  }

  if (!/^\d+\.\d+\.\d+$/.test(backend ?? '')) {
    console.error('--backend must look like 0.21.5')
    process.exit(1)
  }

  fs.writeFileSync(pinFile, JSON.stringify({ ...readPin(), backendVersion: backend, commit }, null, 2) + '\n')
  console.log(`pinned Hermes ${backend} (${commit.slice(0, 7)})`)
} else {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
