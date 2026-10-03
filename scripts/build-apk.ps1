<#
.SYNOPSIS
  Builds the Mono Hermes APK: vite build -> cap sync -> gradle assemble.

.DESCRIPTION
  1. links the renderer's node_modules into the submodule view (link-upstream-modules.mjs)
  2. installs mobile/ dependencies when missing
  3. vite build of the desktop renderer + mobile bridge (mobile/dist)
  4. npx cap sync android
  5. gradlew assembleDebug (WebView remote debugging enabled)
  6. gradlew assembleRelease - ONLY when mobile/android/keystore.properties exists.
     No signing material is ever created or stored by this script.

  APKs are copied to <repo>/apk/ (git-ignored) as mono-hermes-<version>-debug.apk / -release.apk,
  where <version> is mobile/package.json "version" (also the Android versionName; Gradle derives
  versionCode from it). The upstream pin (mobile/upstream-pin.json) is verified first.

.PARAMETER SkipWebBuild
  Reuse the existing mobile/dist (skip npm install + vite build).

.PARAMETER DebugOnly
  Never attempt a release build, even when a keystore exists.

.EXAMPLE
  powershell -File scripts/build-apk.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipWebBuild,
  [switch]$DebugOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$mobile = Join-Path $repo 'mobile'
$android = Join-Path $mobile 'android'
$outDir = Join-Path $repo 'apk'

function Invoke-Step([string]$Title, [scriptblock]$Body) {
  Write-Host ""
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Body
  if ($LASTEXITCODE -ne 0) { throw "Step failed: $Title (exit code $LASTEXITCODE)" }
}

# --- toolchain -------------------------------------------------------------
if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
  $jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $jdk) { throw 'JDK 21 not found. Set JAVA_HOME to a JDK 21 install.' }
  $env:JAVA_HOME = $jdk.FullName
}
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $env:ANDROID_HOME)) { throw "Android SDK not found at $($env:ANDROID_HOME). Set ANDROID_HOME." }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
Write-Host "JAVA_HOME    = $($env:JAVA_HOME)"
Write-Host "ANDROID_HOME = $($env:ANDROID_HOME)"

# Gradle needs sdk.dir; forward slashes avoid .properties escape problems.
$localProps = Join-Path $android 'local.properties'
if (-not (Test-Path $localProps)) {
  $sdk = $env:ANDROID_HOME -replace '\\', '/'
  Set-Content -Path $localProps -Value "sdk.dir=$sdk" -Encoding ascii
}

# Single source of truth for the version: mobile/package.json (Gradle reads the same file).
$pkg = Get-Content (Join-Path $mobile 'package.json') -Raw | ConvertFrom-Json
$versionName = $pkg.version

# --- web build ---------------------------------------------------------------
if (-not $SkipWebBuild) {
  if (-not (Test-Path (Join-Path $repo 'upstream\apps\desktop\src'))) {
    throw 'The upstream submodule is empty. Run: git submodule update --init'
  }

  Push-Location $mobile
  try {
    if (-not (Test-Path 'node_modules')) {
      Invoke-Step 'npm install (mobile)' { npm install }
    }
    Invoke-Step 'Verify the upstream pin matches the submodule' { node ../scripts/upstream-pin.mjs check }
    Invoke-Step 'Link renderer dependencies for the submodule' { node ../scripts/link-upstream-modules.mjs }
    Invoke-Step 'Typecheck the bridge against upstream types' { npx tsc --noEmit -p . }
    Invoke-Step 'vite build (desktop renderer + mobile bridge)' { npx vite build }
  } finally { Pop-Location }
}

if (-not (Test-Path (Join-Path $mobile 'dist\index.html'))) { throw 'mobile/dist is missing; run without -SkipWebBuild.' }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$gradle = Join-Path $android 'gradlew.bat'
$built = @()

# --- debug -------------------------------------------------------------------
Push-Location $mobile
try {
  # Debug builds allow chrome://inspect against the WebView.
  $env:HERMES_MOBILE_WEBVIEW_DEBUG = '1'
  Invoke-Step 'cap sync android (debug config)' { npx cap sync android }
} finally { Pop-Location; Remove-Item Env:\HERMES_MOBILE_WEBVIEW_DEBUG -ErrorAction SilentlyContinue }

Push-Location $android
try {
  Invoke-Step 'gradle assembleDebug' { & $gradle assembleDebug --console=plain }
} finally { Pop-Location }

$debugApk = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
Copy-Item $debugApk (Join-Path $outDir "mono-hermes-$versionName-debug.apk") -Force
$built += (Join-Path $outDir "mono-hermes-$versionName-debug.apk")

# --- release (only with a keystore the user supplied) ---------------------------
$keystoreProps = Join-Path $android 'keystore.properties'
if ($DebugOnly) {
  Write-Host 'Skipping release build (-DebugOnly).'
} elseif (Test-Path $keystoreProps) {
  Push-Location $mobile
  try { Invoke-Step 'cap sync android (release config)' { npx cap sync android } } finally { Pop-Location }

  Push-Location $android
  try {
    Invoke-Step 'gradle assembleRelease (signed)' { & $gradle assembleRelease --console=plain }
  } finally { Pop-Location }

  $releaseApk = Join-Path $android 'app\build\outputs\apk\release\app-release.apk'
  Copy-Item $releaseApk (Join-Path $outDir "mono-hermes-$versionName-release.apk") -Force
  $built += (Join-Path $outDir "mono-hermes-$versionName-release.apk")
} else {
  Write-Host ''
  Write-Host 'No mobile/android/keystore.properties - release build skipped.' -ForegroundColor Yellow
  Write-Host 'Copy keystore.properties.example, point it at your own keystore, and run again.'
}

Write-Host ''
Write-Host 'Built:' -ForegroundColor Green
foreach ($apk in $built) {
  $item = Get-Item $apk
  '{0}  ({1:N1} MB)' -f $item.FullName, ($item.Length / 1MB) | Write-Host
}
Write-Host ''
Write-Host "Install on a connected phone:  adb install -r apk\mono-hermes-$versionName-debug.apk"
