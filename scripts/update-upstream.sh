#!/usr/bin/env bash
# Moves the upstream/ submodule to a Hermes commit and re-syncs the app (cross-platform twin of
# scripts/update-upstream.ps1; it stops after the typecheck, build the APK with gradle or
# scripts/build-apk.ps1).
#
#   scripts/update-upstream.sh                      # follow the Hermes installed on this machine
#   scripts/update-upstream.sh <40-char-sha> <x.y.z>  # pin an explicit commit + the release it belongs to
#
# 1. resolves the commit (installed Hermes HEAD, default ~/.hermes/hermes-agent or $HERMES_INSTALL_ROOT)
# 2. fetches exactly that full SHA from GitHub (`git fetch --depth 1 origin <sha>`)
# 3. checks the submodule out at it, stages the gitlink and mobile/upstream-pin.json (does NOT commit)
# 4. syncs renderer dependencies, then typechecks the bridge against the new upstream types
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="$repo/upstream"
sha="${1:-}"
backend="${2:-}"
installed="${HERMES_INSTALL_ROOT:-${HERMES_HOME:-$HOME/.hermes}/hermes-agent}"

if [[ -z "$sha" ]]; then
  [[ -e "$installed/.git" ]] || { echo "No git checkout at $installed. Pass: $0 <full-sha> <x.y.z>" >&2; exit 1; }
  sha="$(git -C "$installed" rev-parse HEAD)"
  echo "Installed Hermes HEAD: $sha"

  if [[ -z "$backend" && -f "$installed/install-stamp.json" ]]; then
    backend="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^﻿/,'')).baseVersion||'')" "$installed/install-stamp.json")"
  fi
  if [[ -z "$backend" ]] && command -v hermes >/dev/null 2>&1; then
    backend="$(hermes --version 2>/dev/null | head -n1 | sed -nE 's/.*v([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
  fi
fi

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Expected a full 40-character commit SHA, got '$sha'." >&2; exit 1; }
[[ "$backend" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not determine the Hermes release for $sha. Pass it as the 2nd argument (e.g. 0.21.5)." >&2; exit 1; }

# Only initialise an EMPTY submodule; `submodule update` on a populated one would rewind it.
if [[ ! -e "$upstream/.git" ]]; then
  git -C "$repo" submodule update --init --depth 1 upstream
fi

current="$(git -C "$upstream" rev-parse HEAD)"
if [[ "$current" == "$sha" ]]; then
  echo "upstream/ is already at $sha"
else
  echo "upstream/ $current -> $sha"
  git -C "$upstream" fetch --depth 1 origin "$sha"
  git -C "$upstream" checkout --detach "$sha"
  git -C "$repo" add upstream
fi

node "$repo/scripts/upstream-pin.mjs" set --commit "$sha" --backend "$backend"
git -C "$repo" add mobile/upstream-pin.json

cd "$repo"
echo
echo "==> upstream files mobile/ mirrors by hand"
drift=0
node scripts/sync-upstream-deps.mjs --check || drift=1

echo
echo "==> sync renderer dependencies"
node scripts/sync-upstream-deps.mjs

cd mobile
npm install
node ../scripts/link-upstream-modules.mjs

echo
echo "==> typecheck the bridge against the new upstream types"
if ! npx tsc --noEmit -p .; then
  echo "The bridge no longer matches upstream window.hermesDesktop types. Fix mobile/src/bridge/stubs.ts or install.ts, then rerun." >&2
  exit 1
fi

if [[ "$drift" == 1 ]]; then
  echo
  echo "Reminder: upstream vite.config.ts / index.html / global.d.ts changed. Diff them against" >&2
  echo "mobile/vite.config.ts and mobile/index.html and apply what matters." >&2
fi

echo
echo "upstream/ is staged at $sha (Hermes $backend). Next: 'npm run ui:audit' and 'npm run test:e2e' in mobile/, build, commit, bump mobile/package.json and tag a release."
