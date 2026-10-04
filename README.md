<p align="center"><img src="assets/icon/mono-hermes-poster.jpg" alt="Mono Hermes" width="320"></p>

# Mono Hermes

**The official Hermes desktop UI on your Android device, as a remote client of your own `hermes serve`.
Best on tablets and foldables, works on phones.**

> **Unofficial community project.** Mono Hermes is **not affiliated with, authorized or endorsed by
> Nous Research**. "Hermes", "Hermes Agent" and the original Hermes artwork belong to Nous Research.
> See [NOTICE](NOTICE).

The app runs the unmodified desktop renderer from [hermes-agent](https://github.com/NousResearch/hermes-agent)
and reaches **your own** server over Tailscale. Desktop and Android attach to the same server, so sessions,
streaming turns and history are shared live.

```
 Android (Mono Hermes)                          your PC
 ┌───────────────────────────────┐   Tailscale   ┌──────────────────────────┐
 │ official desktop renderer     │  100.x.y.z    │ hermes serve --host      │
 │ + window.hermesDesktop bridge │ ────────────▶ │   0.0.0.0 --port 9119    │
 └───────────────────────────────┘  REST + WS    │ (also used by desktop)   │
                                                 └──────────────────────────┘
```

## Demo

| Tablet | Phone |
|:---:|:---:|
| <a href="docs/media/mono-hermes-demo.mp4"><img src="docs/media/mono-hermes-demo-preview.gif" alt="Mono Hermes on a tablet (6x preview)" width="300"></a> | <a href="docs/media/mono-hermes-phone-demo.mp4"><img src="docs/media/mono-hermes-phone-demo-preview.gif" alt="Mono Hermes on a phone (4x preview)" width="200"></a> |
| <sub>6x preview. <a href="docs/media/mono-hermes-demo.mp4">Full 1:36 demo</a>, Samsung Galaxy Tab S8 Ultra with the display at 2K resolution (that's why the full desktop layout shows).</sub> | <sub>4x preview. <a href="docs/media/mono-hermes-phone-demo.mp4">Full 1:05 demo</a> on a regular (non-foldable) phone.</sub> |

<sub>Real devices; private content blurred.</sub>

| Cover screen | Sidebar | Unfolded (settings) |
|---|---|---|
| <img src="docs/screenshots/cover-home.png" width="180"> | <img src="docs/screenshots/cover-sidebar.png" width="180"> | <img src="docs/screenshots/inner-settings.png" width="360"> |

## Quick setup

Needs a PC running [Hermes](https://github.com/NousResearch/hermes-agent) with `hermes serve`,
[Tailscale](https://tailscale.com/download) on the PC and the Android device (same tailnet), and Android 7.0+.

- **Step by step** (Windows, macOS, Linux; Tailscale, firewall, autostart, troubleshooting): [docs/SETUP.md](docs/SETUP.md)
- **Let an AI agent do the PC side** (paste one prompt into Hermes, Claude Code, Codex...): [docs/agent-setup-prompt.md](docs/agent-setup-prompt.md)

Then install the APK from [Releases](../../releases), open **Mono Hermes**, enter `http://<pc-tailscale-ip>:9119`
plus your Hermes username and password. To share sessions with the desktop app, point it at the same server
(see [SETUP](docs/SETUP.md#8-share-sessions-with-the-desktop-app)).

## Security

- **Threat model:** your own server, reached only over your tailnet. Nothing is meant to be exposed to the
  public internet, and there is no Mono Hermes cloud: the app talks to the one server you enter.
- **Transport:** the URL is usually plain `http://` inside Tailscale, which encrypts traffic end to end
  (WireGuard). Android's network config cannot express IP ranges, so the app enforces the rule itself
  (`mobile/src/bridge/util.ts`): `http://` is accepted only for Tailscale (`100.64.0.0/10`, `*.ts.net`),
  loopback, private LAN ranges (`10/8`, `172.16/12`, `192.168/16`), `*.local` and single-label names;
  anything else must use `https://`. Over LAN or loopback, `http://` is cleartext on that network. User-installed
  CAs are not trusted.
- **Authentication:** Hermes native password login with PKCE yields a short-lived bearer token plus a rotating
  refresh token; WebSockets use single-use, 30 s tickets. The password is sent once at login and never stored.
- **Stored on the device:** the server URL, the last username (to pre-fill the form) and the token set.
  Tokens are sealed with an AES-GCM key that is non-extractable in WebCrypto and kept in the WebView's
  IndexedDB; the ciphertext sits in Capacitor Preferences (app-private storage). This is **not** backed by
  the Android Keystore or secure hardware: it defeats casual inspection, not a rooted device or code
  running inside the app. Android backup and device transfer of app data are disabled. Moving the tokens to
  Keystore-backed storage is a planned hardening.
- **Permissions:** `INTERNET` (reach your server), `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` (voice input,
  asked at first use), `POST_NOTIFICATIONS` (local "turn finished" notifications). The keep-awake setting adds
  the normal `WAKE_LOCK`.
- **No telemetry:** no analytics, crash reporting or third-party servers in the app. Traffic goes to your
  server, plus pages you or the agent link to (image and link-title fetches). The bundled Hermes UI has its own
  opt-in usage-stats setting; its desktop metrics bridge is not implemented here, so it does nothing on Android.
- **Reporting a vulnerability:** use a private
  [GitHub security advisory](https://github.com/Monoperro0207/mono-hermes/security/advisories/new); see [SECURITY.md](SECURITY.md).

### Verify a release

1. **SHA-256** of the APK matches the value in the release notes (`sha256sum mono-hermes-<version>-release.apk`).
2. **Signer certificate** (needs Android build-tools): `apksigner verify --print-certs mono-hermes-<version>-release.apk`
   must show SHA-256 digest `86de4550a5fc023f2cb55ce0bae2f5d315525207b80335c560cf661ec8c845ce`.
3. **Build provenance** (signed statement that GitHub Actions built this exact file from this repository):
   `gh attestation verify mono-hermes-<version>-release.apk -R Monoperro0207/mono-hermes`

Provenance attestations exist for releases from 0.2.0 on.

## What works and what does not

**Works:** chat and streaming, sessions and history, tool cards, approvals and clarify prompts, settings,
capabilities, artifacts, scheduled jobs, messaging pages, attachments (picker and camera), voice input (needs
the microphone permission and a server STT provider), local notifications while the app is alive, light and dark themes.

**Does not** (desktop-only features, hidden or inert): local backend and updater (the PC owns the backend),
host terminal, filesystem and git panels, the in-app browser or preview pane (links open in the system browser),
HUD, pet overlay, tray, extra windows, Hermes Cloud sign-in, SSH and multiple saved servers (one server only),
push notifications (a fully killed app is not woken by the server), and audio or video seeking
(media is downloaded whole, 64 MB cap).

## Compatibility and updates

The UI inside the app is **frozen per release**: the Hermes desktop UI at one pinned upstream commit. Your
Hermes **server** is yours to update (or fork) when you like. Each release is tested against its pinned Hermes
version and the previous one, and a small dismissible in-app notice appears when your server's version is newer
or older than that (an older server may still work fine). A new release ships when upstream UI changes are
worth integrating or a break is detected (a weekly workflow watches upstream). How it fits together:
[docs/how-it-works.md](docs/how-it-works.md).

| Mono Hermes | UI built from Hermes | Also tested against server |
|---|---|---|
| 0.2.0 | 0.21.5, `158fd638da1629c8e62caf9ade1515d162def8ab` | 0.21.5, `10c6188de188871f64a88dd95bc6b262adb0c307` |
| 0.1.x | 0.21.5, `10c6188de188871f64a88dd95bc6b262adb0c307` | n/a |

## Build from source

Requires Node 22+, JDK 21, Android SDK (platform 36) and Git.

```
git clone --recurse-submodules https://github.com/Monoperro0207/mono-hermes
cd mono-hermes/mobile && npm ci && cd ..
powershell -File scripts/build-apk.ps1 -DebugOnly      # Windows; elsewhere see CONTRIBUTING.md
```

APKs land in `apk/`. A signed release APK needs your own keystore (see `mobile/android/keystore.properties.example`).
Tests, the UI audit and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md). Never edit `upstream/`; phone adaptations live in `mobile/`.

## License

MIT, see [LICENSE](LICENSE). The bundled Hermes UI is MIT (c) Nous Research; the icon is a derivative of
Nous Research artwork, see [NOTICE](NOTICE).
