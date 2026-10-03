#!/usr/bin/env node
// Composes the body of the "upstream watch" issue from the files the workflow collected.
//
//   node scripts/upstream-watch-report.mjs <dir>
//
// <dir> contains (all optional, missing = "n/a"):
//   status.json         { pinned, latest, pinnedVersion, latestRelease, typecheck, e2e }   (pass | fail | skipped)
//   stat-desktop.txt    git diff --stat of apps/desktop
//   stat-shared.txt     git diff --stat of apps/shared
//   contract-diff.txt   diff of global.d.ts, gateway-contract.openrpc.json and dashboard_auth
//   typecheck.log       tail of the bridge typecheck against the latest upstream
//   e2e.log             tail of the e2e run against the latest backend
//
// Writes <dir>/body.md and <dir>/result.json { breaking, changed, title }.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]

if (!dir) {
  console.error('usage: upstream-watch-report.mjs <dir>')
  process.exit(2)
}

const read = name => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8').trim()
  } catch {
    return ''
  }
}

const status = JSON.parse(read('status.json') || '{}')
const desktop = read('stat-desktop.txt')
const shared = read('stat-shared.txt')
const contract = read('contract-diff.txt')

const failed = [status.typecheck === 'fail' && 'bridge typecheck', status.e2e === 'fail' && 'e2e suite'].filter(Boolean)
const contractChanged = contract.length > 0
const uiChanged = desktop.length > 0 || shared.length > 0
const breaking = failed.length > 0

const fence = (text, lang = '') => '```' + lang + '\n' + text.slice(-6000) + '\n```'
const icon = value => (value === 'pass' ? 'pass' : value === 'fail' ? '**FAIL**' : 'not run')
const short = sha => String(sha ?? '').slice(0, 7)

const lines = []

lines.push(
  breaking
    ? `**BREAKING:** ${failed.join(' and ')} failed against the latest upstream. The bridge needs attention before this UI can be updated.`
    : uiChanged || contractChanged
      ? 'Upstream changed since the pinned release, but the bridge still typechecks and the e2e suite passes. Review the diff below and decide whether a new Mono Hermes release is worth it.'
      : 'No relevant upstream change since the pinned release.',
  '',
  '| | |',
  '|---|---|',
  `| Pinned | Hermes ${status.pinnedVersion ?? '?'} (\`${short(status.pinned)}\`) |`,
  `| Latest \`main\` | \`${short(status.latest)}\`${status.latestRelease ? ` (latest release tag: ${status.latestRelease})` : ''} |`,
  `| Bridge typecheck vs latest | ${icon(status.typecheck)} |`,
  `| E2E vs latest backend | ${icon(status.e2e)} |`,
  `| Contract files changed | ${contractChanged ? 'yes' : 'no'} |`,
  ''
)

if (contractChanged) {
  lines.push('<details><summary>Contract diff (global.d.ts, gateway-contract.openrpc.json, dashboard_auth)</summary>', '', fence(contract, 'diff'), '', '</details>', '')
}

lines.push('### `apps/desktop` since the pinned commit', '', desktop ? fence(desktop) : '_no changes_', '')
lines.push('### `apps/shared` since the pinned commit', '', shared ? fence(shared) : '_no changes_', '')

if (status.typecheck === 'fail') {
  lines.push('<details><summary>Typecheck output</summary>', '', fence(read('typecheck.log')), '', '</details>', '')
}

if (status.e2e === 'fail') {
  lines.push('<details><summary>E2E output</summary>', '', fence(read('e2e.log')), '', '</details>', '')
}

lines.push(
  '---',
  'Updated automatically by the `upstream-watch` workflow. To adopt the new upstream: `scripts/update-upstream.ps1` (or `.sh`), run `npm run ui:audit` and the e2e suite in `mobile/`, then bump `mobile/package.json` and tag a release.'
)

const title = `${breaking ? '[BREAKING] ' : ''}Upstream watch: Hermes main ${short(status.latest)} vs pinned ${status.pinnedVersion ?? '?'}`

fs.writeFileSync(path.join(dir, 'body.md'), lines.join('\n') + '\n')
fs.writeFileSync(
  path.join(dir, 'result.json'),
  JSON.stringify({ breaking, changed: uiChanged || contractChanged || breaking, title })
)
