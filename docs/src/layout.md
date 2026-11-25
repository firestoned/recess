<!-- Copyright (c) 2026 Erick Bourgeois, Recess -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Infrastructure layout

Both 3D views stand on one theatre: the infrastructure every claim passes through, each piece a
**station** at a fixed place on a wireframe floor. AgentSandbox adds one run's journey to it
(your sheets, the sandbox VM, the exit); Admin adds every live agent, the gateways, the
policies, the pools and the providers. Learn the floor once and both views read the same way.

## The floor, from above

![The theatre seen from above. Left, Admin: the OIDC issuer far west; the broker, the SandboxPolicy, the Kubernetes API and its Secrets together east of it; OpenBao and SPIRE south of the API. Right, AgentSandbox: the same stations, with your sheets next to the issuer, the sandbox VM far east and the exit north of it.](media/layout-map.svg){ .shot }

Drawn by `scripts/docs-map.mjs` from the coordinates the views use (`assets/theatre.js`, and the
run's places in `assets/agentsandbox.js`): north is up, `x` runs east and `z` south. These are
the places Recess stands things by default; [you can move them](#arranging-the-theatre).

## The stations

| Station | Colour | What it is | When it lights up |
|---|---|---|---|
| **OIDC issuer** | violet | Your identity provider (Dex): the login mints your ID token here, with PKCE | AgentSandbox: as you sign in |
| **Broker** | cyan | mediatore: takes the claim, seals your credentials, answers the guest, decides each gateway credential | the claim is sent |
| **ExposureCeiling** | orange, above the policy | The policy's approved maximum (notaio ADR-0007), approved by Security; dashed red when there is none, and notaio then does not publish the policy | the policy is read |
| **SandboxPolicy** | orange | notaio's signed bundle the claim names (`spec.policyRef`): its audiences, lease and egress | the broker reads it for the claim |
| **Authz shields** | green, amber or red | Where the claim is authorized: the broker's admission, the API's admission and reconciler, the gateway's authorizer; a tick, a cross, or a keyhole while undecided | each decides |
| **Kubernetes API** | cyan | Holds the `AgentSandbox`, its Events, the VMs and the Secrets; admission (CEL) checks the claim | the `AgentSandbox` is written |
| **Secrets** | amber | The broker's namespace: one sealed Secret per credential, drawn as a vault of deposit boxes | something is sealed; double-click to open |
| **OpenBao** | amber | Holds the transit key that seals them, and the PKI that is SPIRE's upstream CA | sealing; its PKI edge shows while SPIRE or OpenBao is picked |
| **SPIRE** | teal | Issues every SPIFFE identity on the sandbox path; attests the VM by its vTPM | the claim's entries are set; the VM attests |
| **Sandbox VM** | cyan | A pool member, claimed for this run: the guest agent, the egress proxy and nsjail inside | AgentSandbox: the claim binds |
| **Gateways** | pink | The egress gateways: every tunnel out goes through one, which checks it against the claim | traffic leaves; the one in use is solid |
| **Exit** | green | Where the run ends, with its exit code | AgentSandbox: the workload exits |

Admin adds, around the same stations: a **plot** per namespace with a cage per agent, the
**gateways** in one column inside a cyan circle with the **audiences** east of them, the
**policies** in a row north-west of the gateways, each under its ExposureCeiling, a **rack** per VM pool, and the **providers**
(the hosts the VMs run on) south of the racks.

## The two views

=== "AgentSandbox"

    ![AgentSandbox as it opens: sheet 01, the mediatore login form, square to the camera, with the OIDC issuer's tower up and to its left](media/agentsandbox-open.png){ .shot }

    As it opens: sheet 01 (`mediatore login`) square to you, the issuer it signs in with up and
    to its left.

    ![AgentSandbox after a run, pulled back: the journey from your card through the broker and the Kubernetes API to the sandbox VM, the gateway in use, SPIRE and the Secrets](media/agentsandbox-run.png){ .shot }

    A finished run, pulled back: the arc from your card and sheet 02 through the broker and the
    API to the VM, the gateway that carried its tunnels, SPIRE that attested it and the Secrets
    sealed for it.

=== "Admin"

    ![The Admin view of the demo's fleet](media/admin.png){ .shot }

    Every live agent: the base stations west, the namespaces' plots east of the API, the
    gateways, audiences and policies north, the pools' racks and the providers south.

## Arranging the theatre

{%
  include-markdown "../../README.md"
  start="### Arranging the theatre"
  end="### Recording it"
%}

## Regenerating these pictures

`make docs-media` redraws the map and retakes the screenshots from the demo (placeholder values
only, as `make record`). It needs node and Chrome or Chromium (`CHROME` names the binary).
