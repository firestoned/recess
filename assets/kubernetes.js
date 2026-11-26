// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// The Kubernetes view: the whole theatre is the cluster. Its floor is a plate with the
// Kubernetes API standing at its north edge; on it, each namespace is a room (a wireframe box),
// its pods in rows at the front as the jail's cages, coloured by their state, and its custom
// resources behind them on shelves, one shelf per kind. Click a pod and it rises out of its
// room and opens, with its containers inside, each one clickable; the details panel shows it
// from the outside in, as AgentSandbox shows the jail: the node, the pod, each container.
// Each room with Secrets has a vault, as AgentSandbox's: click it and its door swings open on a
// wall of safety deposit boxes, one per Secret (listed as metadata only). Click a box and its
// drawer slides out; when your RBAC lets you read Secrets there, it opens on the Secret's keys,
// and a value is shown only when you ask for it. A locked drawer is red.
// Each room with ConfigMaps has a pin board on its back wall, a post-it per ConfigMap, coloured
// by who made it (by hand, Helm, an operator) and laminated when immutable. Click it and it
// rises: red string runs from each note to the pods that use it (by volume, env or envFrom), and
// a note no pod uses curls at the corner. kube-root-ca.crt, which Kubernetes puts in every
// namespace, is a small printed notice in the corner, and alone it makes no board.
// East of the API stand the ValidatingAdmissionPolicies, with their hits live (the API server's
// own counts), and the cupboard of what they warned or denied, a shelf per namespace.
//
// What is shown is what the viewer's own credentials may list, across all namespaces: a kind
// they may not read is named in the caption. Read-only. The data is one server-sent event
// stream (/api/kubernetes): the whole picture, then each change, applied once a frame.
'use strict';

THEATRE.glow = false;
THEATRE.fogFar = 90;

Object.assign(SHAPES, {
  // A pod: the nsjail cage of AgentSandbox, bars on every side.
  podCage: (() => {
    const b = box(1.7, 1.7, 1.7), bars = [];
    for (const x of [-0.42, 0, 0.42]) for (const z of [-0.85, 0.85]) bars.push({ pts: [[x, -0.85, z], [x, 0.85, z]], edges: [[0, 1]] });
    for (const z of [-0.42, 0, 0.42]) for (const x of [-0.85, 0.85]) bars.push({ pts: [[x, -0.85, z], [x, 0.85, z]], edges: [[0, 1]] });
    return merge(b, ...bars);
  })(),
  // A container in an open pod: a unit box with its process inside.
  ctr: merge(box(1, 1, 1), octa(0.3)),
  // A Secret's key in an open drawer: a card standing in it.
  keyCard: { pts: [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0]], edges: chain(4, true) },
  // A custom resource: a sheet with a folded corner and its fields.
  crDoc: merge(
    { pts: [[-0.8, 1.05, 0], [0.5, 1.05, 0], [0.8, 0.75, 0], [0.8, -1.05, 0], [-0.8, -1.05, 0]], edges: chain(5, true) },
    { pts: [[0.5, 1.05, 0], [0.5, 0.75, 0], [0.8, 0.75, 0]], edges: chain(3) },
    ...[0.45, 0.05, -0.35].map((y, i) => ({ pts: [[-0.55, y, 0], [i === 2 ? 0.1 : 0.5, y, 0]], edges: [[0, 1]] })),
  ),
});

const FLOOR_Y = -0.9;
const PSP = 2.6; // between pods in a room
const POD_SCALE = 0.72; // a closed cage, 1.22 across
const POD_Y = FLOOR_Y + 0.85 * POD_SCALE + 0.05;
const OPEN_SCALE = 2.1; // an open one, 3.6 across
const OPEN_LIFT = 3.4; // how far an open pod rises out of its room
const CSP = 1.5; // between custom resources on a shelf
const CR_SCALE = 0.42;
const CR_Y = FLOOR_Y + 1.05 * CR_SCALE + 0.08;
const NS_PAD = 1.4; // a room's margin round what is in it
const NS_H = 2.2; // a room's walls
const NS_GAP = 0.8; // between the pods and the shelves
const KIND_H = 1.4; // a shelf's room for its kind's name
const NS_FOOT = 0.6;
// A room's vault: its column beside the pods and shelves, and how it opens (as a pod does).
const VAULT_W = 2.8;
const VAULT_Y = FLOOR_Y + 0.8;
const VAULT_OPEN_SCALE = 2.6;
const VAULT_LIFT = 3.0;
const MAX_BOX = 64; // boxes drawn in one vault; the rest are listed in its details
// A room's pin board: on its back wall over the pods, BOARD_W by BOARD_H, and how it opens.
const BOARD_W = 2.6;
const BOARD_H = 1.5;
const BOARD_Y = FLOOR_Y + 1.2;
const BOARD_OPEN_SCALE = 2.5;
const BOARD_LIFT = 3.6;
const MAX_NOTE = 48; // post-its on one board; the rest are listed in its details
const ROOT_CA = 'kube-root-ca.crt'; // in every namespace: a notice in the corner, never a board alone
const PLATE_PAD = 5; // round the rooms, before the room to spare
// The plate is this much bigger each way than what is on it (15% more), so a room has
// somewhere to be moved to; it follows the rooms, so one moved past its edge grows it again.
const PLATE_SPARE = 1.15;

const POD_STATES = ['running', 'unready', 'pending', 'failing', 'succeeded', 'terminating'];
const POD_COLOR = { running: C.wire, unready: C.seal, pending: C.muted, failing: C.bad, succeeded: C.ok, terminating: C.dim };
const CTR_COLOR = { running: C.wire, unready: C.seal, waiting: C.seal, failing: C.bad, done: C.ok };
const CR_COLOR = { ok: C.ok, bad: C.bad, unknown: C.ident };
// A post-it's colour says who made it; the board is cork, its strings red.
const NOTE_COLOR = { hand: C.seal, helm: C.carrier, owned: C.spire, notice: C.muted };
const NOTE_MADE = { hand: 'by hand', helm: 'by Helm', owned: 'by an operator', notice: 'by Kubernetes' };
const CORK = C.policy;
const STRING = C.bad;

// ------------------------------------------------------------------------------ the data

const S = {
  ns: new Map(), pod: new Map(), crd: new Map(), cr: new Map(), secret: new Map(), cm: new Map(),
  // The admission policies, their bindings, their hits (one tally per binding), the cupboard.
  vap: new Map(), vapb: new Map(), vaphit: new Map(), vapfail: new Map(), notes: {},
};
const STORES = () => [S.ns, S.pod, S.crd, S.cr, S.secret, S.cm, S.vap, S.vapb, S.vaphit, S.vapfail];
const inbox = [];
let dirty = true;
let stamp = 0; // bumped on each applied change, so open details re-render
const CLUSTER_INFO = { context: '', user: '' };

function storeOf(kind) {
  if (kind === 'namespace') return S.ns;
  if (kind === 'pod') return S.pod;
  if (kind === 'crd') return S.crd;
  if (kind === 'secret') return S.secret;
  if (kind === 'configmap') return S.cm;
  if (kind === 'vap') return S.vap;
  if (kind === 'vapb') return S.vapb;
  if (kind === 'vaphit') return S.vaphit;
  if (kind === 'vapfail') return S.vapfail;
  if (String(kind).startsWith('cr:')) return S.cr;
  return null;
}
function apply(m) {
  if (m.op === 'snapshot') {
    for (const st of STORES()) st.clear();
    S.notes = { ...(m.notes || {}) };
    for (const it of m.items || []) storeOf(it.kind)?.set(it.key, it.obj);
  } else if (m.op === 'put') {
    const st = storeOf(m.kind);
    // A policy hit, or something turned away, as it happens: sent on its way across the plate.
    if (m.kind === 'vaphit') onHits(st.get(m.key), m.obj);
    else if (m.kind === 'vapfail') onTurnedAway(st.get(m.key), m.obj);
    st?.set(m.key, m.obj);
  }
  else if (m.op === 'del') { for (const st of STORES()) st.delete(m.key); }
  else if (m.op === 'note') { if (m.text) S.notes[m.kind] = m.text; else delete S.notes[m.kind]; }
  dirty = true; stamp++;
}

const at = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const nsOf = (o) => at(o, 'metadata.namespace') || '';
const nameOf = (o) => at(o, 'metadata.name') || '';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function ago(ts) {
  const t = Date.parse(ts);
  if (!(t > 0)) return '';
  const s = Math.abs(Date.now() - t) / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// A pod's state, from what the kubelet reports: failing once a container is in a back-off or
// an error, whatever the phase says.
const BAD_REASON = /BackOff|Err|Error|Invalid|OOMKilled|DeadlineExceeded/;
function podState(o) {
  if (at(o, 'metadata.deletionTimestamp')) return 'terminating';
  const ph = at(o, 'status.phase') || 'Pending';
  if (ph === 'Failed') return 'failing';
  if (ph === 'Succeeded') return 'succeeded';
  const cs = [...(at(o, 'status.initContainerStatuses') || []), ...(at(o, 'status.containerStatuses') || [])];
  if (cs.some((c) => BAD_REASON.test(c.state?.waiting?.reason || '') || (c.state?.terminated && c.state.terminated.exitCode !== 0 && BAD_REASON.test(c.state.terminated.reason || 'Error')))) return 'failing';
  if (ph === 'Running') return (at(o, 'status.containerStatuses') || []).every((c) => c.ready) ? 'running' : 'unready';
  return 'pending';
}
// A pod's containers, init ones first (as they run), each with its spec and its status.
function containersOf(o) {
  const st = new Map([...(at(o, 'status.initContainerStatuses') || []).map((c) => [`i/${c.name}`, c]), ...(at(o, 'status.containerStatuses') || []).map((c) => [`c/${c.name}`, c])]);
  return [
    ...(at(o, 'spec.initContainers') || []).map((spec) => ({ name: spec.name, init: true, spec, st: st.get(`i/${spec.name}`) })),
    ...(at(o, 'spec.containers') || []).map((spec) => ({ name: spec.name, init: false, spec, st: st.get(`c/${spec.name}`) })),
  ];
}
function ctrState(c) {
  const s = c.st?.state;
  if (!s) return 'waiting';
  if (s.running) return c.st.ready || c.init ? 'running' : 'unready';
  if (s.terminated) return s.terminated.exitCode === 0 ? 'done' : 'failing';
  if (s.waiting) return BAD_REASON.test(s.waiting.reason || '') ? 'failing' : 'waiting';
  return 'waiting';
}
function ctrStateText(c) {
  const s = c.st?.state;
  if (!s) return 'not started';
  if (s.running) return `running since ${s.running.startedAt || '?'}${c.st.ready ? ', ready' : ', not ready'}`;
  if (s.terminated) return `terminated: exit ${s.terminated.exitCode}${s.terminated.reason ? ` (${s.terminated.reason})` : ''}`;
  if (s.waiting) return `waiting: ${s.waiting.reason || '?'}${s.waiting.message ? `: ${s.waiting.message}` : ''}`;
  return '';
}
// A custom resource's state, as far as it says: its Ready (or Available) condition, else its phase.
function crState(o) {
  const cs = at(o, 'status.conditions') || [];
  const c = ['Ready', 'Available', 'Synced', 'Healthy'].map((t) => cs.find((x) => x?.type === t)).find(Boolean);
  if (c?.status === 'True') return 'ok';
  if (c?.status === 'False') return 'bad';
  const ph = String(at(o, 'status.phase') || at(o, 'status.state') || '');
  if (/fail|error|degraded/i.test(ph)) return 'bad';
  if (/running|ready|active|bound|succeeded|healthy|available/i.test(ph)) return 'ok';
  return 'unknown';
}
const kindOf = (o) => o?.kind || '?';

// Who made a ConfigMap: Kubernetes (the root CA notice), an operator (it has an owner), Helm (its
// labels or annotations say so), else someone by hand.
function noteOrigin(o) {
  if (nameOf(o) === ROOT_CA) return 'notice';
  if ((at(o, 'metadata.ownerReferences') || []).length) return 'owned';
  const by = String(at(o, 'metadata.labels')?.['app.kubernetes.io/managed-by'] || '').toLowerCase();
  if (by === 'helm' || at(o, 'metadata.annotations')?.['meta.helm.sh/release-name']) return 'helm';
  return 'hand';
}
// The ConfigMaps a pod's spec uses, and how: a volume (or a projected one), an env var, envFrom.
function podUses(o) {
  const ctrs = [...(at(o, 'spec.initContainers') || []), ...(at(o, 'spec.containers') || []), ...(at(o, 'spec.ephemeralContainers') || [])];
  const mounts = (v) => ctrs.flatMap((c) => (c.volumeMounts || []).filter((m) => m.name === v).map((m) => `${c.name}:${m.mountPath}`));
  const out = [];
  for (const v of at(o, 'spec.volumes') || []) {
    const where = mounts(v.name), at0 = where.length ? ` at ${where.join(', ')}` : '';
    if (v.configMap?.name) out.push({ cm: v.configMap.name, how: `volume ${v.name}${at0}` });
    for (const src of v.projected?.sources || []) if (src.configMap?.name) out.push({ cm: src.configMap.name, how: `projected volume ${v.name}${at0}` });
  }
  for (const c of ctrs) {
    for (const e of c.env || []) if (e.valueFrom?.configMapKeyRef?.name) out.push({ cm: e.valueFrom.configMapKeyRef.name, how: `env ${e.name} in ${c.name}` });
    for (const e of c.envFrom || []) if (e.configMapRef?.name) out.push({ cm: e.configMapRef.name, how: `envFrom in ${c.name}` });
  }
  return out;
}
// A small stable number from a name: a post-it's tilt and its scribbles.
function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
const bytesOf = (o) => (o?.keys || []).reduce((s, k) => s + (k.bytes || 0), 0);

// Whether you may read Secrets in a namespace, as the API server answers for you (a
// SelfSubjectAccessReview): true, false, or absent while not yet asked. Asked a few at a time.
const ACCESS = new Map();
const accessQueue = [];
let accessBusy = 0;
function askAccess(ns) {
  if (ACCESS.has(ns) || accessQueue.includes(ns)) return;
  accessQueue.push(ns);
  pumpAccess();
}
function pumpAccess() {
  while (accessBusy < 4 && accessQueue.length) {
    const ns = accessQueue.shift();
    accessBusy++;
    fetch(`/api/kubernetes/access?ns=${encodeURIComponent(ns)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) ACCESS.set(ns, !!j.read); })
      .catch(() => {})
      .finally(() => { accessBusy--; stamp++; wake(); pumpAccess(); });
  }
}
// The drawer pulled open: one Secret at a time, its keys, and the values you asked to see. It
// lives only while that box is picked; picking another, or none, empties it.
const DRAWER = { id: '', state: '', msg: '', data: null, values: new Map() };
function closeDrawer() { Object.assign(DRAWER, { id: '', state: '', msg: '', data: null, values: new Map() }); }
async function readDrawer(ns, name, key = null) {
  const id = `${ns}/${name}`;
  const q = new URLSearchParams({ ns, name });
  if (key) q.set('key', key);
  let r, j = null;
  try { r = await fetch(`/api/kubernetes/secret?${q}`, { cache: 'no-store' }); j = await r.json().catch(() => null); } catch { r = null; }
  if (DRAWER.id !== id) return; // another box was picked meanwhile
  if (!r || !r.ok) {
    const msg = j?.error || (r ? `HTTP ${r.status}` : 'no answer from Recess');
    if (key) DRAWER.values.set(key, { error: msg });
    else Object.assign(DRAWER, { state: r?.status === 403 ? 'refused' : 'error', msg });
  } else if (key) DRAWER.values.set(key, j);
  else Object.assign(DRAWER, { state: 'open', data: j });
  stamp++; wake(400);
}
function pullDrawer(ns, name) {
  const id = `${ns}/${name}`;
  if (DRAWER.id === id) return;
  closeDrawer();
  DRAWER.id = id;
  if (ACCESS.get(ns) === false) { DRAWER.state = 'locked'; return; }
  DRAWER.state = 'loading';
  readDrawer(ns, name);
}
// How a box stands: open (its keys read), refused or locked (red), readable, or not yet known.
function boxState(ns, name) {
  if (DRAWER.id === `${ns}/${name}`) {
    if (DRAWER.state === 'open') return 'open';
    if (DRAWER.state === 'refused' || DRAWER.state === 'locked') return 'locked';
  }
  const a = ACCESS.get(ns);
  return a === true ? 'readable' : a === false ? 'locked' : 'unknown';
}
const BOX_COLOR = { open: C.ink, readable: C.seal, locked: C.bad, unknown: C.wire };
// The post-it peeled off: the values you asked to see, one key at a time. The board already
// lists the keys (the watch gives each key's name and size); a value is read when shown, and
// all are dropped when another note, or nothing, is picked.
let PEELED = { id: '', values: new Map() };
async function readNote(ns, name, key) {
  const id = `${ns}/${name}`;
  let r, j = null;
  try { r = await fetch(`/api/kubernetes/configmap?${new URLSearchParams({ ns, name, key })}`, { cache: 'no-store' }); j = await r.json().catch(() => null); } catch { r = null; }
  if (PEELED.id !== id || !PEELED.values.has(key)) return; // another note was picked, or it was hidden
  PEELED.values.set(key, r?.ok ? j : { error: j?.error || (r ? `HTTP ${r.status}` : 'no answer from Recess') });
  stamp++; wake(400);
}
const apiGroupOf = (o) => String(o?.apiVersion || '').split('/').slice(0, -1).join('/') || 'core';

// ------------------------------------------------------------------------------ the scene's nodes

// What can be picked: the API, the namespaces' rooms, pods and custom resources. Nodes persist
// across changes and ease to where the layout puts them; a gone one fades out.
const nodes = new Map();
const view = { target: [0, 0, 0], goal: null, yaw: -0.25, pitch: 0.7, dist: 60, sel: null, part: null, hover: null, hoverPart: null, filter: '', only: null, shift: 0, touched: false };
let fit = { center: [0, 0, 0], dist: 60 };
const PLATE = { x0: -12, x1: 12, z0: -12, z1: 12, grid: { pts: [], edges: [] } };
let byUid = new Map(); // metadata.uid -> node key, for the owner references

function node(key, kind) {
  let n = nodes.get(key);
  if (!n) {
    n = { key, kind, pos: null, goal: [0, 0, 0], alpha: 0, gone: false, label: null, obj: null, info: null, open: 0 };
    nodes.set(key, n);
  }
  n.gone = false;
  return n;
}

// What a Ctrl-drag moves (the layout, theatre.js): a namespace's room, with all in it; the API;
// the admission policies on their dais; the cupboard.
function groupOfNode(n) {
  if (!n) return null;
  if (n.kind === 'pod' || n.kind === 'cr' || n.kind === 'vault' || n.kind === 'board') return `ns/${n.ns}`;
  if (n.kind === 'ns' || n.kind === 'api' || n.kind === 'cupboard') return n.key;
  if (n.kind === 'vap' || n.kind === 'vapgate') return 'vapgate';
  return null;
}
const offsetOf = (key) => LAYOUT.moved[key] || [0, 0, 0];
function moveGroups(keys, d) {
  for (const key of keys) noteMove(key, d);
  layout();
  for (const n of nodes.values()) if (n.pos && keys.has(groupOfNode(n))) n.pos = n.goal.slice();
}
function holdNode(e, n) {
  const key = groupOfNode(n);
  if (!key) return;
  const keys = MARK.keys.has(key) ? new Set(MARK.keys) : new Set([key]);
  if (takeHold(e, key, n.pos, true, (d) => moveGroups(keys, d), true)) view.touched = true;
}

// Boxes in rows, wrapped at about the square root of their area, centred on x = 0 from z = 0.
function pack(items, gap) {
  const area = items.reduce((s, p) => s + (p.w + gap) * (p.d + gap), 0);
  const maxRow = Math.max(30, Math.sqrt(area) * 1.4);
  const rows = [[]];
  let rw = 0;
  for (const p of items) {
    if (rw > 0 && rw + p.w > maxRow) { rows.push([]); rw = 0; }
    rows[rows.length - 1].push(p);
    rw += p.w + gap;
  }
  let z = 0;
  for (const row of rows) {
    if (!row.length) continue;
    const w = row.reduce((s, p) => s + p.w + gap, -gap);
    let x = -w / 2;
    for (const p of row) { p.x0 = x; p.z0 = z; x += p.w + gap; }
    z += Math.max(...row.map((p) => p.d)) + gap;
  }
}

function layout() {
  const seen = new Set();
  // Every namespace listed, and any an object names that could not be listed.
  const names = new Set([...S.ns.values()].map(nameOf));
  for (const o of S.pod.values()) names.add(nsOf(o));
  for (const o of S.cr.values()) names.add(nsOf(o));
  for (const o of S.secret.values()) names.add(nsOf(o));
  // A namespace whose only ConfigMap is its kube-root-ca.crt is not made a room for it.
  for (const o of S.cm.values()) if (nameOf(o) !== ROOT_CA) names.add(nsOf(o));
  names.delete('');
  const byNs = new Map([...names].map((n) => [n, { pods: [], crs: new Map(), secrets: [], cms: [] }]));
  for (const [k, o] of S.secret) byNs.get(nsOf(o))?.secrets.push([k, o]);
  for (const [k, o] of S.cm) byNs.get(nsOf(o))?.cms.push([k, o]);
  for (const [k, o] of S.pod) byNs.get(nsOf(o))?.pods.push([k, o]);
  for (const [k, o] of S.cr) {
    const b = byNs.get(nsOf(o));
    if (!b) continue;
    const kd = kindOf(o);
    if (!b.crs.has(kd)) b.crs.set(kd, []);
    b.crs.get(kd).push([k, o]);
  }
  const rooms = [];
  for (const ns of [...names].sort()) {
    const b = byNs.get(ns);
    b.pods.sort((x, y) => x[0].localeCompare(y[0]));
    const np = b.pods.length;
    const cols = np ? clamp(Math.ceil(Math.sqrt(np * 1.6)), 2, 14) : 0;
    const rows = np ? Math.ceil(np / cols) : 0;
    const kinds = [...b.crs.keys()].sort();
    const maxK = Math.max(0, ...kinds.map((k) => b.crs.get(k).length));
    const innerW = Math.max(cols * PSP, Math.min(maxK, 12) * CSP, 6);
    const perRow = Math.max(1, Math.floor(innerW / CSP));
    let crD = 0;
    const shelves = kinds.map((k) => {
      const list = b.crs.get(k).sort((x, y) => x[0].localeCompare(y[0]));
      const s = { kind: k, list, dz: crD };
      crD += KIND_H + Math.ceil(list.length / perRow) * CSP;
      return s;
    });
    const podD = rows * PSP;
    b.secrets.sort((x, y) => x[0].localeCompare(y[0]));
    const vw = b.secrets.length ? VAULT_W : 0;
    const d = Math.max(NS_PAD + podD + (podD && crD ? NS_GAP : 0) + crD + NS_PAD + NS_FOOT, vw ? 2 * NS_PAD + 2 + NS_FOOT : 0);
    // The board's notes, and the root CA's notice apart; no board for the notice alone.
    b.cms.sort((x, y) => x[0].localeCompare(y[0]));
    const notes = b.cms.filter(([, o]) => nameOf(o) !== ROOT_CA), rootCa = notes.length ? b.cms.find(([, o]) => nameOf(o) === ROOT_CA)?.[1] || null : null;
    // Which pods use each ConfigMap, and how: the board's strings.
    const uses = new Map();
    for (const [k, o] of b.pods) for (const u of podUses(o)) {
      if (!uses.has(u.cm)) uses.set(u.cm, new Map());
      const m = uses.get(u.cm);
      m.set(k, [...(m.get(k) || []), u.how]);
    }
    rooms.push({ ns, pods: b.pods, cols, shelves, perRow, podD, secrets: b.secrets, notes, rootCa, uses, innerW, w: innerW + vw + 2 * NS_PAD, d, x0: 0, z0: 0, crZ: 0 });
  }
  pack(rooms, 3.2);
  for (const r of rooms) { const o = offsetOf(`ns/${r.ns}`); r.x0 += o[0]; r.z0 += o[2]; }
  byUid = new Map();
  for (const r of rooms) {
    const nk = `ns/${r.ns}`;
    const n = node(nk, 'ns');
    n.info = r; n.obj = S.ns.get(`namespace//${r.ns}`) || null; n.ns = r.ns;
    n.goal = [r.x0 + r.w / 2, FLOOR_Y, r.z0 + r.d / 2];
    seen.add(nk);
    r.pods.forEach(([k, o], i) => {
      const p = node(k, 'pod');
      p.obj = o; p.ns = r.ns;
      p.goal = [r.x0 + NS_PAD + (i % r.cols + 0.5) * PSP, POD_Y, r.z0 + NS_PAD + Math.floor(i / r.cols) * PSP + PSP / 2];
      seen.add(k);
      if (at(o, 'metadata.uid')) byUid.set(o.metadata.uid, k);
    });
    // The vault, in its column on the room's east side, toward the front.
    if (r.secrets.length) {
      const vk = `vault/${r.ns}`, v = node(vk, 'vault');
      v.ns = r.ns; v.info = r;
      v.goal = [r.x0 + NS_PAD + r.innerW + VAULT_W - 0.9, VAULT_Y, r.z0 + NS_PAD + 1.0];
      seen.add(vk);
      askAccess(r.ns);
    }
    // The pin board, upright on the back wall over the pods.
    if (r.notes.length) {
      const bk = `board/${r.ns}`, bd = node(bk, 'board');
      bd.ns = r.ns; bd.info = r;
      bd.goal = [r.x0 + NS_PAD + r.innerW / 2, BOARD_Y, r.z0 + 0.3];
      seen.add(bk);
    }
    r.crZ = r.z0 + NS_PAD + r.podD + (r.podD && r.shelves.length ? NS_GAP : 0);
    for (const s of r.shelves) {
      s.z = r.crZ + s.dz;
      s.list.forEach(([k, o], i) => {
        const c = node(k, 'cr');
        c.obj = o; c.ns = r.ns;
        c.goal = [r.x0 + NS_PAD + (i % r.perRow + 0.5) * CSP, CR_Y, s.z + KIND_H + Math.floor(i / r.perRow) * CSP + CSP / 2];
        seen.add(k);
        if (at(o, 'metadata.uid')) byUid.set(o.metadata.uid, k);
      });
    }
  }
  // The plate: every room, and room at the north for the API.
  const x0 = rooms.length ? Math.min(...rooms.map((r) => r.x0)) : -8, x1 = rooms.length ? Math.max(...rooms.map((r) => r.x0 + r.w)) : 8;
  const z0 = rooms.length ? Math.min(...rooms.map((r) => r.z0)) : -4, z1 = rooms.length ? Math.max(...rooms.map((r) => r.z0 + r.d)) : 8;
  // What is drawn: the rooms and the API's place north of them; the plate, that grown about its
  // middle by PLATE_SPARE.
  const used = { x0: x0 - PLATE_PAD, x1: x1 + PLATE_PAD, z0: z0 - PLATE_PAD - 7, z1: z1 + PLATE_PAD };
  // The API mid-north; its admission policies and their cupboard east of it, the plate grown
  // to hold them.
  const ax = (used.x0 + used.x1) / 2, az = used.z0 + 3.6;
  layoutAdmission(seen, ax, az);
  const api = node('api', 'api');
  const ao = offsetOf('api');
  api.goal = [ax + ao[0], 0.3, az + ao[2]];
  seen.add('api');
  // Each grows the plate to hold it where it stands, moved or not.
  const hold = (bx0, bx1, bz0, bz1) => {
    used.x0 = Math.min(used.x0, bx0 - 1.5); used.x1 = Math.max(used.x1, bx1 + 1.5);
    used.z0 = Math.min(used.z0, bz0 - 1.5); used.z1 = Math.max(used.z1, bz1 + 1.5);
  };
  hold(api.goal[0] - 2.5, api.goal[0] + 2.5, api.goal[2] - 2.5, api.goal[2] + 2.5);
  const gate = seen.has('vapgate') && nodes.get('vapgate'), cup = seen.has('cupboard') && nodes.get('cupboard');
  if (gate) hold(gate.info.x0, gate.info.x1, gate.info.z0, gate.info.z1);
  if (cup) hold(cup.goal[0] - CUP_W / 2, cup.goal[0] + CUP_W / 2, cup.goal[2] - 1, cup.goal[2] + 1);
  const ex = ((used.x1 - used.x0) * (PLATE_SPARE - 1)) / 2, ez = ((used.z1 - used.z0) * (PLATE_SPARE - 1)) / 2;
  Object.assign(PLATE, { x0: used.x0 - ex, x1: used.x1 + ex, z0: used.z0 - ez, z1: used.z1 + ez });
  const pts = [], edges = [], y = FLOOR_Y - 0.02;
  for (let x = Math.ceil(PLATE.x0 / 5) * 5; x <= PLATE.x1; x += 5) { const o = pts.length; pts.push([x, y, PLATE.z0], [x, y, PLATE.z1]); edges.push([o, o + 1]); }
  for (let z = Math.ceil(PLATE.z0 / 5) * 5; z <= PLATE.z1; z += 5) { const o = pts.length; pts.push([PLATE.x0, y, z], [PLATE.x1, y, z]); edges.push([o, o + 1]); }
  PLATE.grid = { pts, edges };
  for (const [key, n] of nodes) if (!seen.has(key) && !n.gone) n.gone = true;
  // The camera frames what is on the plate, not the room to spare round it.
  const w = used.x1 - used.x0, dd = used.z1 - used.z0;
  fit = { center: [(used.x0 + used.x1) / 2, 0, (used.z0 + used.z1) / 2], dist: clamp(Math.max(w, dd * 1.3) * 0.95, 22, 170) };
  THEATRE.fogFar = Math.max(90, fit.dist * 2);
  if (!view.touched) { view.goal = fit.center; view.dist = fit.dist; }
}

const visible = (n) => !n.gone && !!n.pos;
function matches(n) {
  if (n.kind === 'pod' && view.only && podState(n.obj) !== view.only) return false;
  const f = view.filter;
  if (!f) return true;
  const o = n.obj;
  if (n.kind === 'ns') return n.ns.toLowerCase().includes(f);
  if (n.kind === 'pod') {
    const hay = [nameOf(o), nsOf(o), at(o, 'spec.nodeName'), podState(o), ...containersOf(o).flatMap((c) => [c.name, c.spec.image])];
    return hay.some((s) => String(s || '').toLowerCase().includes(f));
  }
  if (n.kind === 'cr') return [nameOf(o), nsOf(o), kindOf(o), o?.apiVersion].some((s) => String(s || '').toLowerCase().includes(f));
  if (n.kind === 'vault') return n.ns.toLowerCase().includes(f) || 'secrets'.includes(f) || n.info.secrets.some(([, x]) => nameOf(x).toLowerCase().includes(f));
  if (n.kind === 'board') return n.ns.toLowerCase().includes(f) || 'configmaps'.includes(f) || n.info.notes.some(([, x]) => nameOf(x).toLowerCase().includes(f));
  if (n.kind === 'vap') return nameOf(o).toLowerCase().includes(f) || 'admission policy'.includes(f);
  if (n.kind === 'cupboard') return 'cupboard'.includes(f) || n.info.shelves.some((s) => s.recs.some((r) => [r.ns, r.policy, r.object?.name].some((x) => String(x || '').toLowerCase().includes(f))));
  return true;
}
// Whether a room holds anything that matches (a filter set, or a state picked).
function roomMatches(n) {
  if (!view.filter && !view.only) return true;
  if (!view.only && matches(n)) return true;
  for (const m of nodes.values()) if ((m.kind === 'pod' || m.kind === 'cr' || m.kind === 'vault' || m.kind === 'board') && m.ns === n.ns && !m.gone && matches(m)) return true;
  return false;
}

// Where a pod is drawn (it rises as it opens), and how big.
const podAt = (n) => add(n.pos, [0, n.open * OPEN_LIFT, 0]);
const podScale = (n) => POD_SCALE + n.open * (OPEN_SCALE - POD_SCALE);
// The containers of an open pod, in a grid in the plane that faces the camera.
function ctrPlaces(n) {
  const list = containersOf(n.obj), k = list.length;
  if (!k) return [];
  const p = podAt(n), face = Math.atan2(cam.pos[0] - p[0], cam.pos[2] - p[2]);
  const ext = 1.7 * podScale(n) * 0.78, cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols);
  const cell = ext / Math.max(cols, rows), size = cell * 0.6;
  return list.map((c, i) => {
    const x = (i % cols - (cols - 1) / 2) * cell, y = ((rows - 1) / 2 - Math.floor(i / cols)) * cell;
    return { c, at: add(p, rotY([x, y, 0], face)), size, face };
  });
}

// A vault rises and grows as it opens, turning to face you; local points to the world.
const vaultCentre = (n) => add(n.pos, [0, n.open * VAULT_LIFT, 0]);
const vaultScale = (n) => 1 + (VAULT_OPEN_SCALE - 1) * ease(n.open);
function vaultFace(n) {
  const c = vaultCentre(n);
  return ease(n.open) * Math.atan2(cam.pos[0] - c[0], cam.pos[2] - c[2]);
}
const vaultAt = (n, p) => add(rotY(mul(p, vaultScale(n)), vaultFace(n)), vaultCentre(n));
// The boxes on the wall inside, as AgentSandbox lays them out: a square-ish grid.
function boxGrid(count, i) {
  const k = Math.max(1, Math.min(count, MAX_BOX)), cols = Math.ceil(Math.sqrt(k)), rows = Math.ceil(k / cols);
  const cw = 1.3 / cols, rh = 1.3 / rows, c = i % cols, r = Math.floor(i / cols);
  return { x: -0.65 + cw * (c + 0.5), y: 0.65 - rh * (r + 0.5), w: cw * 0.84, h: rh * 0.62 };
}
// How far a drawer is out: well out once picked (further once open), a little on hover.
function boxSlide(n, name) {
  if (view.sel === n.key && view.part === name) return DRAWER.state === 'open' ? 0.9 : 0.55;
  return view.sel === n.key && view.hoverPart === name ? 0.18 : 0;
}
// Each shown box's name, its grid cell and where its front is in the world.
function boxPlaces(n) {
  const list = n.info.secrets.slice(0, MAX_BOX);
  return list.map(([, o], i) => {
    const g = boxGrid(list.length, i), name = nameOf(o);
    return { name, o, g, front: vaultAt(n, [g.x, g.y, -0.3 + boxSlide(n, name) + 0.05]) };
  });
}

// A board rises and grows as it opens, turning to face you, as a vault does. Closed, it faces
// the front of the room (+z); its local units are those of a closed board.
const boardCentre = (n) => add(n.pos, [0, n.open * BOARD_LIFT, 0]);
const boardScale = (n) => 1 + (BOARD_OPEN_SCALE - 1) * ease(n.open);
function boardFace(n) {
  const c = boardCentre(n);
  return ease(n.open) * Math.atan2(cam.pos[0] - c[0], cam.pos[2] - c[2]);
}
const boardAt = (n, p) => add(rotY(mul(p, boardScale(n)), boardFace(n)), boardCentre(n));
// Where each post-it is pinned: a grid over the cork, the corner at the top right kept for the
// root CA's notice. A note is bigger the more it holds, tilted a little, and the picked one is
// peeled off toward you (the hovered one lifts a little).
function notePlaces(n) {
  const r = n.info, list = r.notes.slice(0, MAX_NOTE), k = list.length;
  const aw = r.rootCa ? 2.0 : 2.3, ah = BOARD_H - 0.28, cx = r.rootCa ? -0.15 : 0;
  const cols = Math.max(1, Math.ceil(Math.sqrt((k * aw) / ah))), rows = Math.max(1, Math.ceil(k / cols));
  const cw = aw / cols, ch = ah / rows, base = Math.min(cw, ch) * 0.84;
  const peel = (name) => (view.sel === n.key && view.part === name ? 0.35 : view.sel === n.key && view.hoverPart === name ? 0.1 : 0);
  const out = list.map(([, o], i) => {
    const name = nameOf(o), h = hashOf(name), c = i % cols, row = Math.floor(i / cols);
    const full = 0.72 + 0.28 * Math.min(1, Math.log2(1 + bytesOf(o)) / 14);
    return { name, o, origin: noteOrigin(o), x: cx - aw / 2 + cw * (c + 0.5), y: ah / 2 - ch * (row + 0.5), s: base * full * (view.sel === n.key && view.part === name ? 1.35 : 1),
      tilt: (h - 0.5) * 0.24, z: 0.06 + peel(name), h };
  });
  if (r.rootCa) out.push({ name: ROOT_CA, o: r.rootCa, origin: 'notice', notice: true, x: 1.06, y: 0.5, s: 0.34 * (view.sel === n.key && view.part === ROOT_CA ? 1.35 : 1), tilt: 0.06, z: 0.06 + peel(ROOT_CA), h: 0.5 });
  return out;
}
// A point on a post-it (u, v in -0.5..0.5 of its side) in the world.
const noteAt = (n, pl, u, v) => boardAt(n, add([pl.x, pl.y, pl.z], rotZ([u * pl.s, v * pl.s * (pl.notice ? 1.3 : 1), 0], pl.tilt)));
const pinOf = (n, pl) => noteAt(n, pl, 0, 0.38);

// ------------------------------------------------------------------------------ the admission policies

// East of the API stand the ValidatingAdmissionPolicies, each a sheet on a dais, orange when a
// binding puts it to work and dashed grey when none does. A hit (the API server's own count, read
// every few seconds) flies from the API to its policy: green let through, amber warned, violet
// audited, red denied. What is warned or denied flies on to the cupboard east of them, a shelf
// per namespace (from the Events that say where) and one shelf for the API server's counts, which
// say no namespace. Click the cupboard and its doors open on its shelves; click a shelf for what
// is on it.
const VSP = 2.4; // between policies on the dais
const VAP_SCALE = 0.42;
const VAP_Y = FLOOR_Y + 1.05 * VAP_SCALE + 0.12;
const CUP_W = 2.4;
const CUP_D = 1.0;
const CUP_OPEN_SCALE = 2.0;
const CUP_LIFT = 2.6;
const CUP_MAX_SHELF = 8; // shelves drawn in the cupboard; the rest are listed in its details
const CUP_ITEMS = 10; // records drawn on one shelf
const SHELF_ANY = '*'; // the part naming the shelf with no namespace (no namespace is called *)
const MAX_PULSES = 48;
const HIT_KEYS = ['allow', 'warn', 'audit', 'deny', 'error'];
const ACTION_COLOR = { allow: C.ok, warn: C.seal, audit: C.ident, deny: C.bad };
const ACTION_SAYS = { allow: 'allowed', warn: 'warned', audit: 'audited', deny: 'denied' };

const bindingsOf = (name) => [...S.vapb.values()].filter((b) => at(b, 'spec.policyName') === name);
const hitsOf = (name) => [...S.vaphit.values()].filter((h) => h.policy === name);
function sumHits(list) {
  const t = Object.fromEntries(HIT_KEYS.map((k) => [k, 0]));
  for (const h of list) for (const k of HIT_KEYS) t[k] += h[k] || 0;
  return t;
}
const shelfOf = (ns) => ns || SHELF_ANY;
const shelfName = (part) => (part === SHELF_ANY ? 'any namespace' : part);
const whenOf = (ts) => Date.parse(ts) || 0;

// Hits in flight, from one end to another: the API, a policy (`vap/<name>`), or a cupboard
// shelf (`shelf:<part>`). One that lands lights what it lands on, and may fly on (`then`).
const PULSES = [];
function pulse(from, to, action, delay = 0, then = null) {
  if (REDUCED) { arrive({ to, action, then }); return; }
  if (PULSES.length >= MAX_PULSES) return;
  PULSES.push({ from, to, action, t0: clock + delay, dur: 0.8, then });
  wake();
}
function endAt(e) {
  if (e === 'api') { const a = nodes.get('api'); return a?.pos ? add(a.pos, [0, 0.4, 0]) : null; }
  if (e.startsWith('shelf:')) { const c = nodes.get('cupboard'); return c?.pos ? shelfFront(c, e.slice(6)) : null; }
  return nodes.get(e)?.pos || null;
}
function arrive(p) {
  const shelf = p.to.startsWith('shelf:'), n = nodes.get(shelf ? 'cupboard' : p.to);
  if (n) { n.flash = 1; n.flashColor = ACTION_COLOR[p.action] || C.bad; n.flashShelf = shelf ? p.to.slice(6) : null; }
  if (p.then) pulse(p.to, p.then, p.action);
  wake();
}
// A binding's tally moved on: one pulse for what was let through, one for each turned away (a
// few at most), which go on to the cupboard's shelf with no namespace. The first tally is where
// counting starts, not a hit.
function onHits(was, now) {
  if (!was || !now) return;
  let i = 0;
  for (const a of ['deny', 'warn', 'audit', 'allow']) {
    const d = (now[a] || 0) - (was[a] || 0);
    if (d <= 0) continue;
    const away = a === 'deny' || a === 'warn';
    for (let j = 0; j < (a === 'allow' ? 1 : Math.min(d, 4)); j++) pulse('api', `vap/${now.policy}`, a, (i++) * 0.18, away ? `shelf:${SHELF_ANY}` : null);
  }
}
// An Event's verdict, as it happens (not one listed from the last hour): from its policy to its
// namespace's shelf.
function onTurnedAway(was, rec) {
  if (rec?.from !== 'event') return;
  const d = (rec.count || 1) - (was?.count || 0);
  if (d <= 0 || !(Date.now() - whenOf(rec.last) < 120000)) return;
  const from = nodes.has(`vap/${rec.policy}`) ? `vap/${rec.policy}` : 'api';
  for (let j = 0; j < Math.min(d, 3); j++) pulse(from, `shelf:${shelfOf(rec.ns)}`, rec.action, 0.3 + j * 0.2);
}
// Each frame: the pulses in flight, drawn; the ones that landed, gone. Returns whether any fly.
function drawPulses() {
  for (let i = PULSES.length - 1; i >= 0; i--) {
    const p = PULSES[i], t = (clock - p.t0) / p.dur;
    if (t < 0) continue;
    if (t >= 1) { PULSES.splice(i, 1); arrive(p); continue; }
    const a = endAt(p.from), b = endAt(p.to);
    if (!a || !b) { PULSES.splice(i, 1); continue; }
    const h = 0.8 + len(sub(a, b)) * 0.12, e = easeOut(t), col = ACTION_COLOR[p.action] || C.bad;
    polyline(Array.from({ length: 6 }, (_, k) => arc(a, b, h, Math.max(0, e - k * 0.035))), col, 0.55 * (1 - t * 0.5), 1.4, { glow: true });
    draw(SHAPES.packet, arc(a, b, h, e), col, 1 - t * 0.3, { width: 1.5, glow: true });
  }
  return PULSES.length > 0;
}

// The policies on their dais east of the API, and the cupboard east of them; `ax`, `az` the
// API's place before it is moved. Either may have been moved itself (a Ctrl-drag).
function layoutAdmission(seen, ax, az) {
  let east = ax + 8;
  const go = offsetOf('vapgate'), co = offsetOf('cupboard');
  const policies = [...S.vap.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  if (policies.length) {
    const rows = clamp(Math.ceil(Math.sqrt(policies.length / 1.5)), 1, 4), cols = Math.ceil(policies.length / rows);
    const g = node('vapgate', 'vapgate');
    g.info = { x0: east - 0.6 + go[0], x1: east + cols * VSP + 0.6 + go[0], z0: az - (rows * VSP) / 2 - 0.4 + go[2], z1: az + (rows * VSP) / 2 + 0.4 + go[2], policies };
    g.goal = [(g.info.x0 + g.info.x1) / 2, FLOOR_Y, g.info.z1];
    seen.add('vapgate');
    policies.forEach((o, i) => {
      const key = `vap/${nameOf(o)}`, p = node(key, 'vap');
      p.obj = o;
      p.goal = [east + (i % cols + 0.5) * VSP + go[0], VAP_Y, az + (Math.floor(i / cols) - (rows - 1) / 2) * VSP + go[2]];
      seen.add(key);
    });
    east += cols * VSP + 2.4;
  }
  if (policies.length || S.vapfail.size) {
    const byShelf = new Map();
    for (const r of S.vapfail.values()) {
      const s = shelfOf(r.ns);
      if (!byShelf.has(s)) byShelf.set(s, []);
      byShelf.get(s).push(r);
    }
    const shelves = [...byShelf].map(([part, recs]) => {
      recs.sort((a, b) => whenOf(b.last) - whenOf(a.last));
      const sum = (act) => recs.filter((r) => r.action === act).reduce((s, r) => s + (r.count || 1), 0);
      return { part, recs, deny: sum('deny'), warn: sum('warn'), last: recs[0]?.last || '' };
    }).sort((a, b) => (a.part === SHELF_ANY ? -1 : b.part === SHELF_ANY ? 1 : a.part.localeCompare(b.part)));
    const k = Math.min(shelves.length, CUP_MAX_SHELF);
    const h = clamp(0.5 + Math.max(k, 3) * 0.55, 2.2, 5);
    const c = node('cupboard', 'cupboard');
    c.info = { shelves, h, k };
    c.goal = [east + CUP_W / 2 + co[0], FLOOR_Y + h / 2, az + co[2]];
    seen.add('cupboard');
  }
}

// The cupboard rises, grows and turns to face you as it opens, as a vault does.
const cupCentre = (n) => add(n.pos, [0, n.open * CUP_LIFT, 0]);
const cupScale = (n) => 1 + (CUP_OPEN_SCALE - 1) * ease(n.open);
function cupFace(n) {
  const c = cupCentre(n);
  return ease(n.open) * Math.atan2(cam.pos[0] - c[0], cam.pos[2] - c[2]);
}
const cupAt = (n, p) => add(rotY(mul(p, cupScale(n)), cupFace(n)), cupCentre(n));
// Its shelves, top first: three at least, so an empty cupboard still looks like one.
const shelfStep = (n) => (n.info.h - 0.3) / Math.max(n.info.k, 3);
const shelfY = (n, i) => n.info.h / 2 - 0.15 - (i + 1) * shelfStep(n);
function shelfFront(n, part) {
  const i = n.info.shelves.findIndex((s) => s.part === part);
  if (i < 0 || i >= n.info.k) return cupAt(n, [0, 0, CUP_D / 2]);
  return cupAt(n, [0, shelfY(n, i) + shelfStep(n) * 0.4, CUP_D / 2]);
}

function drawCupboard(n) {
  const info = n.info, on = view.sel === n.key || view.hover === n.key, fl = n.flash || 0;
  const a = (matches(n) ? (on ? 1 : 0.8) : 0.12) * n.alpha;
  const col = fl ? mixColor(C.policy, n.flashColor || C.bad, fl) : C.policy;
  const at0 = (p) => cupAt(n, p), W2 = CUP_W / 2, D2 = CUP_D / 2, H2 = info.h / 2;
  const body = box(CUP_W, info.h, CUP_D);
  lines(body.pts.map(at0), body.edges, col, a, on || fl > 0.2 ? 1.5 : 1.1, { glow: fl > 0.2 });
  // While it rose, a ghost where it stands, and the line it rose along.
  if (n.open > 0.001) {
    lines(body.pts.map((p) => add(p, n.pos)), body.edges, C.policy, 0.15 * n.open, 1, { dash: [2, 4], focus: false });
    lines([add(cupCentre(n), [0, -H2 * cupScale(n), 0]), add(n.pos, [0, H2, 0])], [[0, 1]], C.policy, 0.45 * n.open, 1, { dash: [3, 4], focus: false });
  }
  // Its shelves, seen through the doors until they open, and on each its records, newest first:
  // a card each, red denied, amber warned, dashed when it is the API server's count.
  const inside = a * (0.3 + 0.7 * ease(n.open));
  for (let i = 0; i < Math.max(info.k, 3); i++) {
    const y = shelfY(n, i), s = i < info.k ? info.shelves[i] : null;
    const picked = s && view.sel === n.key && view.part === s.part, hov = s && view.hoverPart === s.part;
    const lit = s && n.flashShelf === s.part ? fl : 0;
    const sc = picked ? C.wire : lit ? mixColor(C.muted, n.flashColor || C.bad, lit) : C.muted;
    lines([[-W2, y, -D2], [W2, y, -D2], [W2, y, D2], [-W2, y, D2]].map(at0), chain(4, true), sc, inside * (picked || hov || lit ? 1 : 0.7), picked ? 1.6 : 1, { glow: picked || lit > 0.2 });
    if (!s) continue;
    const ch = Math.min(shelfStep(n) * 0.7, 0.34), cw = 0.13, gap = (CUP_W - 0.4) / CUP_ITEMS;
    s.recs.slice(0, CUP_ITEMS).forEach((r, j) => {
      const x = -W2 + 0.2 + (j + 0.5) * gap, z = 0.1 - (j % 2) * 0.2;
      const card = SHAPES.keyCard.pts.map(([u, v]) => [x + u * cw, y + 0.01 + v * ch, z]);
      lines(card.map(at0), SHAPES.keyCard.edges, ACTION_COLOR[r.action] || C.bad, inside, 1, { dash: r.from === 'metrics' ? [2, 2] : null });
    });
  }
  // The doors, hinged at either side, swing out.
  const swing = ease(n.open) * 1.9;
  for (const side of [-1, 1]) {
    const hinge = [side * W2, 0, D2 + 0.01];
    const door = (p) => at0(add(hinge, rotY(sub(p, hinge), side * swing)));
    lines([[side * W2, -H2, D2 + 0.01], [0, -H2, D2 + 0.01], [0, H2, D2 + 0.01], [side * W2, H2, D2 + 0.01]].map(door), chain(4, true), col, a * 0.9, 1.1);
    lines([[side * 0.14, -0.18, D2 + 0.02], [side * 0.14, 0.18, D2 + 0.02]].map(door), [[0, 1]], col, a, 1.4);
  }
}

// The dais, the way a request comes (the API, the policies, the cupboard), the policies, the
// cupboard and what flies between them. Returns whether anything still flies.
function drawAdmission(sel) {
  const g = nodes.get('vapgate'), api = nodes.get('api'), cup = nodes.get('cupboard');
  if (g?.pos && !g.gone) {
    const i = g.info, y = FLOOR_Y + 0.01, mid = (i.z0 + i.z1) / 2, on = sel === g || view.hover === g.key || sel?.kind === 'vap';
    lines([[i.x0, y, i.z0], [i.x1, y, i.z0], [i.x1, y, i.z1], [i.x0, y, i.z1]], chain(4, true), C.policy, (on ? 0.8 : 0.45) * g.alpha, on ? 1.4 : 1, { dash: [3, 4], focus: false });
    if (api?.pos) lines([add(api.pos, [1.9, -0.6, 0]), [i.x0, y + 0.3, mid]], [[0, 1]], C.policy, 0.3 * g.alpha, 1, { dash: [2, 4], focus: false });
    if (cup?.pos) lines([[i.x1, y + 0.3, mid], cupAt(cup, [-CUP_W / 2, -cup.info.h / 2 + 0.3, 0])], [[0, 1]], C.policy, 0.3 * g.alpha, 1, { dash: [2, 4], focus: false });
  }
  const face = Math.atan2(cam.pos[0] - view.target[0], cam.pos[2] - view.target[2]);
  for (const n of nodes.values()) if (n.kind === 'vap' && n.pos) {
    const bound = bindingsOf(nameOf(n.obj)).length > 0, on = sel === n || view.hover === n.key, fl = n.flash || 0;
    const a = (matches(n) ? (on ? 1 : bound ? 0.85 : 0.45) : 0.1) * n.alpha;
    const base = bound ? C.policy : C.muted, col = fl ? mixColor(base, n.flashColor || C.ok, fl) : base;
    draw(SHAPES.policyDoc, n.pos, col, a, { ry: face, scale: VAP_SCALE * (on ? 1.2 : 1) * (1 + fl * 0.15), width: on || fl > 0.3 ? 1.6 : 1.1, glow: on || fl > 0.3, dash: bound ? null : [2, 3] });
  }
  if (cup?.pos) drawCupboard(cup);
  return drawPulses();
}

// The dais's name, each policy's, the cupboard's and, once it is open, its shelves'.
function admissionLabels(sel) {
  const g = nodes.get('vapgate');
  if (g && !g.gone) {
    const l = extraLabel('vapgate', 'vapgate', () => select('vapgate'));
    const pols = g.info.policies, bound = pols.filter((o) => bindingsOf(nameOf(o)).length).length, t = sumHits([...S.vaphit.values()]);
    const counted = S.vaphit.size ? `${t.allow} allowed · ${t.warn} warned · ${t.deny} denied` : S.notes.vaphit ? 'hits not counted' : 'counting';
    setLabel(l, 'Admission policies', `${bound}/${pols.length} bound · ${counted}`, 'vapgate');
    placeLabel(l, g.pos, visible(g), g.alpha, true, view.sel === 'vapgate');
  }
  const few = [...nodes.values()].filter((n) => n.kind === 'vap' && visible(n)).length <= 12;
  for (const n of nodes.values()) if (n.kind === 'vap') {
    // Named when picked or hovered, when the dais is, or when close and few; not while the
    // cupboard is open in front of them.
    const quiet = sel?.kind === 'cupboard' || sel?.kind === 'vap';
    const show = visible(n) && matches(n) && (view.sel === n.key || view.hover === n.key || sel?.kind === 'vapgate' || (few && !quiet && view.dist < 20));
    if (!n.label && !show) continue;
    if (!n.label) n.label = label(n.key, 'vap');
    const name = nameOf(n.obj), bound = bindingsOf(name).length, hits = hitsOf(name), t = sumHits(hits);
    const said = HIT_KEYS.filter((k) => k !== 'error' && t[k]).map((k) => `${t[k]} ${ACTION_SAYS[k]}`).join(' · ');
    setLabel(n.label, name, !bound ? 'not bound' : hits.length ? said || 'no hits yet' : plural(bound, 'binding'), `vap${bound ? '' : ' unbound'}`);
    placeLabel(n.label, n.pos && add(n.pos, [0.35, 0.35, 0]), show, n.alpha, false, view.sel === n.key);
  }
  const c = nodes.get('cupboard');
  if (c && !c.gone) {
    if (!c.label) c.label = label(c.key, 'cupboard');
    const sh = c.info.shelves, deny = sh.some((s) => s.deny), last = sh.map((s) => s.last).sort((a, b) => whenOf(b) - whenOf(a))[0];
    setLabel(c.label, 'Cupboard', sh.length ? `turned away · ${plural(sh.length, 'shelf', 'shelves')} · last ${ago(last)} ago` : 'nothing turned away yet', `cupboard${deny ? ' deny' : sh.length ? ' warn' : ''}`);
    placeLabel(c.label, c.pos && cupAt(c, [0, -c.info.h / 2 - 0.05, 0]), visible(c) && matches(c) && c.open < 0.5 && (view.dist < 45 || view.hover === c.key || view.sel === c.key), c.alpha, true, view.sel === c.key && !view.part);
    if (sel === c && c.open > 0.5) {
      sh.slice(0, c.info.k).forEach((s, i) => {
        const l = extraLabel(`cshelf/${s.part}`, 'cshelf', () => select(c.key, s.part));
        setLabel(l, shelfName(s.part), [s.deny ? `${s.deny} denied` : '', s.warn ? `${s.warn} warned` : '', s.last ? `${ago(s.last)} ago` : ''].filter(Boolean).join(' · '), `cshelf${s.deny ? ' deny' : ' warn'}`);
        placeLabel(l, cupAt(c, [CUP_W / 2 + 0.05, shelfY(c, i) + shelfStep(c) * 0.35, CUP_D / 2]), true, c.open, false, view.part === s.part);
      });
    }
  }
}

// ------------------------------------------------------------------------------ labels

const labelLayer = $('labels');
function label(key, cls, onClick) {
  const e = document.createElement('div');
  e.className = `lbl ${cls}`;
  const b = document.createElement('b'), i = document.createElement('i');
  e.append(b, i);
  e.addEventListener('click', (ev) => {
    const n = nodes.get(key);
    if (markKey(ev)) markToggle(groupOfNode(n));
    else if (!moveKey(ev)) (onClick || (() => select(key)))();
  });
  e.addEventListener('pointerdown', (ev) => {
    const n = nodes.get(key);
    if (HAND.m || !moveKey(ev) || !n?.pos || !groupOfNode(n)) return;
    ev.preventDefault();
    ev.stopPropagation();
    holdNode(ev, n);
  });
  labelLayer.append(e);
  return { el: e, b, i, w: 0, title: null, detail: null, cls, key };
}
function setLabel(l, title, detail, cls) {
  if (l.title !== title) { l.b.textContent = title; l.title = title; l.w = 0; }
  if (l.detail !== detail) { l.i.textContent = detail; l.detail = detail; l.w = 0; }
  if (cls != null && l.cls !== cls) { l.el.className = `lbl ${cls}`; l.cls = cls; }
}
// A label beside its point, or centred under it (`under`). Styles are written only on change.
function placeLabel(l, p, show, alpha = 1, under = false, picked = false) {
  if (!l) return;
  const hide = () => { if (l.shown !== false) { l.el.style.opacity = '0'; l.el.style.pointerEvents = 'none'; l.shown = false; l.op = '0'; } };
  const c = p && toCam(p);
  if (!show || !c || c[2] <= NEAR) return hide();
  const [x, y] = proj(c);
  if (y < 52 || y > H - 84 || x < -10 || x > W - 30) return hide();
  if (!l.w) l.w = l.el.offsetWidth || 80;
  const lx = clamp(under ? x - l.w / 2 : x + 12, 8, Math.max(8, W - l.w - 8));
  const tf = `translate(${Math.round(lx)}px, ${Math.round(under ? y + 2 : y - 10)}px)`, op = clamp(fog(c[2]) * 1.2 * alpha, 0.25, 1).toFixed(2);
  if (l.tf !== tf) { l.el.style.transform = tf; l.tf = tf; }
  if (l.op !== op || l.shown !== true) { l.el.style.opacity = op; l.op = op; }
  if (l.shown !== true) l.el.style.pointerEvents = '';
  if (l.picked !== picked) { l.el.classList.toggle('sel', picked); l.picked = picked; }
  const ln = MARK.keys.size && nodes.get(l.key);
  l.el.classList.toggle('marked', !!ln && MARK.keys.has(groupOfNode(ln)));
  l.el.classList.toggle('under', under);
  l.shown = true;
}
// Labels that belong to no node: the plate's, each room's shelves, an open pod's containers.
const extraLabels = new Map();
function extraLabel(key, cls, onClick) {
  let l = extraLabels.get(key);
  if (!l) { l = label(key, cls, onClick); extraLabels.set(key, l); }
  l.used = true;
  return l;
}

function updateLabels() {
  for (const l of extraLabels.values()) l.used = false;
  const sel = view.sel && nodes.get(view.sel);
  // The cluster, at the plate's north-west corner.
  const cl = extraLabel('cluster', 'cluster', () => select('api'));
  const nNs = [...nodes.values()].filter((n) => n.kind === 'ns' && !n.gone).length;
  setLabel(cl, 'Kubernetes cluster', [CLUSTER_INFO.context || 'current context', CLUSTER_INFO.user ? `as ${CLUSTER_INFO.user}` : '', plural(nNs, 'namespace')].filter(Boolean).join(' · '));
  placeLabel(cl, [PLATE.x0 + 0.5, FLOOR_Y, PLATE.z0 + 0.5], true);

  // Pod and resource names: the picked and hovered one, a filter's few matches, the nearest few.
  const near = [...nodes.values()].filter((n) => (n.kind === 'pod' || n.kind === 'cr') && visible(n) && matches(n))
    .map((n) => [n, len(sub(n.pos, view.target))]).sort((a, b) => a[1] - b[1])
    .slice(0, view.dist < 18 ? 30 : view.dist < 32 ? 14 : view.dist < 50 ? 5 : 0).map(([n]) => n.key);
  const nearSet = new Set(near);
  const filtered = view.filter ? [...nodes.values()].filter((n) => (n.kind === 'pod' || n.kind === 'cr') && visible(n) && matches(n)) : [];
  const fewMatches = new Set(filtered.length <= 40 ? filtered.map((n) => n.key) : []);
  // The rooms close enough to read their shelves: there a resource's kind is on its shelf.
  const closeNs = new Set([...nodes.values()].filter((n) => n.kind === 'ns' && visible(n) && view.dist < 46 && len(sub(n.goal, view.target)) < Math.max(18, n.info.w)).map((n) => n.ns));
  for (const n of nodes.values()) {
    if (n.kind === 'api') {
      if (!n.label) n.label = label(n.key, 'ident');
      const kinds = S.crd.size, refused = Object.keys(S.notes).filter((k) => k.startsWith('cr:')).length;
      setLabel(n.label, 'Kubernetes API', `${plural(kinds, 'custom kind')}${refused ? ` · ${refused} not readable` : ''}`);
      placeLabel(n.label, n.pos && add(n.pos, [2.2, 1.2, 0]), visible(n), 1, false, view.sel === n.key);
    } else if (n.kind === 'ns') {
      if (!n.label) n.label = label(n.key, 'kns');
      const r = n.info, ph = at(n.obj, 'status.phase');
      const crs = r.shelves.reduce((s, x) => s + x.list.length, 0);
      setLabel(n.label, n.ns, [plural(r.pods.length, 'pod'), crs ? plural(crs, 'resource') : '', r.secrets.length ? plural(r.secrets.length, 'Secret') : '', r.notes.length ? plural(r.notes.length, 'ConfigMap') : '', n.obj ? '' : 'not listed'].filter(Boolean).join(' · '), ph === 'Terminating' ? 'kns terminating' : 'kns');
      placeLabel(n.label, n.pos && [r.x0 + r.w / 2, FLOOR_Y, r.z0 + r.d], visible(n) && roomMatches(n), n.alpha, true, view.sel === n.key);
      // Each shelf's kind, while the room is close.
      const close = closeNs.has(n.ns);
      for (const s of r.shelves) {
        const sl = extraLabel(`shelf/${n.ns}/${s.kind}`, 'shelf nopick');
        setLabel(sl, `${s.kind} × ${s.list.length}`, apiGroupOf(s.list[0][1]));
        placeLabel(sl, [r.x0 + NS_PAD - 0.2, FLOOR_Y, s.z + 0.25], close, n.alpha);
      }
    } else if (n.kind === 'pod') {
      const st = podState(n.obj);
      const show = visible(n) && matches(n) && (view.sel === n.key || view.hover === n.key || nearSet.has(n.key) || fewMatches.has(n.key));
      if (!n.label && !show) continue;
      if (!n.label) n.label = label(n.key, `pod ${st}`);
      const cs = containersOf(n.obj).filter((c) => !c.init), ready = cs.filter((c) => c.st?.ready).length;
      const restarts = cs.reduce((s, c) => s + (c.st?.restartCount || 0), 0);
      setLabel(n.label, nameOf(n.obj), `${ready}/${cs.length} ready${restarts ? ` · ${plural(restarts, 'restart')}` : ''} · ${st}`, `pod ${st}`);
      // Beside a closed cage; centred over an open one, clear of its containers' names.
      const open = n.open > 0.5;
      placeLabel(n.label, n.pos && add(podAt(n), open ? [0, 0.85 * podScale(n) + 0.5, 0] : [0.5 * podScale(n), 0.4 * podScale(n), 0]), show, n.alpha, open, view.sel === n.key && !view.part);
    } else if (n.kind === 'vault') {
      if (!n.label) n.label = label(n.key, 'vault');
      const a = ACCESS.get(n.ns), cnt = n.info.secrets.length;
      setLabel(n.label, 'Secrets', `${plural(cnt, 'box', 'boxes')}${a === false ? ' · locked' : a === true ? ' · readable' : ''}`, `vault${a === false ? ' locked' : a === true ? ' readable' : ''}`);
      const show = visible(n) && matches(n) && (n.open > 0.5 || closeNs.has(n.ns) || view.hover === n.key || view.sel === n.key);
      placeLabel(n.label, n.pos && add(vaultCentre(n), [0, -0.85 * vaultScale(n) - 0.1, 0]), show, n.alpha, true, view.sel === n.key && !view.part);
    } else if (n.kind === 'board') {
      if (!n.label) n.label = label(n.key, 'board');
      const cnt = n.info.notes.length, unused = n.info.notes.filter(([, o]) => !n.info.uses.has(nameOf(o))).length;
      setLabel(n.label, 'ConfigMaps', `${plural(cnt, 'note')}${unused ? ` · ${unused} unused` : ''}`, 'board');
      const show = visible(n) && matches(n) && (n.open > 0.5 || closeNs.has(n.ns) || view.hover === n.key || view.sel === n.key);
      placeLabel(n.label, n.pos && boardAt(n, [0, -BOARD_H / 2 - 0.05, 0]), show, n.alpha, true, view.sel === n.key && !view.part);
    } else if (n.kind === 'cr') {
      const show = visible(n) && matches(n) && (view.sel === n.key || view.hover === n.key || (nearSet.has(n.key) && view.dist < 30) || fewMatches.has(n.key));
      if (!n.label && !show) continue;
      if (!n.label) n.label = label(n.key, 'cr');
      const st = crState(n.obj);
      setLabel(n.label, nameOf(n.obj), closeNs.has(n.ns) ? '' : kindOf(n.obj), `cr ${st}`);
      placeLabel(n.label, n.pos && add(n.pos, [0.3, 0.3, 0]), show, n.alpha, false, view.sel === n.key);
    }
  }
  // The open vault's boxes: every one when few, else the picked and hovered.
  if (sel?.kind === 'vault' && sel.open > 0.5 && sel.pos) {
    const places = boxPlaces(sel), all = places.length <= 24;
    for (const { name, front, g } of places) {
      if (!all && view.part !== name && view.hoverPart !== name) continue;
      const l = extraLabel(`box/${sel.ns}/${name}`, 'box', () => select(sel.key, name));
      const st = boxState(sel.ns, name);
      setLabel(l, name, st === 'open' ? `${plural(DRAWER.data?.keys?.length || 0, 'key')}` : st === 'locked' ? 'locked' : '', `box ${st}`);
      placeLabel(l, add(front, [g.w * vaultScale(sel) * 0.5, 0, 0]), true, sel.open, false, view.part === name);
    }
  }
  // The open board's notes, each named under itself: every one when few, else the picked and
  // hovered; what it holds only for those two.
  if (sel?.kind === 'board' && sel.open > 0.5 && sel.pos) {
    const places = notePlaces(sel), all = places.length <= 24;
    for (const pl of places) {
      if (!all && view.part !== pl.name && view.hoverPart !== pl.name) continue;
      const l = extraLabel(`note/${sel.ns}/${pl.name}`, 'note', () => select(sel.key, pl.name));
      const used = sel.info.uses.get(pl.name)?.size || 0, near = view.part === pl.name || view.hoverPart === pl.name;
      setLabel(l, pl.name, !near ? '' : pl.notice ? 'the cluster CA' : `${plural(pl.o.keys?.length || 0, 'key')} · ${used ? plural(used, 'pod') : 'unused'}`, `note ${pl.origin}${used || pl.notice ? '' : ' unused'}`);
      placeLabel(l, noteAt(sel, pl, 0, pl.notice ? -0.42 : -0.55), true, sel.open, true, view.part === pl.name);
    }
  }
  admissionLabels(sel);
  // The open pod's containers.
  if (sel?.kind === 'pod' && sel.open > 0.5 && sel.pos) {
    for (const { c, at: p, size } of ctrPlaces(sel)) {
      const l = extraLabel(`ctr/${sel.key}/${c.name}`, 'ctr', () => select(sel.key, c.name));
      const st = ctrState(c);
      setLabel(l, `${c.init ? 'init · ' : ''}${c.name}`, shortImage(c.spec.image), `ctr ${c.init ? 'init' : st}`);
      placeLabel(l, add(p, [size * 0.6, size * 0.5, 0]), true, sel.open, false, view.part === c.name);
    }
  }
  for (const [k, l] of extraLabels) if (!l.used) { l.el.remove(); extraLabels.delete(k); }
}
const shortImage = (img) => String(img || '').replace(/^(docker\.io\/)?(library\/)?/, '').replace(/@sha256:[0-9a-f]{12}[0-9a-f]*$/, '@sha256…');

// ------------------------------------------------------------------------------ the frame

let clock = 0, last = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - (last || now)) / 1000);
  last = now; clock += dt;
  for (const m of inbox.splice(0)) {
    try { apply(m); } catch (err) { console.error('recess: a change from the server was not applied', m, err); }
  }
  if (dirty) { layout(); paintBar(); dirty = false; }

  // Nodes ease to their places; new ones rise in, gone ones fade and are dropped. The picked pod
  // opens; the rest close.
  const k = 1 - Math.exp(-dt * 4);
  let moving = false;
  for (const [key, n] of nodes) {
    if (!n.pos) n.pos = n.kind === 'pod' || n.kind === 'cr' ? add(n.goal, [0, -1.5, 0]) : n.goal.slice();
    if (len(sub(n.pos, n.goal)) < 0.01) { if (n.pos[0] !== n.goal[0] || n.pos[1] !== n.goal[1] || n.pos[2] !== n.goal[2]) n.pos = n.goal.slice(); }
    else { n.pos = mix(n.pos, n.goal, REDUCED ? 1 : k); moving = true; }
    const alpha = n.gone ? Math.max(0, n.alpha - dt * 1.2) : Math.min(1, n.alpha + dt * 1.5);
    if (alpha !== n.alpha) { n.alpha = alpha; moving = true; }
    if (n.kind === 'pod' || n.kind === 'vault' || n.kind === 'board' || n.kind === 'cupboard') {
      const want = view.sel === key && !n.gone ? 1 : 0;
      if (Math.abs(want - n.open) < 0.005) n.open = want;
      else { n.open += (want - n.open) * (REDUCED ? 1 : 1 - Math.exp(-dt * 5)); moving = true; }
    }
    // A policy or the cupboard a hit landed on glows, then fades.
    if (n.flash > 0) { n.flash = Math.max(0, n.flash - dt * (REDUCED ? 0.8 : 1.6)); moving = true; }
    if (n.gone && n.alpha <= 0) { n.label?.el.remove(); nodes.delete(key); if (view.sel === key) select(null); }
  }

  // The camera orbits its target and stays where you leave it.
  if (view.goal) {
    if (len(sub(view.target, view.goal)) < 0.005) view.target = view.goal.slice();
    else { view.target = mix(view.target, view.goal, 1 - Math.exp(-dt * 3)); moving = true; }
  }
  const off = rotY(rotX([0, 0, view.dist], -view.pitch), view.yaw);
  const shiftWant = inspOpen ? view.dist * 0.2 : 0;
  if (Math.abs(shiftWant - view.shift) < 0.005) view.shift = shiftWant;
  else { view.shift += (shiftWant - view.shift) * (1 - Math.exp(-dt * 4)); moving = true; }
  const look = add(view.target, mul(norm([cam.r[0], 0, cam.r[2]]), view.shift));
  aim(add(look, off), look);

  const fn = view.sel && nodes.get(view.sel);
  THEATRE.focus = fn?.pos && !fn.gone && fn.kind !== 'ns' && fn.kind !== 'vapgate' ? (fn.kind === 'pod' ? podAt(fn) : fn.kind === 'vault' ? vaultCentre(fn) : fn.kind === 'board' ? boardCentre(fn) : fn.kind === 'cupboard' ? cupCentre(fn) : fn.pos) : null;
  THEATRE.focusR = fn?.kind === 'pod' ? 1.9 * podScale(fn) : fn?.kind === 'vault' ? 1.2 * vaultScale(fn) : fn?.kind === 'board' ? 1.5 * boardScale(fn) : fn?.kind === 'cupboard' ? 1.7 * cupScale(fn) : 1.4;
  ctx.clearRect(0, 0, W, H);
  const flying = drawScene();
  updateLabels();
  if (stamp !== shownStamp && view.sel && clock - shownAt > 0.5) renderDetails();
  return moving || flying || inbox.length > 0 || dirty || !!(stamp !== shownStamp && view.sel);
}

// Shapes of one colour and dash gathered over a frame and stroked once per room: a cluster's
// worth of cages costs a few strokes, not one each.
const batches = new Map();
function batched(group, color, alpha, shape, at0, o = {}) {
  const key = `${group}|${color}|${alpha.toFixed(2)}|${o.dash ? 'd' : ''}`;
  let b = batches.get(key);
  if (!b) { b = { color, alpha, dash: o.dash, pts: [], edges: [] }; batches.set(key, b); }
  const off = b.pts.length;
  b.pts.push(...place(shape, at0, o));
  for (const [i, j] of shape.edges) b.edges.push([i + off, j + off]);
}
function flushBatches() {
  for (const b of batches.values()) lines(b.pts, b.edges, b.color, b.alpha, 1, b.dash ? { dash: b.dash } : {});
  batches.clear();
}

function drawScene() {
  const sel = view.sel && nodes.get(view.sel);
  // The plate: the cluster's floor, its grid, and its edge.
  lines(PLATE.grid.pts, PLATE.grid.edges, C.dim, 0.3, 1, { focus: false });
  const y = FLOOR_Y - 0.02;
  lines([[PLATE.x0, y, PLATE.z0], [PLATE.x1, y, PLATE.z0], [PLATE.x1, y, PLATE.z1], [PLATE.x0, y, PLATE.z1]], chain(4, true), C.wire, sel?.kind === 'api' ? 0.85 : 0.5, 1.4, { focus: false });
  // The API at the north edge.
  const api = nodes.get('api');
  if (api?.pos) {
    ST.api = api.pos;
    drawApi(sel?.kind === 'api' || view.hover === 'api' ? 1 : 0.8, 0);
  }

  // The rooms.
  for (const n of nodes.values()) if (n.kind === 'ns' && n.pos) {
    const r = n.info, on = sel === n || (sel && sel.ns === n.ns && sel.kind !== 'ns') || view.hover === n.key;
    const term = at(n.obj, 'status.phase') === 'Terminating';
    const a = (roomMatches(n) ? (on ? 0.8 : 0.42) : 0.12) * n.alpha;
    const x0 = r.x0, x1 = r.x0 + r.w, z0 = r.z0, z1 = r.z0 + r.d, y0 = FLOOR_Y, y1 = FLOOR_Y + NS_H;
    const pts = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    const col = sel === n ? C.wire : C.muted;
    lines(pts, [[0, 1], [1, 2], [2, 3], [3, 0]], col, a, on ? 1.5 : 1.1, { dash: term ? [4, 4] : null, focus: false });
    lines(pts, [[4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]], col, a * 0.55, 1, { dash: term ? [4, 4] : [2, 5], focus: false });
    // The line between the pods and the shelves.
    if (r.podD && r.shelves.length) lines([[x0 + 0.6, y0 + 0.01, r.crZ - NS_GAP / 2], [x1 - 0.6, y0 + 0.01, r.crZ - NS_GAP / 2]], [[0, 1]], C.dim, a, 1, { dash: [2, 4], focus: false });
  }

  // Custom resources: sheets that face you, coloured by their Ready condition or phase.
  const face = Math.atan2(cam.pos[0] - view.target[0], cam.pos[2] - view.target[2]);
  for (const n of nodes.values()) if (n.kind === 'cr' && n.pos) {
    const st = crState(n.obj), ok = matches(n), on = sel === n || view.hover === n.key;
    const a = (ok ? (on ? 1 : 0.7) : 0.08) * n.alpha;
    if (on) draw(SHAPES.crDoc, n.pos, CR_COLOR[st], a, { ry: face, scale: CR_SCALE * 1.25, width: 1.6, glow: true });
    else batched(n.ns, CR_COLOR[st], a, SHAPES.crDoc, n.pos, { ry: face, scale: CR_SCALE });
  }
  // Pods: closed cages, batched; the picked one rises and opens on its containers.
  for (const n of nodes.values()) if (n.kind === 'pod' && n.pos) {
    const st = podState(n.obj), ok = matches(n), on = view.hover === n.key;
    const a = (ok ? (on ? 1 : st === 'pending' || st === 'terminating' ? 0.6 : 0.8) : 0.08) * n.alpha;
    const dash = st === 'pending' || st === 'terminating' ? [2, 3] : null;
    if (n.open > 0.001 || on) {
      const p = podAt(n), s = podScale(n);
      draw(SHAPES.podCage, p, POD_COLOR[st], a, { scale: s, width: on || n.open > 0.5 ? 1.6 : 1.2, glow: on || n.open > 0.5, dash, ry: n.open * 0.2 });
      if (n.open > 0.001) {
        // Its place in the room, and the line it rose along.
        lines(place(SHAPES.podCage, n.pos, { scale: POD_SCALE }), SHAPES.podCage.edges, POD_COLOR[st], 0.18 * n.open, 1, { dash: [2, 4], focus: false });
        lines([add(p, [0, -0.85 * s, 0]), add(n.pos, [0, 0.85 * POD_SCALE, 0])], [[0, 1]], POD_COLOR[st], 0.5 * n.open, 1, { dash: [3, 4], focus: false });
        for (const { c, at: cp, size, face: f } of ctrPlaces(n)) {
          const cs = ctrState(c), picked = view.part === c.name, hov = view.hoverPart === c.name;
          draw(SHAPES.ctr, cp, CTR_COLOR[cs], n.open * (c.init ? 0.55 : picked || hov ? 1 : 0.85),
            { scale: size * (picked ? 1.15 : 1), ry: f, width: picked || hov ? 1.8 : 1.2, glow: picked || hov, dash: c.init || cs === 'waiting' ? [2, 3] : null });
        }
      }
    } else batched(n.ns, POD_COLOR[st], a, SHAPES.podCage, n.pos, { scale: POD_SCALE, dash });
  }
  flushBatches();
  for (const n of nodes.values()) if (n.kind === 'vault' && n.pos) drawVault(n);
  for (const n of nodes.values()) if (n.kind === 'board' && n.pos) drawBoard(n);
  drawStrings(sel);
  const flying = drawAdmission(sel);

  // What the picked thing owns, and what owns it, where both are on the plate.
  if (sel && (sel.kind === 'pod' || sel.kind === 'cr') && sel.pos) {
    const from = sel.kind === 'pod' ? podAt(sel) : sel.pos, uid = at(sel.obj, 'metadata.uid');
    const ends = [];
    for (const ref of at(sel.obj, 'metadata.ownerReferences') || []) { const o = nodes.get(byUid.get(ref.uid)); if (o?.pos) ends.push(o); }
    if (uid) for (const o of nodes.values()) if (o !== sel && o.pos && (at(o.obj, 'metadata.ownerReferences') || []).some((r) => r.uid === uid)) ends.push(o);
    for (const o of ends) {
      const to = o.kind === 'pod' ? podAt(o) : o.pos;
      const pts = arcPts(from, to, 1.5 + len(sub(from, to)) * 0.15);
      polyline(pts, C.ident, 0.7, 1.2, { dash: [3, 4], focus: false });
    }
  }
  return flying;
}

// A room's vault, as AgentSandbox draws its own: the body, the door hinged on its left edge with
// its dial, and once open the wall of safety deposit boxes, one per Secret, each with a handle.
// Amber when you may read its Secrets, red when you may not, cyan while that is not known.
function drawVault(n) {
  const acc = ACCESS.get(n.ns), on = view.sel === n.key || view.hover === n.key;
  const vc = acc === true ? C.seal : acc === false ? C.bad : C.wire;
  const a = (matches(n) ? (on ? 1 : 0.75) : 0.1) * n.alpha;
  const at0 = (p) => vaultAt(n, p);
  const body = box(1.5, 1.5, 1.5);
  lines(body.pts.map(at0), body.edges, vc, a, on ? 1.4 : 1, { dash: acc === false ? [3, 3] : null });
  // While it rose, a ghost where it stands, and the line it rose along.
  if (n.open > 0.001) {
    lines(body.pts.map((p) => add(p, n.pos)), body.edges, vc, 0.15 * n.open, 1, { dash: [2, 4], focus: false });
    lines([add(vaultCentre(n), [0, -0.75 * vaultScale(n), 0]), add(n.pos, [0, 0.75, 0])], [[0, 1]], vc, 0.45 * n.open, 1, { dash: [3, 4], focus: false });
  }
  const swing = -ease(n.open) * 1.95, hinge = [-0.75, 0, 0.76];
  const door = (p) => at0(add(hinge, rotY(sub(p, hinge), swing)));
  const plate = [[-0.75, -0.75, 0.76], [0.75, -0.75, 0.76], [0.75, 0.75, 0.76], [-0.75, 0.75, 0.76]];
  lines(plate.map(door), chain(4, true), vc, a, 1.1);
  for (const [r, k] of [[0.42, 24], [0.12, 12]]) {
    const rr = ringPts(r, k, 'xy').map((p) => add(p, [0, 0, 0.77]));
    lines(rr.map(door), chain(k, true), vc, a * 0.9, 1);
  }
  const spokes = [0, 1, 2].flatMap((k) => { const ang = k * 2.09 + n.open * 6; return [[0, 0, 0.77], [Math.cos(ang) * 0.42, Math.sin(ang) * 0.42, 0.77]]; });
  lines(spokes.map(door), [[0, 1], [2, 3], [4, 5]], vc, a * 0.8, 1, { glow: false });
  if (n.open < 0.15) return;
  const va = clamp((n.open - 0.15) / 0.6) * n.alpha;
  for (const { name, g } of boxPlaces(n)) {
    const z = -0.3 + boxSlide(n, name), st = boxState(n.ns, name), picked = view.part === name;
    const x0 = g.x - g.w / 2, x1 = g.x + g.w / 2, y0 = g.y - g.h / 2, y1 = g.y + g.h / 2;
    const pts = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y0, -0.6], [x1, y0, -0.6], [x1, y1, -0.6], [x0, y1, -0.6],
      [g.x - g.w * 0.15, g.y, z + 0.01], [g.x + g.w * 0.15, g.y, z + 0.01]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 5], [2, 6], [3, 7], [8, 9]];
    lines(pts.map(at0), edges, BOX_COLOR[st], va * (picked || view.hoverPart === name ? 1 : 0.8), picked ? 1.6 : 1.1,
      { glow: picked, dash: st === 'locked' ? [2, 3] : null });
    // An open drawer: its keys stand in it as cards, one per key (eight at most).
    if (picked && st === 'open') {
      const keys = (DRAWER.data?.keys || []).slice(0, 8), m = keys.length;
      keys.forEach((_, i) => {
        const kz = z - 0.08 - (i * 0.4) / Math.max(1, m);
        const cw = g.w * 0.7, ch = g.h * 0.75;
        const card = SHAPES.keyCard.pts.map(([x, y]) => [g.x + x * cw, y0 + 0.02 + y * ch, kz]);
        lines(card.map(at0), SHAPES.keyCard.edges, C.seal, va, 1.2, { glow: true });
      });
    }
  }
}

// A room's pin board: the cork in its frame, and the post-its on it. A note's colour says who
// made it; an immutable one is laminated (a second edge) and held by a tack, the rest stuck on
// by their adhesive strip; one no pod uses curls at its corner and fades. Open, each note shows
// a scribble per key, and the root CA's notice is a printed sheet in the corner.
function drawBoard(n) {
  const on = view.sel === n.key || view.hover === n.key;
  const a = (matches(n) ? (on ? 1 : 0.75) : 0.1) * n.alpha;
  const at0 = (p) => boardAt(n, p);
  const hw = BOARD_W / 2, hh = BOARD_H / 2, in0 = 0.08;
  const frame = [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0], [-hw + in0, -hh + in0, 0], [hw - in0, -hh + in0, 0], [hw - in0, hh - in0, 0], [-hw + in0, hh - in0, 0]];
  lines(frame.map(at0), [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]], CORK, a * 0.85, on ? 1.4 : 1);
  if (n.open > 0.001) {
    // A ghost where it hangs, and the line it rose along.
    lines([[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]].map((p) => add(p, n.pos)), chain(4, true), CORK, 0.15 * n.open, 1, { dash: [2, 4], focus: false });
    lines([add(boardCentre(n), [0, -hh * boardScale(n), 0]), add(n.pos, [0, hh, 0])], [[0, 1]], CORK, 0.45 * n.open, 1, { dash: [3, 4], focus: false });
  }
  // One stroke per colour and look: a board of many notes costs a few strokes.
  const groups = new Map();
  const put = (color, alpha, width, dash, pts, edges) => {
    const key = `${color}|${alpha.toFixed(2)}|${width}|${dash ? 'd' : ''}`;
    let g = groups.get(key);
    if (!g) { g = { color, alpha, width, dash, pts: [], edges: [] }; groups.set(key, g); }
    const off = g.pts.length;
    g.pts.push(...pts);
    for (const [i, j] of edges) g.edges.push([i + off, j + off]);
  };
  const open = n.open > 0.4, picked0 = view.sel === n.key ? view.part : null;
  for (const pl of notePlaces(n)) {
    const col = NOTE_COLOR[pl.origin], picked = picked0 === pl.name, hov = view.sel === n.key && view.hoverPart === pl.name;
    const used = pl.notice || n.info.uses.has(pl.name);
    const na = a * (picked || hov ? 1 : used ? 0.85 : 0.5);
    const w = picked ? 1.6 : 1, P = (u, v) => noteAt(n, pl, u, v);
    if (pl.notice) {
      // A printed notice: a sheet with its lines, held by a tack.
      put(col, na, w, null, [P(-0.5, -0.5), P(0.5, -0.5), P(0.5, 0.5), P(-0.5, 0.5)], chain(4, true));
      if (open) put(col, na * 0.7, 1, null, [P(-0.35, 0.2), P(0.35, 0.2), P(-0.35, 0), P(0.3, 0), P(-0.35, -0.2), P(0.1, -0.2)], [[0, 1], [2, 3], [4, 5]]);
      put(col, na, 1, null, ringPts(0.05, 8, 'xy').map(([u, v]) => P(u / pl.s, 0.38 + v / pl.s)), chain(8, true));
      continue;
    }
    // The note: a curled corner when no pod uses it.
    const c = 0.24;
    const outline = used ? [P(-0.5, -0.5), P(0.5, -0.5), P(0.5, 0.5), P(-0.5, 0.5)] : [P(-0.5, -0.5), P(0.5 - c, -0.5), P(0.5, -0.5 + c), P(0.5, 0.5), P(-0.5, 0.5)];
    put(col, na, w, null, outline, chain(outline.length, true));
    if (!used) put(col, na, 1, null, [P(0.5 - c, -0.5), P(0.5 - c * 0.85, -0.5 + c * 0.85), P(0.5, -0.5 + c)], chain(3));
    if (pl.o.immutable) {
      // Laminated, and held by a tack.
      put(col, na * 0.6, 1, [2, 2], [P(-0.58, -0.58), P(0.58, -0.58), P(0.58, 0.58), P(-0.58, 0.58)], chain(4, true));
      put(col, na, 1, null, ringPts(0.06, 8, 'xy').map(([u, v]) => P(u / pl.s, 0.38 + v / pl.s)), chain(8, true));
    } else put(col, na * 0.7, 1, null, [P(-0.5, 0.3), P(0.5, 0.3)], [[0, 1]]);
    // Open, a scribble per key (four at most).
    if (open) {
      const m = Math.min(4, pl.o.keys?.length || 0), sp = [], se = [];
      for (let i = 0; i < m; i++) {
        const v = 0.14 - i * 0.16, len0 = 0.3 + 0.5 * hashOf(`${pl.name}/${i}`);
        sp.push(P(-0.36, v), P(-0.36 + len0 * 0.72, v));
        se.push([2 * i, 2 * i + 1]);
      }
      if (m) put(col, na * 0.6, 1, null, sp, se);
    }
  }
  for (const g of groups.values()) lines(g.pts, g.edges, g.color, g.alpha * clamp(0.35 + n.open, 0, 1), g.width, { dash: g.dash, glow: g.width > 1 });
}

// Red string: from a post-it's pin to the top of each pod that uses it, sagging between. Drawn
// while a board is open (every note's, or only the picked one's), and while a pod is picked
// (to the notes it uses). The root CA's notice gets string only when it is the note picked: every
// pod uses it, and its string would hide the rest.
function drawStrings(sel) {
  if (!sel?.pos || sel.gone) return;
  const podTop = (p) => add(podAt(p), [0, 0.85 * podScale(p), 0]);
  const tie = (from, to, alpha) => {
    const d = len(sub(from, to));
    polyline(arcPts(from, to, -(0.3 + d * 0.07), 18), STRING, alpha, 1.1, { focus: false });
  };
  const pin = (p, alpha) => lines(ringPts(0.07, 8, 'xz').map((q) => add(q, p)), chain(8, true), STRING, alpha, 1.2, { focus: false });
  if (sel.kind === 'board' && sel.open > 0.3) {
    for (const pl of notePlaces(sel)) {
      if (pl.notice && view.part !== pl.name) continue;
      const uses = sel.info.uses.get(pl.name);
      if (!uses) continue;
      const alpha = (view.part ? (view.part === pl.name ? 0.9 : 0.08) : 0.55) * clamp((sel.open - 0.3) / 0.5);
      const from = pinOf(sel, pl);
      for (const k of uses.keys()) {
        const p = nodes.get(k);
        if (p?.pos && !p.gone) { const to = podTop(p); tie(from, to, alpha); pin(to, alpha); }
      }
    }
  } else if (sel.kind === 'pod') {
    const board = nodes.get(`board/${sel.ns}`);
    if (!board?.pos || board.gone) return;
    const names = new Set(podUses(sel.obj).map((u) => u.cm));
    names.delete(ROOT_CA);
    const to = podTop(sel);
    for (const pl of notePlaces(board)) if (names.has(pl.name)) tie(pinOf(board, pl), to, 0.8);
    if (names.size) pin(to, 0.8);
  }
}

// ------------------------------------------------------------------------------ the bar and caption

function paintBar() {
  const counts = Object.fromEntries(POD_STATES.map((s) => [s, 0]));
  for (const o of S.pod.values()) counts[podState(o)]++;
  const bx = $('counts');
  if (!bx.children.length) {
    for (const s of POD_STATES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = s; b.dataset.s = s;
      b.title = `Only the ${s} pods (click again for all)`;
      b.append(document.createElement('b'), document.createTextNode(s));
      b.addEventListener('click', () => { view.only = view.only === s ? null : s; for (const x of bx.children) x.classList.toggle('on', x.dataset.s === view.only); wake(); });
      bx.append(b);
    }
  }
  for (const b of bx.children) { const t = String(counts[b.dataset.s]); if (b.firstChild.textContent !== t) b.firstChild.textContent = t; }
  const nNs = new Set([...S.ns.values()].map(nameOf)).size;
  const ctrs = [...S.pod.values()].reduce((s, o) => s + (at(o, 'spec.containers') || []).length, 0);
  const kindsWith = new Set([...S.cr.values()].map(kindOf)).size;
  $('cap-detail').textContent = `${plural(nNs, 'namespace')} · ${plural(S.pod.size, 'pod')}, ${plural(ctrs, 'container')} · ${plural(S.cr.size, 'custom resource')} of ${plural(kindsWith, 'kind')} (${S.crd.size} discovered) · ${plural(S.secret.size, 'Secret')} · ${plural(S.cm.size, 'ConfigMap')}`;
  // What could not be read: the cluster-wide kinds by name, the custom ones counted.
  const notes = [];
  const NOTE_NAME = { cluster: 'cluster', namespace: 'Namespaces', pod: 'Pods', secret: 'Secrets', configmap: 'ConfigMaps' };
  for (const k of Object.keys(NOTE_NAME)) if (S.notes[k]) notes.push(`${NOTE_NAME[k]}: ${S.notes[k]}`);
  // The admission policies' reads: a cluster that serves none is not one to note; their hits and
  // the Events matter only once there are policies.
  if (S.notes.vap && !/not served/.test(S.notes.vap)) notes.push(`Admission policies: ${S.notes.vap}`);
  if (S.vap.size) for (const [k, t] of [['vapb', 'Policy bindings'], ['vaphit', 'Policy hits'], ['vapevent', 'Events']]) if (S.notes[k]) notes.push(`${t}: ${S.notes[k]}`);
  const refused = Object.keys(S.notes).filter((k) => k.startsWith('cr:'));
  if (refused.length) notes.push(`${plural(refused.length, 'custom resource kind')} not readable (the API's details list them)`);
  $('cap-notes').hidden = !notes.length;
  $('cap-notes').textContent = notes.join(' · ');
}

// ------------------------------------------------------------------------------ the details

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let shownStamp = -1, shownAt = 0, rawOpen = false, inspOpen = false;

function dl(rows, cls) {
  const d = el('dl', cls);
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    d.append(el('dt', null, k));
    const dd = el('dd');
    if (v instanceof Node) dd.append(v); else dd.textContent = String(v);
    d.append(dd);
  }
  return d;
}
function pickLink(key, text, ctr = null) {
  const b = el('button', 'pick', text);
  b.type = 'button';
  b.addEventListener('click', () => select(key, ctr));
  return b;
}
function raw(title, obj) {
  const d = el('details');
  d.open = rawOpen;
  d.addEventListener('toggle', () => { rawOpen = d.open; });
  d.append(el('summary', null, title), yamlBlock(obj));
  return d;
}
const note = (text) => el('p', 'note', text);
function chips(map) {
  const wrap = el('div', 'chips');
  for (const [k, v] of Object.entries(map || {})) wrap.append(el('span', 'chip', v === '' ? k : `${k}=${v}`));
  return wrap.children.length ? wrap : null;
}
function kicker(...parts) {
  const k = el('div', 'kicker');
  parts.forEach((p, i) => { if (i) k.append(document.createTextNode(' · ')); k.append(p instanceof Node ? p : document.createTextNode(String(p))); });
  return k;
}
const created = (o) => { const t = at(o, 'metadata.creationTimestamp'); return t ? `${t} (${ago(t)} ago)` : ''; };
const nsPick = (ns) => (nodes.has(`ns/${ns}`) ? pickLink(`ns/${ns}`, ns) : ns);
// The owners named on an object: a link when it is on the plate.
function owners(o) {
  const refs = at(o, 'metadata.ownerReferences') || [];
  if (!refs.length) return '';
  const wrap = el('span');
  refs.forEach((r, i) => {
    if (i) wrap.append(document.createTextNode(', '));
    const k = byUid.get(r.uid);
    wrap.append(k ? pickLink(k, `${r.kind}/${r.name}`) : `${r.kind}/${r.name}`);
  });
  return wrap;
}
function conditions(o) {
  const cs = at(o, 'status.conditions') || [];
  if (!cs.length) return null;
  const t = el('table', 'routes');
  const h = el('tr');
  for (const c of ['type', 'status', 'reason', 'since']) h.append(el('th', null, c));
  t.append(h);
  for (const c of cs) {
    const tr = el('tr');
    tr.append(el('td', null, c.type), el('td', c.status === 'True' ? 'allow' : c.status === 'False' ? 'deny' : '', c.status),
      el('td', null, [c.reason, c.message].filter(Boolean).join(': ')), el('td', 'n', ago(c.lastTransitionTime)));
    t.append(tr);
  }
  return t;
}
const quantity = (r) => Object.entries(r || {}).map(([k, v]) => `${k} ${v}`).join(', ');
// A container's facts: what it runs, how it stands, what it asks for.
function ctrRows(c) {
  const s = c.spec, st = c.st || {};
  const last = st.lastState?.terminated;
  return [
    ['image', s.image],
    ['image ID', st.imageID],
    ['state', ctrStateText(c)],
    ['restarts', st.restartCount],
    ['last ended', last ? `exit ${last.exitCode}${last.reason ? ` (${last.reason})` : ''} at ${last.finishedAt || '?'}` : ''],
    ['command', (s.command || []).join(' ')],
    ['args', (s.args || []).join(' ')],
    ['ports', (s.ports || []).map((p) => `${p.containerPort}/${p.protocol || 'TCP'}${p.name ? ` (${p.name})` : ''}`).join(', ')],
    ['requests', quantity(s.resources?.requests)],
    ['limits', quantity(s.resources?.limits)],
    // Names and where each comes from; never a value, which may be a credential.
    ['env', (s.env || []).map((e) => `${e.name}${e.valueFrom?.secretKeyRef ? ` (Secret ${e.valueFrom.secretKeyRef.name})` : e.valueFrom?.configMapKeyRef ? ` (ConfigMap ${e.valueFrom.configMapKeyRef.name})` : e.valueFrom ? ' (field)' : ''}`).join(', ')],
    ['env from', (s.envFrom || []).map((e) => (e.secretRef ? `Secret ${e.secretRef.name}` : e.configMapRef ? `ConfigMap ${e.configMapRef.name}` : '')).filter(Boolean).join(', ')],
    ['mounts', (s.volumeMounts || []).map((m) => `${m.mountPath}${m.readOnly ? ' (ro)' : ''} ← ${m.name}`).join(', ')],
    ['user', s.securityContext?.runAsUser != null ? String(s.securityContext.runAsUser) : s.securityContext?.runAsNonRoot ? 'non-root' : ''],
    ['privileged', s.securityContext?.privileged ? 'yes' : ''],
  ];
}
// A layer box, as AgentSandbox draws the jail: a head, its facts, and what runs inside it.
function layerBox(name, sub, rows, inner = [], opts = {}) {
  const b = el('div', `layer${opts.picked ? ' picked' : ''}`);
  const head = el('div', 'layer-head');
  head.append(opts.pick || el('b', null, name));
  if (sub) head.append(el('span', null, sub));
  b.append(head);
  const facts = dl(rows, 'facts');
  if (facts.children.length) b.append(facts);
  for (const i of inner) b.append(i);
  return b;
}

// What the drawer of a picked box shows: locked, being pulled, refused, or open on its keys,
// each value behind its own button and dropped when the box is let go.
function drawerSection(ns, name) {
  const out = [el('h3', null, 'The drawer')];
  const st = DRAWER.state;
  if (st === 'locked') out.push(note(`Locked: your RBAC does not allow get on Secrets in ${ns}, so this drawer stays shut.`));
  else if (st === 'loading') out.push(note('Pulling it open…'));
  else if (st === 'refused') out.push(note(`Refused by the API server: ${DRAWER.msg}`));
  else if (st === 'error') out.push(note(`Could not be read: ${DRAWER.msg}`));
  else if (st === 'open') {
    const d = DRAWER.data || {};
    out.push(dl([['type', d.type], ['immutable', d.immutable ? 'yes' : 'no'], ['keys', String((d.keys || []).length)]]));
    out.push(note('Read just now with your own credentials. A value is fetched only when you show it, and forgotten when you pick something else.'));
    const t = el('table', 'routes keys');
    const h = el('tr');
    for (const c of ['key', 'size', '']) h.append(el('th', null, c));
    t.append(h);
    for (const k of d.keys || []) {
      const tr = el('tr'), act = el('td', 'n');
      const shownV = DRAWER.values.get(k.name);
      const b = el('button', 'ghost small', shownV ? 'Hide' : 'Show');
      b.type = 'button';
      b.addEventListener('click', () => {
        if (DRAWER.values.has(k.name)) DRAWER.values.delete(k.name);
        else { DRAWER.values.set(k.name, { loading: true }); readDrawer(ns, name, k.name); }
        stamp++; renderDetails();
      });
      act.append(b);
      tr.append(el('td', null, k.name), el('td', 'n', `${k.bytes} B${k.text ? '' : ' (binary)'}`), act);
      t.append(tr);
      if (shownV) {
        const vr = el('tr'), vd = el('td');
        vd.colSpan = 3;
        if (shownV.loading) vd.append(note('reading…'));
        else if (shownV.error) vd.append(note(shownV.error));
        else {
          // In the raw blocks' box, so its copy button sits in the corner as theirs does.
          const wrap = el('div', 'yamlwrap');
          wrap.append(el('pre', 'secret-value', shownV.value), copyButton(() => shownV.value, 'value'));
          vd.append(wrap);
          if (!shownV.text) vd.append(note('Not UTF-8: shown as base64.'));
        }
        vr.append(vd);
        t.append(vr);
      }
    }
    if (!(d.keys || []).length) out.push(note('It holds no keys.'));
    else out.push(t);
  }
  return out;
}
const annotationNames = (o) => Object.keys(at(o, 'metadata.annotations') || {});

// A post-it's keys: each with its size and a Show button; a value is read when shown.
function noteKeys(ns, name, o) {
  const keys = o.keys || [];
  if (!keys.length) return [note('It holds no keys.')];
  const t = el('table', 'routes keys');
  const h = el('tr');
  for (const c of ['key', 'size', '']) h.append(el('th', null, c));
  t.append(h);
  for (const k of keys) {
    const tr = el('tr'), act = el('td', 'n'), shownV = PEELED.values.get(k.name);
    const b = el('button', 'ghost small', shownV ? 'Hide' : 'Show');
    b.type = 'button';
    b.addEventListener('click', () => {
      if (PEELED.values.has(k.name)) PEELED.values.delete(k.name);
      else { PEELED.values.set(k.name, { loading: true }); readNote(ns, name, k.name); }
      stamp++; renderDetails();
    });
    act.append(b);
    tr.append(el('td', null, k.name), el('td', 'n', `${k.bytes} B${k.text ? '' : ' (binary)'}`), act);
    t.append(tr);
    if (shownV) {
      const vr = el('tr'), vd = el('td');
      vd.colSpan = 3;
      if (shownV.loading) vd.append(note('reading…'));
      else if (shownV.error) vd.append(note(shownV.error));
      else {
        const wrap = el('div', 'yamlwrap');
        wrap.append(el('pre', 'note-value', shownV.value), copyButton(() => shownV.value, 'value'));
        vd.append(wrap);
        if (!shownV.text) vd.append(note('binaryData: shown as base64.'));
      }
      vr.append(vd);
      t.append(vr);
    }
  }
  return [t];
}
// The ConfigMaps a pod uses, each a link to its post-it when it is on a board.
function podNotes(o) {
  const names = [...new Set(podUses(o).map((u) => u.cm))];
  if (!names.length) return '';
  const wrap = el('span'), bk = `board/${nsOf(o)}`, board = nodes.get(bk);
  names.forEach((nm, i) => {
    if (i) wrap.append(document.createTextNode(', '));
    const pinned = board && (nm === ROOT_CA ? board.info.rootCa : board.info.notes.some(([, x]) => nameOf(x) === nm));
    wrap.append(pinned ? pickLink(bk, nm, nm) : nm);
  });
  return wrap;
}

// The admission policies' details: hits by binding, the bindings' scopes, what was turned away.
function hitsTable(rows) {
  const t = el('table', 'routes');
  const h = el('tr');
  for (const c of ['', 'allowed', 'warned', 'audited', 'denied', 'errors']) h.append(el('th', null, c));
  t.append(h);
  for (const [name, x] of rows) {
    const tr = el('tr'), td = el('td');
    td.append(name);
    tr.append(td, el('td', 'n st-allow', String(x.allow || 0)), el('td', `n${x.warn ? ' st-warn' : ''}`, String(x.warn || 0)),
      el('td', `n${x.audit ? ' st-audit' : ''}`, String(x.audit || 0)), el('td', `n${x.deny ? ' st-deny' : ''}`, String(x.deny || 0)), el('td', 'n', String(x.error || 0)));
    t.append(tr);
  }
  return t;
}
function countedSince() {
  const s = [...S.vaphit.values()].map((h) => h.since).filter(Boolean).sort((a, b) => whenOf(a) - whenOf(b))[0];
  return s ? `since ${ago(s)} ago` : '';
}
function countingNote() {
  if (S.notes.vaphit) return note(`Hits: ${S.notes.vaphit}.`);
  return note('Hits are the API server\'s own counts (its /metrics, read with your credentials every 10 seconds while this page is open), from when Recess began counting. Where several API servers share one address, each one\'s count is added as it is read.');
}
function selectorText(s) {
  const parts = Object.entries(s?.matchLabels || {}).map(([k, v]) => `${k}=${v}`);
  for (const e of s?.matchExpressions || []) parts.push(`${e.key} ${e.operator}${(e.values || []).length ? ` (${e.values.join(', ')})` : ''}`);
  return parts.join(', ') || 'all';
}
// What the cupboard holds, a row each: what (how often) and when, which policy (unless the table
// is one policy's), where (unless it is one shelf's), on what, and why.
function recordTable(recs, { shelf = false, policy = true } = {}) {
  const t = el('table', 'routes records');
  const h = el('tr');
  for (const c of ['', ...(policy ? ['policy'] : []), ...(shelf ? ['shelf'] : []), 'object', 'why']) h.append(el('th', null, c));
  t.append(h);
  for (const r of recs) {
    const tr = el('tr'), what = el('td', 'what');
    what.append(el('span', `st-${r.action}`, `${ACTION_SAYS[r.action] || r.action}${(r.count || 1) > 1 ? ` ×${r.count}` : ''}`), el('span', 'sub', r.last ? `${ago(r.last)} ago` : ''));
    what.title = r.first && r.first !== r.last ? `first ${r.first}, last ${r.last}` : r.last || '';
    const cells = [what];
    if (policy) {
      const td = el('td');
      td.append(nodes.has(`vap/${r.policy}`) ? pickLink(`vap/${r.policy}`, r.policy) : r.policy);
      td.title = `binding ${r.binding || '?'}`;
      cells.push(td);
    }
    if (shelf) { const td = el('td'); td.append(pickLink('cupboard', shelfName(shelfOf(r.ns)), shelfOf(r.ns))); cells.push(td); }
    const obj = r.object?.name ? `${r.object.kind || '?'}/${r.object.name}` : r.from === 'metrics' ? 'not reported' : '';
    cells.push(el('td', null, obj), el('td', null, r.message || (r.from === 'metrics' ? `the API server's count, through ${r.binding}` : '')));
    tr.append(...cells);
    t.append(tr);
  }
  return t;
}

const PANELS = {
  vapgate: (n) => {
    const pols = n.info.policies, bound = pols.filter((o) => bindingsOf(nameOf(o)).length).length;
    const out = [kicker(pickLink('api', 'Kubernetes API'), 'Admission'), el('h2', null, 'Admission policies'),
      el('p', 'lede', 'The ValidatingAdmissionPolicies the API server checks requests against, as your RBAC lists them. A hit flies from the API to its policy: green let through, amber warned, violet audited, red denied. What is warned or denied goes on to the cupboard.'),
      dl([['policies', `${pols.length}, ${bound} bound`], ['bindings', S.notes.vapb || String(S.vapb.size)],
        ['hits', S.notes.vaphit || countedSince() || 'counting'], ['Events', S.notes.vapevent || 'Warning Events in all namespaces, read for denials']]),
      countingNote(),
      el('h3', null, `Hits ${countedSince()}`),
      hitsTable(pols.map((o) => [pickLink(`vap/${nameOf(o)}`, nameOf(o)), sumHits(hitsOf(nameOf(o)))]))];
    if (nodes.has('cupboard')) { const h = el('h3', null, 'What they turned away: '); h.append(pickLink('cupboard', 'the cupboard')); out.push(h); }
    return out;
  },
  vap: (n) => {
    const o = n.obj, name = nameOf(o), sp = o.spec || {}, binds = bindingsOf(name), hits = hitsOf(name);
    const rules = (at(o, 'spec.matchConstraints.resourceRules') || []).map((r) => `${(r.operations || []).join('/')} ${(r.resources || []).join(', ')}${(r.apiGroups || []).length ? ` (${r.apiGroups.map((g) => g || 'core').join(', ')})` : ''}`).join('; ');
    const warns = at(o, 'status.typeChecking.expressionWarnings') || [];
    const out = [kicker(nodes.has('vapgate') ? pickLink('vapgate', 'Admission policies') : 'Admission', 'ValidatingAdmissionPolicy', el('span', binds.length ? 'st-ok' : 'st-unknown', binds.length ? 'bound' : 'not bound')),
      el('h2', null, name),
      dl([['matches', rules], ['failure policy', sp.failurePolicy || 'Fail'], ['params', sp.paramKind ? `${sp.paramKind.kind} (${sp.paramKind.apiVersion})` : ''],
        ['validations', (sp.validations || []).length], ['audit annotations', (sp.auditAnnotations || []).length || ''],
        ['type checking', warns.length ? plural(warns.length, 'warning') : ''], ['created', created(o)]])];
    if (!binds.length) out.push(note('No binding names this policy, so the API server checks nothing against it.'));
    out.push(el('h3', null, `Hits ${countedSince()}`));
    if (hits.length) out.push(hitsTable(hits.map((h) => [document.createTextNode(h.binding), h])));
    out.push(countingNote());
    if (binds.length) {
      out.push(el('h3', null, `Bindings (${binds.length})`));
      const ul = el('ul');
      for (const b of binds) {
        const li = el('li'), mr = at(b, 'spec.matchResources') || {}, acts = at(b, 'spec.validationActions') || [];
        const scope = [mr.namespaceSelector && Object.keys(mr.namespaceSelector).length ? `namespaces ${selectorText(mr.namespaceSelector)}` : 'all namespaces',
          mr.objectSelector && Object.keys(mr.objectSelector).length ? `objects ${selectorText(mr.objectSelector)}` : '',
          at(b, 'spec.paramRef.name') ? `params ${b.spec.paramRef.name}` : ''].filter(Boolean).join(' · ');
        li.append(el('span', null, nameOf(b)), el('span', `sub ${acts.includes('Deny') ? 'st-deny' : 'st-warn'}`, `${acts.join(', ') || 'no action'} · ${scope}`));
        ul.append(li);
      }
      out.push(ul);
    }
    if ((sp.validations || []).length) {
      out.push(el('h3', null, 'Validations'));
      for (const v of sp.validations) {
        const wrap = el('div', 'yamlwrap');
        wrap.append(el('pre', null, v.expression || ''));
        out.push(wrap, note(v.message || (v.messageExpression ? `message: ${v.messageExpression}` : 'no message')));
      }
    }
    const recs = [...S.vapfail.values()].filter((r) => r.policy === name).sort((a, b) => whenOf(b.last) - whenOf(a.last));
    if (recs.length) out.push(el('h3', null, `Turned away (${recs.length})`), recordTable(recs.slice(0, 30), { shelf: true, policy: false }));
    out.push(raw('Raw (YAML)', o));
    return out;
  },
  cupboard: (n) => {
    const shelves = n.info.shelves, s = view.part && shelves.find((x) => x.part === view.part);
    if (s) {
      const any = s.part === SHELF_ANY;
      return [kicker(pickLink(n.key, 'Cupboard'), 'Shelf', any ? 'no namespace' : nsPick(s.part)), el('h2', null, shelfName(s.part)),
        el('p', 'lede', any
          ? 'The API server\'s own counts of what each policy denied or warned, in any namespace: they name the policy and the binding, never the request.'
          : `What the admission policies denied or warned in ${s.part}, from the Warning Events that carry it (a controller records one when the API server refuses what it tried to create). Kept here after the Event is gone.`),
        dl([['denied', String(s.deny)], ['warned', String(s.warn)], ['last', s.last ? `${s.last} (${ago(s.last)} ago)` : '']]),
        recordTable(s.recs.slice(0, 200))];
    }
    const out = [kicker(nodes.has('vapgate') ? pickLink('vapgate', 'Admission policies') : 'Admission', 'Cupboard'), el('h2', null, 'What was turned away'),
      el('p', 'lede', 'Every deny and warning the admission policies gave while Recess has been running: a shelf per namespace, from the Warning Events that say where, and one shelf for the API server\'s own counts, which say no namespace. The API server drops an Event after an hour; the shelves keep it (up to 1000 records, 200 a shelf).'),
      dl([['shelves', String(shelves.length)], ['Events', S.notes.vapevent || 'read, all namespaces'], ['counts', S.notes.vaphit || 'read from /metrics']])];
    const ul = el('ul');
    for (const x of shelves) {
      const li = el('li');
      li.append(pickLink(n.key, shelfName(x.part), x.part), el('span', `sub ${x.deny ? 'st-deny' : 'st-warn'}`, [x.deny ? `${x.deny} denied` : '', x.warn ? `${x.warn} warned` : '', x.last ? `last ${ago(x.last)} ago` : ''].filter(Boolean).join(' · ')));
      ul.append(li);
    }
    if (!shelves.length) ul.append(el('li', 'empty', 'nothing yet'));
    out.push(el('h3', null, `Shelves (${shelves.length})`), ul);
    return out;
  },
  board: (n) => {
    const r = n.info, all = [...r.notes, ...(r.rootCa ? [[null, r.rootCa]] : [])];
    const hit = view.part && all.find(([, o]) => nameOf(o) === view.part);
    if (hit) {
      const o = hit[1], name = nameOf(o), origin = noteOrigin(o), uses = r.uses.get(name);
      const out = [kicker(nsPick(n.ns), pickLink(n.key, 'Pin board'), 'ConfigMap', el('span', `og-${origin}`, NOTE_MADE[origin])),
        el('h2', null, name)];
      if (origin === 'notice') out.push(el('p', 'lede', 'Kubernetes puts this one in every namespace: the cluster\'s CA certificate, which every pod\'s service account volume mounts. It is pinned in the corner as a notice, not a post-it, and gets its string only while it is picked.'));
      out.push(dl([['created', created(o)], ['made', NOTE_MADE[origin]], ['owner', owners(o)], ['immutable', o.immutable ? 'yes: laminated' : 'no'],
        ['labels', chips(at(o, 'metadata.labels'))], ['annotations', annotationNames(o).join(', ')]]));
      out.push(el('h3', null, `Used by (${uses?.size || 0})`));
      if (uses?.size) {
        const ul = el('ul');
        for (const [k, how] of uses) {
          const p = S.pod.get(k), li = el('li');
          li.append(p ? pickLink(k, nameOf(p)) : k, el('span', 'sub', how.join(' · ')));
          ul.append(li);
        }
        out.push(ul);
      } else out.push(note('No pod in this namespace names it in its spec (a volume, env or envFrom). Something may still read it through the API.'));
      out.push(el('h3', null, `Keys (${(o.keys || []).length})`),
        note('Each value is read only when you show it, with your own credentials, and dropped when you pick something else.'),
        ...noteKeys(n.ns, name, o), raw('Raw (metadata, keys and sizes)', o));
      return out;
    }
    const used = r.notes.filter(([, o]) => r.uses.has(nameOf(o))).length;
    const out = [kicker(nsPick(n.ns), 'Pin board'), el('h2', null, `ConfigMaps in ${n.ns}`),
      el('p', 'lede', 'Each ConfigMap a post-it: yellow when made by hand, pink by Helm, teal by an operator (it has an owner); laminated and held by a tack when immutable. Red string runs from each note to the pods that use it; a note no pod uses curls at its corner.'),
      dl([['notes', `${r.notes.length}${r.notes.length > MAX_NOTE ? ` (${MAX_NOTE} on the board)` : ''}`],
        ['used', `${used} by pods, ${r.notes.length - used} not`],
        ['notice', r.rootCa ? pickLink(n.key, ROOT_CA, ROOT_CA) : '']]),
      el('h3', null, `Notes (${r.notes.length})`)];
    const ul = el('ul');
    for (const [, o] of r.notes.slice(0, 500)) {
      const li = el('li'), origin = noteOrigin(o), u = r.uses.get(nameOf(o))?.size || 0;
      li.append(pickLink(n.key, nameOf(o), nameOf(o)), el('span', `sub og-${origin}`, [NOTE_MADE[origin], plural((o.keys || []).length, 'key'), u ? `used by ${plural(u, 'pod')}` : 'unused', o.immutable ? 'immutable' : ''].filter(Boolean).join(' · ')));
      ul.append(li);
    }
    out.push(ul);
    return out;
  },
  vault: (n) => {
    const acc = ACCESS.get(n.ns), list = n.info.secrets;
    const box = view.part && list.find(([, o]) => nameOf(o) === view.part);
    if (box) {
      const o = box[1], st = boxState(n.ns, view.part);
      return [kicker(nsPick(n.ns), pickLink(n.key, 'Secrets vault'), 'Secret', el('span', `st-${st === 'locked' ? 'bad' : st === 'open' ? 'ok' : 'unknown'}`, st)),
        el('h2', null, nameOf(o)),
        dl([['created', created(o)], ['owner', owners(o)], ['labels', chips(at(o, 'metadata.labels'))],
          ['annotations', annotationNames(o).join(', ')]]),
        ...drawerSection(n.ns, view.part),
        raw('Raw (metadata only)', o)];
    }
    const out = [kicker(nsPick(n.ns), 'Secrets vault', el('span', acc === true ? 'st-ok' : acc === false ? 'st-bad' : 'st-unknown', acc === true ? 'readable' : acc === false ? 'locked' : 'checking')),
      el('h2', null, `Secrets in ${n.ns}`),
      el('p', 'lede', 'Each Secret a safety deposit box. The wall is drawn from metadata only; a drawer opens when you click its box, read then with your own credentials.'),
      dl([['boxes', `${list.length}${list.length > MAX_BOX ? ` (${MAX_BOX} on the wall)` : ''}`],
        ['your access', acc === true ? 'get allowed: drawers open' : acc === false ? 'get not allowed: drawers stay shut' : 'asking the API server']]),
      el('h3', null, `Boxes (${list.length})`)];
    const ul = el('ul');
    for (const [, o] of list.slice(0, 500)) {
      const li = el('li');
      li.append(pickLink(n.key, nameOf(o), nameOf(o)), el('span', 'sub', [at(o, 'metadata.annotations')?.['kubernetes.io/service-account.name'] ? `service account ${o.metadata.annotations['kubernetes.io/service-account.name']}` : '', (at(o, 'metadata.ownerReferences') || []).map((r) => `${r.kind}/${r.name}`).join(', '), ago(at(o, 'metadata.creationTimestamp')) ? `${ago(at(o, 'metadata.creationTimestamp'))} old` : ''].filter(Boolean).join(' · ')));
      ul.append(li);
    }
    out.push(ul);
    return out;
  },
  api: () => {
    const refused = Object.entries(S.notes).filter(([k]) => k.startsWith('cr:'));
    const kinds = [...S.crd.values()].sort((a, b) => `${a.group}/${a.kind}`.localeCompare(`${b.group}/${b.kind}`));
    const count = new Map();
    for (const o of S.cr.values()) count.set(kindOf(o) + '|' + apiGroupOf(o), (count.get(kindOf(o) + '|' + apiGroupOf(o)) || 0) + 1);
    const out = [kicker('Kubernetes API'), el('h2', null, CLUSTER_INFO.context || 'The cluster'),
      el('p', 'lede', 'Everything here was listed and watched with your own credentials, across all namespaces. What your RBAC does not allow is named, not shown.'),
      dl([['as', CLUSTER_INFO.user], ['namespaces', [...nodes.values()].filter((n) => n.kind === 'ns' && !n.gone).length], ['pods', S.pod.size],
        ['custom kinds', `${S.crd.size} discovered, ${new Set([...S.cr.values()].map(kindOf)).size} with objects`], ['custom resources', S.cr.size],
        ['discovery', S.notes.cluster || 'ok'], ['Namespaces', S.notes.namespace || 'readable'], ['Pods', S.notes.pod || 'readable'],
        ['Secrets', S.notes.secret || `${S.secret.size} listed, as metadata only`],
        ['ConfigMaps', S.notes.configmap || `${S.cm.size} listed, keys and sizes only`],
        ['admission policies', S.notes.vap || (S.vap.size ? nodes.has('vapgate') ? pickLink('vapgate', `${S.vap.size} ValidatingAdmissionPolicies`) : String(S.vap.size) : 'none')]])];
    if (refused.length) {
      out.push(el('h3', null, `Not readable (${refused.length})`));
      const ul = el('ul');
      for (const [k, t] of refused.sort()) { const li = el('li'); li.append(el('span', null, k.slice(3)), el('span', 'sub', t)); ul.append(li); }
      out.push(ul);
    }
    out.push(el('h3', null, 'Custom resource kinds'));
    const t = el('table', 'routes');
    const h = el('tr');
    for (const c of ['kind', 'group', 'version', 'n']) h.append(el('th', null, c));
    t.append(h);
    for (const k of kinds) {
      const tr = el('tr');
      const bad = S.notes[k.watch];
      tr.append(el('td', bad ? 'deny' : null, k.kind), el('td', null, k.group), el('td', null, k.version), el('td', 'n', bad ? '-' : String(count.get(`${k.kind}|${k.group}`) || 0)));
      t.append(tr);
    }
    out.push(t);
    return out;
  },
  ns: (n) => {
    const r = n.info, o = n.obj;
    const counts = Object.fromEntries(POD_STATES.map((s) => [s, 0]));
    for (const [, p] of r.pods) counts[podState(p)]++;
    const out = [kicker('Namespace', el('span', at(o, 'status.phase') === 'Terminating' ? 'st-terminating' : 'st-running', at(o, 'status.phase') || (o ? '' : 'not listed'))),
      el('h2', null, n.ns),
      dl([['created', created(o)],
        ['pods', POD_STATES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ') || 'none'],
        ['labels', chips(at(o, 'metadata.labels'))]])];
    if (!o) out.push(note('This namespace was not listed (your RBAC may not allow listing namespaces); it is here because objects in it were.'));
    if (r.secrets.length) {
      const h = el('h3', null, 'Secrets ');
      h.append(pickLink(`vault/${n.ns}`, `the vault, ${plural(r.secrets.length, 'box', 'boxes')}`));
      out.push(h);
    }
    if (r.notes.length) {
      const h = el('h3', null, 'ConfigMaps ');
      h.append(pickLink(`board/${n.ns}`, `the pin board, ${plural(r.notes.length, 'note')}`));
      out.push(h);
    }
    out.push(el('h3', null, `Pods (${r.pods.length})`));
    const ul = el('ul');
    for (const [k, p] of r.pods.slice(0, 300)) {
      const li = el('li'), st = podState(p);
      li.append(pickLink(k, nameOf(p)), el('span', `sub st-${st}`, `${st} · ${containersOf(p).filter((c) => !c.init).map((c) => c.name).join(', ')}`));
      ul.append(li);
    }
    if (!r.pods.length) ul.append(el('li', 'empty', 'none'));
    out.push(ul);
    for (const s of r.shelves) {
      out.push(el('h3', null, `${s.kind} (${s.list.length}) · ${apiGroupOf(s.list[0][1])}`));
      const l2 = el('ul');
      for (const [k, c] of s.list.slice(0, 300)) { const li = el('li'), st = crState(c); li.append(pickLink(k, nameOf(c)), el('span', `sub st-${st}`, st === 'unknown' ? 'no condition' : st)); l2.append(li); }
      out.push(l2);
    }
    return out;
  },
  pod: (n) => {
    const o = n.obj, s = o.status || {}, st = podState(o), all = containersOf(o);
    const cs = all.filter((c) => !c.init), ready = cs.filter((c) => c.st?.ready).length;
    const restarts = all.reduce((x, c) => x + (c.st?.restartCount || 0), 0);
    const picked = view.part && all.find((c) => c.name === view.part);
    const out = [];
    if (picked) {
      const cst = ctrState(picked);
      out.push(kicker(nsPick(nsOf(o)), pickLink(n.key, nameOf(o)), picked.init ? 'Init container' : 'Container', el('span', `st-${cst === 'done' ? 'succeeded' : cst === 'waiting' ? 'unready' : cst}`, cst)),
        el('h2', null, picked.name), el('p', 'lede', picked.spec.image), dl(ctrRows(picked)));
      out.push(raw('Raw (spec and status)', { spec: picked.spec, status: picked.st || null }));
      out.push(el('h3', null, 'Its pod'));
    } else {
      out.push(kicker(nsPick(nsOf(o)), 'Pod', el('span', `st-${st}`, st)), el('h2', null, nameOf(o)),
        el('p', 'lede', [s.podIP, at(o, 'spec.nodeName') ? `on ${at(o, 'spec.nodeName')}` : 'not scheduled', `${ago(at(o, 'metadata.creationTimestamp'))} old`].filter(Boolean).join(' · ')));
    }
    out.push(dl([
      ['phase', s.phase + (s.reason ? ` (${s.reason})` : '')],
      ['ready', `${ready}/${cs.length} containers`],
      ['restarts', restarts],
      ['owner', owners(o)],
      ['ConfigMaps', podNotes(o)],
      ['deleting', at(o, 'metadata.deletionTimestamp') ? `since ${at(o, 'metadata.deletionTimestamp')}` : ''],
      ['message', s.message],
    ]));
    // From the outside in: the node, the pod, then each container in it, side by side.
    out.push(el('h3', null, 'From the outside in'));
    const ctrBoxes = all.map((c) => {
      const cst = ctrState(c);
      return layerBox(c.name, `${c.init ? 'init · ' : ''}${shortImage(c.spec.image)} · ${cst}`, picked ? [['state', ctrStateText(c)], ['restarts', c.st?.restartCount]] : ctrRows(c), [],
        { picked: picked === c, pick: pickLink(n.key, c.name, c.name) });
    });
    const podBox = layerBox('Pod', `${s.podIP || 'no IP yet'}${(s.podIPs || []).length > 1 ? ` (+${s.podIPs.length - 1})` : ''}`, [
      ['service account', at(o, 'spec.serviceAccountName')], ['QoS', s.qosClass], ['restart policy', at(o, 'spec.restartPolicy')],
      ['priority', at(o, 'spec.priorityClassName')], ['host network', at(o, 'spec.hostNetwork') ? 'yes: the node\'s own' : ''],
      ['volumes', (at(o, 'spec.volumes') || []).map((v) => `${v.name} (${Object.keys(v).find((k) => k !== 'name') || '?'})`).join(', ')],
      ['started', s.startTime],
    ], ctrBoxes);
    out.push(el('div', 'stack nest'));
    out[out.length - 1].append(layerBox('Node', at(o, 'spec.nodeName') || 'not scheduled', [['host IP', s.hostIP]], [podBox]));
    const cond = conditions(o);
    if (cond) out.push(el('h3', null, 'Conditions'), cond);
    const lab = chips(at(o, 'metadata.labels'));
    if (lab) out.push(el('h3', null, 'Labels'), lab);
    if (!picked) out.push(raw('Raw (YAML)', o));
    return out;
  },
  cr: (n) => {
    const o = n.obj, st = crState(o);
    const out = [kicker(nsPick(nsOf(o)), kindOf(o), o.apiVersion || '', el('span', `st-${st}`, st === 'unknown' ? 'no condition' : st)),
      el('h2', null, nameOf(o)),
      dl([['created', created(o)],
        ['generation', at(o, 'metadata.generation') != null ? `${at(o, 'metadata.generation')}${at(o, 'status.observedGeneration') != null ? `, observed ${at(o, 'status.observedGeneration')}` : ''}` : ''],
        ['phase', at(o, 'status.phase') || at(o, 'status.state')],
        ['owner', owners(o)],
        ['deleting', at(o, 'metadata.deletionTimestamp') ? `since ${at(o, 'metadata.deletionTimestamp')}` : ''],
        ['finalizers', (at(o, 'metadata.finalizers') || []).join(', ')]])];
    const uid = at(o, 'metadata.uid');
    const owned = uid ? [...nodes.values()].filter((m) => !m.gone && (at(m.obj, 'metadata.ownerReferences') || []).some((r) => r.uid === uid)) : [];
    if (owned.length) {
      out.push(el('h3', null, `Owns (${owned.length})`));
      const ul = el('ul');
      for (const m of owned) { const li = el('li'); li.append(pickLink(m.key, nameOf(m.obj)), el('span', 'sub', kindOf(m.obj))); ul.append(li); }
      out.push(ul);
    }
    const cond = conditions(o);
    if (cond) out.push(el('h3', null, 'Conditions'), cond);
    const lab = chips(at(o, 'metadata.labels'));
    if (lab) out.push(el('h3', null, 'Labels'), lab);
    out.push(raw('Raw (YAML)', o));
    return out;
  },
};

function renderDetails() {
  shownStamp = stamp; shownAt = clock;
  const bx = $('details');
  const n = view.sel && nodes.get(view.sel);
  inspOpen = !!n;
  $('insp').hidden = !n;
  if (!n) return;
  const keep = bx.scrollTop;
  bx.replaceChildren(...(PANELS[n.kind] ? PANELS[n.kind](n) : []));
  bx.scrollTop = keep;
}

// ------------------------------------------------------------------------------ selection and input

// Pick a node, and a part of it: a pod's container, a vault's box (whose drawer is then pulled
// open) or a board's note (peeled off). Whatever drawer was open, and whatever values a note
// showed, are emptied when the part picked changes.
function select(key, part = null) {
  const was = view.sel;
  view.sel = key && nodes.has(key) ? key : null;
  view.part = view.sel && part ? part : null;
  if (view.sel) view.touched = true;
  const n = view.sel && nodes.get(view.sel);
  if (n?.kind === 'vault' && view.part) pullDrawer(n.ns, view.part);
  else closeDrawer();
  const peeled = n?.kind === 'board' && view.part ? `${n.ns}/${view.part}` : '';
  if (PEELED.id !== peeled) PEELED = { id: peeled, values: new Map() };
  if (n && was !== view.sel) {
    // Framed: a room whole, a pod risen with its containers, the API with the plate.
    if (n.kind === 'ns') { view.goal = [n.info.x0 + n.info.w / 2, 0, n.info.z0 + n.info.d / 2]; view.dist = clamp(Math.max(n.info.w, n.info.d) * 1.5, 14, 90); }
    else if (n.kind === 'pod') { view.goal = add(n.goal, [0, OPEN_LIFT * 0.85, 0]); view.dist = 16; }
    else if (n.kind === 'cr') { view.goal = n.goal.slice(); view.dist = 10; }
    else if (n.kind === 'vault') { view.goal = add(n.goal, [0, VAULT_LIFT * 0.9, 0]); view.dist = 19; askAccess(n.ns); }
    else if (n.kind === 'board') { view.goal = add(n.goal, [0, BOARD_LIFT * 0.8, 0]); view.dist = 20; }
    else if (n.kind === 'cupboard') { view.goal = add(n.goal, [0, CUP_LIFT * 0.9, 0]); view.dist = 15; }
    else if (n.kind === 'vap') { view.goal = n.goal.slice(); view.dist = 12; }
    else if (n.kind === 'vapgate') { view.goal = [(n.info.x0 + n.info.x1) / 2, 0, (n.info.z0 + n.info.z1) / 2]; view.dist = clamp((n.info.x1 - n.info.x0) * 2.4, 14, 40); }
    else if (n.kind === 'api') { view.goal = fit.center; view.dist = fit.dist; }
  }
  $('details').scrollTop = 0;
  renderDetails();
  wake(400);
}

// What is under (x, y): an open pod's container, an open vault's box or an open board's note
// first, then the nearest pod, resource, vault, board or the API on screen, then the room whose
// floor is there.
function pickAt(x, y) {
  const sel = view.sel && nodes.get(view.sel);
  if (sel?.kind === 'pod' && sel.open > 0.5) {
    let best = null, bd = 26;
    for (const { c, at: p } of ctrPlaces(sel)) {
      const cc = toCam(p);
      if (cc[2] <= NEAR) continue;
      const [px, py] = proj(cc), d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = c.name; }
    }
    if (best) return { key: sel.key, ctr: best };
  }
  if (sel?.kind === 'vault' && sel.open > 0.5) {
    let best = null, bd = 22;
    for (const { name, front } of boxPlaces(sel)) {
      const cc = toCam(front);
      if (cc[2] <= NEAR) continue;
      const [px, py] = proj(cc), d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = name; }
    }
    if (best) return { key: sel.key, ctr: best };
  }
  if (sel?.kind === 'board' && sel.open > 0.5) {
    let best = null, bd = 26;
    for (const pl of notePlaces(sel)) {
      const cc = toCam(noteAt(sel, pl, 0, 0));
      if (cc[2] <= NEAR) continue;
      const [px, py] = proj(cc), d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = pl.name; }
    }
    if (best) return { key: sel.key, ctr: best };
  }
  if (sel?.kind === 'cupboard' && sel.open > 0.5) {
    let best = null, bd = 34;
    for (const s of sel.info.shelves.slice(0, sel.info.k)) {
      const cc = toCam(shelfFront(sel, s.part));
      if (cc[2] <= NEAR) continue;
      const [px, py] = proj(cc), d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = s.part; }
    }
    if (best) return { key: sel.key, ctr: best };
  }
  // Within 24 px of its middle; an open pod, being larger, within 60.
  let best = null;
  for (const n of nodes.values()) {
    if (n.gone || !n.pos || n.kind === 'ns') continue;
    if ((n.kind === 'pod' || n.kind === 'cr' || n.kind === 'vault' || n.kind === 'board') && !matches(n)) continue;
    const c = toCam(n.kind === 'pod' ? podAt(n) : n.kind === 'vault' ? vaultCentre(n) : n.kind === 'board' ? boardCentre(n) : n.kind === 'cupboard' ? cupCentre(n) : n.pos);
    if (c[2] <= NEAR) continue;
    const [px, py] = proj(c), d = Math.hypot(px - x, py - y);
    const reach = n.open > 0.5 ? (n.kind === 'vault' || n.kind === 'board' || n.kind === 'cupboard' ? 90 : 60) : n.kind === 'cupboard' ? 40 : 24;
    if (d < reach && (!best || d < best.d)) best = { key: n.key, d };
  }
  if (best) return { key: best.key, ctr: null };
  const hit = rayHit(x, y, [0, FLOOR_Y, 0], false);
  if (hit) {
    for (const n of nodes.values()) {
      if (n.kind !== 'ns' || n.gone || !n.info) continue;
      const r = n.info;
      if (hit[0] >= r.x0 && hit[0] <= r.x0 + r.w && hit[2] >= r.z0 && hit[2] <= r.z0 + r.d) return { key: n.key, ctr: null };
    }
  }
  return null;
}

function bind() {
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (HAND.m) return;
    if (moveKey(e)) {
      const p = pickAt(e.clientX, e.clientY);
      holdNode(e, p && nodes.get(p.key));
      return;
    }
    if (markBegin(e)) return;
    drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, target: view.target.slice(), pan: e.button === 2 || e.shiftKey || e.metaKey, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (HAND.m) return;
    if (markMove(e)) return;
    if (!drag) {
      const p = pickAt(e.clientX, e.clientY);
      view.hover = p && !p.ctr ? p.key : null;
      view.hoverPart = p?.ctr || null;
      canvas.classList.toggle('pick', !!p);
      canvas.classList.toggle('movable', moveKey(e) && !!p && !!groupOfNode(nodes.get(p.key)));
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) { drag.moved = true; view.touched = true; }
    if (drag.pan) {
      const k = view.dist / cam.F;
      const right = norm([cam.r[0], 0, cam.r[2]]), fwd = norm([cam.f[0], 0, cam.f[2]]);
      view.goal = null;
      view.target = add(drag.target, add(mul(right, -dx * k), mul(fwd, dy * k)));
    } else {
      view.yaw = drag.yaw - dx * 0.0035;
      view.pitch = clamp(drag.pitch + dy * 0.003, 0.08, 1.4);
    }
  });
  const end = (e) => {
    const inside = (x0, y0, x1, y1) => [...nodes.values()]
      .filter((n) => n.kind === 'ns' && !n.gone && n.pos && inSquare(n.pos, x0, y0, x1, y1)).map(groupOfNode);
    if (markEnd(e, inside)) return;
    if (drag && !drag.moved && e.type === 'pointerup') {
      const p = pickAt(e.clientX, e.clientY);
      if (markKey(e)) markToggle(p && groupOfNode(nodes.get(p.key)));
      else {
        if (!p) MARK.keys = new Set();
        select(p?.key || null, p?.ctr || null);
      }
    }
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // Ctrl-double-click: a room back where the layout stands it.
  canvas.addEventListener('dblclick', (e) => {
    const p = moveKey(e) && performance.now() - HAND.dropped > 700 && pickAt(e.clientX, e.clientY), key = p && groupOfNode(nodes.get(p.key));
    if (key && LAYOUT.moved[key]) moveGroups(new Set([key]), mul(LAYOUT.moved[key], -1));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.touched = true;
    view.dist = clamp(view.dist * Math.exp(e.deltaY * 0.001), 4, 220);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey) return;
    // Esc steps out: from a container to its pod (a box to its vault, a note to its board), then
    // to the cluster.
    if (e.key === 'Escape') {
      if (view.part) select(view.sel, null);
      else { select(null); view.touched = false; dirty = true; }
    } else if (e.key === '/') { e.preventDefault(); $('filter').focus(); }
  });
  $('insp-close').addEventListener('click', () => select(null));
  $('filter').addEventListener('input', (e) => { view.filter = e.target.value.trim().toLowerCase(); });
  $('filter').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; view.filter = ''; e.target.blur(); } });
}

function connect() {
  const pill = $('live');
  const es = new EventSource('/api/kubernetes');
  es.onopen = () => { pill.textContent = 'live'; pill.className = 'pill ok'; };
  es.onmessage = (ev) => { try { inbox.push(JSON.parse(ev.data)); wake(); } catch { /* a malformed message is dropped */ } };
  // The browser reconnects by itself, and the server answers with the whole picture again.
  es.onerror = () => { pill.textContent = 'reconnecting'; pill.className = 'pill bad'; };
}

// Which cluster, and as whom: the kubeconfig's context, or the person signed in.
async function whichCluster() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return;
    const c = await r.json();
    CLUSTER_INFO.context = c.kubeContext || (c.demo ? 'demo' : '');
    CLUSTER_INFO.user = c.user?.kubeUser || c.user?.email || '';
    wake();
  } catch { /* the caption keeps its defaults */ }
}

resize();
window.addEventListener('resize', resize);
bind();
loadLayout('kubernetes').then(() => { dirty = true; wake(); });
whichCluster();
connect();
paintBar();
requestAnimationFrame(runFrames(frame));
