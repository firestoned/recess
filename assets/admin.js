// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// The Admin view: every live agent the kubeconfig may see, in the base theatre (theatre.js)
// AgentSandbox stands on. The infrastructure stands where it stands in your run: the issuer, the
// broker, the Kubernetes API and its Secrets vault, OpenBao and SPIRE. East of the API, the
// fleet: each namespace a plot on the floor, each AgentSandbox a cage on it, coloured by where
// it is in its life; the egress gateways float north of it, and a running agent has one line to
// the gateway carrying its traffic, a packet on it each time the gateway decides something for
// it. South of the fleet, the VM pools: a rack each, a box per member VM, claimed, warm or still
// booting. The policies stand in a row north-west of the gateways. Read-only: nothing
// here changes the cluster.
//
// The data is one server-sent event stream (/api/admin): the whole picture, then each change.
// Messages are queued as they come and applied once a frame, so a burst costs one layout.
'use strict';

THEATRE.glow = false;
THEATRE.fogFar = 90;

const STATE_COLOR = { running: C.wire, pending: C.muted, gaps: C.seal, refused: C.bad, exited: C.ok };

// The Admin view's own shapes, beside the base theatre's.
const bar = (a, b) => ({ pts: [a, b], edges: [[0, 1]] });
Object.assign(SHAPES, {
  // An agent's sandbox: the nsjail cage, big enough to read from high up.
  agentCage: merge(box(1.7, 1.7, 1.7),
    ...[-0.28, 0.28].flatMap((x) => [-0.85, 0.85].map((z) => bar([x, -0.85, z], [x, 0.85, z]))),
    ...[-0.28, 0.28].flatMap((z) => [-0.85, 0.85].map((x) => bar([x, -0.85, z], [x, 0.85, z])))),
  agentCore: octa(0.34),
  agentCross: merge(bar([-0.64, 0.64, 0.86], [0.64, -0.64, 0.86]), bar([0.64, 0.64, 0.86], [-0.64, -0.64, 0.86])),
  gwBig: octa(0.55),
  gatewayRing: ring(0.85, 32),
  host: merge(ring(0.32, 20, 'xy'), octa(0.12)),
  pkt: octa(0.13),
  // A banlieue Provider: the host machine the VMs are scheduled on, a low wide slab.
  provider: merge(box(5, 0.5, 2.6), bar([-2.2, 0.26, 1.31], [2.2, 0.26, 1.31]), bar([-2.2, 0.05, 1.31], [2.2, 0.05, 1.31]), bar([-2.2, -0.16, 1.31], [2.2, -0.16, 1.31])),
  // A pool member: a small server, its front rack lines.
  // Big enough to read from high up, with its rack lines and a power light.
  member: merge(box(1.9, 1.0, 1.5),
    bar([-0.75, 0.2, 0.76], [0.75, 0.2, 0.76]), bar([-0.75, 0, 0.76], [0.75, 0, 0.76]), bar([-0.75, -0.2, 0.76], [0.75, -0.2, 0.76]),
    moved(ring(0.09, 8, 'xy'), [0.72, 0.36, 0.76])),
});
const FLOOR_Y = -0.9;
// Where the fleet starts: east of the Kubernetes API and its vault.
const FLEET = { x0: 36, z0: -5 };
// The policies: a row north-west of the gateways, this far apart.
const POLICY_SP = 13;
const VSP = 2.8; // between members on a rack
const RACK_PAD = 1.4; // the rack's margin round its members

// ------------------------------------------------------------------------------ the data

// Every kind the stream carries, by the server's name for it.
const KINDS = ['sandbox', 'vm', 'pool', 'policy', 'egress', 'entry', 'envelope', 'segment', 'node', 'floor', 'machine', 'provider', 'host'];
const S = Object.fromEntries(KINDS.map((k) => [k, new Map()]));
S.notes = {};
const inbox = [];
let dirty = true;
let stamp = 0; // bumped on each applied change, so open details re-render

function apply(m) {
  if (m.op === 'snapshot') {
    for (const k of KINDS) S[k].clear();
    S.notes = { ...(m.notes || {}) };
    for (const it of m.items || []) put(it.kind, it.key, it.obj);
  } else if (m.op === 'put') put(m.kind, m.key, m.obj);
  else if (m.op === 'del') { for (const k of KINDS) S[k].delete(m.key); }
  else if (m.op === 'note') { if (m.text) S.notes[m.kind] = m.text; else delete S.notes[m.kind]; }
  dirty = true; stamp++;
  indexed = null;
}
function put(kind, key, obj) { if (S[kind]) S[kind].set(key, obj); }

const at = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const nsOf = (o) => at(o, 'metadata.namespace') || '';
const nameOf = (o) => at(o, 'metadata.name') || '';
const condOf = (o, type) => (at(o, 'status.conditions') || []).find((c) => c.type === type);
const isGateway = (vm) => at(vm, 'metadata.labels')?.['mediatore.io/role'] === 'gateway' || /^gateway-/.test(nameOf(vm));

// Lookups rebuilt once after each change: the gateway decisions read from the log, the SPIRE
// entries, the sealed envelopes, and the pools' members, by what they belong to.
let indexed = null;
function index() {
  if (indexed) return indexed;
  const egress = new Map(), claimEntry = new Map(), byParent = new Map(), envBySandbox = new Map(), envByClaim = new Map();
  for (const o of S.egress.values()) egress.set(o.claimUid, o);
  for (const o of S.entry.values()) {
    const n = nameOf(o);
    if (n.startsWith('mediatore-claim-')) claimEntry.set(n.slice('mediatore-claim-'.length), o);
    else if (n.startsWith('mediatore-node-')) byParent.set(at(o, 'spec.parentID'), o);
  }
  const push = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  // A Secret both watches return (an output segment labelled with its sandbox too) counts once.
  for (const e of sealedSecrets()) {
    const lb = e.labels || {};
    push(envBySandbox, lb['mediatore.io/sandbox-uid'], e);
    if (!lb['mediatore.io/sandbox-uid']) push(envByClaim, lb['mediatore.io/claim-uid'], e);
  }
  // A pool's members: the VMs it owns, or labels, or names after itself (as banlieue does).
  const poolKeys = new Map([...S.pool.entries()].map(([k, p]) => [`${nsOf(p)}/${nameOf(p)}`, k]));
  const members = new Map(), poolOfVm = new Map(), agentOnVm = new Map(), vmByName = new Map();
  for (const [key, vm] of S.vm) {
    if (isGateway(vm)) continue;
    vmByName.set(nameOf(vm), key);
    const owner = (at(vm, 'metadata.ownerReferences') || []).find((r) => r.kind === 'VirtualMachinePool')?.name
      || at(vm, 'metadata.labels')?.['banlieue.io/pool']
      || [...S.pool.values()].map(nameOf).find((p) => nameOf(vm).startsWith(`${p}-`));
    const pk = owner && poolKeys.get(`${nsOf(vm)}/${owner}`);
    if (!pk) continue;
    push(members, pk, key);
    poolOfVm.set(key, pk);
  }
  for (const [key, o] of S.sandbox) {
    const vm = at(o, 'status.virtualMachineRef.name');
    if (vm && vmByName.has(vm)) agentOnVm.set(vmByName.get(vm), key);
  }
  // The cross-references the controllers record in status, joined: a VM's EK hash (derived by
  // Recess from status.tpmEndorsementCertificates) names its SandboxNode, its SPIRE node entry
  // and its agent's SPIFFE ID; its infrastructureRef names its machine, whose domain UUID is the
  // node's DMI UUID; its scheduled provider is a Provider, which a faubourg Host names.
  const ekOfVm = new Map(), vmByEk = new Map(), nodeByEk = new Map(), nodeByDmi = new Map(), entryByName = new Map();
  for (const [key, vm] of S.vm) { const ek = vm['x-recess']?.ekHash; if (ek) { ekOfVm.set(key, ek); vmByEk.set(ek, key); } }
  for (const [key, n] of S.node) { if (at(n, 'spec.ekHash')) nodeByEk.set(at(n, 'spec.ekHash'), key); if (at(n, 'spec.dmiUuid')) nodeByDmi.set(at(n, 'spec.dmiUuid'), key); }
  for (const [key, e] of S.entry) entryByName.set(nameOf(e), key);
  const byNsName = (map) => new Map([...map.entries()].map(([k, o]) => [`${nsOf(o)}/${nameOf(o)}`, k]));
  const machineByNsName = byNsName(S.machine), providerByName = new Map([...S.provider.entries()].map(([k, o]) => [nameOf(o), k]));
  const hostByProvider = new Map([...S.host.entries()].map(([k, o]) => [at(o, 'status.providerRef'), k]).filter(([p]) => p));
  const policyByUid = new Map([...S.policy.entries()].map(([k, o]) => [at(o, 'metadata.uid'), k]));
  const floorByUid = new Map([...S.floor.entries()].map(([k, o]) => [at(o, 'spec.uid'), k]));
  const vmsOnProvider = new Map();
  for (const [key, vm] of S.vm) push(vmsOnProvider, at(vm, 'status.scheduled.providerName'), key);
  indexed = { egress, claimEntry, byParent, envBySandbox, envByClaim, members, poolOfVm, agentOnVm, vmByName,
    ekOfVm, vmByEk, nodeByEk, nodeByDmi, entryByName, machineByNsName, providerByName, hostByProvider, policyByUid, floorByUid, vmsOnProvider };
  return indexed;
}

// Where an agent is in its life. A refusal and an exit outrank the rest; gaps (the reconciler
// found the sandbox wider than its policy, in shadow) outrank plain running.
function stateOf(o) {
  const st = o.status || {};
  if (st.phase === 'Failed' || (st.reason && !at(st, 'record.exit'))) return 'refused';
  if (at(st, 'record.exit') || st.phase === 'Released' || st.phase === 'Releasing') return 'exited';
  const gaps = condOf(o, 'PolicyConformant')?.status === 'False';
  if (st.phase === 'Bound' || st.ready) return gaps ? 'gaps' : 'running';
  return gaps ? 'gaps' : 'pending';
}
const STATES = ['running', 'pending', 'gaps', 'refused', 'exited'];
const live = (o) => ['running', 'gaps'].includes(stateOf(o));
// Exited in the last two minutes: its connections stay drawn, dimmed, so a short run is seen.
const RECENT_MS = 120000;
const justExited = (o) => { const x = Date.parse(at(o, 'status.record.exit.exited_at')); return stateOf(o) === 'exited' && x > 0 && Date.now() - x < RECENT_MS; };
const claimUidOf = (o) => at(o, 'status.claimUid') || at(o, 'status.record.claimUid') || at(o, 'metadata.labels')?.['mediatore.io/claim-uid'] || '';
// The agent's egress: on its status (ADR-0063) when the broker writes it, else from the log.
function egressOf(o) {
  const e = at(o, 'status.egress');
  if (e && (e.routes || []).length) return { source: 'status', e };
  const l = index().egress.get(claimUidOf(o));
  if (l?.egress && (l.egress.routes || []).length) return { source: 'log', e: l.egress };
  return null;
}
// Gateway checks from a broker without ADR-0062: that a gateway checked the claim, not which.
const checksOf = (o) => index().egress.get(claimUidOf(o))?.checks;
const checked = (o) => (checksOf(o)?.count || 0) > 0;
// Where a line goes when the gateway is not known: the middle of the gateways' row.
function tierPos() {
  const gs = [...nodes.values()].filter((n) => n.kind === 'gateway' && !n.gone && n.pos);
  if (!gs.length) return null;
  return mul(gs.reduce((s, n) => add(s, n.pos), [0, 0, 0]), 1 / gs.length);
}
const routesOf = (eg) => (eg?.e.routes || []).slice().sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
const carrierOf = (eg) => routesOf(eg)[0]?.gateway || '';
// The agent's SPIRE entries: its claim's, and the node's under the same agent.
function entriesOf(o) {
  const ix = index(), claim = ix.claimEntry.get(claimUidOf(o));
  const node = claim ? ix.byParent.get(at(claim, 'spec.parentID')) : null;
  return { claim, node };
}
// The agent's sealed envelopes: its session and delegations (by sandbox), its output (by claim).
function envelopesOf(o) {
  const ix = index();
  return [...(ix.envBySandbox.get(at(o, 'metadata.uid')) || []), ...(ix.envByClaim.get(claimUidOf(o)) || [])];
}
const envelopeKind = (e) => {
  const lb = e.labels || {};
  return lb['mediatore.io/logs'] ? 'output segment' : lb['mediatore.io/audience'] ? `delegated credential (${lb['mediatore.io/audience']})` : lb['mediatore.io/session'] ? `issuer session (${lb['mediatore.io/session']})` : 'sealed Secret';
};
const entriesSetCount = () => [...S.entry.values()].filter((e) => at(e, 'status.set')).length;
const sealedSecrets = () => [...new Map([...S.envelope.values(), ...S.segment.values()].map((e) => [`${e.namespace}/${e.name}`, e])).values()];
const envelopeCount = () => sealedSecrets().length;
// The agent's VM (its key), and a VM's agent.
const vmKeyOf = (o) => index().vmByName.get(at(o, 'status.virtualMachineRef.name'));
// A member VM's state: claimed by an agent, warm (ready, waiting), booting, or off.
function memberState(key) {
  const vm = S.vm.get(key);
  if (!vm) return 'gone';
  if (index().agentOnVm.has(key)) return 'claimed';
  const power = at(vm, 'status.observedPowerState');
  if (power && power !== 'PoweredOn') return 'off';
  const ready = condOf(vm, 'GuestReady')?.status === 'True' || condOf(vm, 'Ready')?.status === 'True';
  return ready ? 'warm' : 'booting';
}
// A pool member's SPIRE agent has attested: banlieue's GuestReady means exactly that, for a
// sandbox member (mediatore ADR-0019: booted, attested as a SPIRE agent, registered as a node),
// as does an attestation subject on its status, or a node entry naming it.
function attestedVm(key) {
  const vm = S.vm.get(key);
  if (!vm) return false;
  // Exactly: its EK hash names a SandboxNode (mediatore registered it) or a node entry.
  const ek = index().ekOfVm.get(key);
  if (ek && (index().nodeByEk.has(ek) || index().entryByName.has(`mediatore-node-${ek}`))) return true;
  if (condOf(vm, 'GuestReady')?.status === 'True') return true;
  const subj = at(vm, 'status.attestationSubject');
  return !!subj && [...S.entry.values()].some((e) => at(e, 'spec.spiffeID') === subj);
}
// An EK hash from a SPIRE agent's SPIFFE ID (…/spire/agent/tpm/<ek hash>).
const ekFromId = (id) => (id || '').match(/\/spire\/agent\/tpm\/([0-9a-f]{64})$/)?.[1] || '';

// The cross-references of one object, as an audit: each link, the field it was read from, and
// whether the object at the other end exists. [relation, target key or null, target's name, via, ok]
function xrefs(n) {
  const ix = index(), rows = [];
  const row = (rel, key, name, via, ok = !!key) => rows.push([rel, key, name, via, ok]);
  if (n.kind === 'agent') {
    const o = n.obj, st = o.status || {}, rec = st.record || {};
    // After the release the claim's entry is deleted and its VM recycled: gone, as it should be.
    const over = !live(o) && stateOf(o) !== 'pending';
    const gone = (name) => `${name} (gone after the release)`;
    const vmName = st.virtualMachineRef?.name;
    if (vmName) { const vk = ix.vmByName.get(vmName); row(over ? 'ran in VM' : 'runs in VM', vk, vk || !over ? vmName : gone(vmName), 'status.virtualMachineRef', !!vk || over); }
    const ek = ekFromId(rec.nodeId);
    if (rec.nodeId) {
      const nk = ix.nodeByEk.get(ek), label = ek ? `SandboxNode ${ek.slice(0, 12)}…` : rec.nodeId;
      row('attested node', nk, nk || !over ? label : gone(label), 'status.record.nodeId = SandboxNode.spec.nodeId', !!nk || over);
      const byEk = ix.vmByEk.get(ek);
      const same = vmName && byEk && nameOf(S.vm.get(byEk)) === vmName;
      row('VM by its TPM', byEk, byEk ? nameOf(S.vm.get(byEk)) : over ? gone('the VM with this EK') : 'none with this EK', 'record.nodeId EK = hash(VM.status.tpmEndorsementCertificates)', byEk ? (!vmName || same) : over);
    }
    if (rec.entryId) { const k = ix.entryByName.get(rec.entryId); row('claim SPIRE entry', k, k || !over ? rec.entryId : gone(rec.entryId), 'status.record.entryId', !!k || over); }
    if (ek) {
      // The node entry belongs to the VM, not the claim: still there after the release while
      // the VM is; still there once the VM is gone, it has leaked.
      const k = ix.entryByName.get(`mediatore-node-${ek}`), vmGone = !ix.vmByEk.has(ek);
      row('node SPIRE entry', k, `mediatore-node-${ek.slice(0, 12)}…${k && vmGone ? ' (its VM is gone: stale)' : ''}`, 'record.nodeId EK', k ? !vmGone : over);
    }
    if (rec.policyUid) {
      const pk = ix.policyByUid.get(rec.policyUid), pol = pk && S.policy.get(pk);
      row('policy', pk, pol ? `${nsOf(pol)}/${nameOf(pol)}` : rec.policyUid, 'status.record.policyUid = SandboxPolicy.metadata.uid');
      if (pol && rec.bundleVersion != null) {
        const now = at(pol, 'status.bundleVersion');
        row('policy bundle', pk, `${rec.bundleVersion} (policy now ${now ?? '?'})`, 'status.record.bundleVersion', now == null || rec.bundleVersion >= now);
      }
      const fk = ix.floorByUid.get(rec.policyUid);
      row('policy floor', fk, fk ? `${nameOf(S.floor.get(fk))} · version ${at(S.floor.get(fk), 'spec.version')}` : 'none', 'PolicyFloor.spec.uid = record.policyUid');
    }
    for (const e of envelopesOf(o)) row('sealed', null, `${envelopeKind(e)}: ${e.name}`, e.labels?.['mediatore.io/sandbox-uid'] ? 'Secret label mediatore.io/sandbox-uid' : 'Secret label mediatore.io/claim-uid', true);
  } else if (n.kind === 'vm' || n.kind === 'gateway') {
    const vk = n.kind === 'vm' ? n.key : [...S.vm.entries()].find(([, v]) => nameOf(v) === n.name)?.[0];
    const vm = vk && S.vm.get(vk);
    if (!vm) return rows;
    const pool = (at(vm, 'metadata.ownerReferences') || []).find((r) => r.kind === 'VirtualMachinePool');
    if (pool) row('pool', ix.poolOfVm.get(vk), pool.name, 'metadata.ownerReferences');
    const inf = at(vm, 'status.infrastructureRef');
    const mk = inf && ix.machineByNsName.get(`${inf.namespace || nsOf(vm)}/${inf.name}`);
    if (inf) row('machine', mk, `${inf.kind} ${inf.name}`, 'status.infrastructureRef', !!mk || inf.kind !== 'LibvirtMachine');
    const pv = at(vm, 'status.scheduled.providerName');
    if (pv) {
      const pk = ix.providerByName.get(pv);
      row('provider', pk, pv, 'status.scheduled.providerName');
      const hk = ix.hostByProvider.get(pv);
      row('host', hk, hk ? nameOf(S.host.get(hk)) : 'no faubourg Host names this provider', 'Host.status.providerRef', !!hk || !S.host.size);
    }
    const ek = ix.ekOfVm.get(vk);
    if (ek) {
      row('TPM', null, `EK ${ek.slice(0, 16)}…`, 'hash(status.tpmEndorsementCertificates)', true);
      const nk = ix.nodeByEk.get(ek);
      row('SandboxNode', nk, nk ? `${ek.slice(0, 12)}…` : 'not registered', 'SandboxNode.spec.ekHash = EK', !!nk || n.kind === 'gateway');
      if (nk && mk) {
        const dmi = at(S.node.get(nk), 'spec.dmiUuid'), dom = at(S.machine.get(mk), 'status.domainUuid');
        row('same machine', mk, `DMI ${dmi || '?'}`, 'SandboxNode.spec.dmiUuid = LibvirtMachine.status.domainUuid', !!dmi && dmi === dom);
      }
      const ne = `mediatore-node-${ek}`;
      if (n.kind === 'vm') row('node SPIRE entry', ix.entryByName.get(ne), `${ne.slice(0, 27)}…`, 'ClusterStaticEntry name');
    } else if (n.kind === 'vm') row('TPM', null, 'no endorsement certificate', 'status.tpmEndorsementCertificates', false);
    for (const [ak, a] of S.sandbox) {
      const byRef = at(a, 'status.virtualMachineRef.name') === nameOf(vm);
      const byEk = ek && ekFromId(at(a, 'status.record.nodeId')) === ek;
      if (byRef || byEk) row('ran', ak, `${nameOf(a)} (${stateOf(a)})`, byRef && byEk ? 'virtualMachineRef and record.nodeId' : byRef ? 'AgentSandbox.status.virtualMachineRef' : 'AgentSandbox.status.record.nodeId');
    }
  } else if (n.kind === 'provider') {
    const o = n.obj;
    const hk = ix.hostByProvider.get(nameOf(o));
    row('host', hk, hk ? nameOf(S.host.get(hk)) : 'none names it', 'Host.status.providerRef', !!hk);
    for (const vk of ix.vmsOnProvider.get(nameOf(o)) || []) row('runs', vk, nameOf(S.vm.get(vk)), 'VM.status.scheduled.providerName');
  }
  return rows;
}
function xrefTable(n) {
  const rows = xrefs(n);
  const t = el('table', 'routes xref');
  const h = el('tr');
  for (const c of ['', 'link', 'to', 'via']) h.append(el('th', null, c));
  t.append(h);
  for (const [rel, key, name, via, ok] of rows) {
    const tr = el('tr', ok ? '' : 'broken');
    const to = el('td');
    to.append(key && nodes.get(key) ? pick(key, name) : document.createTextNode(name));
    tr.append(el('td', ok ? 'allow' : 'deny', ok ? '✓' : '✗'), el('td', null, rel), to, el('td', 'via', via));
    t.append(tr);
  }
  if (!rows.length) return note('No cross-reference recorded.');
  return t;
}

const MEMBER_COLOR = { claimed: C.wire, warm: C.ok, booting: C.muted, off: C.dim, gone: C.dim };

function ago(ts) {
  const t = Date.parse(ts);
  if (!t) return '';
  const s = Math.max(0, Math.round(Math.abs(Date.now() - t) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ------------------------------------------------------------------------------ the scene's nodes

// Every drawn thing that can be picked: the base stations, agents, gateways, policies,
// namespaces, pools and their VMs. Nodes persist across changes and ease to where the layout
// puts them; a gone one fades out.
const nodes = new Map();
const view = { target: [30, 0, 0], goal: null, yaw: -0.3, pitch: 0.62, dist: 55, sel: null, hover: null, idle: 0, filter: '', only: null, shift: 0, touched: false };
const SP = 3.6; // between cages on a plot
const CAGE_TOP = 0.85; // half a cage: where its lines leave from
let fit = { center: [30, 0, 0], dist: 55 };

function node(key, kind) {
  let n = nodes.get(key);
  if (!n) {
    n = { key, kind, pos: null, goal: [0, 0, 0], alpha: 0, gone: false, label: null, info: null };
    nodes.set(key, n);
  }
  n.gone = false;
  return n;
}
// The base stations, where they stand in every view.
const BASE = [['issuer', 'issuer', ST.issuer], ['broker', 'broker', ST.broker], ['api', 'api', ST.api], ['vault', 'vault', ST.vault], ['openbao', 'openbao', ST.bao], ['spire', 'spire', ST.spire]];
const BASE_AT = new Map(BASE.map(([key, , p]) => [key, p]));
// What a Ctrl-drag of a node moves (the layout, theatre.js): a base station itself; an agent,
// its namespace's plot; a VM, its pool's rack; a gateway, a policy or a provider, itself.
// Each is kept as an offset by that key; layout() adds it.
function groupOf(n) {
  if (n.kind === 'agent') return `ns/${nsOf(n.obj)}`;
  if (n.kind === 'vm') return n.pool || null;
  return BASE_AT.has(n.key) || ['ns', 'pool', 'gateway', 'policy', 'provider'].includes(n.kind) ? n.key : null;
}
const offsetOf = (key) => LAYOUT.moved[key] || [0, 0, 0];
// Move a group by d: a base station in place (its edges are drawn from it), the rest by
// offset; then straight there, not eased.
function moveGroup(key, d) {
  if (BASE_AT.has(key)) shiftPoints([BASE_AT.get(key)], d);
  noteMove(key, d);
  layout();
  for (const n of nodes.values()) if (n.pos && groupOf(n) === key) n.pos = n.goal.slice();
}

// Boxes in rows: each item's width, wrapped at about the square root of the whole, rows centred
// on `cx` from `z`; sets x0 and z0 on each and returns where the last row ends.
function rowsAt(items, cx, z, gap, rowGap) {
  const total = items.reduce((s, p) => s + p.w + gap, 0);
  const maxRow = Math.max(20, Math.sqrt(total * 22));
  const rows = [[]];
  let rw = 0;
  for (const p of items) {
    if (rw > 0 && rw + p.w > maxRow) { rows.push([]); rw = 0; }
    rows[rows.length - 1].push(p);
    rw += p.w + gap;
  }
  let width = 0;
  for (const row of rows) {
    if (!row.length) continue;
    const w = row.reduce((s, p) => s + p.w + gap, -gap);
    width = Math.max(width, w);
    let x = cx - w / 2;
    for (const p of row) { p.x0 = x; p.z0 = z; x += p.w + gap; }
    z += Math.max(0, ...row.map((p) => p.d)) + rowGap;
  }
  return { end: z, width };
}

function layout() {
  const seen = new Set();
  for (const [key, kind, p] of BASE) { node(key, kind).goal = p; seen.add(key); }
  // Namespaces, each a plot of agents, oldest first.
  const byNs = new Map();
  for (const [key, o] of S.sandbox) {
    const ns = nsOf(o);
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push([key, o]);
  }
  const plots = [];
  for (const ns of [...byNs.keys()].sort()) {
    const list = byNs.get(ns).sort((a, b) => String(at(a[1], 'metadata.creationTimestamp')).localeCompare(String(at(b[1], 'metadata.creationTimestamp'))) || a[0].localeCompare(b[0]));
    const cols = clamp(Math.ceil(Math.sqrt(list.length * 1.4)), 2, 7);
    const rows = Math.max(1, Math.ceil(list.length / cols));
    plots.push({ ns, list, cols, rows, x0: 0, z0: 0, w: cols * SP, d: rows * SP });
  }
  // The pools, each a rack of its members: claimed first, then warm, then the rest.
  const ix = index();
  const ORDER = { claimed: 0, warm: 1, booting: 2, off: 3, gone: 4 };
  const racks = [...S.pool.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, p]) => {
    const ms = (ix.members.get(key) || []).slice().sort((a, b) => ORDER[memberState(a)] - ORDER[memberState(b)] || a.localeCompare(b));
    const cols = clamp(Math.ceil(Math.sqrt(ms.length * 3)), 3, 10);
    const rows = Math.max(1, Math.ceil(ms.length / cols));
    return { key, pool: p, ms, cols, rows, x0: 0, z0: 0, w: cols * VSP + 2 * RACK_PAD, d: rows * VSP + 2 * RACK_PAD };
  });
  // The fleet's width is its plots' or its racks', whichever is wider; both centred on it.
  const probe = rowsAt(plots.map((p) => ({ ...p })), 0, 0, 4, 4.5);
  const probeR = rowsAt(racks.map((r) => ({ ...r })), 0, 0, 6, 5);
  const fleetW = Math.max(14, probe.width, probeR.width);
  const cx = FLEET.x0 + fleetW / 2;
  const fleetEnd = rowsAt(plots, cx, FLEET.z0, 4, 4.5).end;
  const racksAt = (plots.length ? fleetEnd : FLEET.z0) + 3;
  const racksEnd = rowsAt(racks, cx, racksAt, 6, 5).end;
  // Plots and racks moved by hand stay on the floor.
  for (const p of plots) { const o = offsetOf(`ns/${p.ns}`); p.x0 += o[0]; p.z0 += o[2]; }
  for (const r of racks) { const o = offsetOf(r.key); r.x0 += o[0]; r.z0 += o[2]; }
  // The providers (the hosts the VMs are scheduled on), a row south of the racks.
  const provs = [...S.provider.keys()].sort();
  const pspan = Math.max(fleetW, (provs.length - 1) * 9);
  const provZ = racksEnd + 4;
  provs.forEach((key, i) => {
    const n = node(key, 'provider');
    n.obj = S.provider.get(key);
    n.goal = add([cx + (provs.length > 1 ? -pspan / 2 + (pspan * i) / (provs.length - 1) : 0), FLOOR_Y + 0.25, provZ], offsetOf(key));
    seen.add(key);
  });
  const provEnd = provs.length ? provZ + 3 : racksEnd;
  for (const p of plots) {
    const nk = `ns/${p.ns}`;
    const n = node(nk, 'ns');
    n.info = p; n.goal = [p.x0 + p.w / 2, FLOOR_Y, p.z0 + p.d + 0.6];
    seen.add(nk);
    p.list.forEach(([key, o], i) => {
      const a = node(key, 'agent');
      a.obj = o;
      a.goal = [p.x0 + (i % p.cols + 0.5) * SP, 0, p.z0 + Math.floor(i / p.cols) * SP + SP / 2];
      seen.add(key);
    });
  }
  for (const r of racks) {
    const n = node(r.key, 'pool');
    n.obj = r.pool; n.info = r;
    n.goal = [r.x0 + r.w / 2, FLOOR_Y, r.z0 + r.d + 0.8];
    seen.add(r.key);
    r.ms.forEach((key, i) => {
      const v = node(key, 'vm');
      v.obj = S.vm.get(key); v.pool = r.key;
      v.goal = [r.x0 + RACK_PAD + (i % r.cols + 0.5) * VSP, FLOOR_Y + 0.5, r.z0 + RACK_PAD + Math.floor(i / r.cols) * VSP + VSP / 2];
      seen.add(key);
    });
  }
  // The gateways, north of the fleet: the VMs labelled as one, and any a decision names that
  // is not among them (a gateway's name is its own claim, ADR-0062, and need not match its VM's).
  const gws = new Map();
  for (const o of S.vm.values()) if (isGateway(o)) gws.set(nameOf(o), o);
  for (const o of S.sandbox.values()) for (const r of egressOf(o)?.e.routes || []) if (r.gateway && !gws.has(r.gateway)) gws.set(r.gateway, null);
  const gwNames = [...gws.keys()].sort();
  // Spread wide enough to tell apart from high up: at least 14 between them.
  const span = Math.max(fleetW * 1.1, (gwNames.length - 1) * 14);
  gwNames.forEach((g, i) => {
    const key = `gw/${g}`;
    const n = node(key, 'gateway');
    n.obj = gws.get(g); n.name = g;
    n.goal = add([cx + (gwNames.length > 1 ? -span / 2 + (span * i) / (gwNames.length - 1) : 0), 7, FLEET.z0 - 14], offsetOf(key));
    seen.add(key);
  });
  // The policies (by namespace, then name): a row north of the gateways' and west of the
  // westmost one, spread so each stands clear with its name under it.
  const gwWest = cx - (gwNames.length > 1 ? span / 2 : 0);
  const pols = [...S.policy.entries()].sort((a, b) => nsOf(a[1]).localeCompare(nsOf(b[1])) || nameOf(a[1]).localeCompare(nameOf(b[1])));
  const polZ = FLEET.z0 - 18;
  pols.forEach(([key, o], i) => {
    const n = node(key, 'policy');
    n.obj = o;
    n.goal = add([gwWest - 7 - (pols.length - 1 - i) * POLICY_SP, 8, polZ], offsetOf(key));
    seen.add(key);
  });
  const polWest = pols.length ? gwWest - 7 - (pols.length - 1) * POLICY_SP : Infinity;
  for (const [key, n] of nodes) if (!seen.has(key) && !n.gone) n.gone = true;
  // The frame: from the broker to the fleet's east edge, the gateways to SPIRE or the racks' end.
  const x0 = Math.min(ST.broker[0] - 3, cx - span / 2 - 3, polWest - 3), x1 = Math.max(FLEET.x0 + fleetW + 2, cx + span / 2 + 3), z0 = Math.min(FLEET.z0 - 17, polZ - 3), z1 = Math.max(provEnd, ST.spire[2] + 3);
  fit = { center: [(x0 + x1) / 2, 0, (z0 + z1) / 2], dist: clamp(Math.max(x1 - x0, (z1 - z0) * 1.3) * 0.95, 30, 160) };
  THEATRE.fogFar = Math.max(90, fit.dist * 2);
  if (!view.touched) { view.goal = fit.center; view.dist = fit.dist; }
}

const agents = () => [...nodes.values()].filter((n) => n.kind === 'agent');
const gatewayNode = (g) => nodes.get(`gw/${g}`);
function matches(n) {
  if (view.only && stateOf(n.obj) !== view.only) return false;
  const f = view.filter;
  if (!f) return true;
  const o = n.obj;
  const hay = [nameOf(o), nsOf(o), at(o, 'spec.subject.display'), at(o, 'spec.subject.id'), at(o, 'spec.policyRef.name'), at(o, 'status.virtualMachineRef.name'), at(o, 'status.poolRef.name'),
    ...routesOf(egressOf(o)).map((r) => `${r.gateway} ${r.authority}`)].join(' ').toLowerCase();
  return f.split(/\s+/).every((w) => hay.includes(w));
}

// ------------------------------------------------------------------------------ packets

// A packet from an agent to its gateway each time the gateway decides something new for it.
const packets = [];
const lastEgress = new Map(); // agent key -> updatedAt seen
function notePackets() {
  for (const n of agents()) {
    if (n.gone) continue;
    const eg = egressOf(n.obj), ck = checksOf(n.obj);
    const u = `${eg?.e.updatedAt || ''} ${ck?.lastAt || ''}`.trim();
    const before = lastEgress.get(n.key);
    lastEgress.set(n.key, u);
    if (!u || before === undefined || before === u || packets.length > 160) continue;
    const r = routesOf(eg)[0];
    // A named decision goes to its gateway; a bare check, to the row of them.
    if (r) packets.push({ from: n.key, gw: r.gateway, t: 0, bad: r.verdict === 'deny', d: 0.9 + Math.random() * 0.4 });
    else if (ck) packets.push({ from: n.key, gw: null, t: 0, bad: false, d: 0.9 + Math.random() * 0.4 });
  }
}

// ------------------------------------------------------------------------------ labels

const labelLayer = $('labels');
function label(n, cls) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  const b = document.createElement('b'), i = document.createElement('i');
  el.append(b, i);
  el.addEventListener('click', () => select(n.key));
  labelLayer.append(el);
  return { el, b, i, w: 0, title: null, detail: null, cls };
}
function setLabel(l, title, detail, cls) {
  if (l.title !== title) { l.b.textContent = title; l.title = title; l.w = 0; }
  if (l.detail !== detail) { l.i.textContent = detail; l.detail = detail; l.w = 0; }
  if (cls != null && l.cls !== cls) { l.el.className = `lbl ${cls}`; l.cls = cls; }
}
const hostLabels = [];
// A label beside its point, or centred under it (`under`).
function placeLabel(l, p, show, alpha = 1, under = false) {
  if (!l) return;
  const hide = () => { if (l.shown !== false) { l.el.style.opacity = '0'; l.el.style.pointerEvents = 'none'; l.shown = false; } };
  const c = toCam(p);
  if (!show || c[2] <= NEAR) return hide();
  const [x, y] = proj(c);
  if (y < 52 || y > H - 84 || x < -10 || x > W - 30) return hide();
  if (!l.w) l.w = l.el.offsetWidth || 80;
  const lx = clamp(under ? x - l.w / 2 : x + 12, 8, Math.max(8, W - l.w - 8));
  l.el.style.transform = `translate(${Math.round(lx)}px, ${Math.round(under ? y + 2 : y - 10)}px)`;
  l.el.style.opacity = String(clamp(fog(c[2]) * 1.2 * alpha, 0.25, 1));
  l.el.style.pointerEvents = '';
  l.el.classList.toggle('sel', view.sel === l.key);
  l.el.classList.toggle('under', under);
  l.shown = true;
}
const issuersSeen = () => [...new Set([...S.sandbox.values()].map((o) => at(o, 'spec.subject.issuer')).filter(Boolean))];
// The base stations' labels: [title, detail, class, offset].
function baseLabel(n) {
  const sealed = envelopeCount(), set = entriesSetCount();
  switch (n.kind) {
    case 'issuer': { const is = issuersSeen(); return ['OIDC issuer', is.length === 1 ? is[0] : is.length ? `${is.length} issuers` : 'who the agents are', 'ident', [1.6, 1.2, 0]]; }
    case 'broker': return ['broker', 'mediatore', '', [2.2, 0.8, 0]];
    case 'api': return ['Kubernetes API', `${S.sandbox.size} AgentSandbox${S.sandbox.size === 1 ? '' : 'es'}`, '', [2.2, 1.2, 0]];
    case 'vault': return ['Secrets', sealed ? `${sealed} sealed` : 'sealed at rest', 'seal', [0.9, 0.9, 0]];
    case 'openbao': return ['OpenBao', sealed ? `transit key · ${sealed} envelope${sealed === 1 ? '' : 's'}` : 'transit key', 'seal', [1.1, 1.0, 0]];
    case 'spire': {
      const vms = [...S.vm.keys()].filter(attestedVm).length;
      const all = S.entry.size;
      const detail = [S.notes.entry ? 'entries not readable' : `${all} entr${all === 1 ? 'y' : 'ies'}, ${set} set`, vms ? `${vms} VM${vms === 1 ? '' : 's'} attested` : ''].filter(Boolean).join(' · ');
      return ['SPIRE', detail, set || vms ? 'spire lit' : 'spire', [1.3, 1.6, 0]];
    }
    default: return null;
  }
}
function poolCounts(r) {
  const c = { claimed: 0, warm: 0, booting: 0, off: 0 };
  for (const k of r.ms) { const s = memberState(k); if (c[s] != null) c[s]++; }
  return c;
}

function updateLabels() {
  // Agent names: the selected and hovered one, the matches of a filter, and the nearest few.
  const near = agents().filter((n) => !n.gone && n.pos)
    .map((n) => [n, len(sub(n.pos, view.target))]).sort((a, b) => a[1] - b[1]).slice(0, view.dist < 26 ? 18 : view.dist < 45 ? 8 : 0).map(([n]) => n.key);
  const nearSet = new Set(near);
  const load = gatewayLoad();
  const selAgentVm = (() => { const s = view.sel && nodes.get(view.sel); return s?.kind === 'agent' ? vmKeyOf(s.obj) : null; })();
  for (const n of nodes.values()) {
    if (!n.pos) continue;
    const base = baseLabel(n);
    if (base) {
      const [title, detail, cls, off] = base;
      if (!n.label) n.label = label(n, cls);
      n.label.key = n.key;
      setLabel(n.label, title, detail, cls);
      placeLabel(n.label, add(n.pos, off), true);
    } else if (n.kind === 'agent') {
      const st = stateOf(n.obj);
      if (!n.label) n.label = label(n, 'agent');
      n.label.key = n.key;
      const owner = at(n.obj, 'spec.subject.display') || '';
      setLabel(n.label, nameOf(n.obj), `${owner ? owner + ' · ' : ''}${st} · ${ago(at(n.obj, 'metadata.creationTimestamp'))}`, `agent ${st}`);
      const show = !n.gone && (view.sel === n.key || view.hover === n.key || (view.filter && matches(n)) || (nearSet.has(n.key) && matches(n)) || S.sandbox.size <= 12);
      placeLabel(n.label, add(n.pos, [0, 1.2, 0]), show, n.alpha);
    } else if (n.kind === 'gateway') {
      if (!n.label) n.label = label(n, 'gateway');
      n.label.key = n.key;
      const l = load.get(n.name) || 0;
      const ready = n.obj ? condOf(n.obj, 'Ready')?.status : '';
      setLabel(n.label, n.name, `${l} agent${l === 1 ? '' : 's'}${ready && ready !== 'True' ? ' · not ready' : ''}${n.obj ? '' : ' · no VM seen'}`);
      placeLabel(n.label, add(n.pos, [1.7, 2.7, 0]), !n.gone, n.alpha);
    } else if (n.kind === 'policy') {
      if (!n.label) n.label = label(n, 'policy');
      n.label.key = n.key;
      // The name only; the kind and the bundle are in its panel, a click away.
      setLabel(n.label, nameOf(n.obj), '');
      placeLabel(n.label, add(n.pos, [0, -1.35, 0]), !n.gone, n.alpha, true);
    } else if (n.kind === 'ns') {
      if (!n.label) n.label = label(n, 'ns');
      n.label.key = n.key;
      const counts = STATES.map((s) => [s, n.info.list.filter(([, o]) => stateOf(o) === s).length]).filter(([, c]) => c).map(([s, c]) => `${c} ${s}`).join(' · ');
      setLabel(n.label, n.info.ns, counts);
      placeLabel(n.label, n.pos, !n.gone, n.alpha);
    } else if (n.kind === 'pool') {
      if (!n.label) n.label = label(n, 'pool');
      n.label.key = n.key;
      const c = poolCounts(n.info);
      setLabel(n.label, nameOf(n.obj), [`${c.claimed} claimed`, `${c.warm} warm`, c.booting ? `${c.booting} booting` : '', c.off ? `${c.off} off` : ''].filter(Boolean).join(' · '));
      placeLabel(n.label, n.pos, !n.gone, n.alpha);
    } else if (n.kind === 'provider') {
      if (!n.label) n.label = label(n, 'provider');
      n.label.key = n.key;
      const ix = index(), hk = ix.hostByProvider.get(nameOf(n.obj));
      const nv = (ix.vmsOnProvider.get(nameOf(n.obj)) || []).length;
      setLabel(n.label, nameOf(n.obj), [hk ? `host ${nameOf(S.host.get(hk))}` : '', `${nv} VM${nv === 1 ? '' : 's'}`].filter(Boolean).join(' · '));
      // Under the slab's front edge, centred.
      placeLabel(n.label, add(n.pos, [0, -0.5, 1.4]), !n.gone, n.alpha, true);
    } else if (n.kind === 'vm') {
      if (!n.label) n.label = label(n, 'vm');
      n.label.key = n.key;
      const st = memberState(n.key);
      setLabel(n.label, nameOf(n.obj), st, `vm ${st}`);
      placeLabel(n.label, add(n.pos, [0, 0.9, 0]), !n.gone && (view.sel === n.key || view.hover === n.key || selAgentVm === n.key || (view.sel === n.pool && (nodes.get(n.pool)?.info?.ms.length || 0) <= 8)), n.alpha);
    }
  }
  // The selected agent's (or gateway's) hosts.
  const hs = selHosts();
  while (hostLabels.length < hs.length) { const l = label({ key: '' }, 'gateway'); l.el.classList.add('nopick'); hostLabels.push(l); }
  hostLabels.forEach((l, i) => {
    const h = hs[i];
    if (!h) { placeLabel(l, [0, 0, 0], false); return; }
    setLabel(l, h.r.authority, `${h.r.verdict}${h.r.reason ? ' · ' + h.r.reason : ''} · ${h.r.count}×`, h.r.verdict === 'deny' ? 'agent refused' : 'agent exited');
    placeLabel(l, add(h.at, [0, 0.4, 0]), true);
  });
}

// How many running agents each gateway carries.
function gatewayLoad() {
  const load = new Map();
  for (const a of agents()) {
    if (a.gone || !live(a.obj)) continue;
    const g = carrierOf(egressOf(a.obj));
    if (g) load.set(g, (load.get(g) || 0) + 1);
  }
  return load;
}

// Where the selected agent's (or gateway's) hosts float: above the gateway that carried each.
function selHosts() {
  const n = view.sel && nodes.get(view.sel);
  if (!n || n.gone) return [];
  let routes = [];
  if (n.kind === 'agent') routes = routesOf(egressOf(n.obj));
  else if (n.kind === 'gateway') {
    const by = new Map();
    for (const a of agents()) for (const r of routesOf(egressOf(a.obj))) if (r.gateway === n.name) {
      const k = `${r.authority} ${r.verdict}`;
      const was = by.get(k);
      by.set(k, was ? { ...was, count: was.count + r.count } : { ...r });
    }
    routes = [...by.values()].sort((a, b) => b.count - a.count);
  } else return [];
  routes = routes.slice(0, 10);
  const perGw = new Map();
  return routes.map((r) => {
    const g = gatewayNode(r.gateway);
    if (!g?.pos) return null;
    const i = perGw.get(r.gateway) || 0;
    perGw.set(r.gateway, i + 1);
    return { r, gw: g, at: add(g.pos, [(i % 3 - 1) * 3, 4.2 + Math.floor(i / 3) * 1.8, 0.6]) };
  }).filter(Boolean);
}

// ------------------------------------------------------------------------------ the frame

let clock = 0, last = 0;
const floor = (() => {
  const pts = [], edges = [], y = FLOOR_Y - 0.4;
  for (let x = -30; x <= 160; x += 5) { const o = pts.length; pts.push([x, y, -50], [x, y, 90]); edges.push([o, o + 1]); }
  for (let z = -50; z <= 90; z += 5) { const o = pts.length; pts.push([-30, y, z], [160, y, z]); edges.push([o, o + 1]); }
  return { pts, edges };
})();

function frame(now) {
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now; clock += dt;
  if (inbox.length) { for (const m of inbox.splice(0)) apply(m); }
  if (dirty) { dirty = false; layout(); notePackets(); paintBar(); }

  // Nodes ease to their places; new ones rise in, gone ones fade and are dropped.
  const k = 1 - Math.exp(-dt * 4);
  for (const [key, n] of nodes) {
    if (!n.pos) n.pos = n.kind === 'agent' || n.kind === 'vm' ? add(n.goal, [0, -2, 0]) : n.goal.slice();
    n.pos = mix(n.pos, n.goal, REDUCED ? 1 : k);
    n.alpha = n.gone ? Math.max(0, n.alpha - dt * 1.2) : Math.min(1, n.alpha + dt * 1.5);
    if (n.gone && n.alpha <= 0) { n.label?.el.remove(); nodes.delete(key); lastEgress.delete(key); if (view.sel === key) select(null); }
  }

  // The camera: orbiting its target, turning slowly while nobody touches it.
  view.idle += dt;
  if (!view.sel && view.idle > 8 && !REDUCED) view.yaw += dt * 0.025;
  if (view.goal) view.target = mix(view.target, view.goal, 1 - Math.exp(-dt * 3));
  const off = rotY(rotX([0, 0, view.dist], -view.pitch), view.yaw);
  // With the details open, the scene's centre moves left of them.
  view.shift += ((inspOpen ? view.dist * 0.2 : 0) - view.shift) * (1 - Math.exp(-dt * 4));
  const look = add(view.target, mul(norm([cam.r[0], 0, cam.r[2]]), view.shift));
  aim(add(look, off), look);

  ctx.clearRect(0, 0, W, H);
  lines(floor.pts, floor.edges, C.dim, 0.35, 1);
  drawScene(dt);
  updateLabels();
  flushOutput();
  if (stamp !== shownStamp && view.sel && clock - shownAt > 0.5) renderDetails();
  requestAnimationFrame(frame);
}

// A raised arc from a to b, as points.

// Faint lines of one colour and dash, gathered over a frame and stroked once: a fleet's worth of
// connections costs a few strokes, not one per line.
const batches = new Map();
function batched(color, pts, dash = null) {
  const k = `${color}|${dash || ''}`;
  let b = batches.get(k);
  if (!b) { b = { color, dash, pts: [], edges: [] }; batches.set(k, b); }
  const o = b.pts.length;
  b.pts.push(...pts);
  for (let i = 0; i < pts.length - 1; i++) b.edges.push([o + i, o + i + 1]);
}
function flushBatches(alpha) {
  for (const b of batches.values()) if (b.edges.length) lines(b.pts, b.edges, b.color, alpha, 1, b.dash ? { dash: b.dash } : {});
  batches.clear();
}

function drawScene(dt) {
  const sel = view.sel && nodes.get(view.sel);
  const t = clock;
  // The base theatre: the issuer, the broker, the Kubernetes API and its vault, OpenBao and
  // SPIRE, lit by what the cluster shows of them.
  const attestedCount = [...S.vm.keys()].filter(attestedVm).length;
  const sealed = envelopeCount() > 0, ids = entriesSetCount() > 0 || attestedCount > 0;
  drawIssuer(S.sandbox.size ? 0.7 : 0.35, t);
  drawBroker(0.85, t);
  drawApi(0.85, t);
  draw(SHAPES.vault, ST.vault, sealed ? C.seal : C.dim, sealed ? 0.85 : 0.5, { ry: -0.5 });
  drawBao(sealed, t);
  drawSpire(ids, t);
  // The base edges that carry something: the broker seals with OpenBao; the API's entries are
  // rendered into SPIRE. OpenBao's PKI under SPIRE only while one of the two is picked.
  if (sealed) lines(BASE_EDGES.transit(), [[0, 1]], C.seal, 0.4, 1);
  if (ids) lines(BASE_EDGES.entries(), [[0, 1]], C.spire, 0.45, 1.1);
  if (['spire', 'openbao'].includes(sel?.key)) lines(BASE_EDGES.pki(), [[0, 1]], C.spire, 0.5, 1, { dash: [4, 6] });
  // Plots.
  for (const n of nodes.values()) if (n.kind === 'ns' && n.pos) {
    const p = n.info, y = FLOOR_Y, x0 = p.x0 - 0.6, x1 = p.x0 + p.w + 0.6, z0 = p.z0 - 0.8, z1 = p.z0 + p.d + 0.4;
    const lit = sel && sel.kind === 'agent' && nsOf(sel.obj) === p.ns;
    lines([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], chain(4, true), lit ? C.wire : C.muted, (lit ? 0.6 : 0.3) * n.alpha, 1);
  }
  // The providers, and a line from each VM (pool member or gateway) to the one it runs on.
  for (const n of nodes.values()) if (n.kind === 'provider' && n.pos) {
    const on = sel && (sel.key === n.key || ((sel.kind === 'vm' || sel.kind === 'gateway') && at(sel.kind === 'vm' ? sel.obj : sel.obj, 'status.scheduled.providerName') === nameOf(n.obj)));
    const ready = condOf(n.obj, 'Ready')?.status !== 'False';
    draw(SHAPES.provider, n.pos, ready ? C.ident : C.bad, (on ? 1 : 0.7) * n.alpha, { width: on ? 1.6 : 1, glow: on });
  }
  for (const n of nodes.values()) if ((n.kind === 'vm' || n.kind === 'gateway') && n.pos && n.obj) {
    const pk = index().providerByName.get(at(n.obj, 'status.scheduled.providerName'));
    const pn = pk && nodes.get(pk);
    if (!pn?.pos) continue;
    const pts = arcPts(add(n.pos, [0, -0.3, 0]), add(pn.pos, [0, 0.3, 0]), 1, 10);
    if (sel && (sel.key === n.key || sel.key === pk)) lines(pts, chain(pts.length), C.ident, 0.7, 1.2);
    else batched(C.ident, pts, [1, 4]);
  }
  // The pools: a rack each, its members on it.
  const selVm = sel?.kind === 'agent' ? vmKeyOf(sel.obj) : sel?.kind === 'vm' ? sel.key : null;
  for (const n of nodes.values()) if (n.kind === 'pool' && n.pos) {
    const r = n.info, y = FLOOR_Y, x0 = r.x0, x1 = r.x0 + r.w, z0 = r.z0, z1 = r.z0 + r.d;
    const lit = sel && (sel.key === n.key || (selVm && nodes.get(selVm)?.pool === n.key));
    lines([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], chain(4, true), lit ? C.ok : C.muted, (lit ? 0.7 : 0.35) * n.alpha, lit ? 1.4 : 1);
    lines([[x0, y + 0.02, z0 + 0.5], [x1, y + 0.02, z0 + 0.5]], [[0, 1]], C.muted, 0.25 * n.alpha, 1);
  }
  for (const n of nodes.values()) if (n.kind === 'vm' && n.pos) {
    const st = memberState(n.key);
    const on = selVm === n.key || view.hover === n.key;
    draw(SHAPES.member, n.pos, MEMBER_COLOR[st], (on ? 1 : st === 'claimed' ? 0.8 : 0.6) * n.alpha, { width: on ? 1.8 : 1, glow: on, dash: st === 'booting' ? [2, 3] : null });
    // Its SPIRE agent, attested at boot, holds the node SVID from then on: warm or claimed.
    if ((st === 'warm' || st === 'claimed') && attestedVm(n.key)) {
      const pts = arcPts(add(ST.spire, [0, 1.9, 0]), add(n.pos, [0, 0.6, 0]), 5, 16);
      // A few per pool, so drawn at a steady strength, not thinned with the fleet.
      lines(pts, chain(pts.length), C.spire, on ? 0.85 : 0.45, on ? 1.4 : 1.1, { dash: [3, 5] });
    }
    // The sandbox in it: a small cage in its agent's colour, turning while the agent runs.
    if (st === 'claimed') {
      const a = nodes.get(index().agentOnVm.get(n.key));
      if (a?.obj) {
        const as = stateOf(a.obj);
        draw(SHAPES.agentCage, add(n.pos, [0, 0.05, 0]), STATE_COLOR[as], 0.9 * n.alpha, { scale: 0.42, ry: live(a.obj) ? t * 0.8 : 0, glow: on });
      }
    }
  }
  // Gateways, brighter for the load they carry; each reports its decisions to the broker.
  const load = gatewayLoad();
  for (const n of nodes.values()) if (n.kind === 'gateway' && n.pos) {
    const l = load.get(n.name) || 0;
    const on = sel && (sel.key === n.key || (sel.kind === 'agent' && routesOf(egressOf(sel.obj)).some((r) => r.gateway === n.name)));
    // A banlieue VM like the pools' members, larger, with Envoy's diamond turning over it.
    const top = add(n.pos, [0, 1.9, 0]);
    draw(SHAPES.member, n.pos, C.carrier, (l ? 0.85 : 0.4) * n.alpha, { scale: 1.6, width: on ? 1.8 : 1.2, glow: on });
    draw(SHAPES.gwBig, top, C.carrier, (l ? 0.95 : 0.4) * n.alpha, { ry: t * 0.6, scale: 1 + Math.min(l, 12) * 0.04, width: on ? 2 : 1.3, glow: l > 0 || on });
    if (l) draw(SHAPES.gatewayRing, n.pos, C.carrier, 0.35 * n.alpha, { scale: 1.6 + 0.1 * Math.sin(t * 2 + n.pos[0]) });
    if (l) lines([n.pos, add(ST.broker, [0, 1.2, 0])], [[0, 1]], C.ident, 0.12 * n.alpha, 1, { dash: [3, 6] });
  }
  // Policies: a signed sheet, turned to face you.
  for (const n of nodes.values()) if (n.kind === 'policy' && n.pos) {
    const d = sub(cam.pos, n.pos);
    const on = sel && (sel.key === n.key || (sel.kind === 'agent' && nsOf(sel.obj) === nsOf(n.obj) && at(sel.obj, 'spec.policyRef.name') === nameOf(n.obj)));
    draw(SHAPES.policyDoc, n.pos, C.policy, (on ? 1 : 0.6) * n.alpha, { ry: Math.atan2(d[0], d[2]), width: on ? 1.8 : 1, glow: on });
  }
  // Agents. Their carrier lines thin out as they multiply, so the city stays readable.
  const carrying = agents().filter((n) => !n.gone && live(n.obj)).length;
  const tier = tierPos();
  const thin = clamp(30 / Math.max(1, carrying), 0.15, 1);
  for (const n of agents()) {
    if (!n.pos) continue;
    const st = stateOf(n.obj);
    const code = at(n.obj, 'status.record.exit.code');
    const color = st === 'exited' && code != null && code !== 0 ? C.bad : STATE_COLOR[st];
    const isSel = view.sel === n.key, hov = view.hover === n.key;
    const m = matches(n);
    let a = (st === 'exited' ? 0.45 : st === 'pending' ? 0.6 : 0.85) * n.alpha * (m ? 1 : 0.12);
    if (isSel || hov) a = Math.max(a, 0.95 * n.alpha);
    draw(SHAPES.agentCage, n.pos, color, a, { width: isSel ? 2 : 1, glow: isSel || (m && st === 'running' && !!view.filter), dash: st === 'pending' ? [3, 4] : null });
    if (live(n.obj)) draw(SHAPES.agentCore, n.pos, color, a, { ry: t * 1.4 + n.pos[0], rx: 0.4 });
    if (st === 'refused') draw(SHAPES.agentCross, n.pos, C.bad, a, { width: 1.6 });
    // One line, to the gateway carrying it (or the row of them, when the broker says only that
    // one checked it); kept, dimmed, for a while after the agent exits.
    const active = live(n.obj), recent = !active && justExited(n.obj);
    const eg = active || recent ? egressOf(n.obj) : null;
    const g = eg && gatewayNode(carrierOf(eg));
    const to = g?.pos || ((active || recent) && checked(n.obj) ? tier : null);
    if (to) lines(arcPts(add(n.pos, [0, CAGE_TOP, 0]), to, 2.2, 12), chain(13), C.carrier, (isSel ? 0.85 : view.filter && m ? 0.5 : 0.2 * thin) * n.alpha * (m ? 1 : 0.2) * (recent ? 0.5 : 1), isSel ? 1.6 : 1, recent ? { dash: [4, 4] } : {});
    // Every other connection an active sandbox has, always drawn: its guest agent to the
    // broker's sandbox listener (output, the exit, /v1/me, over mutual TLS); its identities
    // from SPIRE while its entry is set; its credentials, sealed and opened with OpenBao's key;
    // the pool VM it runs in; the policy it runs under. Faint and batched; bright when picked.
    if (active || recent) {
      const top = add(n.pos, [0, CAGE_TOP, 0]);
      const ties = [[C.wire, arcPts(top, add(ST.broker, [0, 1.2, 0]), 5, 16), null]];
      if (entriesOf(n.obj).claim) ties.push([C.spire, arcPts(add(ST.spire, [0, 1.9, 0]), top, 4, 16), [3, 5]]);
      if (envelopesOf(n.obj).length) ties.push([C.seal, arcPts(add(ST.bao, [0, 1.5, 0]), top, 3, 16), [2, 5]]);
      const vk = vmKeyOf(n.obj), v = vk && nodes.get(vk);
      if (v?.pos) ties.push([C.wire, arcPts(add(n.pos, [0, -CAGE_TOP, 0]), add(v.pos, [0, 0.3, 0]), 1.5, 12), [3, 4]]);
      const pn = nodes.get(`policy/${nsOf(n.obj)}/${at(n.obj, 'spec.policyRef.name')}`);
      if (pn?.pos) ties.push([C.policy, [top, add(pn.pos, [0, -1.05, 0])], [4, 5]]);
      for (const [col, pts, dash] of ties) {
        if (isSel) lines(pts, chain(pts.length), col, 0.8, 1.3, dash ? { dash } : {});
        else if (m && !recent) batched(col, pts, dash);
      }
    }
  }
  // The fleet's connections, faint, thinning as they multiply; dimmer still while one is picked.
  flushBatches(clamp(0.32 * thin * (sel ? 0.5 : 1), 0.08, 0.32));
  // An agent and its VM, from either end.
  if (selVm) {
    const v = nodes.get(selVm), ak = index().agentOnVm.get(selVm), a = ak && nodes.get(ak);
    if (v?.pos && a?.pos) lines(arcPts(add(a.pos, [0, -CAGE_TOP, 0]), add(v.pos, [0, 0.3, 0]), 1.5, 12), chain(13), C.wire, 0.75, 1.3, { dash: [3, 4] });
  }
  // A pool picked: each claimed member to its agent, faint.
  if (sel?.kind === 'pool') {
    for (const k of sel.info.ms) {
      const v = nodes.get(k), ak = index().agentOnVm.get(k), a = ak && nodes.get(ak);
      if (v?.pos && a?.pos) lines([add(v.pos, [0, 0.3, 0]), add(a.pos, [0, -CAGE_TOP, 0])], [[0, 1]], C.wire, 0.3, 1);
    }
  }
  if (sel?.kind === 'policy') {
    for (const a of agents()) if (!a.gone && nsOf(a.obj) === nsOf(sel.obj) && at(a.obj, 'spec.policyRef.name') === nameOf(sel.obj)) {
      lines([add(sel.pos, [0, -1.05, 0]), add(a.pos, [0, CAGE_TOP, 0])], [[0, 1]], C.policy, 0.35, 1, { dash: [4, 5] });
    }
  }
  // SPIRE or OpenBao picked: one faint line to each agent it holds something for.
  if (sel?.key === 'spire' || sel?.key === 'openbao') {
    const from = sel.key === 'spire' ? add(ST.spire, [0, 1.9, 0]) : ST.vault;
    const col = sel.key === 'spire' ? C.spire : C.seal;
    for (const a of agents()) {
      if (a.gone || !a.pos) continue;
      const has = sel.key === 'spire' ? !!entriesOf(a.obj).claim : envelopesOf(a.obj).length > 0;
      if (has) lines([from, add(a.pos, [0, CAGE_TOP, 0])], [[0, 1]], col, 0.22, 1);
    }
  }
  for (const h of selHosts()) {
    const c = h.r.verdict === 'deny' ? C.bad : C.ok;
    draw(SHAPES.host, h.at, c, 0.9, { ry: Math.atan2(cam.pos[0] - h.at[0], cam.pos[2] - h.at[2]) });
    lines([h.gw.pos, h.at], [[0, 1]], c, 0.45, 1, { dash: h.r.verdict === 'deny' ? [3, 4] : null });
  }
  // Packets: up the arc to the gateway; a refused one bounces back.
  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i];
    const from = nodes.get(p.from), to = p.gw ? gatewayNode(p.gw)?.pos : tierPos();
    p.t += dt / p.d;
    if (!from?.pos || !to || p.t >= (p.bad ? 2 : 1)) { packets.splice(i, 1); continue; }
    const tt = p.bad && p.t > 1 ? 2 - p.t : p.t;
    draw(SHAPES.pkt, arc(add(from.pos, [0, CAGE_TOP, 0]), to, 2.2, clamp(tt)), p.bad ? C.bad : C.carrier, 0.95, { ry: t * 4, glow: true });
  }
}

// ------------------------------------------------------------------------------ the bar and caption

function paintBar() {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const o of S.sandbox.values()) counts[stateOf(o)]++;
  const box = $('counts');
  if (!box.children.length) {
    for (const s of STATES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = s; b.dataset.s = s;
      b.title = `Only the ${s} agents (click again for all)`;
      b.append(document.createElement('b'), document.createTextNode(s));
      b.addEventListener('click', () => { view.only = view.only === s ? null : s; for (const x of box.children) x.classList.toggle('on', x.dataset.s === view.only); });
      box.append(b);
    }
  }
  for (const b of box.children) { const t = String(counts[b.dataset.s]); if (b.firstChild.textContent !== t) b.firstChild.textContent = t; }
  const nsCount = new Set([...S.sandbox.values()].map(nsOf)).size;
  const gws = [...nodes.values()].filter((n) => n.kind === 'gateway' && !n.gone).length;
  const sources = new Set([...S.sandbox.values()].map((o) => egressOf(o)?.source || (checked(o) ? 'checks' : null)).filter(Boolean));
  const SRC = { status: 'status.egress (ADR-0063)', log: 'the broker log (ADR-0062)', checks: 'gateway checks in the broker log' };
  const src = sources.size ? `egress from ${[...sources].map((s) => SRC[s]).join(' and ')}` : 'no gateway decisions seen yet';
  const members = [...index().members.values()].reduce((s, l) => s + l.length, 0);
  $('cap-detail').textContent = `${S.sandbox.size} agent${S.sandbox.size === 1 ? '' : 's'} in ${nsCount} namespace${nsCount === 1 ? '' : 's'} · ${S.pool.size} pool${S.pool.size === 1 ? '' : 's'}, ${members} VM${members === 1 ? '' : 's'} · ${gws} gateway${gws === 1 ? '' : 's'} · ${src}`;
  const notes = Object.entries(S.notes).map(([k, t]) => `${KIND_NAME[k] || k}: ${t}`);
  $('cap-notes').hidden = !notes.length;
  $('cap-notes').textContent = notes.join(' · ');
}
const KIND_NAME = { sandbox: 'AgentSandboxes', vm: 'VirtualMachines', pool: 'VirtualMachinePools', policy: 'SandboxPolicies', egress: 'gateway decisions', entry: 'SPIRE entries', envelope: 'sealed Secrets', segment: 'sealed output', node: 'SandboxNodes', floor: 'PolicyFloors', machine: 'LibvirtMachines', provider: 'Providers', host: 'faubourg Hosts', cluster: 'cluster' };

// ------------------------------------------------------------------------------ the details

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let shownStamp = -1, shownAt = 0, rawOpen = false, inspOpen = false;

function dl(rows) {
  const d = el('dl');
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    d.append(el('dt', null, k));
    const dd = el('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = String(v);
    d.append(dd);
  }
  return d;
}
function pick(key, text) {
  const b = el('button', 'pick', text);
  b.type = 'button';
  b.addEventListener('click', () => select(key));
  return b;
}
function raw(title, obj) {
  const d = el('details');
  d.open = rawOpen;
  d.addEventListener('toggle', () => { rawOpen = d.open; });
  const { 'x-recess': _derived, ...own } = obj || {};
  d.append(el('summary', null, title), el('pre', null, toYaml(own)));
  return d;
}
const note = (text) => el('p', 'note', text);
function routesTable(routes, withGw) {
  const t = el('table', 'routes');
  const h = el('tr');
  for (const c of [...(withGw ? ['gateway'] : []), 'host', 'kind', 'verdict', 'n', 'last']) h.append(el('th', null, c));
  t.append(h);
  for (const r of routes) {
    const tr = el('tr');
    if (withGw) { const td = el('td', 'gw'); td.append(gatewayNode(r.gateway) ? pick(`gw/${r.gateway}`, r.gateway) : r.gateway); tr.append(td); }
    tr.append(el('td', null, r.authority + (r.audience ? ` (${r.audience})` : '')), el('td', null, r.kind),
      el('td', r.verdict, r.verdict + (r.reason ? ` · ${r.reason}` : '')), el('td', 'n', String(r.count)), el('td', 'n', ago(r.lastAt)));
    t.append(tr);
  }
  return t;
}
// A list of nodes, each a link to it.
function nodeList(list, title, sub) {
  const ul = el('ul');
  for (const a of list) { const li = el('li'); li.append(pick(a.key, title(a)), el('span', 'sub', sub(a))); ul.append(li); }
  if (!list.length) ul.append(el('li', 'empty', 'none on screen'));
  return ul;
}
const agentList = (list, sub) => nodeList(list, (a) => nameOf(a.obj), sub);
// A VM's facts, as banlieue reports them.
function vmRows(vm) {
  const ready = condOf(vm, 'Ready'), guest = condOf(vm, 'GuestReady');
  return [['power', at(vm, 'status.observedPowerState')], ['ready', ready ? `${ready.status}${ready.reason ? ` (${ready.reason})` : ''}` : ''],
    ['guest ready', guest?.status], ['class', at(vm, 'spec.classRef.name')], ['image', at(vm, 'spec.imageRef.name')],
    ['addresses', (at(vm, 'status.addresses') || []).map((x) => (typeof x === 'string' ? x : x.address)).join(', ')],
    ['host', at(vm, 'status.scheduled.providerName')], ['failure domain', at(vm, 'status.scheduled.failureDomain')],
    ['attested as', at(vm, 'status.attestationSubject')], ['created', at(vm, 'metadata.creationTimestamp')]];
}

function renderDetails() {
  shownStamp = stamp; shownAt = clock;
  const box = $('details');
  const n = view.sel && nodes.get(view.sel);
  inspOpen = !!n;
  $('insp').hidden = !n;
  if (!n) return;
  const keep = box.scrollTop;
  const panel = PANELS[n.kind];
  box.replaceChildren(...(panel ? panel(n) : []));
  box.scrollTop = keep;
}

function entryRows(e) {
  if (!e) return [];
  return [['SPIFFE ID', at(e, 'spec.spiffeID')], ['parent (agent)', at(e, 'spec.parentID')], ['selectors', (at(e, 'spec.selectors') || []).join(', ')],
    ['SVID lifetime', at(e, 'spec.x509SVIDTTL')], ['on the server', at(e, 'status.set') ? 'yes (set)' : at(e, 'status.rendered') ? 'rendered, not yet set' : 'not yet']];
}

const PANELS = {
  agent: (n) => {
    const o = n.obj, st = stateOf(o), s = o.status || {};
    const pol = at(o, 'spec.policyRef.name');
    const pk = `policy/${nsOf(o)}/${pol}`;
    const conf = condOf(o, 'PolicyConformant');
    const exit = at(s, 'record.exit');
    const vk = vmKeyOf(o);
    const vmObj = vk && S.vm.get(vk);
    const poolKey = vk && index().poolOfVm.get(vk);
    const k = el('div', 'kicker');
    k.append(pick(`ns/${nsOf(o)}`, nsOf(o)), document.createTextNode(' · AgentSandbox · '), el('span', `st-${st}`, st));
    const expires = s.expiresAt ? `${s.expiresAt}${Date.parse(s.expiresAt) > Date.now() ? ` (in ${ago(s.expiresAt)})` : ''}` : '';
    const out = [k, el('h2', null, nameOf(o)),
      el('p', 'lede', `${at(o, 'spec.subject.display') || at(o, 'spec.subject.id') || 'someone'} · ${at(o, 'spec.workload.image') || ''} · ${ago(at(o, 'metadata.creationTimestamp'))} old`),
      dl([
        ['owner', at(o, 'spec.subject.display') ? `${at(o, 'spec.subject.display')} (${at(o, 'spec.subject.id')})` : at(o, 'spec.subject.id')],
        ['issuer', at(o, 'spec.subject.issuer')],
        ['phase', s.phase + (s.ready ? ' · ready' : '')],
        ['reason', s.reason],
        ['policy', pol ? (nodes.get(pk) ? pick(pk, `${pol}${at(s, 'record.bundleVersion') != null ? ' · bundle ' + at(s, 'record.bundleVersion') : ''}`) : `${pol} (not seen)`) : 'none named'],
        ['conformant', conf ? `${conf.status} · ${conf.reason}${conf.message ? ': ' + conf.message : ''}` : ''],
        ['VM', vk && nodes.get(vk) ? pick(vk, s.virtualMachineRef.name) : s.virtualMachineRef?.name || ''],
        ['pool', poolKey && nodes.get(poolKey) ? pick(poolKey, nameOf(S.pool.get(poolKey))) : s.poolRef?.name || ''],
        ['addresses', (s.addresses || []).join(', ')],
        ['expires', expires],
        ['exit', exit ? `code ${exit.code ?? '-'}${exit.signal ? ' signal ' + exit.signal : ''} · ${ago(exit.exited_at)} ago` : ''],
        ['claim', claimUidOf(o)],
      ]),
    ];
    const eg = egressOf(o);
    const h = el('h3', null, 'Egress');
    h.append(el('span', `src ${eg ? (eg.source === 'status' ? 'status' : 'log') : 'none'}`, eg ? (eg.source === 'status' ? 'status.egress' : 'broker log') : 'none yet'));
    out.push(h);
    if (eg) {
      const routes = routesOf(eg);
      out.push(note(`${routes.length} host${routes.length === 1 ? '' : 's'} through ${new Set(routes.map((r) => r.gateway)).size} gateway(s), newest first.${eg.e.overflow ? ` ${eg.e.overflow} more decision(s) past the bound.` : ''} The gateway's name is its own claim (ADR-0062): attribution, not proof.`));
      out.push(routesTable(routes, true));
    } else if (checked(o)) {
      const ck = checksOf(o);
      out.push(dl([['gateway checks', `${ck.count}${ck.refused ? ` (${ck.refused} refused)` : ''}`], ['last', ck.lastAt ? `${ago(ck.lastAt)} ago` : '']]));
      out.push(note('The broker logs each time a gateway checks this claim (a tunnel being opened), not which gateway or which host; its line goes to the gateways as a row. A broker with ADR-0062 names both.'));
    } else {
      out.push(note(live(o)
        ? 'No gateway decision about this claim yet: either it has made no connection, or the broker neither writes status.egress (ADR-0063) nor logs gateway decisions you may read (ADR-0062).'
        : 'Egress is shown while the agent runs.'));
    }
    // Its identity, from SPIRE, and its envelopes, sealed by OpenBao.
    const { claim, node: nodeEntry } = entriesOf(o);
    const hs = el('h3', null, 'Identity · ');
    hs.append(pick('spire', 'SPIRE'));
    out.push(hs);
    if (claim) out.push(dl([['claim entry', nameOf(claim)], ...entryRows(claim)]));
    if (nodeEntry) out.push(dl([['node entry', nameOf(nodeEntry)], ...entryRows(nodeEntry)]));
    if (!claim) out.push(note(S.notes.entry ? `SPIRE entries not readable: ${S.notes.entry}` : live(o) ? 'No SPIRE entry for this claim seen.' : 'Its entries exist while it is bound; the release deletes them.'));
    const envs = envelopesOf(o);
    const hb = el('h3', null, 'Sealed · ');
    hb.append(pick('openbao', 'OpenBao'));
    out.push(hb);
    if (envs.length) {
      const ul = el('ul');
      for (const e of envs) { const li = el('li'); li.append(el('span', null, envelopeKind(e)), el('span', 'sub', `${e.name} · ${ago(e.created)} old`)); ul.append(li); }
      out.push(ul);
    } else out.push(note(S.notes.envelope ? `sealed Secrets not readable: ${S.notes.envelope}` : 'No sealed Secret for this agent seen.'));
    out.push(el('h3', null, 'Cross-references'), xrefTable(n));
    out.push(raw('raw (YAML)', o));
    if (vmObj) out.push(raw('its VirtualMachine (YAML)', vmObj));
    return out;
  },

  pool: (n) => {
    const p = n.obj, r = n.info, c = poolCounts(r), st = p.status || {};
    const warm = condOf(p, 'Warm');
    const byState = (s) => r.ms.filter((k) => memberState(k) === s).map((k) => nodes.get(k)).filter(Boolean);
    const agentOf = (v) => { const ak = index().agentOnVm.get(v.key); return ak && nodes.get(ak); };
    const out = [el('div', 'kicker', `${nsOf(p)} · VirtualMachinePool`), el('h2', null, nameOf(p)),
      el('p', 'lede', 'banlieue keeps these VMs booted and warm; a claim binds one, mediatore\'s guest runs the agent in it, and the release returns it.'),
      dl([['replicas', st.replicas], ['available', st.available], ['claimed', st.claimed], ['provisioning', st.provisioning],
        ['warm', warm ? `${warm.status}${warm.message ? `: ${warm.message}` : ''}` : ''], ['class', at(p, 'spec.classRef.name')], ['image', at(p, 'spec.imageRef.name')],
        ['members on screen', `${c.claimed} claimed · ${c.warm} warm · ${c.booting} booting${c.off ? ` · ${c.off} off` : ''}`]]),
      el('h3', null, 'Claimed: the agent on each'),
      nodeList(byState('claimed'), (v) => nameOf(v.obj), (v) => { const a = agentOf(v); return a ? `${nameOf(a.obj)} · ${nsOf(a.obj)} · ${stateOf(a.obj)}` : ''; }),
      el('h3', null, 'Warm and booting'),
      nodeList([...byState('warm'), ...byState('booting'), ...byState('off')], (v) => nameOf(v.obj), (v) => `${memberState(v.key)} · ${ago(at(v.obj, 'metadata.creationTimestamp'))} old`),
      raw('raw (YAML)', p)];
    return out;
  },

  provider: (n) => {
    const o = n.obj, hk = index().hostByProvider.get(nameOf(o)), h = hk && S.host.get(hk);
    const ready = condOf(o, 'Ready');
    return [el('div', 'kicker', `${nsOf(o)} · banlieue Provider`), el('h2', null, nameOf(o)),
      el('p', 'lede', 'Where banlieue schedules VMs: one hypervisor (libvirt, Cloud Hypervisor, ...) on one host.'),
      dl([['class', at(o, 'spec.providerClass')], ['ready', ready ? `${ready.status}${ready.reason ? ` (${ready.reason})` : ''}` : ''],
        ['failure domains', (at(o, 'status.failureDomains') || []).map((f) => f.name).filter(Boolean).join(', ')],
        ['host', h ? `${nameOf(h)}${at(h, 'spec.address') ? ' · ' + at(h, 'spec.address') : ''}${at(h, 'spec.zoneRef') ? ' · zone ' + at(h, 'spec.zoneRef') : ''}` : '']]),
      el('h3', null, 'Cross-references'), xrefTable(n),
      raw('raw (YAML)', o), ...(h ? [raw('its faubourg Host (YAML)', h)] : [])];
  },

  vm: (n) => {
    const vm = n.obj, st = memberState(n.key);
    const ak = index().agentOnVm.get(n.key), a = ak && nodes.get(ak);
    const pk = n.pool;
    return [el('div', 'kicker', `${nsOf(vm)} · VirtualMachine · ${st}`), el('h2', null, nameOf(vm)),
      el('p', 'lede', st === 'claimed' ? 'A pool member bound to a claim: the agent below runs in its jail.' : st === 'warm' ? 'A pool member booted and waiting for a claim.' : st === 'booting' ? 'A pool member still coming up; it joins the warm ones once its guest is ready.' : 'A pool member, powered off.'),
      dl([['agent', a ? pick(a.key, nameOf(a.obj)) : 'none'], ['pool', pk && nodes.get(pk) ? pick(pk, nameOf(S.pool.get(pk))) : ''],
        ['SPIRE', attestedVm(n.key) ? pick('spire', 'attested: its agent holds the node SVID (ADR-0019)') : st === 'booting' ? 'not yet: it attests as it comes up' : 'not attested'],
        ...vmRows(vm)]),
      el('h3', null, 'Cross-references'), xrefTable(n),
      raw('raw (YAML)', vm)];
  },

  gateway: (n) => {
    const o = n.obj;
    const carried = agents().filter((a) => !a.gone && routesOf(egressOf(a.obj)).some((r) => r.gateway === n.name));
    const all = [];
    for (const a of carried) for (const r of routesOf(egressOf(a.obj))) if (r.gateway === n.name) all.push({ ...r, agent: a });
    all.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    const allow = all.filter((r) => r.verdict === 'allow').reduce((s, r) => s + r.count, 0);
    const deny = all.filter((r) => r.verdict === 'deny').reduce((s, r) => s + r.count, 0);
    const out = [el('div', 'kicker', 'egress gateway'), el('h2', null, n.name),
      el('p', 'lede', 'Envoy and the authorizer: it decides each tunnel and each credential placement a claim asks for, and reports the decision to the broker.'),
      dl([['VM', o ? `${nsOf(o)}/${nameOf(o)}` : 'none seen with this name (a gateway names itself)'], ...(o ? vmRows(o) : []),
        ['decisions', `${allow} allowed · ${deny} refused, for ${carried.length} agent(s) on screen`]]),
      el('h3', null, 'Agents it carried'),
      agentList(carried, (a) => `${nsOf(a.obj)} · ${stateOf(a.obj)} · ${routesOf(egressOf(a.obj)).filter((r) => r.gateway === n.name).length} host(s)`),
      el('h3', null, 'Recent decisions')];
    const t = el('table', 'routes');
    const h = el('tr');
    for (const c of ['agent', 'host', 'verdict', 'n', 'last']) h.append(el('th', null, c));
    t.append(h);
    for (const r of all.slice(0, 40)) {
      const tr = el('tr'), td = el('td');
      td.append(pick(r.agent.key, nameOf(r.agent.obj)));
      tr.append(td, el('td', null, r.authority), el('td', r.verdict, r.verdict + (r.reason ? ` · ${r.reason}` : '')), el('td', 'n', String(r.count)), el('td', 'n', ago(r.lastAt)));
      t.append(tr);
    }
    out.push(t);
    out.push(el('h3', null, 'Cross-references'), xrefTable(n));
    if (o) out.push(raw('raw (YAML)', o));
    return out;
  },

  policy: (n) => {
    const o = n.obj;
    const naming = agents().filter((a) => !a.gone && nsOf(a.obj) === nsOf(o) && at(a.obj, 'spec.policyRef.name') === nameOf(o));
    const ready = condOf(o, 'Ready');
    return [el('div', 'kicker', `${nsOf(o)} · SandboxPolicy`), el('h2', null, nameOf(o)),
      el('p', 'lede', 'notaio signs it into a bundle; the broker verifies the bundle and admits claims that name it.'),
      dl([
        ['profile', at(o, 'spec.profileRef')],
        ['bundle', at(o, 'status.bundleVersion')],
        ['ready', ready ? `${ready.status} (${ready.reason || ''})` : ''],
        ['named by', `${naming.length} agent(s) on screen`],
        ['with gaps', naming.filter((a) => stateOf(a.obj) === 'gaps').length || ''],
      ]), el('h3', null, 'Agents naming it'),
      agentList(naming, (a) => `${stateOf(a.obj)} · ${at(a.obj, 'spec.subject.display') || ''}`),
      raw('raw (YAML)', o)];
  },

  ns: (n) => {
    const p = n.info;
    const list = p.list.map(([key]) => nodes.get(key)).filter(Boolean);
    return [el('div', 'kicker', 'namespace'), el('h2', null, p.ns),
      dl(STATES.map((s) => [s, p.list.filter(([, o]) => stateOf(o) === s).length || ''])), el('h3', null, 'Agents'),
      agentList(list, (a) => `${stateOf(a.obj)} · ${at(a.obj, 'spec.subject.display') || ''} · ${ago(at(a.obj, 'metadata.creationTimestamp'))}`)];
  },

  issuer: () => {
    const by = new Map();
    for (const o of S.sandbox.values()) { const i = at(o, 'spec.subject.issuer') || '(none named)'; by.set(i, (by.get(i) || 0) + 1); }
    const people = new Set([...S.sandbox.values()].map((o) => at(o, 'spec.subject.id')).filter(Boolean));
    return [el('div', 'kicker', 'OIDC'), el('h2', null, 'OIDC issuer'),
      el('p', 'lede', 'Who each agent runs for: every claim carries its requester\'s subject, as the issuer named it, and the broker pins it on the AgentSandbox.'),
      dl([...by.entries()].map(([i, c]) => [i, `${c} agent${c === 1 ? '' : 's'}`])), dl([['people', people.size || '']])];
  },

  broker: () => [el('div', 'kicker', 'mediatore'), el('h2', null, 'broker'),
    el('p', 'lede', 'Admits each claim against its policy and creates the AgentSandbox; seals its credentials with OpenBao; declares its SPIRE entries; hears the gateways\' decisions (ADR-0062) and folds them onto each sandbox\'s status.egress (ADR-0063, proposed).'),
    dl([['agents', S.sandbox.size], ['decisions from the log', S.egress.size ? `${S.egress.size} claim(s)` : ''], ['log', S.notes.egress ? `not read: ${S.notes.egress}` : '']])],

  api: () => [el('div', 'kicker', 'Kubernetes'), el('h2', null, 'Kubernetes API'),
    el('p', 'lede', 'Where this view reads everything: one watch per kind, shared by every viewer, with your kubeconfig.'),
    dl([['AgentSandboxes', S.notes.sandbox || S.sandbox.size], ['VirtualMachinePools', S.notes.pool || S.pool.size], ['VirtualMachines', S.notes.vm || S.vm.size], ['SandboxPolicies', S.notes.policy || S.policy.size],
      ['ClusterStaticEntries', S.notes.entry || S.entry.size], ['sealed Secrets (metadata)', S.notes.envelope || envelopeCount()]])],

  vault: () => {
    const kinds = new Map();
    for (const e of sealedSecrets()) { const k = envelopeKind(e).replace(/ \(.*\)$/, ''); kinds.set(k, (kinds.get(k) || 0) + 1); }
    const out = [el('div', 'kicker', 'Secrets'), el('h2', null, 'Secrets vault'),
      el('p', 'lede', 'The broker\'s namespace: every credential at rest, each an envelope OpenBao\'s transit key sealed. This view reads their names, labels and annotations, never their data.'),
      dl([...kinds.entries()])];
    if (S.notes.envelope) out.push(note(`not readable: ${S.notes.envelope}`));
    return out;
  },

  spire: () => {
    const claims = [...S.entry.values()].filter((e) => nameOf(e).startsWith('mediatore-claim-'));
    const nodesE = [...S.entry.values()].filter((e) => nameOf(e).startsWith('mediatore-node-'));
    const holding = agents().filter((a) => !a.gone && entriesOf(a.obj).claim);
    // Audit: entries whose other end is gone. A node entry outlives its VM and SandboxNode; a
    // claim entry outlives its AgentSandbox.
    const ix = index();
    const staleNodes = nodesE.filter((e) => { const ek = nameOf(e).slice('mediatore-node-'.length); return !ix.vmByEk.has(ek) && !ix.nodeByEk.has(ek); });
    const claimUids = new Set([...S.sandbox.values()].map(claimUidOf));
    const staleClaims = claims.filter((e) => !claimUids.has(nameOf(e).slice('mediatore-claim-'.length)));
    const out = [el('div', 'kicker', 'SPIFFE'), el('h2', null, 'SPIRE server'), el('p', 'lede', DESIGN.spire.summary),
      dl([['claim entries', claims.length], ['node entries', nodesE.length], ['set', entriesSetCount()], ['readable', S.notes.entry ? `no: ${S.notes.entry}` : ''],
        ['stale node entries', staleNodes.length ? `${staleNodes.length}: no VM and no SandboxNode with their EK` : ''],
        ['stale claim entries', staleClaims.length ? `${staleClaims.length}: no AgentSandbox with their claim` : '']])];
    if (nodesE.length && !entriesSetCount()) out.push(note('No entry reports status.set: either the SPIRE Controller Manager does not fill it in, or the entries are not on the server.'));
    return [...out,
      el('h3', null, 'Agents it holds an identity for'),
      agentList(holding, (a) => at(entriesOf(a.obj).claim, 'spec.spiffeID') || ''),
      el('h3', null, 'Pool VMs attested (node SVIDs)'),
      nodeList([...nodes.values()].filter((v) => v.kind === 'vm' && !v.gone && attestedVm(v.key)), (v) => nameOf(v.obj), (v) => `${memberState(v.key)} · ${at(v.obj, 'status.attestationSubject') || 'GuestReady'}`),
      el('h3', null, 'How a guest gets its identities'), dl(DESIGN.spire.attestation),
      el('h3', null, 'Its CA'), dl(DESIGN.spire.ca)];
  },

  openbao: () => {
    const holding = agents().filter((a) => !a.gone && envelopesOf(a.obj).length);
    return [el('div', 'kicker', 'OpenBao'), el('h2', null, 'OpenBao'), el('p', 'lede', DESIGN.openbao.summary),
      dl([['envelopes', envelopeCount()], ['for agents on screen', holding.length], ['readable', S.notes.envelope ? `no: ${S.notes.envelope}` : '']]),
      el('h3', null, 'Agents with sealed envelopes'),
      agentList(holding, (a) => envelopesOf(a.obj).map(envelopeKind).join(', ')),
      el('h3', null, 'The transit key'), dl(DESIGN.openbao.transit),
      el('h3', null, 'The broker\'s login'), dl(DESIGN.openbao.login),
      el('h3', null, 'PKI'), dl(DESIGN.openbao.pki)];
  },
};

// ------------------------------------------------------------------------------ the Output tab

// The selected agent's output, as AgentSandbox shows a run's: the broker's stream, read as you, which
// it allows only for your own sandboxes; lines written once a frame, the last TERM_MAX kept.
const TERM_MAX = 2000;
const out = { tab: 'details', es: null, key: null, pending: [], lines: [] };

function setTab(tab) {
  const n = view.sel && nodes.get(view.sel);
  if (tab === 'output' && n?.kind !== 'agent') tab = 'details';
  out.tab = tab;
  $('tab-details').classList.toggle('on', tab === 'details');
  $('tab-output').classList.toggle('on', tab === 'output');
  $('details').hidden = tab !== 'details';
  $('linewrap').hidden = tab !== 'output';
  if (tab === 'output') openOutput(n);
  else closeOutput();
}

function closeOutput() {
  if (out.es) { out.es.close(); out.es = null; }
  out.key = null;
}

function outNote(text) { out.pending.push({ stream: 'note', text }); }

function openOutput(n) {
  if (!n || n.kind !== 'agent' || out.key === n.key) return;
  closeOutput();
  out.key = n.key; out.pending = []; out.lines = [];
  $('lines').replaceChildren();
  $('term-count').textContent = '';
  if (at(n.obj, 'spec.workload.logs') === false) { outNote('Not captured: this sandbox did not opt in to output (logs off).'); return; }
  const q = new URLSearchParams({ ns: nsOf(n.obj), name: nameOf(n.obj) });
  const es = new EventSource(`/api/admin/output?${q}`);
  out.es = es;
  // Each stream is one read: closed on its end, never reconnected (that would repeat the tail).
  const done = (text) => { if (text) outNote(text); if (out.es === es) { es.close(); out.es = null; } };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'line') out.pending.push({ stream: m.stream, text: m.text });
    else if (m.t === 'gap') outNote(`[output lost: ${m.stdout} B stdout, ${m.stderr} B stderr]`);
    else if (m.t === 'end') done(`[the stream ended: ${String(m.reason || 'done').replace(/_/g, ' ')}]`);
    else if (m.t === 'closed') done('[the broker closed the stream]');
    else if (m.t === 'error') done(m.text);
  };
  es.onerror = () => done(out.lines.length || out.pending.length ? '[disconnected]' : 'The output could not be read.');
}

function flushOutput() {
  if (!out.pending.length) return;
  const pre = $('lines'), batch = out.pending.slice(-TERM_MAX);
  out.pending = [];
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  const frag = document.createDocumentFragment();
  for (const e of batch) {
    const span = document.createElement('span');
    if (e.stream === 'stderr') span.className = 'stderr';
    else if (e.stream === 'note') span.className = 'note';
    span.textContent = e.text + '\n';
    frag.append(span);
    out.lines.push(e.text);
  }
  if (out.lines.length > 5 * TERM_MAX) out.lines.splice(0, out.lines.length - 5 * TERM_MAX);
  pre.append(frag);
  for (let extra = pre.childElementCount - TERM_MAX; extra > 0; extra--) pre.firstChild.remove();
  if (atEnd) pre.scrollTop = pre.scrollHeight;
  $('term-count').textContent = String(out.lines.length);
}

// ------------------------------------------------------------------------------ selection and input

function select(key) {
  view.sel = key && nodes.has(key) ? key : null;
  if (view.sel) view.touched = true;
  const n = view.sel && nodes.get(view.sel);
  // The Output tab is an agent's; another agent picked follows that one's output instead.
  $('tab-output').hidden = n?.kind !== 'agent';
  if (out.key && out.key !== view.sel) closeOutput();
  setTab(n?.kind === 'agent' ? out.tab : 'details');
  if (n) {
    // Framed with what it leads to: an agent with its gateway, a gateway with its hosts, a VM
    // with its agent.
    const g = n.kind === 'agent' && gatewayNode(carrierOf(egressOf(n.obj)));
    const ak = n.kind === 'vm' && index().agentOnVm.get(n.key), a = ak && nodes.get(ak);
    if (g) {
      view.goal = mix(n.goal, add(g.goal, [0, 2, 0]), 0.5);
      view.dist = clamp(len(sub(n.goal, g.goal)) * 1.5, 16, 60);
    } else if (a) {
      view.goal = mix(n.goal, a.goal, 0.5);
      view.dist = clamp(len(sub(n.goal, a.goal)) * 1.8, 12, 50);
    } else if (n.kind === 'gateway') {
      view.goal = add(n.goal, [0, 1.2, 0]);
      view.dist = 20;
    } else if (n.kind === 'spire' || n.kind === 'openbao') {
      // With the agents it holds something for.
      view.goal = mix(n.goal, fit.center, 0.45);
      view.dist = fit.dist * 0.75;
    } else if (n.kind === 'pool') {
      view.goal = [n.info.x0 + n.info.w / 2, 0, n.info.z0 + n.info.d / 2 - 3];
      view.dist = Math.max(18, n.info.w * 1.6);
    } else {
      view.goal = n.goal.slice();
      view.dist = n.kind === 'ns' ? Math.max(14, n.info.w * 1.6) : 14;
    }
  }
  renderDetails();
}

function pickAt(x, y) {
  let best = null, bd = 30;
  for (const n of nodes.values()) {
    if (n.gone || !n.pos || n.kind === 'ns' || n.kind === 'pool') continue;
    if (n.kind === 'agent' && !matches(n)) continue;
    const c = toCam(n.pos);
    if (c[2] <= NEAR) continue;
    const [px, py] = proj(c);
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = n.key; }
  }
  return best;
}

function bind() {
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    // Ctrl: move what is under the pointer (the layout, theatre.js).
    if (e.ctrlKey && LAYOUT.editable) {
      const n = nodes.get(pickAt(e.clientX, e.clientY)), key = n && groupOf(n);
      const flat = !n || n.kind === 'agent' || n.kind === 'vm';
      const m = key && beginMove(e.clientX, e.clientY, n.pos, moveUpright(e.shiftKey, flat));
      if (m) {
        drag = { move: m, key, moved: false };
        view.touched = true;
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('moving');
      }
      return;
    }
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, target: view.target.slice(), pan: e.button === 2 || e.shiftKey || e.metaKey, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    view.idle = 0;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      view.hover = pickAt(e.clientX, e.clientY);
      canvas.classList.toggle('pick', !!view.hover);
      canvas.classList.toggle('movable', e.ctrlKey && LAYOUT.editable && !!view.hover && !!groupOf(nodes.get(view.hover)));
      return;
    }
    if (drag.move) {
      const d = drag.move.step(e.clientX, e.clientY);
      if (len(d) > 0) { moveGroup(drag.key, d); drag.moved = true; }
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) { drag.moved = true; view.touched = true; }
    view.idle = 0;
    if (drag.pan) {
      const k = view.dist / cam.F;
      const right = norm([cam.r[0], 0, cam.r[2]]), fwd = norm([cam.f[0], 0, cam.f[2]]);
      view.goal = null;
      view.target = add(drag.target, add(mul(right, -dx * k), mul(fwd, dy * k)));
    } else {
      view.yaw = drag.yaw - dx * 0.0035;
      view.pitch = clamp(drag.pitch + dy * 0.003, 0.08, 1.35);
    }
  });
  const end = (e) => {
    if (drag?.move) canvas.classList.remove('moving');
    else if (drag && !drag.moved && e.type === 'pointerup') select(pickAt(e.clientX, e.clientY));
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // Ctrl-double-click: back where the layout stands it.
  canvas.addEventListener('dblclick', (e) => {
    const n = e.ctrlKey && LAYOUT.editable && nodes.get(pickAt(e.clientX, e.clientY)), key = n && groupOf(n);
    if (key && LAYOUT.moved[key]) moveGroup(key, mul(LAYOUT.moved[key], -1));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.idle = 0; view.touched = true;
    view.dist = clamp(view.dist * Math.exp(e.deltaY * 0.001), 5, 180);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Escape') { select(null); view.touched = false; dirty = true; }
    else if (e.key === '/') { e.preventDefault(); $('filter').focus(); }
  });
  $('insp-close').addEventListener('click', () => select(null));
  $('tab-details').addEventListener('click', () => setTab('details'));
  $('tab-output').addEventListener('click', () => setTab('output'));
  $('linewrap').append(copyButton(() => out.lines.join('\n')));
  $('filter').addEventListener('input', (e) => { view.filter = e.target.value.trim().toLowerCase(); });
  $('filter').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; view.filter = ''; e.target.blur(); } });
}

function connect() {
  const pill = $('live');
  const es = new EventSource('/api/admin');
  es.onopen = () => { pill.textContent = 'live'; pill.className = 'pill ok'; };
  es.onmessage = (ev) => { try { inbox.push(JSON.parse(ev.data)); } catch { /* a malformed message is dropped */ } };
  // The browser reconnects by itself, and the server answers with the whole picture again.
  es.onerror = () => { pill.textContent = 'reconnecting'; pill.className = 'pill bad'; };
}

resize();
window.addEventListener('resize', resize);
bind();
// The saved layout: the base stations moved in place; the rest, layout() offsets.
loadLayout('admin').then((moved) => {
  for (const [key, p] of BASE_AT) if (moved[key]) shiftPoints([p], moved[key]);
  dirty = true;
});
connect();
paintBar();
requestAnimationFrame(frame);
