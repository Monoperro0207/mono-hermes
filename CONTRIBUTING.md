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

## Tests

From `mobile/`:

| Command | What it does |
|---|---|
| `npx tsc --noEmit -p .` | Typechecks the bridge against upstream's `window.hermesDesktop` types |
| `npx vitest run` | Unit tests |
| `npm run test:e2e` | Runs the real bridge against a throwaway, isolated `hermes serve` (needs Hermes installed; never touches your own Hermes home or server) |
| `npm run ui:audit` | Drives the real renderer in a phone-sized browser and reports layout problems (see README); re-run after UI/CSS changes |

CI runs typecheck, unit tests, the web build and `assembleDebug` on every push and pull request.

## Releases

1. Make sure CI is green; for a new Hermes version run `scripts/update-upstream.ps1` (or `.sh`), then
   `npm run ui:audit` and `npm run test:e2e`.
2. Bump `version` in `mobile/package.json` (the single source for the app version; the Android
   versionName/versionCode derive from it) and update `docs/release-notes/<version>.md` if you have notes.
3. Tag `v<version>` and push the tag. The `Release` workflow builds the signed APK, checksums it and
   publishes the GitHub Release. It needs the repository secrets `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` (maintainers only).

A weekly `Upstream watch` workflow opens/updates a single `upstream-watch` issue when Hermes `main`
moves away from the pinned commit or breaks the bridge.
