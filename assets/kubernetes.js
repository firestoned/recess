// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// The Kubernetes view: the whole theatre is the cluster. Its floor is a plate with the
// Kubernetes API standing at its north edge; on it, each namespace is a room (a wireframe box),
// its pods in rows at the front as the jail's cages, coloured by their state, and its custom
// resources behind them on shelves, one shelf per kind. Click a pod and it rises out of its
// room and opens, with its containers inside, each one clickable; the details panel shows it
// from the outside in, as AgentSandbox shows the jail: the node, the pod, each container.
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
const PLATE_PAD = 5; // round the rooms, before the room to spare
// The plate is this much bigger each way than what is on it (half as big again), so a room has
// somewhere to be moved to.
const PLATE_SPARE = 1.5;

const POD_STATES = ['running', 'unready', 'pending', 'failing', 'succeeded', 'terminating'];
const POD_COLOR = { running: C.wire, unready: C.seal, pending: C.muted, failing: C.bad, succeeded: C.ok, terminating: C.dim };
const CTR_COLOR = { running: C.wire, unready: C.seal, waiting: C.seal, failing: C.bad, done: C.ok };
const CR_COLOR = { ok: C.ok, bad: C.bad, unknown: C.ident };

// ------------------------------------------------------------------------------ the data

const S = { ns: new Map(), pod: new Map(), crd: new Map(), cr: new Map(), notes: {} };
const inbox = [];
let dirty = true;
let stamp = 0; // bumped on each applied change, so open details re-render
const CLUSTER_INFO = { context: '', user: '' };

function storeOf(kind) {
  if (kind === 'namespace') return S.ns;
  if (kind === 'pod') return S.pod;
  if (kind === 'crd') return S.crd;
  if (String(kind).startsWith('cr:')) return S.cr;
  return null;
}
function apply(m) {
  if (m.op === 'snapshot') {
    for (const st of [S.ns, S.pod, S.crd, S.cr]) st.clear();
    S.notes = { ...(m.notes || {}) };
    for (const it of m.items || []) storeOf(it.kind)?.set(it.key, it.obj);
  } else if (m.op === 'put') storeOf(m.kind)?.set(m.key, m.obj);
  else if (m.op === 'del') { for (const st of [S.ns, S.pod, S.crd, S.cr]) st.delete(m.key); }
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
const apiGroupOf = (o) => String(o?.apiVersion || '').split('/').slice(0, -1).join('/') || 'core';

// ------------------------------------------------------------------------------ the scene's nodes

// What can be picked: the API, the namespaces' rooms, pods and custom resources. Nodes persist
// across changes and ease to where the layout puts them; a gone one fades out.
const nodes = new Map();
const view = { target: [0, 0, 0], goal: null, yaw: -0.25, pitch: 0.7, dist: 60, sel: null, ctr: null, hover: null, hoverCtr: null, filter: '', only: null, shift: 0, touched: false };
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

// What a Ctrl-drag moves (the layout, theatre.js): a namespace's room, with all in it.
function groupOfNode(n) {
  if (!n) return null;
  if (n.kind === 'pod' || n.kind === 'cr') return `ns/${n.ns}`;
  if (n.kind === 'ns') return n.key;
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
  names.delete('');
  const byNs = new Map([...names].map((n) => [n, { pods: [], crs: new Map() }]));
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
    const d = NS_PAD + podD + (podD && crD ? NS_GAP : 0) + crD + NS_PAD + NS_FOOT;
    rooms.push({ ns, pods: b.pods, cols, shelves, perRow, podD, w: innerW + 2 * NS_PAD, d, x0: 0, z0: 0, crZ: 0 });
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
  const ex = ((used.x1 - used.x0) * (PLATE_SPARE - 1)) / 2, ez = ((used.z1 - used.z0) * (PLATE_SPARE - 1)) / 2;
  Object.assign(PLATE, { x0: used.x0 - ex, x1: used.x1 + ex, z0: used.z0 - ez, z1: used.z1 + ez });
  const pts = [], edges = [], y = FLOOR_Y - 0.02;
  for (let x = Math.ceil(PLATE.x0 / 5) * 5; x <= PLATE.x1; x += 5) { const o = pts.length; pts.push([x, y, PLATE.z0], [x, y, PLATE.z1]); edges.push([o, o + 1]); }
  for (let z = Math.ceil(PLATE.z0 / 5) * 5; z <= PLATE.z1; z += 5) { const o = pts.length; pts.push([PLATE.x0, y, z], [PLATE.x1, y, z]); edges.push([o, o + 1]); }
  PLATE.grid = { pts, edges };
  const api = node('api', 'api');
  api.goal = [(used.x0 + used.x1) / 2, 0.3, used.z0 + 3.6];
  seen.add('api');
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
  return true;
}
// Whether a room holds anything that matches (a filter set, or a state picked).
function roomMatches(n) {
  if (!view.filter && !view.only) return true;
  if (!view.only && matches(n)) return true;
  for (const m of nodes.values()) if ((m.kind === 'pod' || m.kind === 'cr') && m.ns === n.ns && !m.gone && matches(m)) return true;
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
      setLabel(n.label, n.ns, [plural(r.pods.length, 'pod'), crs ? plural(crs, 'resource') : '', n.obj ? '' : 'not listed'].filter(Boolean).join(' · '), ph === 'Terminating' ? 'kns terminating' : 'kns');
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
      placeLabel(n.label, n.pos && add(podAt(n), open ? [0, 0.85 * podScale(n) + 0.5, 0] : [0.5 * podScale(n), 0.4 * podScale(n), 0]), show, n.alpha, open, view.sel === n.key && !view.ctr);
    } else if (n.kind === 'cr') {
      const show = visible(n) && matches(n) && (view.sel === n.key || view.hover === n.key || (nearSet.has(n.key) && view.dist < 30) || fewMatches.has(n.key));
      if (!n.label && !show) continue;
      if (!n.label) n.label = label(n.key, 'cr');
      const st = crState(n.obj);
      setLabel(n.label, nameOf(n.obj), closeNs.has(n.ns) ? '' : kindOf(n.obj), `cr ${st}`);
      placeLabel(n.label, n.pos && add(n.pos, [0.3, 0.3, 0]), show, n.alpha, false, view.sel === n.key);
    }
  }
  // The open pod's containers.
  if (sel?.kind === 'pod' && sel.open > 0.5 && sel.pos) {
    for (const { c, at: p, size } of ctrPlaces(sel)) {
      const l = extraLabel(`ctr/${sel.key}/${c.name}`, 'ctr', () => select(sel.key, c.name));
      const st = ctrState(c);
      setLabel(l, `${c.init ? 'init · ' : ''}${c.name}`, shortImage(c.spec.image), `ctr ${c.init ? 'init' : st}`);
      placeLabel(l, add(p, [size * 0.6, size * 0.5, 0]), true, sel.open, false, view.ctr === c.name);
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
    if (n.kind === 'pod') {
      const want = view.sel === key && !n.gone ? 1 : 0;
      if (Math.abs(want - n.open) < 0.005) n.open = want;
      else { n.open += (want - n.open) * (REDUCED ? 1 : 1 - Math.exp(-dt * 5)); moving = true; }
    }
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
  THEATRE.focus = fn?.pos && !fn.gone && fn.kind !== 'ns' ? (fn.kind === 'pod' ? podAt(fn) : fn.pos) : null;
  THEATRE.focusR = fn?.kind === 'pod' ? 1.9 * podScale(fn) : 1.4;
  ctx.clearRect(0, 0, W, H);
  drawScene();
  updateLabels();
  if (stamp !== shownStamp && view.sel && clock - shownAt > 0.5) renderDetails();
  return moving || inbox.length > 0 || dirty || !!(stamp !== shownStamp && view.sel);
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
          const cs = ctrState(c), picked = view.ctr === c.name, hov = view.hoverCtr === c.name;
          draw(SHAPES.ctr, cp, CTR_COLOR[cs], n.open * (c.init ? 0.55 : picked || hov ? 1 : 0.85),
            { scale: size * (picked ? 1.15 : 1), ry: f, width: picked || hov ? 1.8 : 1.2, glow: picked || hov, dash: c.init || cs === 'waiting' ? [2, 3] : null });
        }
      }
    } else batched(n.ns, POD_COLOR[st], a, SHAPES.podCage, n.pos, { scale: POD_SCALE, dash });
  }
  flushBatches();

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
  $('cap-detail').textContent = `${plural(nNs, 'namespace')} · ${plural(S.pod.size, 'pod')}, ${plural(ctrs, 'container')} · ${plural(S.cr.size, 'custom resource')} of ${plural(kindsWith, 'kind')} (${S.crd.size} discovered)`;
  // What could not be read: the cluster-wide kinds by name, the custom ones counted.
  const notes = [];
  for (const k of ['cluster', 'namespace', 'pod']) if (S.notes[k]) notes.push(`${k === 'cluster' ? 'cluster' : k === 'pod' ? 'Pods' : 'Namespaces'}: ${S.notes[k]}`);
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

const PANELS = {
  api: () => {
    const refused = Object.entries(S.notes).filter(([k]) => k.startsWith('cr:'));
    const kinds = [...S.crd.values()].sort((a, b) => `${a.group}/${a.kind}`.localeCompare(`${b.group}/${b.kind}`));
    const count = new Map();
    for (const o of S.cr.values()) count.set(kindOf(o) + '|' + apiGroupOf(o), (count.get(kindOf(o) + '|' + apiGroupOf(o)) || 0) + 1);
    const out = [kicker('Kubernetes API'), el('h2', null, CLUSTER_INFO.context || 'The cluster'),
      el('p', 'lede', 'Everything here was listed and watched with your own credentials, across all namespaces. What your RBAC does not allow is named, not shown.'),
      dl([['as', CLUSTER_INFO.user], ['namespaces', [...nodes.values()].filter((n) => n.kind === 'ns' && !n.gone).length], ['pods', S.pod.size],
        ['custom kinds', `${S.crd.size} discovered, ${new Set([...S.cr.values()].map(kindOf)).size} with objects`], ['custom resources', S.cr.size],
        ['discovery', S.notes.cluster || 'ok'], ['Namespaces', S.notes.namespace || 'readable'], ['Pods', S.notes.pod || 'readable']])];
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
    const picked = view.ctr && all.find((c) => c.name === view.ctr);
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

function select(key, ctr = null) {
  const was = view.sel;
  view.sel = key && nodes.has(key) ? key : null;
  view.ctr = view.sel && ctr ? ctr : null;
  if (view.sel) view.touched = true;
  const n = view.sel && nodes.get(view.sel);
  if (n && was !== view.sel) {
    // Framed: a room whole, a pod risen with its containers, the API with the plate.
    if (n.kind === 'ns') { view.goal = [n.info.x0 + n.info.w / 2, 0, n.info.z0 + n.info.d / 2]; view.dist = clamp(Math.max(n.info.w, n.info.d) * 1.5, 14, 90); }
    else if (n.kind === 'pod') { view.goal = add(n.goal, [0, OPEN_LIFT * 0.85, 0]); view.dist = 16; }
    else if (n.kind === 'cr') { view.goal = n.goal.slice(); view.dist = 10; }
    else if (n.kind === 'api') { view.goal = fit.center; view.dist = fit.dist; }
  }
  $('details').scrollTop = 0;
  renderDetails();
  wake(400);
}

// What is under (x, y): an open pod's container first, then the nearest pod, resource or the
// API on screen, then the room whose floor is there.
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
  // Within 24 px of its middle; an open pod, being larger, within 60.
  let best = null;
  for (const n of nodes.values()) {
    if (n.gone || !n.pos || n.kind === 'ns') continue;
    if ((n.kind === 'pod' || n.kind === 'cr') && !matches(n)) continue;
    const c = toCam(n.kind === 'pod' ? podAt(n) : n.pos);
    if (c[2] <= NEAR) continue;
    const [px, py] = proj(c), d = Math.hypot(px - x, py - y);
    if (d < (n.kind === 'pod' && n.open > 0.5 ? 60 : 24) && (!best || d < best.d)) best = { key: n.key, d };
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
      view.hoverCtr = p?.ctr || null;
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
    // Esc steps out: from a container to its pod, from the pod to the whole cluster.
    if (e.key === 'Escape') {
      if (view.ctr) select(view.sel, null);
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
