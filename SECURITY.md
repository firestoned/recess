<!--
Copyright (c) 2026 Erick Bourgeois, Recess
SPDX-License-Identifier: Apache-2.0
-->
# Security policy

## Supported versions

Recess is pre-1.0. Only the latest commit on `main` and the most recent release receive
security fixes.

| Version | Supported |
| ------- | --------- |
| latest release / `main` | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/firestoned/recess/security/advisories/new)
("Report a vulnerability" on the repository's Security tab).

Include, where possible:

- the affected part (the web server, a view, the TUI, the engine, the config file) and the
  version or commit;
- steps to reproduce, or a proof of concept;
- the impact you believe it has.

Expect an acknowledgement within **3 business days** and a triage decision (accepted, needs
more information, or not a vulnerability) within **7**. Accepted reports get a fix or a
mitigation plan, and credit in the release notes unless you ask otherwise.

## Scope

Recess is a local tool: the web server listens on loopback, checks the `Host` header and
requires the key from the printed link on every route. What it promises never to do (send a
token to the browser or the terminal, read a Secret's data) is listed under
[What it never does](README.md#what-it-never-does); a way to make it break one of those
promises is in scope.

A vulnerability in mediatore itself (the broker, the gateways, the claims controller) belongs
to [mediatore](https://github.com/firestoned/mediatore/security/advisories/new). Issues that
need someone who already holds your session file or your kubeconfig are generally out of scope.
