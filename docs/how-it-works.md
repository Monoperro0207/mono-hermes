# How Mono Hermes works

`window.hermesDesktop` is the only door the Hermes desktop renderer uses to reach its backend
(`electron/preload.ts`, typed in `src/global.d.ts`). `mobile/src/entry.ts` installs a
Capacitor-backed implementation of it **before** importing the untouched
`upstream/apps/desktop/src/main.tsx`.

| File (`mobile/src/bridge/`) | Concern |
|---|---|
| `install.ts` | Typed composition root. The literal is checked against upstream's `Window['hermesDesktop']`, so a new required member upstream is a **compile error** (drift detection). |
| `auth.ts` | Native bearer login (below), refresh, single-flight rotation. |
| `api.ts` | `api()` = Electron's `hermes:api`: bearer REST, `?profile=` scoping, `"<status>: <body>"` errors. |
| `gateway-ws.ts` | Mints a fresh single-use ticket per WebSocket dial. |
| `platform.ts`, `local-files.ts`, `media.ts` | Browser, clipboard, notifications, mic, keep-awake, downloads/share, file picker, `hermes-media://`. |
| `native-http.ts` | Typed wrapper around the native `BoundedHttp` plugin (below): capped downloads, public-only fetches, cache cleanup. |
| `stubs.ts` | Desktop-only surface (local backend, updater, terminal, git, windows, HUD, Cloud). |
| `connection.ts`, `storage.ts` | The one saved server + tokens sealed with a non-extractable AES-GCM key. |

Outside the bridge: `mobile/src/mobile.css` (phone layout adaptations, each block names the upstream
behaviour it compensates for), `composer-touch.ts` (Enter inserts a newline on touch screens),
`compat.ts` / `compat-notice.ts` (server-version notice), `connect-screen.ts` (login screen).

## Login

The gateway brokers a native-app flow that works for the password provider without a browser:
`GET /auth/native/authorize` (PKCE S256, loopback redirect URI that is never fetched) -> 302 to
`/login` plus a broker cookie -> `POST /auth/password-login` returns the loopback URL carrying
`code`+`state` -> `POST /auth/native/token` yields `access_token`/`refresh_token`. REST then uses
`Authorization: Bearer`, refreshing through `/auth/native/refresh` on expiry or 401. WebSockets use
`POST /api/auth/ws-ticket` -> `/api/ws?ticket=` (30 s, single use, never cached).

## Why native HTTP instead of `fetch`

The WebView origin is `http://localhost`, which the gateway's CORS allows - but its auth gate answers
the credential-less CORS preflight of any authenticated route with 401, so a cross-origin `fetch`
with an `Authorization` header cannot work. The login also needs the raw `Set-Cookie` header and a
non-followed redirect. Capacitor's native HTTP (`HttpURLConnection`) has none of those limits. Plain
`fetch` is only used by the dev harness / tests (`createFetchTransport`).

## Transport policy

Plain `http://` is accepted silently only for Tailscale (`100.64.0.0/10`, `*.ts.net`) and loopback hosts
(`src/bridge/util.ts`, `classifyHost`). LAN hosts (private ranges, link-local, `*.local`, single-label names)
need the user's explicit consent at sign-in: the connect screen shows a warning and a checkbox, and the
accepted base URL is stored with the connection (`lanCleartextAcceptedFor`), so a different LAN address asks
again. Any other `http://` host is refused. Android's network security config cannot express a CIDR range, so
cleartext is allowed there and enforced in the app instead. `https://` works anywhere.

Two other native fetches are bounded by the `BoundedHttp` plugin (next section). Link titles
(`fetchLinkTitle`) only contact public web hosts, follow at most 3 redirects with every hop re-validated, and
read at most 64 KB. Media (`createMediaResolver`) downloads the file natively with the bearer and a hard 64 MB
cap enforced while streaming (no `HEAD` or `Range`; the whole file is fetched before playback), turns the cache
file into one Blob and deletes it. The Blob URLs sit in a strict LRU (128 MB / 24 entries) and are revoked when
evicted; only files playing at that moment are exempt, and an evicted entry that an idle `<audio>`/`<video>`
still references is detached and downloaded again when it plays.

## BoundedHttp (native plugin)

Capacitor's stock `CapacitorHttp` buffers the whole response before returning it to JavaScript, so it cannot
enforce a byte cap while streaming, and it resolves DNS through the system, so a public hostname that rebinds to
a private address cannot be caught. The app therefore ships its own Capacitor plugin,
`mobile/android/app/src/main/java/com/hermesmovil/app/net/` (OkHttp 5.3.2):

| File | Concern |
|---|---|
| `BoundedHttpPlugin.java` | Capacitor bridge (`fetchPublicText`, `download`, `deleteFiles`); refuses any request above the ceilings in `RequestLimits`, and runs the blocking work on a small private pool. |
| `RequestLimits.java` | The hard ceilings, owned by the native side whatever JavaScript asks for: link titles 64 KB and at most 3 redirects; media 64 MB; public-web image downloads 32 MB; gateway file saves 1 GiB. A size above the ceiling, non-finite, fractional or non-positive is refused, never clamped. |
| `BoundedFetcher.java` | The streaming client: byte caps enforced while reading (also when `Content-Length` is larger), a cache-file target for downloads, a free-space check sized to the real download (the announced length plus a 16 MB margin, re-checked every 8 MB while writing, so a small file never needs the ceiling's worth of space), manual redirects (max 3) with every hop re-validated, no system proxy. |
| `PublicOnlyDns.java` | Resolves the host itself and refuses it if **any** answer is non-public; OkHttp then connects only to those validated addresses, which closes DNS rebinding. |
| `AddressPolicy.java` | What counts as public: not loopback, RFC1918, CGNAT (`100.64/10`, so Tailscale), link-local, ULA, multicast, documentation ranges (`2001:db8::/32`, `3fff::/20`), the IETF protocol block `2001::/23` (Teredo, benchmarking, ORCHID), and IPv4-mapped / NAT64 / 6to4 forms that embed a private IPv4. |

Public-only mode is used for link titles and for image saves from any host except the connected server. The
gateway itself (media, file saves, API) is reached with the bearer and without the public-only rule. JVM unit
tests (`AddressPolicyTest`, `PublicOnlyDnsTest`, `BoundedFetcherTest`) run with `./gradlew testDebugUnitTest`
in `mobile/android` and in CI.

## Versions

- App version: `mobile/package.json` `version` (Android versionName; versionCode = major*10000 + minor*100 + patch).
- Pinned Hermes: `mobile/upstream-pin.json` (`commit` + `backendVersion`), written by
  `scripts/update-upstream.*` and verified against the submodule by `scripts/upstream-pin.mjs check`.
  Both reach the app as build-time constants (`mobile/build-constants.ts` -> `src/build-info.ts`).
- Compatibility notice: after connecting, the app reads `version` from `GET /api/status`. If the server
  is newer by a minor/major version, or older than the pinned backend version, it shows one dismissible
  notice (remembered per server version).

## Security notes

- Tokens are sealed with a non-extractable AES-GCM key (IndexedDB) and stored in Preferences; Android
  backup/transfer is disabled. This stops casual inspection, not a rooted device.
- The server only ever sees bearer tokens/tickets; the password is sent once, at login.
- `dashboard.basic_auth` passwords are rate limited by the gateway (10 attempts/minute/IP).
- Keep the server off the LAN: bind `127.0.0.1` behind `tailscale serve` (docs/SETUP.md, Option A), or keep the
  firewall rule limited to the Tailscale range and run `scripts/check-server-exposure.*`.
- The user-facing summary (threat model, permissions, release verification) is in the README's [Security section](../README.md#security); reporting policy in [SECURITY.md](../SECURITY.md).

## UI audit

`npm run ui:audit` (in `mobile/`) drives the REAL renderer (the same bundle the APK ships) in Chromium
with touch + mobile emulation at several phone/foldable/tablet viewports, using a mock OpenAI-compatible
model and a seeded throwaway Hermes home so the real gateway produces streaming turns, approvals, errors,
long threads, tables, code, math, RTL text, and every tool-card kind. Every state in
`ui-audit/scenarios.mjs` is screenshotted into `mobile/ui-audit/screens/<viewport>/` (git-ignored) and
checked in the page: text fit (with [pretext](https://github.com/chenglou/pretext)), horizontal overflow,
off-screen or overlapping controls, touch targets under 44px, hover-only controls, dialogs taller than
the screen, console errors, and soft-keyboard composer visibility.

Output: `ui-audit/REPORT.md` + `report.json`. `ui-audit/waivers.json` lists accepted findings with their
reasons; `ui-audit/baseline.json` is the pre-fix run so the report also lists what was fixed;
`ui-audit/INVENTORY.md` is the screen/state inventory. The report generator redacts the local home
directory from anything it writes. Re-run it after every upstream update: new upstream layout bugs show
up as new issues.

```
cd mobile
npm run ui:audit                         # build + throwaway gateway + Playwright, ~10 min
npm run ui:audit -- --viewports fold-cover,phone --only settings,session-tools
npm run ui:audit -- --no-build           # reuse mobile/dist
```

Real-WebView spot check (emulator or phone, debug APK): `node ui-audit/device-server.mjs` starts the
seeded throwaway gateway for `10.0.2.2`, `node ui-audit/device-shots.mjs cover|inner` drives the app
through its debuggable WebView and saves `adb screencap` images into `ui-audit/device/`.

Native-path smoke (emulator or phone, debug APK): with `device-server.mjs` running, `node ui-audit/device-smoke.mjs`
starts the app from clean data, signs in through the LAN-consent flow and asserts through the WebView debugger
that the `BoundedHttp` plugin is registered, a small `hermes-media://` file downloads natively and plays from a
`blob:` URL, a file over the 64 MiB cap is refused while streaming without crashing the page or the app, a link
title for a private host returns nothing, a public one returns its title, and the native DNS guard rejects a public
name that resolves to loopback and a private IP literal. It prints `ok` / `FAIL` / `WARN` per check, saves a
screenshot for each failure and exits 1 on any failure; `SMOKE_REQUIRE_PUBLIC=1` makes the checks that need the
public internet fatal instead of a warning. CI runs it in the `android-device` job of `ci.yml`: build the debug
APK, start the throwaway gateway, boot an API 34 emulator, install the APK and run the smoke. `release.yml`
calls the whole CI workflow and `needs` it, so a tag cannot publish unless it passes.

```
cd mobile
node ui-audit/device-server.mjs                    # terminal 1 (throwaway gateway)
adb install -r ../apk/mono-hermes-<version>-debug.apk   # debug build (WebView debugging on)
node ui-audit/device-smoke.mjs                     # terminal 2
```

Rotation (issue #2) is checked twice:

- The `rotation` audit scenario swaps the Playwright viewport between portrait and landscape with the
  left sidebar or the right rail toggled in either orientation, and reports `rotation-layout` (high)
  when the page overflows horizontally, the shell does not fill the viewport, a layout column is left
  with no visible pane in it, the chat pane does not span the screen below 640px, or the composer is
  off screen.
- `node ui-audit/device-rotation.mjs [label] [phone,fold-cover,fold-inner,tablet]` uses the real system
  rotation (`adb shell settings put system user_rotation`) on the emulator/phone at four panel sizes
  (`wm size/density`), in seven states (idle, left sidebar or right rail opened in portrait or in
  landscape, soft keyboard up, a live streaming turn, Settings open). After every rotation it applies
  the same checks plus: the viewport follows the rotation, no wide-layout edge overlay stays open,
  the row being typed into stays above the keyboard (with the keyboard up the orientation is read from
  the screen, since the keyboard shrinks the viewport), Settings covers the screen, and returning to an orientation
  gives the same layout as before. Screenshots + JSON go to `ui-audit/device/rotation-<label>-*`; it
  restores auto-rotate and `wm size/density` and exits 1 on any failure.

```
cd mobile
node ui-audit/device-server.mjs                    # terminal 1 (throwaway gateway)
node ui-audit/device-rotation.mjs after            # terminal 2 (debug APK installed)
npm run ui:audit -- --no-build --only rotation
```
