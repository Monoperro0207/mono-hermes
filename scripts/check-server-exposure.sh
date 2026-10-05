#!/usr/bin/env bash
# Read-only check: is the Hermes server port reachable from more than Tailscale? (Linux / macOS)
#
#   scripts/check-server-exposure.sh [port]        # default 9119
#
# Lists the local addresses the port listens on and classifies them:
#   loopback only            -> OK (only reachable locally or through Tailscale Serve)
#   Tailscale address only   -> OK
#   0.0.0.0 / :: / LAN IP    -> looks at the firewall (Linux: ufw; macOS: explains the limits of the
#                               application firewall and reads pf rules when it can)
# It changes nothing and prints no secrets. `sudo -n` is only tried for read-only firewall listings and
# never prompts. Exit code: 0 = OK, 1 = likely exposure found, 2 = undetermined.

set -u

PORT="${1:-9119}"
case "$PORT" in
  '' | *[!0-9]*) echo "usage: $0 [port]" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "usage: $0 [port]  (1-65535)" >&2
  exit 2
fi

verdict() { # level message
  printf '\n%s: %s\n' "$1" "$2"
}

# ---------- 1. who listens on the port ----------------------------------------------------------

addrs=''
tool=''
if command -v ss >/dev/null 2>&1; then
  tool='ss'
  # Local Address:Port is column 4. `ss` prints * for the wildcard and [addr] for IPv6.
  addrs="$(ss -H -ltn "sport = :$PORT" 2>/dev/null | awk '{print $4}')" || addrs=''
elif command -v lsof >/dev/null 2>&1; then
  tool='lsof'
  # NAME column looks like *:9119, 127.0.0.1:9119 or [::1]:9119 (followed by "(LISTEN)").
  addrs="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p')" || addrs=''
else
  verdict UNKNOWN "neither 'ss' nor 'lsof' is available, so the listening addresses cannot be read. Install iproute2 (ss) or lsof and run this again."
  exit 2
fi

# Strip the port, the brackets and any %interface suffix; the wildcard * becomes 0.0.0.0.
normalize() {
  local a="${1%:*}"
  a="${a#\[}"
  a="${a%]}"
  a="${a%%\%*}"
  [ "$a" = '*' ] && a='0.0.0.0'
  printf '%s' "$a"
}

kind_of() {
  local a="$1" b c
  case "$a" in
    0.0.0.0 | '::') echo wildcard; return ;;
    127.* | ::1 | ::ffff:127.*) echo loopback; return ;;
    fd7a:115c:a1e0:*) echo tailnet; return ;;
  esac
  case "$a" in
    *.*.*.*)
      b="${a#*.}"; b="${b%%.*}"
      c="${a%%.*}"
      case "$b" in '' | *[!0-9]*) echo other; return ;; esac
      # 100.64.0.0/10 = 100.64.x.x to 100.127.x.x
      if [ "$c" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ]; then echo tailnet; return; fi
      ;;
  esac
  echo other
}

# Deduplicate while keeping order.
list="$(printf '%s\n' "$addrs" | while IFS= read -r line; do
  [ -n "$line" ] && normalize "$line" && printf '\n'
done | awk 'NF && !seen[$0]++')"

if [ -z "$list" ]; then
  verdict UNKNOWN "nothing listens on port $PORT (checked with $tool). Start the server (hermes serve ...) and run this again."
  exit 2
fi

echo "Checking TCP port $PORT (read-only, via $tool)..."
reachable=0
saw_tailnet=0
while IFS= read -r a; do
  k="$(kind_of "$a")"
  case "$a" in *:*) shown="[$a]:$PORT" ;; *) shown="$a:$PORT" ;; esac
  echo "  listening on $shown  [$k]"
  case "$k" in wildcard | other) reachable=1 ;; tailnet) saw_tailnet=1 ;; esac
done <<EOF
$list
EOF

if [ "$reachable" -eq 0 ]; then
  if [ "$saw_tailnet" -eq 1 ]; then
    verdict OK 'the port is bound to a Tailscale address (and/or loopback) only; nothing else can reach it.'
  else
    verdict OK 'the port is bound to loopback only. It is reachable locally or through Tailscale Serve, not from the LAN.'
  fi
  exit 0
fi

# ---------- 2. wildcard / LAN bind: look at the firewall ----------------------------------------

echo
echo 'The port is bound beyond loopback. Looking at the firewall...'

confirm_hint="Confirm from another device on the same Wi-Fi with Tailscale OFF: http://<PC LAN IP>:$PORT must not load."

# Runs a read-only command directly, or through a non-interactive sudo; prints nothing on failure.
read_only() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@" 2>/dev/null
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n "$@" 2>/dev/null
  else
    return 1
  fi
}

case "$(uname -s)" in
  Darwin)
    echo "  macOS: the built-in application firewall filters by program, not by source address, so it"
    echo "  cannot limit port $PORT to Tailscale (100.64.0.0/10)."
    pf="$(read_only pfctl -sr)" || pf=''
    if [ -n "$pf" ]; then
      if printf '%s\n' "$pf" | grep -Eq "block.*port[ =]+\"?$PORT\"?"; then
        verdict OK "a pf rule blocks port $PORT (check that it only lets 100.64.0.0/10 through). $confirm_hint"
        exit 0
      fi
      verdict EXPOSED "port $PORT is bound beyond loopback and no pf rule blocks it. Use the loopback + Tailscale Serve setup (docs/SETUP.md, Option A), or add the pf rules from Option B."
      echo "$confirm_hint"
      exit 1
    fi
    verdict UNKNOWN "port $PORT is bound beyond loopback and pf rules could not be read without sudo. Without pf it is reachable from your local network (the Hermes login still applies). Prefer the loopback + Tailscale Serve setup (docs/SETUP.md, Option A). $confirm_hint"
    exit 2
    ;;
esac

# Linux
if command -v ufw >/dev/null 2>&1; then
  status="$(read_only ufw status verbose)" || status=''
  if [ -z "$status" ]; then
    verdict UNKNOWN "ufw is installed but its status needs root. Run: sudo ufw status verbose  (look for rules on port $PORT that are not limited to tailscale0 or 100.64.0.0/10). $confirm_hint"
    exit 2
  fi
  if printf '%s\n' "$status" | grep -qi '^Status: inactive'; then
    verdict EXPOSED "ufw is installed but inactive, so port $PORT is open on every interface (unless iptables/nftables rules exist elsewhere). Enable ufw with the Tailscale-only rule from docs/SETUP.md, or use Option A."
    echo "$confirm_hint"
    exit 1
  fi
  exposed=''
  limited=''
  while IFS= read -r line; do
    printf '%s\n' "$line" | grep -Eiq "(^|[^0-9])$PORT(/tcp)?([^0-9]|$)" || continue
    printf '%s\n' "$line" | grep -q 'ALLOW' || continue
    if printf '%s\n' "$line" | grep -Eq 'tailscale0|100\.64\.0\.0/10'; then
      limited="$limited
  $line"
    else
      exposed="$exposed
  $line"
    fi
  done <<EOF
$status
EOF
  # A rule that allows everything on tailscale0 (no port) is fine and is not listed above.
  if printf '%s\n' "$status" | grep -Eiq '^Default:.*allow \(incoming\)'; then
    exposed="$exposed
  Default incoming policy is allow"
  fi
  if [ -n "$exposed" ]; then
    echo 'Findings (ufw rules not limited to Tailscale):'
    printf '%s\n' "$exposed"
    verdict EXPOSED "port $PORT is likely reachable from your local network. Limit it with: sudo ufw allow in on tailscale0 to any port $PORT proto tcp (and delete the broader rule), or use Option A."
    echo "$confirm_hint"
    exit 1
  fi
  if [ -n "$limited" ]; then
    echo 'ufw rules limited to Tailscale:'
    printf '%s\n' "$limited"
    verdict OK "ufw limits port $PORT to Tailscale. $confirm_hint"
  else
    verdict OK "ufw is active with a default deny and no rule opens port $PORT, so nothing can reach it, Tailscale included. If the phone cannot connect, add: sudo ufw allow in on tailscale0 to any port $PORT proto tcp, or use Option A."
  fi
  exit 0
fi

# No ufw: show what can be read, but do not guess.
for tool_name in nft iptables; do
  if command -v "$tool_name" >/dev/null 2>&1; then
    echo "  $tool_name is present; its rules were not evaluated (check them with: sudo $tool_name -S INPUT  or  sudo nft list ruleset)."
  fi
done
verdict UNKNOWN "port $PORT is bound beyond loopback and no ufw was found, so the firewall cannot be judged automatically. Make sure inbound $PORT is accepted only on tailscale0 / 100.64.0.0/10 (docs/SETUP.md, Option B), or bind to 127.0.0.1 and use Tailscale Serve (Option A). $confirm_hint"
exit 2
