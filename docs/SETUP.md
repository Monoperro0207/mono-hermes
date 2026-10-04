# Setup guide

Get Mono Hermes talking to your own `hermes serve` in about 10 minutes. Prefer to let a coding agent do the
PC side? Use the [agent setup prompt](agent-setup-prompt.md).

Overview: Hermes server on your PC -> Tailscale -> the Mono Hermes app on your phone. Nothing is exposed to
the public internet.

## 1. Prerequisites

1. A PC (Windows, macOS or Linux) and an Android 7.0+ phone with a recent WebView (Chrome 111+).
2. Install Hermes with its official installer ([docs](https://github.com/NousResearch/hermes-agent#readme)):
   `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` (macOS/Linux) or
   `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` (Windows PowerShell).
3. Check it works: `hermes --version`.
4. Compatibility: this app is tested with Hermes **0.21.5**. Newer versions usually work; if your server is
   newer or older by a minor version, the app shows a dismissible notice. Update the app if it keeps happening.

## 2. Tailscale

1. Install [Tailscale](https://tailscale.com/download) on the PC **and** the phone, and log in to the same account.
2. On the PC, get its address: `tailscale ip -4` (a `100.x.y.z`). Write it down.

## 3. Create the login (once, by you)

Run this yourself in a normal terminal window:

```
hermes serve --host 0.0.0.0 --port 9119
```

When Hermes asks how to authenticate, choose **[1] Username & password** and pick a strong password. It stores
a scrypt hash and a stable signing secret in `config.yaml`, so later non-interactive starts (and phone sessions)
survive restarts. Hermes only asks in an interactive terminal, and any non-loopback bind always engages the login
gate, so the port is never open without credentials. Once it says it is running, stop it with Ctrl+C (autostart
below takes over) or keep it.

`--host 0.0.0.0` matters: the app's WebView origin is `http://localhost`, and the gateway only accepts that origin
on its WebSocket when bound to all interfaces. The firewall step below is what keeps it Tailscale-only.

## 4. Firewall: Tailscale only

Port 9119 must be reachable only from Tailscale (`100.64.0.0/10`).

**Windows** (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Hermes 9119 (Tailscale only)" -Direction Inbound -Protocol TCP -LocalPort 9119 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any
```

If Windows already has a broader Allow rule for `hermes.exe` or `python.exe`, remove it.

**Linux (ufw):**

```bash
sudo ufw allow in on tailscale0 to any port 9119 proto tcp
```

Keep the default "deny incoming". Without ufw, the iptables equivalent is
`sudo iptables -A INPUT -i tailscale0 -p tcp --dport 9119 -j ACCEPT` (and make sure other interfaces drop it).

**macOS:** the built-in application firewall cannot filter by source range. Your protection is the login gate
(always on for `0.0.0.0`) plus Tailscale. Optional hardening with `pf`: put these two lines in
`/etc/pf.anchors/hermes` and load that anchor from `/etc/pf.conf` (review first, a wrong rule can cut you off):

```
pass in quick proto tcp from 100.64.0.0/10 to any port 9119
block in quick proto tcp from any to any port 9119
```

## 5. Autostart

Hermes has no official autostart for `serve` (`hermes gateway install` is for the messaging gateway, not for
this). Hermes does recognize a systemd unit named `hermes-serve.service` and launchd jobs running
`hermes serve`, so `hermes update` can restart them. Use these names.

Check first that nothing is already running: `hermes serve --status`. Two servers on port 9119 will clash.

**Windows** (Scheduled Task at logon, PowerShell, no admin needed):

```powershell
$hermes   = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
$action   = New-ScheduledTaskAction -Execute $hermes -Argument 'serve --host 0.0.0.0 --port 9119 --skip-build'
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Hermes serve' -Action $action -Trigger $trigger -Settings $settings
```

Start now: `Start-ScheduledTask -TaskName 'Hermes serve'`. Remove: `Unregister-ScheduledTask -TaskName 'Hermes serve'`.

**Linux** (systemd user unit): save as `~/.config/systemd/user/hermes-serve.service`

```ini
[Unit]
Description=Hermes serve
After=network-online.target

[Service]
ExecStart=%h/.local/bin/hermes serve --host 0.0.0.0 --port 9119 --skip-build
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now hermes-serve` and, to start without
logging in, `loginctl enable-linger "$USER"`. Adjust `ExecStart` if `command -v hermes` shows another path.

**macOS** (launchd): save as `~/Library/LaunchAgents/com.example.hermes-serve.plist`
(replace `/Users/YOU` with your home folder; launchd does not expand `~`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.hermes-serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/bin/hermes</string>
    <string>serve</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>9119</string>
    <string>--skip-build</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/hermes-serve.log</string>
  <key>StandardErrorPath</key><string>/tmp/hermes-serve.log</string>
</dict>
</plist>
```

Load: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.hermes-serve.plist`.
Unload: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.hermes-serve.plist`.

## 6. Verify on the PC

1. `hermes serve --status` lists the server.
2. `curl http://<tailscale-ip>:9119/api/status` returns JSON with `"auth_required": true` and a `version`.
3. `curl -i http://<tailscale-ip>:9119/api/sessions` returns `401` (no login, no data).

## 7. Phone

1. Download `mono-hermes-<version>-release.apk` from [GitHub Releases](../../../releases), verify it
   ([how](../README.md#security)) and open it (allow "install unknown apps" once). From a computer you can also run
   `adb install -r mono-hermes-<version>-release.apk`.
2. Turn Tailscale on.
3. Open Mono Hermes, enter `http://<tailscale-ip>:9119` (or the MagicDNS name `my-pc.<tailnet>.ts.net`), your
   username and password, tap **Connect**.

To change server or sign out: **Settings -> Gateway** in the app. If the session is lost (password changed, 30
days idle) the connect screen reappears by itself.

## 8. Share sessions with the desktop app

Sessions are shared live only if the desktop app uses the **same server process**. In the Hermes desktop app:
**Settings -> Gateway -> Remote connection**, URL `http://127.0.0.1:9119`, same username and password.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| App cannot connect | Tailscale off on phone or PC; wrong IP (rerun `tailscale ip -4`); server not running (`hermes serve --status`); the URL must be `http://`, not `https://`. If you entered a local-network address (`192.168.x.x`, `10.x.x.x`, `*.local`) the app warns that `http://` is unencrypted there: use the Tailscale address (`100.x.y.z`) instead. |
| `curl` works on the PC but not from the phone | Firewall rule missing or scoped wrong (step 4); server bound to `127.0.0.1` instead of `0.0.0.0`. |
| 401 / wrong password | Re-enter the login. Forgot it: stop the server, remove the `dashboard.basic_auth` block from Hermes' `config.yaml`, and redo step 3. |
| "Server newer/older than the app" notice | Advisory only. Check for a newer Mono Hermes release if things misbehave. |
| Port 9119 already in use | Another server is running: `hermes serve --status`, then `hermes serve --stop` (stops all Hermes web servers) or use another `--port` everywhere. |
| Server stops after reboot or logout | Autostart not set up, or on Linux you need `loginctl enable-linger`. |
| Desktop app shows different sessions | It runs its own backend. Point it at `http://127.0.0.1:9119` (step 8). |
| APK install fails ("conflicts with existing package") | Signature mismatch with a debug build. Uninstall the old app, then install the release APK. |
