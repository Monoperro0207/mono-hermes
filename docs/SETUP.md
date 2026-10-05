# Setup guide

Get Mono Hermes talking to your own `hermes serve` in about 10 minutes. Prefer to let a coding agent do the
PC side? Use the [agent setup prompt](agent-setup-prompt.md).

Overview: Hermes server on your PC -> Tailscale -> the Mono Hermes app on your phone. Nothing is exposed to
the public internet.

There are two ways to run the server side. **Option A (recommended)** keeps Hermes on `127.0.0.1` and lets
Tailscale Serve publish it over HTTPS inside your tailnet: nothing listens on your LAN, so no firewall rule is
needed. **Option B** binds Hermes to all interfaces and relies on a firewall rule to keep it Tailscale-only.

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
2. On the PC, get its address: `tailscale ip -4` (a `100.x.y.z`). Write it down (Option B uses it).
3. Option A only: in the [Tailscale admin console](https://login.tailscale.com/admin/dns) turn on **MagicDNS** and
   **HTTPS Certificates** (DNS page). Tailscale Serve needs both to give your PC an HTTPS name.

On Windows the CLI is `"C:\Program Files\Tailscale\tailscale.exe"` if `tailscale` is not on your PATH.

## 3. Option A (recommended): loopback + Tailscale Serve

Hermes listens on `127.0.0.1:9119` only. `tailscale serve` publishes it as `https://<pc>.<tailnet>.ts.net`
(a certificate your phone already trusts) to devices on your tailnet. Nothing listens on the LAN, so there is no
firewall rule to get wrong.

1. Publish it. This runs in the background; Tailscale keeps the configuration:

   ```
   tailscale serve --bg 9119
   ```

   It prints your URL, `https://<pc>.<tailnet>.ts.net` (for example `https://my-pc.tail1234.ts.net`). Check it
   any time with `tailscale serve status`. If it says HTTPS certificates are not enabled, redo step 2.3.
   Never use `tailscale funnel` for this: Funnel publishes to the public internet.

2. Tell Hermes its public address. Find the config file with `hermes config path`, and add (or merge into your
   existing `dashboard:` section):

   ```yaml
   dashboard:
     public_url: https://my-pc.tail1234.ts.net
   ```

   Use the exact URL from step 1, without a port or trailing slash. The environment variable
   `HERMES_DASHBOARD_PUBLIC_URL` does the same. Hermes reads it only at startup, so restart the server after
   changing it.

3. Create the login (once, by you). Run this yourself in a normal terminal window:

   ```
   hermes serve --host 127.0.0.1 --port 9119 --skip-build
   ```

   When Hermes asks how to authenticate, choose **[1] Username & password** and pick a strong password. It stores
   a scrypt hash and a stable signing secret in `config.yaml`, so later non-interactive starts (and phone
   sessions) survive restarts. Hermes only asks in an interactive terminal. Once it says it is running, stop it
   with Ctrl+C (autostart below takes over) or keep it.

Why this works: a non-loopback `dashboard.public_url` makes Hermes trust that host name and always engage the
login gate (so the port is never open without credentials), while the app's WebView origin `http://localhost`
is accepted on the WebSocket because the bind is loopback. To undo Option A: `tailscale serve reset`, remove
`public_url`, restart the server.

## 4. Option B: all interfaces + firewall (previous method)

Use this if you cannot use Tailscale Serve (no HTTPS certificates, an older Tailscale, a policy that forbids it).
The app then connects over plain `http://` to your Tailscale address, which Tailscale encrypts end to end.

**Create the login** (once, by you). Run this yourself in a normal terminal window:

```
hermes serve --host 0.0.0.0 --port 9119
```

Choose **[1] Username & password** and a strong password, as in Option A. Any non-loopback bind always engages the
login gate, so the port is never open without credentials. Stop it with Ctrl+C afterwards or keep it.

`--host 0.0.0.0` matters here: the app's WebView origin is `http://localhost`, and without a `public_url` the
gateway only accepts that origin on its WebSocket when bound to all interfaces. That bind also listens on your
LAN, so the firewall below is what keeps it Tailscale-only. It is not optional.

**Firewall: Tailscale only.** Port 9119 must be reachable only from Tailscale (`100.64.0.0/10`).

**Windows** (PowerShell as Administrator):

```powershell
New-NetFirewallRule -DisplayName "Hermes 9119 (Tailscale only)" -Direction Inbound -Protocol TCP -LocalPort 9119 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any
```

If Windows already has a broader Allow rule for `hermes.exe` or `python.exe` (the "allow access" prompt creates
one on first start), remove it. Make sure the Windows Firewall is on for the network profile you use.

**Linux (ufw):**

```bash
sudo ufw allow in on tailscale0 to any port 9119 proto tcp
```

Keep the default "deny incoming". Without ufw, the iptables equivalent is
`sudo iptables -A INPUT -i tailscale0 -p tcp --dport 9119 -j ACCEPT` (and make sure other interfaces drop it).

**macOS:** the built-in application firewall cannot filter by source range, so prefer Option A. Your protection
otherwise is the login gate (always on for `0.0.0.0`) plus Tailscale. Optional hardening with `pf`: put these two
lines in `/etc/pf.anchors/hermes` and load that anchor from `/etc/pf.conf` (review first, a wrong rule can cut you
off):

```
pass in quick proto tcp from 100.64.0.0/10 to any port 9119
block in quick proto tcp from any to any port 9119
```

**Verify (mandatory).** A firewall mistake is silent, so prove it:

1. From a device on the same Wi-Fi with Tailscale **off** (for example your phone on Wi-Fi), open
   `http://<PC LAN IP>:9119`. It must **not** load. If it does, the port is exposed: fix the rule before going on.
2. On the PC, run the read-only check (it changes nothing and needs no admin rights where possible):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\check-server-exposure.ps1
   ```

   ```bash
   scripts/check-server-exposure.sh
   ```

   Exit code 0 is OK, 1 means a likely exposure (it lists the rules), 2 means it could not tell (for example,
   run it from an elevated PowerShell or with `sudo`). Pass another port as the argument (`-Port 9200` /
   `scripts/check-server-exposure.sh 9200`). With Option A it reports loopback only.

## 5. Autostart

Hermes has no official autostart for `serve` (`hermes gateway install` is for the messaging gateway, not for
this). Hermes does recognize a systemd unit named `hermes-serve.service` and launchd jobs running
`hermes serve`, so `hermes update` can restart them. Use these names.

Check first that nothing is already running: `hermes serve --status`. Two servers on port 9119 will clash.

The samples use the Option A arguments (`--host 127.0.0.1`). For Option B use `--host 0.0.0.0` instead. They
only start Hermes: with Option A, `tailscale serve --bg` (step 3) is already persistent.

**Windows** (Scheduled Task at logon, PowerShell, no admin needed):

```powershell
$hermes   = Join-Path $env:LOCALAPPDATA 'hermes\bin\hermes.exe'
# Option B: use 'serve --host 0.0.0.0 --port 9119 --skip-build'
$action   = New-ScheduledTaskAction -Execute $hermes -Argument 'serve --host 127.0.0.1 --port 9119 --skip-build'
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
# Option B: use --host 0.0.0.0
ExecStart=%h/.local/bin/hermes serve --host 127.0.0.1 --port 9119 --skip-build
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now hermes-serve` and, to start without
logging in, `loginctl enable-linger "$USER"`. Adjust `ExecStart` if `command -v hermes` shows another path.

**macOS** (launchd): save as `~/Library/LaunchAgents/com.example.hermes-serve.plist`
(replace `/Users/YOU` with your home folder; launchd does not expand `~`; for Option B put `0.0.0.0` instead of
`127.0.0.1`):

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
    <string>--host</string><string>127.0.0.1</string>
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
2. Option A: `curl https://<pc>.<tailnet>.ts.net/api/status` returns JSON with `"auth_required": true` and a
   `version`, and `curl -i https://<pc>.<tailnet>.ts.net/api/sessions` returns `401` (no login, no data).
   Option B: the same with `http://<tailscale-ip>:9119`.
3. Run the exposure check (`scripts/check-server-exposure.ps1` or `.sh`, see step 4). Option A must report
   "OK" with loopback only.

## 7. Phone

1. Download `mono-hermes-<version>-release.apk` from [GitHub Releases](../../../releases), verify it
   ([how](../README.md#security)) and open it (allow "install unknown apps" once). From a computer you can also run
   `adb install -r mono-hermes-<version>-release.apk`.
2. Turn Tailscale on.
3. Open Mono Hermes and enter the server address:
   - Option A: `https://<pc>.<tailnet>.ts.net` (no port).
   - Option B: `http://<tailscale-ip>:9119` (or the MagicDNS name `my-pc.<tailnet>.ts.net` with `:9119`).

   Then your username and password, and tap **Connect**.

To change server or sign out: **Settings -> Gateway** in the app. If the session is lost (password changed, 30
days idle) the connect screen reappears by itself.

## 8. Share sessions with the desktop app

Sessions are shared live only if the desktop app uses the **same server process**. In the Hermes desktop app:
**Settings -> Gateway -> Remote connection**, URL `http://127.0.0.1:9119`, same username and password (this works
with both options).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| App cannot connect | Tailscale off on phone or PC; server not running (`hermes serve --status`). Option A: use `https://<pc>.<tailnet>.ts.net` with no port and check `tailscale serve status`. Option B: use `http://<tailscale-ip>:9119` (rerun `tailscale ip -4`). If you entered a local-network address (`192.168.x.x`, `10.x.x.x`, `*.local`) the app warns that `http://` is unencrypted there: use the Tailscale address instead. |
| Option A: `tailscale serve` asks to enable HTTPS, or the phone shows a certificate error | Turn on MagicDNS and HTTPS Certificates in the admin console (step 2), run `tailscale serve --bg 9119` again, and use the exact `*.ts.net` name. |
| Option A: the app connects but pages or the WebSocket are refused | `dashboard.public_url` is missing, differs from the URL you typed, or the server was not restarted after editing it (step 3). |
| Option B: `curl` works on the PC but not from the phone | Firewall rule missing or scoped wrong (step 4); server bound to `127.0.0.1` instead of `0.0.0.0`. |
| `check-server-exposure` reports exposure | Follow its findings: narrow or remove the broad Allow rule, turn the firewall on, or switch to Option A. |
| 401 / wrong password | Re-enter the login. Forgot it: stop the server, remove the `dashboard.basic_auth` block from Hermes' `config.yaml`, and create the login again (step 3 or 4). |
| "Server newer/older than the app" notice | Advisory only. Check for a newer Mono Hermes release if things misbehave. |
| Port 9119 already in use | Another server is running: `hermes serve --status`, then `hermes serve --stop` (stops all Hermes web servers) or use another `--port` everywhere. |
| Server stops after reboot or logout | Autostart not set up, or on Linux you need `loginctl enable-linger`. |
| Desktop app shows different sessions | It runs its own backend. Point it at `http://127.0.0.1:9119` (step 8). |
| APK install fails ("conflicts with existing package") | Signature mismatch with a debug build. Uninstall the old app, then install the release APK. |
