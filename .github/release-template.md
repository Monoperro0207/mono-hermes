> **Unofficial community project.** Mono Hermes is not affiliated with, endorsed by or sponsored by
> Nous Research. "Hermes" and the original artwork belong to Nous Research.

**Mono Hermes @VERSION@** - an Android client for your own [Hermes](https://github.com/NousResearch/hermes-agent) server.

**Built for Hermes @HERMES_VERSION@** (`@HERMES_COMMIT@`, upstream commit `@HERMES_COMMIT_SHORT@`).
The app UI is frozen on that release; your Hermes server on the PC can update freely. If the server
drifts far from this version the app shows a small notice, and a new Mono Hermes release follows when
upstream desktop UI changes are worth integrating or a compatibility break is detected.

## Install

1. Download `@APK_NAME@` below and open it on your phone (allow "install unknown apps" for your browser/file manager).
2. Make sure Tailscale is connected on the phone, then enter `http://<pc-tailscale-ip>:9119` and your Hermes username/password.

Setup of the server side (Hermes, Tailscale, firewall) is in the [README](https://github.com/@REPOSITORY@#readme).

## Verify the download

SHA-256 of `@APK_NAME@`:

```
@SHA256@
```

The APK is signed with the project release key; `@APK_NAME@.sha256` is attached as well.

## Changes

@NOTES@
