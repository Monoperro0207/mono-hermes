<#
.SYNOPSIS
  Moves the upstream/ submodule to the commit of the Hermes installed on this PC, then rebuilds.

.DESCRIPTION
  The phone app compiles the official desktop renderer straight from the hermes-agent
  source, and it talks to the `hermes serve` backend on the PC. They must stay on the
  same release or the REST/JSON-RPC contract can drift, so the submodule follows the
  installed Hermes.

  1. reads HEAD of the installed checkout (default %LOCALAPPDATA%\hermes\hermes-agent)
  2. fetches exactly that full SHA from GitHub (the installed checkout is a PARTIAL
     clone, so it cannot be fetched from locally):  git fetch --depth 1 origin <sha>
  3. checks the submodule out at it and stages the new gitlink (it does NOT commit)
     and records commit + backend version in mobile/upstream-pin.json (shown in the app and
     used by its server-compatibility notice)
  4. re-syncs renderer dependencies (mobile/package.json + lockfile seeded from upstream)
  5. reports whether the upstream files mobile/ mirrors by hand have changed
  6. typechecks the bridge against the new global.d.ts, then runs scripts\build-apk.ps1

.PARAMETER Sha
  Use this full 40-character commit instead of the installed Hermes HEAD.

.PARAMETER BackendVersion
  Hermes release (x.y.z) the commit belongs to. Defaults to the installed Hermes' install-stamp.json /
  `hermes --version`; REQUIRED together with -Sha. Recorded in mobile/upstream-pin.json.

.PARAMETER InstalledRoot
  Path of the installed Hermes checkout.

.PARAMETER NoBuild
  Stop after the typecheck; do not build the APK.

.EXAMPLE
  powershell -File scripts/update-upstream.ps1
#>
[CmdletBinding()]
param(
  [string]$Sha,
  [string]$BackendVersion,
  [string]$InstalledRoot = (Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent'),
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$upstream = Join-Path $repo 'upstream'
$mobile = Join-Path $repo 'mobile'

function Git-Upstream { & git -C $upstream @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed in upstream/" } }

if (-not $Sha) {
  if (-not (Test-Path (Join-Path $InstalledRoot '.git'))) { throw "No git checkout at $InstalledRoot. Pass -Sha <full commit> instead." }
  $Sha = (& git -C $InstalledRoot rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Could not read HEAD of $InstalledRoot" }
  Write-Host "Installed Hermes HEAD: $Sha"
}
if ($Sha -notmatch '^[0-9a-f]{40}$') { throw "Expected a full 40-character commit SHA, got '$Sha'." }

# The Hermes release number cannot be derived from the shallow submodule: read it from the installed Hermes.
if (-not $BackendVersion -and -not $PSBoundParameters.ContainsKey('Sha')) {
  $stamp = Join-Path $InstalledRoot 'install-stamp.json'
  if (Test-Path $stamp) { $BackendVersion = [string](Get-Content $stamp -Raw | ConvertFrom-Json).baseVersion }
  if (-not $BackendVersion -and (Get-Command hermes -ErrorAction SilentlyContinue)) {
    $first = (& hermes --version 2>$null | Select-Object -First 1)
    if ($first -match 'v(\d+\.\d+\.\d+)') { $BackendVersion = $Matches[1] }
  }
}
if ($BackendVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Could not determine the Hermes release for $Sha. Pass -BackendVersion x.y.z (e.g. 0.21.5)." }

# Only initialise an EMPTY submodule; `submodule update` on a populated one would rewind it
# to the commit recorded in the superproject index.
if (-not (Test-Path (Join-Path $upstream '.git'))) {
  & git -C $repo submodule update --init --depth 1 upstream
  if ($LASTEXITCODE -ne 0) { throw 'git submodule update --init failed' }
}

$current = (& git -C $upstream rev-parse HEAD).Trim()
if ($current -eq $Sha) {
  Write-Host "upstream/ is already at $Sha"
} else {
  Write-Host "upstream/ $current -> $Sha"
  Git-Upstream fetch --depth 1 origin $Sha
  Git-Upstream checkout --detach $Sha
  & git -C $repo add upstream
}

& node (Join-Path $PSScriptRoot 'upstream-pin.mjs') set --commit $Sha --backend $BackendVersion
if ($LASTEXITCODE -ne 0) { throw 'could not write mobile/upstream-pin.json' }
& git -C $repo add mobile/upstream-pin.json

# Dependency mirror + lockfile seeded from the new upstream lock, then the hand-mirrored files.
Push-Location $repo
try {
  Write-Host ''
  Write-Host '==> upstream files mobile/ mirrors by hand' -ForegroundColor Cyan
  & node scripts/sync-upstream-deps.mjs --check
  $drift = $LASTEXITCODE -ne 0

  Write-Host ''
  Write-Host '==> sync renderer dependencies' -ForegroundColor Cyan
  & node scripts/sync-upstream-deps.mjs
  if ($LASTEXITCODE -ne 0) { throw 'sync-upstream-deps failed' }

  Push-Location $mobile
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    & node ../scripts/link-upstream-modules.mjs
    Write-Host ''
    Write-Host '==> typecheck the bridge against the new upstream types' -ForegroundColor Cyan
    & npx tsc --noEmit -p .
    if ($LASTEXITCODE -ne 0) {
      throw 'The bridge no longer matches upstream window.hermesDesktop types. Fix mobile/src/bridge/stubs.ts or install.ts (new/changed members), then rerun.'
    }
  } finally { Pop-Location }

  if ($drift) {
    Write-Host ''
    Write-Host 'Reminder: upstream vite.config.ts / index.html / global.d.ts changed. Diff them against' -ForegroundColor Yellow
    Write-Host 'mobile/vite.config.ts and mobile/index.html, apply what matters, then the recorded hashes' -ForegroundColor Yellow
    Write-Host 'in mobile/upstream-contract.json are already updated by the sync above.' -ForegroundColor Yellow
  }

  if ($NoBuild) { Write-Host 'Done (build skipped).'; return }

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-apk.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'build-apk failed' }
} finally { Pop-Location }

Write-Host ''
Write-Host "upstream/ is staged at $Sha (Hermes $BackendVersion). Review with 'git status' and commit when ready." -ForegroundColor Green
Write-Host "Next: 'npm run ui:audit' in mobile/ and the e2e suite, then bump mobile/package.json and tag a release." -ForegroundColor Green
