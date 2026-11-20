---
description: session handoff, regenerate with /handoff when a quest finishes
budget_tokens: 1000
---
# STATUS: low-tide

> Read this FIRST when resuming. Last updated: 2026-11-20

## ✅ Done

- Low Tide: one Rust binary, `low-tide web` (axum, loopback, key-in-link cookie, Host check) and `low-tide tui` (ratatui 0.30), one engine (`src/engine.rs`) emitting step events.
- Flow follows the CLI: 1 `mediatore login` (form with every CLI option, issuer required, live command preview; `src/settings.rs` `LoginSettings::command`/`to_options`) → run waits (`Run::await_claim`/`submit`, oneshot) → 2 `mediatore sandbox create` (`ClaimSettings`) → 3 seal → 4 run (sub-steps, `src/phases.rs`) → 5 output → 6 exit. Web: `POST /api/login`, then `POST /api/create` (409/400 when out of order or malformed).
- Secrets map (`src/secrets.rs`): red, lock when sealed, RAM when memory-only; Secrets listed by label in the broker namespace, metadata only (`src/kubeinfo.rs`). Gateway VMs by `mediatore.io/role=gateway` with IPs.
- `--demo` scripted run (`src/demo.rs`), placeholders only; default workload python:3.13-slim hello world + sleep.
- CI: `.github/workflows/build.yaml` (SPDX, signed commits, fmt, clippy, test, cargo-audit, cargo-deny, dist linux-x86_64 + darwin-arm64, attach on release), `Makefile` (check/dist/demo), `deny.toml` (mediatore's allowlist, ring banned), `.github/dependabot.yml`.
- Gate green: mac (`make check`, `make dist`) and slate (fmt, clippy 0.1.99, 21 tests, deny, `dist/low-tide-linux-x86_64`); actionlint clean.
- Config file `~/.config/low-tide/config.env` (`src/config.rs`): CLI env names + LOW_TIDE_*; `low-tide config [init]`; MEDIATORE_SESSION honoured; `--workload`/LOW_TIDE_WORKLOAD for web and TUI.
- Web layout: rail of stage nodes (left) + one card in focus; completed cards shrink into the rail, next pops up (queue with 1.6 s dwell), tooltips, click to pin, "Back to live". Refusals parsed (`brokerError`, `REFUSAL_HINTS`).
- mediatore-client/proto pinned by git rev `4dfb9f1` (README has the `[patch]` recipe for a local checkout).

## 🚀 Next quest

**Goal:** commit this work, push, and see the first CI run green; then a live run against the core cluster.

1. Commit (uncommitted: everything above since `bad4473`) with `git commit -s -S`, push to `firestoned/low-tide` main; the user runs push.
2. CI green on GitHub (watch: `macos-latest` dist job, license-check composite on `.rs`/Makefile/workflow YAML only).
3. Live run: `low-tide web --namespace <ns>` with `MEDIATORE_ISSUER`/`MEDIATORE_URL`, kubeconfig for the core cluster; one Dex login per claim.

Live-run note: the core pool reaches only its own registry (not Docker Hub): set LOW_TIDE_WORKLOAD to an image there.

Acceptance: CI all green; a real claim reaches "Exit code" with output streamed; secrets map shows the session and delegation Secrets in `banlieue-system` (or reports RBAC refusal once).

Cluster findings (not Low Tide's, 2026-11-20):
- banlieue gave a warm member to a newer claim while an older one waited (sandbox-78cf20e3 vs aa705d57): no FIFO across waiting claims.
- mediatore: a guest whose VM was claimed the second it announced (sandbox-768f2ab7 on 6q5jv) polled the broker every ~6 s and never reported; needs the guest journal.
- Which gateway carried a tunnel is not observable (shared authorizer identity, NAT'd peer); the graph's `seal.via` slot waits for mediatore to report it.

Open decisions:
- RBAC for the user's kubeconfig to list Secret metadata in `banlieue-system` and `virtualmachines.banlieue.io`.
- Telemetry from the guest (OTel spans keyed by claim UID) to turn the `inferred` jail step into `observed`.

## Context

- Branch `main`, one commit (`bad4473`); the rest is working tree. Repo is private.
- slate's clippy is newer than the mac's: run `make lint` there before handing back (`rsync -az --delete --exclude target --exclude dist --exclude .wolf ./ slate:builds/low-tide/`).
- `~/dev/mediatore-ui` is obsolete (target moved here); delete when the user agrees.
- TUI not yet looked at on a real terminal; web verified by headless Chrome screenshots of `--demo`.

## 📚 References

- `.wolf/cerebrum.md` (preferences, Do-Not-Repeat), `.wolf/buglog.json` (4 fixes this session), `README.md`.
