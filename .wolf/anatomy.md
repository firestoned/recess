# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-11-20T06:37:29.756Z
> Files: 24 tracked | Anatomy hits: 0 | Misses: 0

> Project structure index. Auto-maintained by OpenWolf hooks and daemon.
> Run `openwolf scan` to generate, or wait for the first Claude Code session.
> Status: Pending initial scan

## ./

- `.gitignore` — Git ignore rules (~3 tok)
- `AGENTS.md` — OpenWolf (~75 tok)
- `Cargo.toml` — Rust package manifest (~612 tok)
- `CLAUDE.md` — OpenWolf (~99 tok)
- `deny.toml` — SPDX-License-Identifier: Apache-2.0 (~284 tok)
- `LICENSE` — Project license (~2870 tok)
- `Makefile` — SPDX-License-Identifier: Apache-2.0 (~431 tok)
- `README.md` — Project documentation (~1230 tok)

## .github/workflows/

- `build.yaml` — SPDX-License-Identifier: Apache-2.0 (~2144 tok)

## assets/

- `app.css` — Styles: 105 rules, 34 vars, 2 media queries, 4 animations (~5440 tok)
- `app.js` — SPDX-License-Identifier: Apache-2.0 (~8008 tok)
- `index.html` — Low Tide (~1483 tok)

## src/

- `config.rs` — The config file: `KEY=VALUE` lines in the mediatore CLI's own environment variables (~2275 tok)
- `demo.rs` — `--demo`: a scripted run through the same event stream and the same pure functions (~3636 tok)
- `engine.rs` — One run of the pipeline: the workload, the login, the session it leaves, the identity in (~12003 tok)
- `form.rs` — The TUI's forms: `mediatore login` and `mediatore sandbox create`, every option the CLI (~6044 tok)
- `kubeinfo.rs` — What the Kubernetes API says around the sandbox: the egress gateway VMs, the sandbox's own (~2306 tok)
- `main.rs` — Low Tide: walk one workload through mediatore and watch each stage happen, in a (~2073 tok)
- `phases.rs` — The run's sub-steps, in the guest's own order (`mediatore-guest` `guest::run` and (~3380 tok)
- `secrets.rs` — Where each secret of one claim is, from what the UI can see: the session file's shape (~4757 tok)
- `settings.rs` — The two forms of the flow, in the CLI's own terms: `mediatore login` first, then (~3203 tok)
- `tui.rs` — The terminal front end: the stages as a column of boxes, joined by connectors that fill in (~8644 tok)
- `util.rs` — The pure pieces: the workload text field, the ID token's claims for display, and the (~3595 tok)
- `web.rs` — The web front end: one page, served on loopback, fed by server-sent events. (~3029 tok)
