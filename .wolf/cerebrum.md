---
description: learned preferences, project conventions, and Do-Not-Repeat rules
budget_tokens: 2000
---
# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-11-20

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

- Recess must follow the mediatore CLI's process in order: `mediatore login` first (its form carries every CLI option, issuer required), then `mediatore sandbox create` (the workload), then seal, run, output, exit. Show the equivalent CLI command for each.
- Visual, sleek web UI: stage cards with connectors that draw and darken as the run passes; the TUI mirrors the web flow.
- Secrets in red with where they live; a lock superscript when sealed at rest; RAM when memory-only. Show IP addresses (sandbox VM, gateways).
- Default workload: python:3.13-slim printing hello world, sleeping, printing again. The jail step is named "nsjail enter → jail-exec → exec" (the guest never calls nsenter).
- "Full build" means a GitHub Actions `build.yaml`, Makefile-driven, firestoned/github-actions composites, SHA-pinned (mediatore's conventions).
- Web layout: one stage in focus; a completed card shrinks left into a rail node and the next pops up; hover a node for a tooltip, click to bring it back into focus.
- Config: a dotenv file using the mediatore CLI's own env var names (MEDIATORE_ISSUER, MEDIATORE_URL, ...) plus RECESS_*; flag > env > file.
- A 🔒 beside anything authorized or encrypted (stage boxes top right, rail names, sub-steps, URLs, network nodes), only once it has happened, with a tooltip saying what.
- Rust, not Go: reuse mediatore's crates (mediatore-client, mediatore-proto) rather than shelling out.

## Key Learnings
- [2026-11-20] The egress proxy's 4xx/5xx bodies carry its error code (`gateway_refused`, `gateway_unreachable`, a dial error); `curl -f` drops them. Workloads use `curl -sS --fail-with-body` so a failure says why.

- [2026-11-20] The jail reaches the outside only as `$MEDIATORE_EGRESS_PROXY/<host>/<path>` for hosts in the claim's audiences (broker `audiences[].egress`, rules are path globs). No CONNECT, so HTTPS_PROXY tools fail; PyPI's absolute file URLs need an in-workload rewriting shim. Test workloads on the Linux build host with podman plus a stand-in proxy before a live claim.
- [2026-11-20] Inside the jail: Landlock allows connect only to 3128 and no bind (no local helper servers); /tmp and /home/sandbox are 4 MB tmpfs; /work sits in the per-claim sandbox tmpfs (50% of VM RAM, shared with the unpacked image). Put HOME, TMPDIR and caches under /work.
- [2026-11-20] The egress proxy offers upstreams TLS 1.3 only (MEDIATORE_EGRESS_MIN_TLS=1.2 is pool-wide); registry.npmjs.org has no 1.3 and fails `upstream_unreachable`. Probe a new host with `openssl s_client -tls1_3` first. Claude Code comes from downloads.claude.ai/claude-code-releases (manifest.json has the sha256).
- [2026-11-20] nsjail's RLIMIT_NOFILE default (32) is left in place by mediatore: parallel installers hit EMFILE. Use POETRY_INSTALLER_MAX_WORKERS=1; the test harness sets `ulimit -n 32` before jail-exec.
- [2026-11-20] The jail has no writable /dev/shm: Python multiprocessing (SemLock) fails EACCES. Reproduce the real confinement on a Linux build host with `mediatore jail-exec --writable ... --connect-port N -- argv` (binary copied from the broker image) under setpriv, not with plain podman.

- [2026-11-22] `web-3d` serves assets/3d.{html,js,css} on the same server and /api as `web` (Ui::Wire). The 3D is a hand-written canvas wireframe renderer (CSP allows only 'self'; no three.js). The director derives the act from run state (targetAct), so replays catch up; the demo stops on cancel without a `finished` event, so the page marks the run cancelled itself.

- [2026-11-22] web-3d drill-down: every fact is tagged seen/reported/derived/by design/demo; TLS facts come from Recess's own handshake (/api/tls, broker or issuer only). mediatore does not report which gateway carried a tunnel: draw candidates, never guess (bug-012). `make record` rebuilds docs/media with placeholders only.

- [2026-11-22] Renamed Low Tide to Recess ("when agents go to play"): crate and binary `recess`, `RECESS_*` variables, `~/.config/recess/config.env`. `LOW_TIDE_*` and the old path are still read (config::current_name, adopt_legacy_env), with one warning line; buglog.json keeps the old name as history.
- [2026-11-22] Live gateway/audience attribution: the broker logs one `claim egress answered to the gateway claim_uid=…` per gateway check (cache miss), with no gateway name or host, and all gateways reach it from one NAT address. web-3d shows the count as tier activity; exact attribution needs mediatore to log the gateway and host.

- [2026-11-22] After the rename, `target/*/low-tide` binaries lingered beside `target/*/recess` and showed the old "Low Tide" title; a rename of the package must also remove the old binaries.
- [2026-11-22] One `web` subcommand: the page is picked by `?theme=` (classic, wired-3d), then the `recess-theme` cookie, then `--theme`/`RECESS_THEME`; `web-3d` is a hidden alias. The copy button (`copyButton`) lives in cli.js, shared by both pages.
- [2026-11-22] `cargo update -p url` alone did not move past 2.5.8 (RUSTSEC-2026-0592); `--precise 2.5.9` did.
- [2026-11-22] The live cluster's banlieue VMs carry no `status.attestationSubject`: the trust domain comes from the AgentSandbox's `status.record.nodeId` (`spiffe://<td>/spire/agent/tpm/<ek hash>`, whose hash is also the node SVID's). The VM's name and addresses fall back to the AgentSandbox's `status.virtualMachineRef` and `status.addresses` (3d.js `spiffeOf`, `vmOf`).
- [2026-11-22] In the jail, virtualenv copies pip from the read-only image into `~/.cache/virtualenv/.../CopyPipInstall` keeping its 0555 directories, so `rm -rf ~/.cache` fails (Permission denied) and `set -e` ends the workload. `chmod -R u+w` the tree first.

## Do-Not-Repeat

- [2026-11-22] Changed src/util.rs and ran only `cargo test`; CI failed on `cargo fmt --check` (PR 4). Run `cargo fmt` (or `make check` on slate) after every Rust edit, not only after the first.
- [2026-11-22] The demo's few output lines hid a per-line forced layout in the 3D output box; live bursts dropped it to 18 fps. Write DOM from streamed events once a frame, never read layout (scrollHeight, offsetWidth) per event, and load-test with a burst of thousands of lines.
- [2026-11-22] Stopped test servers with `pkill -f "recess web"`, which also matches the user's own running Recess. Stop only your own, by exact path and port.

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-11-20] Picked Go for a mediatore tool; the user wanted Rust. Default to Rust and mediatore's own crates for anything in this ecosystem.
- [2026-11-20] Put the workload field first and folded the login into one Run button; the flow must be login first, as the CLI.
- [2026-11-20] A local clippy can be older than CI's: run `make lint` on the Linux build host before calling a change done.
- [2026-11-20] zsh does not word-split `$VAR`, and BSD grep's -Z is decompress, not NUL: pass file lists explicitly.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
