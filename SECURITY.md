# Security policy

Mono Hermes is an unofficial Android client for a Hermes server you run yourself. Its security model and what
the app stores are described in the [Security section of the README](README.md#security).

## Reporting a vulnerability

Please report privately through a
[GitHub private security advisory](https://github.com/Monoperro0207/mono-hermes/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab). Do not open a public issue for
vulnerabilities.

Helpful details: affected app version (the APK file name or the Releases page), Android version, what you
expected and what happened, and a minimal reproduction. Never include real credentials, tokens or server
addresses; redact them.

This is a volunteer-run project: expect an acknowledgement within about a week and a fix or a clear decision
afterwards. Fixes ship as a new release with a note in the release description.

## Scope

In scope: this repository (the bridge and Android shell in `mobile/`, the build and release workflows, the
documentation's security guidance).

Out of scope here: bugs in Hermes itself (the server, the desktop renderer under `upstream/`) belong to
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent); Tailscale issues belong to Tailscale.
If you are unsure, report it to us and we will route it.

## Supported versions

Only the latest release receives fixes.

## Verifying a release

See [Verify a release](README.md#verify-a-release) in the README (SHA-256, signer certificate fingerprint and
build provenance attestation).
