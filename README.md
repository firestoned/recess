<!-- Copyright (c) 2026 Erick Bourgeois, Low Tide -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Low Tide

Walk one workload through mediatore and watch each stage happen, in a browser or a terminal.
The stages follow the `mediatore` CLI's process:

1. **`mediatore login`**: the first thing on the page is its form, with every option the CLI
   takes (the issuer is required; client id, scopes, auth params, login hint, CA file, client
   secret file, redirect ports, host and path, `--no-browser`) and the exact command it is
   equivalent to, live as you type. **Log in** mints the token: OIDC with PKCE at the issuer.
   Then it shows the session file (path, mode), the ID token's claims and your groups.
2. **`mediatore sandbox create`**: the workload and the claim's options, with its command.
   **Run** is enabled once the token is minted (one login per claim, as the CLI); the broker
   creates the `AgentSandbox`.
3. **Seal credentials**: the refresh token and any delegated credentials, sealed into
   Secrets in the broker's namespace. A live map shows every secret of the claim in red, where it
   is (your machine, the Kubernetes API, the broker, the sandbox VM, the egress gateways), with
   a 🔒 when it is sealed at rest and `RAM` when it only ever lives in memory.
4. **Run in the sandbox**: the guest's own order (claim a VM, bound, claim identity registered,
   guest attested, sandbox built, nsjail enter → `jail-exec` → exec, running, exit reported,
   released). Each sub-step is `observed` (a field appeared on the `AgentSandbox`), `reported`
   (the guest's report or exit) or `inferred` (no event of its own). The sandbox VM and the
   egress gateway VMs come from the Kubernetes API, with their addresses.
5. **Output**: the workload's stdout and stderr as it runs (`--logs` on the claim).
6. **Exit code**, and where the time went.

It drives mediatore's own client crate (`mediatore-client`, `mediatore-proto`, git
dependencies pinned to a commit of `firestoned/mediatore`) for the login, the claim and the output, and
the Kubernetes API (kube-rs) for the `AgentSandbox`, its Events, the VMs and the Secrets'
metadata.

## Run

```sh
cargo build --release

# Browser: listens on loopback, prints a link carrying a one-time key, opens it.
MEDIATORE_ISSUER=https://dex.example.com MEDIATORE_URL=https://mediatore.example.com \
  ./target/release/low-tide web --namespace sandboxes

# Terminal: the same two forms (login, then sandbox create) with every option and buttons.
./target/release/low-tide tui --namespace sandboxes

# No cluster: a scripted run with placeholder values, for showing the flow.
./target/release/low-tide web --demo
./target/release/low-tide tui --demo
```

The page keeps one stage in focus at a time. When a stage completes, its card shrinks into a
node on the rail at the left and the next stage pops up; stages that start together take turns.
Hover a node for its summary, click it to bring it back into focus ("Back to live" returns).
A claim the broker refuses shows its error code, detail and what to do about it. `#run` (any
stage id) in the URL opens the page on that stage.

While a claim waits for a VM, the Run card shows the pool (available, claimed, provisioning,
which member is booting and for how long) and banlieue's own reason from the claim's `Bound`
condition. A step that makes no progress past its limit (bind 2 min, guest build 2 min, ...)
is flagged with what it waits for; the workload's own run has no limit.

The network graph puts the sandbox VM on top and one arrow down to the egress gateways, laid
out side by side, then the destinations (the audiences the workload named). The guest's egress
proxy picks a gateway per connection (random start, failover), and which one carried a tunnel
is not observable from Kubernetes today, so the arrow meets the whole row; a workload that
names no audience opens no tunnel and its arrow is dashed.

Under the rail, "your recent sandboxes" lists the AgentSandboxes whose subject is the identity
in the session file, newest first, with how each ended (exit code, failure, still waiting).

## The TUI

The same flow in a terminal: the `mediatore login` form (every option, issuer required, then
**[ Log in ]**), then the `mediatore sandbox create` form (the workload and every claim
option, then **[ Run ]** or **[ Cancel run ]**), each with the live command beneath it.

| Keys | |
| --- | --- |
| Tab, ↓ / Shift-Tab, ↑ | next / previous field or button |
| ← → Home End, Backspace Delete, Ctrl-U, Ctrl-W | edit text (Ctrl-U clears, Ctrl-W deletes a word) |
| ← → on a choice, Space on a checkbox | strategy, restart / plain http, logs, no-browser, reuse session |
| Enter | next field, or press the focused button |
| Ctrl-S | submit the form from any field |
| mouse | click a field, a checkbox or a button |
| Esc, then ↑ ↓ | leave the form to look at the stages; `e` comes back |

## Config file

`~/.config/low-tide/config.env` (or `--config PATH`, or `LOW_TIDE_CONFIG`): `KEY=VALUE` lines
in the mediatore CLI's own variables, plus Low Tide's. A flag beats the environment, the
environment beats the file. `low-tide config init` writes a commented template;
`low-tide config` shows what the file set.

```sh
MEDIATORE_ISSUER=https://dex.example.com
MEDIATORE_URL=https://mediatore.example.com
MEDIATORE_NAMESPACE=sandboxes
# An image from a registry the pool reaches (the broker refuses others: unreachable_registry).
LOW_TIDE_WORKLOAD=registry.internal:5000/library/python:3.13-slim python3 -u -c "print('hello world')"
```

Keys other than `MEDIATORE_*`, `LOW_TIDE_*` and `KUBECONFIG` are ignored, and reported.
`MEDIATORE_SESSION` moves the session file, as it does for the CLI.

The default workload is
`docker.io/library/python:3.13-slim python3 -u -c "import time; print('hello world'); time.sleep(10); print('slept 10 s, exiting')"`.
The field takes `IMAGE [ARG...]`, split as a shell splits words, with no expansion.

Every option is also an environment variable (lists comma-separated; booleans true unless
empty, `0`, `false`, `no` or `off`), so a config file or a shell can carry all of it:

| Option | Variable | Default |
| --- | --- | --- |
| `--issuer` (required) | `MEDIATORE_ISSUER` | |
| `--client-id` | `MEDIATORE_CLIENT_ID` | `mediatore` |
| `--ca-file` | `MEDIATORE_CA_FILE` | |
| `--scope` | `LOW_TIDE_SCOPES` | `openid,profile,email,groups,offline_access` |
| `--auth-param` | `LOW_TIDE_AUTH_PARAMS` | |
| `--login-hint` | `LOW_TIDE_LOGIN_HINT` | |
| `--client-secret-file` | `LOW_TIDE_CLIENT_SECRET_FILE` | |
| `--redirect-port` | `LOW_TIDE_REDIRECT_PORTS` | `8000,18000` |
| `--redirect-host` | `LOW_TIDE_REDIRECT_HOST` | `localhost` |
| `--redirect-path` | `LOW_TIDE_REDIRECT_PATH` | |
| `--no-browser` | `LOW_TIDE_NO_BROWSER` | false |
| `--reuse-session` | `LOW_TIDE_REUSE_SESSION` | false |
| (session file) | `MEDIATORE_SESSION` | `~/.config/mediatore/session.json` |
| `--mediatore` | `MEDIATORE_URL` | |
| `--allow-plain-http` | `MEDIATORE_ALLOW_PLAIN_HTTP` | false |
| `--namespace` | `MEDIATORE_NAMESPACE` | the broker's |
| `--pool` | `LOW_TIDE_POOL` | any in the namespace |
| `--pool-selector` | `LOW_TIDE_POOL_SELECTOR` | |
| `--strategy` | `LOW_TIDE_STRATEGY` | banlieue's |
| `--ttl` | `LOW_TIDE_TTL` | 3600 |
| `--audience` | `LOW_TIDE_AUDIENCES` | |
| `--delegate` | `LOW_TIDE_DELEGATE` | |
| `--policy` | `LOW_TIDE_POLICY` | |
| `--restart` | `LOW_TIDE_RESTART` | `never` |
| `--no-logs` | `LOW_TIDE_NO_LOGS` | false (the broker must have `logs.enabled`, else 501) |
| `--workload` | `LOW_TIDE_WORKLOAD` | the Python hello world |
| `--kubeconfig` | `KUBECONFIG` | `~/.kube/config` |
| `--context` | `LOW_TIDE_CONTEXT` | current |
| `--broker-namespace` | `LOW_TIDE_BROKER_NAMESPACE` | `banlieue-system` |
| `--gateway-selector` | `LOW_TIDE_GATEWAY_SELECTOR` | `mediatore.io/role=gateway` |
| `--gateway-namespace` | `LOW_TIDE_GATEWAY_NAMESPACE` | all |
| `--gateway-prefix` | `LOW_TIDE_GATEWAY_PREFIX` | `gateway-` |
| `--no-gateways` | `LOW_TIDE_NO_GATEWAYS` | false |
| `--listen` (web) | `LOW_TIDE_LISTEN` | `127.0.0.1:7480` |
| `--no-open` (web) | `LOW_TIDE_NO_OPEN` | false |
| `--demo` | `LOW_TIDE_DEMO` | false |
| `--config` | `LOW_TIDE_CONFIG` | `~/.config/low-tide/config.env` |

To build against a local mediatore checkout instead of the pinned commit, add to `Cargo.toml`
(and do not commit it):

```toml
[patch."https://github.com/firestoned/mediatore"]
mediatore-client = { path = "../mediatore/crates/mediatore-client" }
mediatore-proto  = { path = "../mediatore/crates/mediatore-proto" }
```

Each claim spends the session's refresh token, so each run logs in again unless
`--reuse-session` finds an unspent one.

## Build

```sh
make check   # fmt, clippy (pedantic, -D warnings), tests, cargo-deny
make dist    # release binary into dist/low-tide-<os>-<arch>, with its SHA-256
make demo    # the scripted run in a browser
```

CI (`.github/workflows/build.yaml`) runs the same targets: SPDX headers, signed commits, fmt,
clippy, tests, cargo-audit, cargo-deny, then the release binary for Linux x86_64 and macOS
arm64, attached to a published release.

## What it never does

- Never sends a token to the browser or the terminal: the session step reports the file's
  path, mode and expiry and a SHA-256 fingerprint; the identity step the decoded claims.
- Never reads a Secret's data: Secrets are listed through the metadata API.
- Never claims a secret is somewhere it cannot see: what lives in a process's memory (the
  gateway's credential cache, the egress proxy's tokens) is shown as *possible* while the claim
  makes it so.

The web server listens on loopback only, checks the `Host` header, and requires the key from
the printed link (traded for a `SameSite=Strict` `HttpOnly` cookie) on every route; POSTs
take JSON only.

## Kubernetes access

Read access to `agentsandboxes.mediatore.io` and Events in the sandbox namespace,
`virtualmachines.banlieue.io` where the VMs are, and `list` on Secrets in the broker's
namespace (metadata only is requested). A list it may not make is reported once on its stage
and the rest of the run goes on.

## Limits

The steps inside the VM between "sandbox built" and the first output have no events of their
own today. Telemetry from the guest (spans keyed by the claim UID) would turn the `inferred`
steps into `observed` ones; the engine's step/event model is where it would plug in.
