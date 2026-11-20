<!-- Copyright (c) 2026 Erick Bourgeois, Low Tide -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Low Tide

Walk one workload through mediatore and watch each stage happen, in a browser or a terminal.
The stages follow the `mediatore` CLI's process:

1. **Mint token**: OIDC with PKCE at the issuer. Shows the session file (path, mode), the ID
   token's claims and your groups.
2. **Create workload**: `POST /v1/claims`; the broker creates the `AgentSandbox`.
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

# Terminal.
./target/release/low-tide tui --namespace sandboxes

# No cluster: a scripted run with placeholder values, for showing the flow.
./target/release/low-tide web --demo
./target/release/low-tide tui --demo
```

The default workload is
`docker.io/library/python:3.13-slim python3 -u -c "import time; print('hello world'); time.sleep(10); print('slept 10 s, exiting')"`.
The field takes `IMAGE [ARG...]`, split as a shell splits words, with no expansion.

| Flag | Default | |
| --- | --- | --- |
| `--issuer`, `--mediatore`, `--ca-file`, `--namespace` | `MEDIATORE_*` env | as the CLI |
| `--pool`, `--pool-selector`, `--strategy`, `--ttl`, `--audience`, `--delegate`, `--policy` | | as `mediatore sandbox create` |
| `--restart` | `never` | one run, one exit |
| `--kubeconfig`, `--context` | `KUBECONFIG`, current context | for the watches |
| `--broker-namespace` | `banlieue-system` | where the broker writes its Secrets |
| `--gateway-selector` | `mediatore.io/role=gateway` | the label `deploy/gateway` puts on the gateway VMs |
| `--gateway-prefix` | `gateway-` | used when the selector finds none |
| `--gateway-namespace` | all | |
| `--reuse-session` | off | skip the login when the session is fresh and its delegation unspent |

To build against a local mediatore checkout instead of the pinned commit, add to `Cargo.toml`
(and do not commit it):

```toml
[patch."https://github.com/firestoned/mediatore"]
mediatore-client = { path = "../mediatore/crates/mediatore-client" }
mediatore-proto  = { path = "../mediatore/crates/mediatore-proto" }
```

Each claim spends the session's refresh token, so each run logs in again unless
`--reuse-session` finds an unspent one.

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
