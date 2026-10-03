# Agent setup prompt

Want an AI to set up the PC side for you? Paste the prompt below into Hermes, Claude Code, Codex or any
coding agent that has terminal access **on the PC that runs Hermes**. It asks before each change, never sees
your password, and stops to let you do the steps only you can do (Tailscale login, creating the password).
Prefer to do it by hand? See the [setup guide](SETUP.md).

````text
You are setting up "Mono Hermes" phone access on THIS computer: a headless `hermes serve` reachable only over
Tailscale. Work step by step. Reply in the user's language, explain each step in plain words, and ask for
approval before ANY change (read-only checks need none). Reference with the same commands: docs/SETUP.md in
github.com/Monoperro0207/mono-hermes.

HARD RULES
- Never see, ask for, invent, type, echo, log or store the user's password; never put a plaintext password
  in an env var, file or command line. Never log in to Tailscale for the user.
- Never print config.yaml (it holds a password hash and a secret). Never stop or modify unrelated Hermes
  services (e.g. the messaging gateway), never run `hermes update` unless asked, never edit unrelated
  config, never touch other firewall rules.
- WAIT means: stop, tell the user exactly what to do, continue only after they confirm.

1. DETECT: OS (Windows/macOS/Linux) and shell. Run `hermes --version` and print it. Not installed -> point
   to https://github.com/NousResearch/hermes-agent#readme and WAIT. The app is tested with Hermes 0.21.5;
   newer usually works (the app shows a notice if the versions differ). Get the binary path for later with
   `Get-Command hermes -All` / `command -v hermes`; if several match (shims, .cmd wrappers), prefer the real
   executable (Windows: `%LOCALAPPDATA%\hermes\bin\hermes.exe`; Linux/macOS: `~/.local/bin/hermes`) and tell the user which you chose.
2. TAILSCALE: run `tailscale status`. Not installed or not logged in -> ask the user to install
   (https://tailscale.com/download) and log in on this PC and on their phone with the same account, then
   WAIT. Get the IPv4 with `tailscale ip -4` (a 100.x.y.z); call it <IP>.
3. LOGIN: check whether a login exists WITHOUT showing secrets. Config file: `hermes config path`.
   Windows: `Select-String -Path <file> -Pattern 'basic_auth:' -Context 0,1`; macOS/Linux:
   `grep -A1 'basic_auth:' <file>`. Only a `username:` line directly after `basic_auth:` counts (that line is
   safe to show); also `grep -c password_hash <file>` must be 1+ (print only the count). If missing, tell the
   user: "In your own terminal run `hermes serve --host 0.0.0.0 --port 9119`, choose [1] Username & password,
   set your password, wait until it says it is running, stop it with Ctrl+C, and tell me when done." WAIT.
   Then re-check. You will use the username only for the final summary.
4. EXISTING SERVER: run `hermes serve --status`. If a server is already running, do NOT start another one.
   If it was started without `--host 0.0.0.0`, ask permission to run `hermes serve --stop` (stops Hermes web
   servers only) so autostart can replace it. Otherwise keep it.
5. AUTOSTART (idempotent: check first; if an equivalent entry exists, change nothing). Command to run at
   login: `<hermes path> serve --host 0.0.0.0 --port 9119 --skip-build`.
   - Windows: check `Get-ScheduledTask -TaskName 'Hermes serve'`. If missing, with approval register a task
     at logon: New-ScheduledTaskAction -Execute <hermes.exe> -Argument 'serve --host 0.0.0.0 --port 9119
     --skip-build'; New-ScheduledTaskTrigger -AtLogOn; New-ScheduledTaskSettingsSet -ExecutionTimeLimit
     ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
     -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName 'Hermes serve'.
     Then `Start-ScheduledTask -TaskName 'Hermes serve'` (only if step 4 left no server running).
   - Linux: check `systemctl --user cat hermes-serve`. If missing, with approval write
     ~/.config/systemd/user/hermes-serve.service: [Unit] Description=Hermes serve, After=network-online.target;
     [Service] ExecStart=<hermes path> serve --host 0.0.0.0 --port 9119 --skip-build, Restart=on-failure;
     [Install] WantedBy=default.target. Then `systemctl --user daemon-reload`,
     `systemctl --user enable --now hermes-serve`; offer `loginctl enable-linger "$USER"`.
   - macOS: check `launchctl list | grep -i hermes`. If missing, with approval write
     ~/Library/LaunchAgents/com.example.hermes-serve.plist with Label com.example.hermes-serve,
     ProgramArguments = absolute hermes path, serve, --host, 0.0.0.0, --port, 9119, --skip-build, plus
     RunAtLoad and KeepAlive true (absolute paths, no "~"). Load: `launchctl bootstrap gui/$(id -u) <plist>`.
6. FIREWALL: port 9119 must be reachable only from Tailscale (100.64.0.0/10). Check existing rules first.
   Give the user the exact command to run themselves with admin rights; run it only if you already have
   admin AND the user approves.
   - Windows (admin PowerShell): New-NetFirewallRule -DisplayName "Hermes 9119 (Tailscale only)" -Direction
     Inbound -Protocol TCP -LocalPort 9119 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any
   - Linux: `sudo ufw allow in on tailscale0 to any port 9119 proto tcp` (if ufw is not used, say so and
     show the iptables equivalent from docs/SETUP.md).
   - macOS: explain the application firewall cannot filter by source; protection is the login gate plus
     Tailscale; offer the optional pf rules in docs/SETUP.md.
7. VERIFY: `hermes serve --status` shows the server. `curl http://<IP>:9119/api/status` must show
   "auth_required": true. `curl -s -o /dev/null -w "%{http_code}" http://<IP>:9119/api/sessions` must print
   401. On failure, name the likely cause (Troubleshooting in docs/SETUP.md) and stop.
8. FINISH with this box (fill in the real values):
   In the Mono Hermes app enter -> Server: http://<IP>:9119 | Username: <username> | Password: the one you
   created. The phone needs Tailscale on. To share sessions live, in the Hermes desktop app open Settings ->
   Gateway -> Remote connection, URL http://127.0.0.1:9119, same login.
````
