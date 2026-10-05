<#
.SYNOPSIS
  Read-only check: is the Hermes server port reachable from more than Tailscale?

.DESCRIPTION
  Lists the local addresses the port listens on and classifies them:
    - loopback only            -> OK (only reachable locally or through Tailscale Serve)
    - Tailscale address only   -> OK
    - 0.0.0.0 / :: / LAN IP    -> inspects the Windows Firewall (inbound Allow rules that cover the
                                  port, or a program rule for hermes.exe / python.exe) and flags every
                                  rule whose RemoteAddress is not limited to 100.64.0.0/10.
  It changes nothing, needs no administrator rights and prints no secrets (only addresses, rule
  names and process names).

  Exit code: 0 = OK, 1 = likely exposure found, 2 = undetermined.

.PARAMETER Port
  TCP port of `hermes serve` (default 9119).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\check-server-exposure.ps1
  powershell -ExecutionPolicy Bypass -File scripts\check-server-exposure.ps1 -Port 9200
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 9119
)

$ErrorActionPreference = 'Stop'

# ---------- helpers ----------------------------------------------------------------------------

function ConvertTo-Ip4Number([string]$Ip) {
  $addr = $null
  if (-not [System.Net.IPAddress]::TryParse($Ip, [ref]$addr)) { return $null }
  $b = $addr.GetAddressBytes()
  if ($b.Length -ne 4) { return $null }
  return ([long]$b[0] * 16777216) + ([long]$b[1] * 65536) + ([long]$b[2] * 256) + [long]$b[3]
}

$TailLo = ConvertTo-Ip4Number '100.64.0.0'
$TailHi = ConvertTo-Ip4Number '100.127.255.255'

function Test-TailnetV4([string]$Ip) {
  $n = ConvertTo-Ip4Number $Ip
  return ($null -ne $n) -and ($n -ge $TailLo) -and ($n -le $TailHi)
}

function Get-AddressKind([string]$Raw) {
  $a = ($Raw -split '%')[0].Trim().ToLowerInvariant()
  if ($a -eq '0.0.0.0' -or $a -eq '::') { return 'wildcard' }
  if ($a -eq '::1' -or $a.StartsWith('127.')) { return 'loopback' }
  if (Test-TailnetV4 $a) { return 'tailnet' }
  if ($a.StartsWith('fd7a:115c:a1e0:')) { return 'tailnet' }   # Tailscale IPv6 range
  return 'other'
}

# True only if EVERY entry of a firewall RemoteAddress list lies inside 100.64.0.0/10.
function Test-RemoteLimitedToTailnet($Entries) {
  $list = @($Entries | Where-Object { $_ })
  if ($list.Count -eq 0) { return $false }
  foreach ($e in $list) {
    $s = ([string]$e).Trim()
    $lo = $null; $hi = $null
    if ($s -match '^(\d+\.\d+\.\d+\.\d+)/(\d{1,2})$') {
      $base = ConvertTo-Ip4Number $Matches[1]
      if ($null -eq $base) { return $false }
      $mask = ([long]4294967295 -shl (32 - [int]$Matches[2])) -band [long]4294967295
      $lo = $base -band $mask
      $hi = $lo -bor ([long]4294967295 -bxor $mask)
    } elseif ($s -match '^(\d+\.\d+\.\d+\.\d+)/(\d+\.\d+\.\d+\.\d+)$') {
      $base = ConvertTo-Ip4Number $Matches[1]
      $mask = ConvertTo-Ip4Number $Matches[2]
      if ($null -eq $base -or $null -eq $mask) { return $false }
      $lo = $base -band $mask
      $hi = $lo -bor ([long]4294967295 -bxor $mask)
    } elseif ($s -match '^(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)$') {
      $lo = ConvertTo-Ip4Number $Matches[1]
      $hi = ConvertTo-Ip4Number $Matches[2]
    } elseif ($s -match '^\d+\.\d+\.\d+\.\d+$') {
      $lo = ConvertTo-Ip4Number $s
      $hi = $lo
    } else {
      return $false   # Any, LocalSubnet, Internet, Intranet, IPv6 ranges, ...: not limited
    }
    if ($null -eq $lo -or $null -eq $hi) { return $false }
    if ($lo -lt $TailLo -or $hi -gt $TailHi) { return $false }
  }
  return $true
}

function Test-PortListMatches($Ports, [int]$Target) {
  foreach ($p in @($Ports)) {
    $s = ([string]$p).Trim()
    if ($s -eq [string]$Target) { return $true }
    if ($s -match '^(\d+)-(\d+)$' -and [int]$Matches[1] -le $Target -and $Target -le [int]$Matches[2]) { return $true }
  }
  return $false
}

function Write-Verdict([string]$Level, [string]$Message) {
  $color = @{ OK = 'Green'; EXPOSED = 'Red'; UNKNOWN = 'Yellow' }[$Level]
  Write-Host ''
  Write-Host ("{0}: {1}" -f $Level, $Message) -ForegroundColor $color
}

# ---------- 1. who listens on the port ---------------------------------------------------------

Write-Host "Checking TCP port $Port (read-only)..."

try {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
} catch {
  Write-Verdict 'UNKNOWN' "could not read the listening sockets ($($_.Exception.Message))."
  exit 2
}

if ($listeners.Count -eq 0) {
  Write-Verdict 'UNKNOWN' "nothing listens on port $Port. Start the server (hermes serve ...) and run this again."
  exit 2
}

$kinds = @{}
$owners = @{}
foreach ($c in $listeners) {
  $kind = Get-AddressKind $c.LocalAddress
  $kinds[$c.LocalAddress] = $kind
  $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  $name = if ($proc) { $proc.ProcessName } else { "pid $($c.OwningProcess)" }
  $owners[$name] = $true
  Write-Host ("  listening on {0}:{1}  [{2}]  process: {3}" -f $c.LocalAddress, $Port, $kind, $name)
}

$kindSet = @($kinds.Values | Sort-Object -Unique)
$reachableKinds = @($kindSet | Where-Object { $_ -in @('wildcard', 'other') })

if ($reachableKinds.Count -eq 0) {
  if ($kindSet -contains 'tailnet') {
    Write-Verdict 'OK' 'the port is bound to a Tailscale address (and/or loopback) only; nothing else can reach it.'
  } else {
    Write-Verdict 'OK' 'the port is bound to loopback only. It is reachable locally or through Tailscale Serve, not from the LAN.'
  }
  exit 0
}

# ---------- 2. wildcard / LAN bind: look at the firewall ---------------------------------------

Write-Host ''
Write-Host 'The port is bound beyond loopback. Inspecting the Windows Firewall (inbound Allow rules)...'

try {
  $profiles = @(Get-NetFirewallProfile)
  $rules = @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True)
  # Without elevation some filters can be unreadable: keep what can be read and say so below.
  $portFilters = @{}
  Get-NetFirewallPortFilter -All -ErrorAction SilentlyContinue | ForEach-Object { $portFilters[$_.InstanceID] = $_ }
  $addrFilters = @{}
  Get-NetFirewallAddressFilter -All -ErrorAction SilentlyContinue | ForEach-Object { $addrFilters[$_.InstanceID] = $_ }
  $appFilters = @{}
  Get-NetFirewallApplicationFilter -All -ErrorAction SilentlyContinue | ForEach-Object { $appFilters[$_.InstanceID] = $_ }
} catch {
  Write-Verdict 'UNKNOWN' "could not read the firewall configuration ($($_.Exception.Message)). Try an elevated PowerShell, or check with: Get-NetFirewallRule -Direction Inbound -Action Allow"
  exit 2
}

# Profiles of the networks this PC is connected to right now (all three if that cannot be read).
$activeProfiles = @()
try {
  foreach ($n in @(Get-NetConnectionProfile -ErrorAction Stop)) {
    $activeProfiles += $(if ($n.NetworkCategory -eq 'DomainAuthenticated') { 'Domain' } else { [string]$n.NetworkCategory })
  }
} catch { }
$activeProfiles = @($activeProfiles | Sort-Object -Unique)
if ($activeProfiles.Count -eq 0) { $activeProfiles = @('Domain', 'Private', 'Public') }
Write-Host ("  active network profile(s): {0}" -f ($activeProfiles -join ', '))

$findings = New-Object System.Collections.ArrayList
$limited = New-Object System.Collections.ArrayList
$unreadable = 0

foreach ($p in $profiles) {
  $state = if ($p.Enabled -eq 'True') { 'on' } else { 'OFF' }
  $isActive = $activeProfiles -contains [string]$p.Name
  Write-Host ("  firewall profile {0}: {1}, default inbound: {2}{3}" -f $p.Name, $state, $p.DefaultInboundAction, $(if ($isActive) { ' (in use)' } else { '' }))
  if (-not $isActive) { continue }
  if ($p.Enabled -ne 'True') { [void]$findings.Add("Windows Firewall is switched off for the $($p.Name) profile, which is in use.") }
  elseif ($p.DefaultInboundAction -eq 'Allow') { [void]$findings.Add("Windows Firewall allows inbound traffic by default on the $($p.Name) profile, which is in use.") }
}

$ownerNames = @($owners.Keys | ForEach-Object { $_.ToLowerInvariant() })
$serverPrograms = @('hermes', 'python', 'pythonw') + $ownerNames

foreach ($r in $rules) {
  $profileText = [string]$r.Profile
  if ($profileText -ne 'Any') {
    $appliesNow = $false
    foreach ($ap in $activeProfiles) { if ($profileText -match $ap) { $appliesNow = $true } }
    if (-not $appliesNow) { continue }
  }
  $pf = $portFilters[$r.Name]
  $af = $addrFilters[$r.Name]
  $apf = $appFilters[$r.Name]
  if (-not $pf) { $unreadable++; continue }

  $proto = ([string]$pf.Protocol).ToUpperInvariant()
  if ($proto -notin @('TCP', '6', 'ANY')) { continue }

  $localPorts = @($pf.LocalPort)
  $program = if ($apf) { [string]$apf.Program } else { 'Any' }
  $programAny = ($program -eq 'Any' -or [string]::IsNullOrWhiteSpace($program))
  $leaf = if ($programAny) { '' } else { ([System.IO.Path]::GetFileNameWithoutExtension($program)).ToLowerInvariant() }
  $programIsServer = (-not $programAny) -and ($serverPrograms -contains $leaf)

  $coversPort = $false
  $why = ''
  if (Test-PortListMatches $localPorts $Port) {
    if ($programAny -or $programIsServer) { $coversPort = $true; $why = "port $Port" }
  } elseif ($localPorts -contains 'Any') {
    if ($programIsServer) { $coversPort = $true; $why = "program $leaf.exe (any port)" }
    elseif ($programAny -and $proto -ne 'ANY') { $coversPort = $true; $why = 'any TCP port' }
  }
  if (-not $coversPort) { continue }

  $remote = if ($af) { @($af.RemoteAddress) } else { @('Any') }
  $remoteText = ($remote -join ',')
  $line = "'{0}' ({1}, remote: {2}, profile: {3})" -f $r.DisplayName, $why, $remoteText, $profileText
  if (Test-RemoteLimitedToTailnet $remote) { [void]$limited.Add($line) } else { [void]$findings.Add("Allow rule not limited to 100.64.0.0/10: $line") }
}

if ($unreadable -gt 0) {
  Write-Host ("  note: {0} applicable Allow rule(s) could not be read without administrator rights and were not evaluated." -f $unreadable)
}

if ($limited.Count -gt 0) {
  Write-Host ''
  Write-Host 'Allow rules limited to Tailscale (100.64.0.0/10):'
  $limited | ForEach-Object { Write-Host "  $_" }
}

if ($findings.Count -gt 0) {
  Write-Host ''
  Write-Host 'Findings:'
  $findings | ForEach-Object { Write-Host "  - $_" }
  Write-Verdict 'EXPOSED' "port $Port is likely reachable from your local network. Fix those items (turn the firewall on, remove or narrow the rules to RemoteAddress 100.64.0.0/10), or switch to the loopback + Tailscale Serve setup (docs/SETUP.md, Option A)."
  Write-Host "Confirm from another device on the same Wi-Fi with Tailscale OFF: http://<PC LAN IP>:${Port} must not load."
  exit 1
}

if ($unreadable -gt 0) {
  Write-Verdict 'UNKNOWN' "no problem found among the rules that could be read, but $unreadable rule(s) were unreadable. Run this again from an elevated PowerShell for a definitive answer."
  exit 2
}

if ($limited.Count -gt 0) {
  Write-Verdict 'OK' "inbound access to port $Port is limited to Tailscale (100.64.0.0/10) by the firewall. Still confirm once from a device on the same Wi-Fi with Tailscale OFF."
} else {
  Write-Verdict 'OK' "the server listens beyond loopback but no inbound Allow rule opens port $Port (default inbound action blocks it), so nothing can reach it, Tailscale included. If the phone cannot connect, add the Tailscale-only rule from docs/SETUP.md, or use Option A."
}
Write-Host 'This script reads Windows Firewall rules only; it cannot see third-party firewalls, router port forwards or Block rules that override an Allow.'
exit 0
