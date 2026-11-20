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

- Low Tide must follow the mediatore CLI's process in order: `mediatore login` first (its form carries every CLI option, issuer required), then `mediatore sandbox create` (the workload), then seal, run, output, exit. Show the equivalent CLI command for each.
- Visual, sleek web UI: stage cards with connectors that draw and darken as the run passes; the TUI mirrors the web flow.
- Secrets in red with where they live; a lock superscript when sealed at rest; RAM when memory-only. Show IP addresses (sandbox VM, gateways).
- Default workload: python:3.13-slim printing hello world, sleeping, printing again. The jail step is named "nsjail enter → jail-exec → exec" (the guest never calls nsenter).
- "Full build" means a GitHub Actions `build.yaml`, Makefile-driven, firestoned/github-actions composites, SHA-pinned (mediatore's conventions).
- Web layout: one stage in focus; a completed card shrinks left into a rail node and the next pops up; hover a node for a tooltip, click to bring it back into focus.
- Config: a dotenv file using the mediatore CLI's own env var names (MEDIATORE_ISSUER, MEDIATORE_URL, ...) plus LOW_TIDE_*; flag > env > file.
- A 🔒 beside anything authorized or encrypted (stage boxes top right, rail names, sub-steps, URLs, network nodes), only once it has happened, with a tooltip saying what.
- Rust, not Go: reuse mediatore's crates (mediatore-client, mediatore-proto) rather than shelling out.

## Key Learnings

- **Project:** low-tide
- **Description:** <!-- Copyright (c) 2026 Erick Bourgeois, Low Tide -->

- [2026-11-20] The jail reaches the outside only as `$MEDIATORE_EGRESS_PROXY/<host>/<path>` for hosts in the claim's audiences (broker `audiences[].egress`, rules are path globs). No CONNECT, so HTTPS_PROXY tools fail; PyPI's absolute file URLs need an in-workload rewriting shim. Test workloads on slate with podman plus a stand-in proxy before a live claim.

## Do-Not-Repeat

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

- [2026-11-20] Picked Go for a mediatore tool; the user wanted Rust. Default to Rust and mediatore's own crates for anything in this ecosystem.
- [2026-11-20] Put the workload field first and folded the login into one Run button; the flow must be login first, as the CLI.
- [2026-11-20] The mac's clippy is older than slate's: run `make lint` on slate before calling a change done.
- [2026-11-20] zsh does not word-split `$VAR`, and BSD grep's -Z is decompress, not NUL: pass file lists explicitly.

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
