# Contributing to Mono Hermes

Thanks for helping! Mono Hermes is an **unofficial** community project (see [NOTICE](NOTICE)).

## Ground rules

- **Never edit `upstream/`.** It is a git submodule of NousResearch/hermes-agent, pinned to one
  commit (`mobile/upstream-pin.json`). Phone adaptations go in `mobile/` (bridge in
  `mobile/src/bridge/`, CSS in `mobile/src/mobile.css`, small runtime pieces in `mobile/src/`).
  Fixes that belong in Hermes itself should be sent to the Hermes project.
- Keep personal data out of everything you commit: home paths, usernames, IPs, device names.
  (`ui-audit` reports redact the user home automatically.)
- Code, comments and docs are in English. Use conventional commits (`feat:`, `fix:`, `docs:` ...).

## Setup

```
git clone --recurse-submodules <your fork>
cd mobile
npm ci
node ../scripts/link-upstream-modules.mjs
```

Requirements: Node 22+, JDK 21 and the Android SDK (platform 36) for APK builds.

Build a debug APK: `powershell -File scripts/build-apk.ps1 -DebugOnly` (Windows; APKs land in `apk/`). On
Linux/macOS run the same steps by hand (see `.github/workflows/ci.yml`): `node ../scripts/link-upstream-modules.mjs`,
`npx tsc --noEmit -p .`, `npx vite build`, `npx cap sync android`, then `./gradlew assembleDebug` in
`mobile/android`. A signed release APK needs your own keystore: copy `mobile/android/keystore.properties.example`
to `keystore.properties` (git-ignored). The app version comes from `mobile/package.json`.

## Tests

From `mobile/`:

| Command | What it does |
|---|---|
| `npx tsc --noEmit -p .` | Typechecks the bridge against upstream's `window.hermesDesktop` types |
| `npx vitest run` | Unit tests |
| `npm run test:e2e` | Runs the real bridge against a throwaway, isolated `hermes serve` (needs Hermes installed; never touches your own Hermes home or server) |
| `npm run ui:audit` | Drives the real renderer in a phone-sized browser (Fold cover/inner, phone, tablet) and reports clipped text, overflow, small touch targets and more into `mobile/ui-audit/REPORT.md`; re-run after UI/CSS changes ([details](docs/how-it-works.md#ui-audit)) |

CI runs typecheck, unit tests (Vitest and the JVM tests of the native plugin), the web build, `assembleDebug`, the
E2E suite and an Android emulator smoke test on every push and pull request.

`main` only accepts changes through a pull request whose three CI jobs passed; direct pushes, force-pushes and
deleting `main` are refused by a repository ruleset. Release tags (`v*`) cannot be moved or deleted, so a bad
release is fixed by the next patch version.

## Updating upstream

```
powershell -File scripts/update-upstream.ps1      # Windows;  scripts/update-upstream.sh elsewhere
```

Moves `upstream/` to the commit of your installed Hermes (or `-Sha <full sha> -BackendVersion x.y.z`) with a
full-SHA `git fetch --depth 1`, records the commit and Hermes version in `mobile/upstream-pin.json`, re-syncs
dependencies and re-typechecks the bridge. It stages the change; you review, run `npm run ui:audit` and the e2e
suite, and commit.

## Releases

1. Make sure CI is green; for a new Hermes version run `scripts/update-upstream.ps1` (or `.sh`), then
   `npm run ui:audit` and `npm run test:e2e`.
2. Bump `version` in `mobile/package.json` (the single source for the app version; the Android
   versionName/versionCode derive from it) and update `docs/release-notes/<version>.md` if you have notes.
3. Tag `v<version>` and push the tag. The `Release` workflow builds the signed APK, checksums it and
   publishes the GitHub Release. It needs the repository secrets `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD` (maintainers only), plus the optional
   repository variable `ANDROID_KEY_ALIAS` (defaults to `mono-hermes`). The workflow also publishes a
   build provenance attestation for the APK (`gh attestation verify`, see the README's Security section).

A weekly `Upstream watch` workflow opens/updates a single `upstream-watch` issue when Hermes `main`
moves away from the pinned commit or breaks the bridge.
