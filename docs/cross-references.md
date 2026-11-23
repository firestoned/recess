<!-- Copyright (c) 2026 Erick Bourgeois, Recess -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cross-references: auditing a sandbox from status

Every object a sandbox touches is a Kubernetes resource, and most of them say in their
`status` (or `spec`, or labels) which other objects they belong to. Joined, those fields are a
graph: from an `AgentSandbox` to the VM it ran in, the TPM that VM attested with, the
`SandboxNode` mediatore registered for it, the SPIRE entries that gave it identities, the
policy and bundle it was admitted under, the Secrets that held its credentials, the provider
and the host it ran on. Recess's Watch view builds that graph from a watch of each kind and
shows it per object, under **Cross-references**: each link, the field it was read from, and
whether the object at the other end exists (✓) or not (✗). That is the audit.

This page lists the links that exist today, as seen on a live cluster (2026-11-23), and the
ones that are missing, with what each project would need to add.

## The links that exist

| From | To | Read from | Notes |
|---|---|---|---|
| AgentSandbox | VirtualMachine | `status.virtualMachineRef.name` | Kept after the release, when the VM may already be recycled. |
| AgentSandbox | SandboxNode | `status.record.nodeId` (`spiffe://<td>/spire/agent/tpm/<ek>`) = `SandboxNode.spec.nodeId` | Survives the VM: the durable link. |
| AgentSandbox | VirtualMachine | the EK hash in `status.record.nodeId` = hash of `VirtualMachine.status.tpmEndorsementCertificates` | A check of the one above: the VM by its TPM, not its name. |
| AgentSandbox | ClusterStaticEntry (claim) | `status.record.entryId` | Deleted at the release, as it should be. |
| AgentSandbox | ClusterStaticEntry (node) | `mediatore-node-<ek>` from `status.record.nodeId` | |
| AgentSandbox | SandboxPolicy | `status.record.policyUid` = `SandboxPolicy.metadata.uid` | With `status.record.bundleVersion` against `SandboxPolicy.status.bundleVersion`. |
| AgentSandbox | PolicyFloor | `PolicyFloor.spec.uid` = `status.record.policyUid` | |
| AgentSandbox | Secrets | labels `mediatore.io/sandbox-uid`, `mediatore.io/claim-uid` | Read as metadata only. |
| VirtualMachine | VirtualMachinePool | `metadata.ownerReferences` | |
| VirtualMachine | LibvirtMachine | `status.infrastructureRef` | |
| VirtualMachine | SandboxNode | hash of `status.tpmEndorsementCertificates` = `SandboxNode.spec.ekHash` | The hash is mediatore's (`ek_hash_from_pems`: SHA-256 of the RSA EK's SubjectPublicKeyInfo); Recess computes it with the same function. |
| SandboxNode | LibvirtMachine | `spec.dmiUuid` = `LibvirtMachine.status.domainUuid` | Equal on every node seen. |
| VirtualMachine | Provider | `status.scheduled.providerName` | |
| Provider | Host (faubourg) | `Host.status.providerRef` | One way only, from the Host. |
| Gateway decision | AgentSandbox | `claim_uid` = `status.claimUid` | The gateway's name is its own claim (mediatore ADR-0062). |

## What is missing, and what to add

### mediatore

1. **The node GC leaked SPIRE node entries** (fixed, ADR-0039 decision 7, amended
   2026-11-23). `collect_nodes` deleted a gone VM's node record and never its
   `mediatore-node-<ek>` ClusterStaticEntry; on the live cluster, 4 SandboxNodes and 364 node
   entries, 360 of them for VMs long gone. `collect_node_entries` now retracts a TPM node
   entry once no VM publishes its hash, under the node collection's guards, 20 per resync, so
   a backlog drains on its own.
2. **SandboxNode has no status.** It carries the EK hash, the DMI UUID and the node ID in its
   spec and nothing about what it is attached to. Add `status.virtualMachineRef` (the VM that
   publishes its EK, as the GC already computes), `status.claimRef` while a claim is bound to
   it, and conditions `Attested`, `EntrySet` (its node entry is on the server) and `Bound`.
   With those, a node answers "which VM, which claim, is its identity live" by itself.
3. **No entry reports `status.set: true`.** All 364 node entries say `rendered: true,
   set: false`, yet the guests attest. Either the SPIRE Controller Manager in use does not
   populate `set`, or the entries are not on the server. Worth confirming, since a bind is meant
   to wait for `set`.
4. **The label `mediatore.io/node` on an AgentSandbox** (32 hex characters) is neither the EK
   hash nor the DMI UUID. Document what it is, or replace it with `status.record.ekHash`.
5. **Which gateway carried a claim** is not in any status until ADR-0063 (`status.egress`).
   The gateway's name in it is self-claimed; a gateway VM label naming the authorizer
   (`mediatore.io/gateway-name`) would let the name be checked against a VM.

### banlieue

1. **No EK hash in VM status.** Every consumer has to parse the PEM and hash the key. Add
   `status.tpm.ekHash` beside `status.tpmEndorsementCertificates`, and a condition
   `TPMEndorsed` for when the certificates are published.
2. **A VM does not say who claimed it.** The VirtualMachineClaim is deleted at the release, and
   the VM keeps no trace. Add `status.claimRef` while bound and `status.lastClaimRef` (name,
   UID, bound and released times) after, or an Event per bind and release.
3. **A Provider does not name its host.** Only faubourg's Host points at the Provider. Add
   `Provider.status.hostRef` (or the `host` label already on some providers, made a field).

### faubourg

1. **Not every provider has a Host.** On the live cluster only `lenny` has one; the providers
   on `slate` have none, so a VM there cannot be traced to a physical host.

### SPIRE entries

ClusterStaticEntries are cluster-scoped, so they cannot be owned (garbage-collected) by the
namespaced AgentSandbox or SandboxNode. Their lifecycle has to stay in mediatore's own code,
which is why item 1 under mediatore matters: nothing else will ever remove them.
