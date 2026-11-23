// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

// Recess in wire: the same run as the classic page (the same /api), drawn as a journey.
// The request is written on a sheet (the issuer, then the workload, login first as the CLI),
// crumpled into an envelope with a lock, carried to the broker and the Kubernetes API, sealed,
// carried to the sandbox VM, unwrapped into the jail, and its exit code shown at the end.
//
// No 3D library: a small wireframe renderer on a 2D canvas (perspective, near-plane clipping,
// depth fog, a glow pass), so the lines stay crisp and the page loads nothing from elsewhere.
// The director derives the act from the run's state, never from one-shot events, so a page
// that attaches to a run already under way replays to where it is, quickly.

'use strict';

// The renderer, the shapes and the infrastructure stations are the base theatre (theatre.js),
// shared with the Admin view; this file adds the run's journey to it.

// Seven-segment digits as lines: the exit code, drawn at the end of the journey.
const SEGS = { a: [[0, 2], [1, 2]], b: [[1, 2], [1, 1]], c: [[1, 1], [1, 0]], d: [[0, 0], [1, 0]], e: [[0, 1], [0, 0]], f: [[0, 2], [0, 1]], g: [[0, 1], [1, 1]] };
const DIGITS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g' };
function digits(text, w = 0.9, h = 0.9, gap = 0.5) {
  const pts = [], edges = [];
  const chars = [...text].filter((ch) => DIGITS[ch]);
  const total = chars.length * w + (chars.length - 1) * gap;
  chars.forEach((ch, i) => {
    const x0 = -total / 2 + i * (w + gap);
    for (const sg of DIGITS[ch]) {
      const [[ax, ay], [bx, by]] = SEGS[sg];
      const o = pts.length;
      pts.push([x0 + ax * w, (ay - 1) * h, 0], [x0 + bx * w, (by - 1) * h, 0]);
      edges.push([o, o + 1]);
    }
  });
  return { pts, edges };
}

// ------------------------------------------------------------------------------ the world

// The run's own places, beside the base theatre's stations.
Object.assign(ST, {
  you: [0, 0, 0],
  vm: [35, 0, -6],
  // North of the VM, at right angles to the road in: clear of the gateways and the audiences east of it.
  end: [36, 0.6, -21],
});
// Sheet 02, mediatore sandbox create: its own place after the login, on the way to the broker.
ST.form = [7.5, 0, -2];
ST.cage = ST.vm;

// The legs, in journey order; p is how much of each is travelled (drawn solid).
const LEGS = {
  login: { a: ST.you, b: ST.issuer, h: 3, color: C.ident, p: 0 },
  form: { a: ST.you, b: ST.form, h: 1.4, color: C.ident, p: 0 },
  broker: { a: ST.form, b: ST.broker, h: 3, color: C.wire, p: 0 },
  api: { a: ST.broker, b: ST.api, h: 3, color: C.wire, p: 0 },
  vm: { a: ST.api, b: ST.vm, h: 3.5, color: C.wire, p: 0 },
  end: { a: ST.vm, b: ST.end, h: 4, color: C.wire, p: 0 },
};
const legAt = (leg, t) => arc(leg.a, leg.b, leg.h, clamp(t));

Object.assign(SHAPES, {
  floor: (() => {
    const pts = [], edges = [], y = -3.2;
    for (let x = -28; x <= 60; x += 4) { const o = pts.length; pts.push([x, y, -40], [x, y, 14]); edges.push([o, o + 1]); }
    for (let z = -40; z <= 14; z += 4) { const o = pts.length; pts.push([-28, y, z], [60, y, z]); edges.push([o, o + 1]); }
    return { pts, edges };
  })(),
  vm: box(4.4, 2.8, 2.8),
  vmRack: merge(...[-0.9, -0.45, 0, 0.45, 0.9].map((y) => ({ pts: [[-2.2, y, 1.4], [-1.4, y, 1.4]], edges: [[0, 1]] }))),
  cage: (() => {
    const b = box(1.7, 1.7, 1.7);
    const bars = [];
    for (const x of [-0.42, 0, 0.42]) for (const z of [-0.85, 0.85]) bars.push({ pts: [[x, -0.85, z], [x, 0.85, z]], edges: [[0, 1]] });
    for (const z of [-0.42, 0, 0.42]) for (const x of [-0.85, 0.85]) bars.push({ pts: [[x, -0.85, z], [x, 0.85, z]], edges: [[0, 1]] });
    return merge(b, ...bars);
  })(),
  endRing: ring(2.6, 64, 'xy'),
  guest: merge(box(0.7, 0.42, 0.42), moved(box(0.4, 0.2, 0.44), [0, 0.02, 0])),
  proxy: merge(octa(0.32), ring(0.42, 20)),
  // Where the request started, once the sheet is gone: a laptop.
  laptop: (() => {
    const base = box(1.8, 0.06, 1.2);
    const screen = { pts: [[-0.9, 0, -0.6], [0.9, 0, -0.6], [0.95, 1.15, -0.85], [-0.95, 1.15, -0.85]], edges: chain(4, true) };
    const inner = { pts: [[-0.78, 0.1, -0.63], [0.78, 0.1, -0.63], [0.82, 1.05, -0.83], [-0.82, 1.05, -0.83]], edges: chain(4, true) };
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push({ pts: [[-0.7, 0.04, -0.35 + i * 0.16], [0.7, 0.04, -0.35 + i * 0.16]], edges: [[0, 1]] });
    return moved(merge(moved(base, [0, 0, 0]), screen, inner, ...keys), [0, -0.7, 0]);
  })(),
  spark: octa(0.3),
});

// The parts that come and go with the run's data: one node per gateway, per audience the
// workload named, per Secret in the vault; and the two pieces of the guest the jail touches.
const MAX_GW = 5, MAX_AUD = 6, MAX_BOX = 12;
const gwList = () => model.data.seal.gateways || [];
const gwCount = () => Math.min(MAX_GW, Math.max(gwList().length, 3));
// Stacked upward and a little in depth, so from the run's camera each one (and its label) has its own place.
const gwPos = (i) => { const m = i - (gwCount() - 1) / 2; return add(ST.vm, [4.8, 2.4 - m * 1.8, m * 0.9]); };
const audList = () => (model.data.create.workload?.audiences || []).slice(0, MAX_AUD);
const audPos = (i) => add(ST.vm, [8.2, 4.6, 3.2 + (i - (audList().length - 1) / 2) * 2.8]);
const PROXY = add(ST.vm, [1.45, -0.8, 0.9]);
const GUEST = add(ST.vm, [-1.45, -0.8, 0.9]);
// Which gateway carried this claim's tunnels, when the run's data says (mediatore does not
// report it today; the demo's scripted world does). -1 when nothing says.
function viaOf() { return model.data.seal.via ?? model.data.run.via ?? null; }
// The claim's tunnels as the broker's log shows them: each gateway check of the claim.
const egressOf = () => model.data.run.egress || {};
const tierPos = () => mix(gwPos(0), gwPos(gwCount() - 1), 0.5);
// The SandboxPolicy the claim names (spec.policyRef; mediatore has no default policy), and
// what the AgentSandbox says of it: the bundle the record was written under, the reconciler's
// PolicyConformant condition, and a refusal to resolve it.
function policyOf() {
  const w = model.data.create.workload || {}, obj = model.data.run.object || {}, st = obj.status || {}, rec = st.record || {};
  const cond = (st.conditions || []).find((c) => c.type === 'PolicyConformant') || null;
  return {
    name: obj.spec?.policyRef?.name || w.policy || '',
    seenName: !!obj.spec?.policyRef?.name,
    uid: rec.policyUid || '', version: rec.bundleVersion || '', cond,
    refused: /^policy_not_resolved/.test(st.reason || '') ? st.reason : '',
  };
}
// The broker's refusal of the claim, when that is how the run ended.
const claimRefusal = () => brokerError(model.finished?.note || '');

// SPIRE, as Recess sees it: the claim's ClusterStaticEntries (mediatore ADR-0006), and the
// node agent the record names. OpenBao is not reachable from here: what shows it worked is
// the sealed envelopes in the vault.
const spireOf = () => model.data.seal.spire || {};
const entries = () => spireOf().entries || [];
const entriesSet = () => entries().some((e) => e.set);
// Whether this run's entries were ever on the server: the data can run ahead of the scene (the
// release deletes them before the scene has shown the run), and the scene tells it in order.
let entriesWereSet = false;
const entriesShown = () => { if (entriesSet()) entriesWereSet = true; return entriesWereSet; };
const attested = () => !!(model.data.run.object?.status?.record?.nodeId || vmOf().attestationSubject);
// The guest holds this claim's identities from its attestation until the release.
const svidLive = () => (attested() || entriesShown()) && D.act >= 7 && D.act < 9;
const sealedCount = () => (model.data.seal.kubeSecrets || []).length;
// Where the claim is authorized, in the order it meets each place, and what each has decided
// as far as Recess can see: 'ok', 'bad', 'gaps' (shadow mode: allowed, but enforce would not),
// or 'pending'.
function authzPoints() {
  const claim = model.data.create.claim || {}, obj = model.data.run.object || {}, pol = policyOf(), r = claimRefusal();
  const eg = egressOf(), live = D.act >= 7;
  const broker = r ? 'bad' : claim.name || obj.metadata?.uid ? 'ok' : 'pending';
  const api = broker === 'bad' ? 'pending' : pol.refused ? 'bad' : pol.cond?.status === 'False' ? 'gaps' : obj.metadata?.uid ? 'ok' : 'pending';
  const gw = (eg.checks || 0) > 0 ? 'ok' : 'pending';
  return [
    { id: 'authz-broker', name: 'Claim admission', at: add(ST.broker, [0, 2.9, 0]), state: broker, show: () => true },
    { id: 'authz-api', name: 'Admission and reconcile', at: add(ST.api, [0, 2.4, 0]), state: api, show: () => true },
    { id: 'authz-gw', name: 'Gateway authorizer', at: add(tierPos(), [0, -((gwCount() - 1) * 0.9 + 1.9), 0]), state: gw, show: () => live },
  ];
}
const authzById = (id) => authzPoints().find((a) => a.id === id);
// Every check on the claim's way, from mediatore's code and ADRs: where it runs, what it
// compares, and how a refusal shows. `codes` match the broker's error, so a refusal marks
// the check that made it.
const AUTHZ_CHECKS = [
  { at: 'authz-broker', what: 'Your ID token, and the issuer\'s groups the broker requires', how: '403 forbidden', codes: ['forbidden', 'unauthorized'] },
  { at: 'authz-broker', what: 'The namespace: your groups against sandboxes.namespaces (ADR-0046)', how: '403; the broker logs "namespace decision"', codes: ['namespace_required', 'namespace_forbidden'] },
  { at: 'authz-broker', what: 'Each audience is usable in the namespace (ADR-0053)', how: '400 unknown_audience', codes: ['unknown_audience'] },
  { at: 'authz-broker', what: 'The policy grants each audience and the ttl fits its lease (policy.audiences: enforce)', how: '400 policy_required, unknown_policy, ttl_exceeds_policy; 503 policy_not_synced', codes: ['policy_required', 'unknown_policy', 'ttl_exceeds_policy', 'policy_not_synced'] },
  { at: 'authz-broker', what: 'The image is from a registry the pool reaches', how: '400 unreachable_registry', codes: ['unreachable_registry'] },
  { at: 'authz-broker', what: 'The policy named resolves in the namespace\'s policy sources (ADR-0054, policy.egress: enforce; shadow only logs)', how: '400 policy_not_resolved', codes: ['policy_not_resolved'] },
  { at: 'authz-api', what: 'Kubernetes admission (CEL): spec.subject.id is the caller, the spec is immutable, only the broker writes status', how: 'the API server refuses the write', codes: [] },
  { at: 'authz-api', what: 'The reconciler (in the broker): a verified bundle for the policy, and the sandbox against it', how: 'status.reason policy_not_resolved; the PolicyConformant condition (shadow: gaps P001 to P012)', codes: [] },
  { at: 'authz-gw', what: 'Each tunnel: the host against the claim\'s allowlist (its audiences\' endpoints, and the bundle\'s direct egress under ADR-0030 enforce)', how: 'the tunnel is refused; the gateway logs "tunnel" with verdict deny', codes: [] },
  { at: 'authz-gw', what: 'Each credential the proxy asks to place: the policy admits the audience', how: 'the inject is refused; the broker logs "gateway credential refused"', codes: [], unseen: true },
  { at: 'authz-broker', what: 'The guest\'s token requests, for as long as the claim lives', how: '403 claim revoked or expired', codes: [], unseen: true },
];
const AUTHZ_COLOR = { ok: 'ok', bad: 'bad', gaps: 'seal', pending: 'dim' };
// Where this claim's traffic left by, once any is seen: the carrier, else the tier. Null before.
const egressTo = () => ((egressOf().checks || 0) > 0 ? (carrierIdx() >= 0 ? gwPos(carrierIdx()) : tierPos()) : null);
function carrierIdx() {
  const v = viaOf();
  const name = typeof v === 'string' ? v : v?.gateway;
  return name ? gwList().findIndex((g) => g.name === name) : -1;
}

// The vault: double-click opens its door on a wall of safety deposit boxes, one per Secret.
const vault = { open: 0, want: 0 };
const boxes = () => (model.data.seal.kubeSecrets || []).slice(0, MAX_BOX);
// The boxes as this run has known them: the ones there now, and the ones removed since (the
// release deletes the session and the delegations), each kept with what was last seen of it.
function boxLedger() {
  const now = model.data.seal.kubeSecrets || [];
  const names = new Set(now.map((k) => k.name));
  for (const k of now) {
    const seen = model.boxSeen.find((x) => x.k.name === k.name);
    if (seen) { seen.k = k; seen.gone = null; } else model.boxSeen.push({ k, gone: null });
  }
  for (const x of model.boxSeen) if (!names.has(x.k.name) && !x.gone) x.gone = new Date();
  return model.boxSeen;
}
// A Secret's short name: what it holds, from its labels, unique within the run (the uids are
// the same for every box of a claim). The full name is in its details.
function boxShort(k) {
  if (!k) return '';
  const lb = k.labels || {};
  if (lb['mediatore.io/logs']) return `output ${Number((k.name.match(/-(\d+)$/) || [])[1] || 0) || ''}`.trim();
  if (lb['mediatore.io/audience']) return `delegation · ${lb['mediatore.io/audience']}`;
  if (lb['mediatore.io/session']) return 'session';
  return k.name.replace(/^mediatore-/, '').replace(/-?([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16})/g, '') || k.name;
}
const vaultScale = () => 1 + 1.6 * ease(vault.open);
const vaultRy = () => -0.5 * (1 - ease(vault.open));
const vaultAt = (p) => add(rotY(mul(p, vaultScale()), vaultRy()), ST.vault);
function boxGrid(i) {
  const n = Math.max(1, boxes().length), cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const cw = 1.3 / cols, rh = 1.3 / rows;
  const c = i % cols, r = Math.floor(i / cols);
  return { x: -0.65 + cw * (c + 0.5), y: 0.65 - rh * (r + 0.5), w: cw * 0.84, h: rh * 0.62 };
}
// A box slides out when it is picked, a little when hovered.
const boxSlide = (i) => {
  const id = `box${i}`;
  return view.sel?.id === id ? 0.55 : view.hover?.id === id ? 0.18 : 0;
};
const boxAt = (i) => { const g = boxGrid(i); return vaultAt([g.x, g.y, -0.3 + boxSlide(i) + 0.1]); };


// ------------------------------------------------------------------------------ labels

const labelLayer = $('labels');
const LABELS = [];
function label(at, cls = '', node = null) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}${node ? '' : ' nopick'}`;
  const b = document.createElement('b'), i = document.createElement('i');
  el.append(b, i);
  labelLayer.append(el);
  // A label is the easiest thing to hit: clicking it selects its node.
  if (node) el.addEventListener('click', () => select('node', node));
  const l = { el, b, i, at, node, show: () => true, lit: () => false };
  LABELS.push(l);
  return l;
}
function setLabel(l, title, detail) {
  if (l.b.textContent !== title) l.b.textContent = title;
  const d = detail || '';
  if (l.i.textContent !== d) l.i.textContent = d;
}
function placeLabels() {
  for (const l of LABELS) {
    const at = typeof l.at === 'function' ? l.at() : l.at;
    const c = toCam(at);
    const show = l.show() && c[2] > NEAR;
    if (!show) { l.el.style.opacity = '0'; continue; }
    const [x, y] = proj(c);
    // Not under the bar or the caption, and not for a station off screen.
    if (y < 52 || y > H - 84 || x < -10 || x > W - 30) { l.el.style.opacity = '0'; l.el.style.pointerEvents = 'none'; continue; }
    l.el.style.opacity = String(clamp(fog(c[2]) * 1.2, 0.25, 1));
    // Kept on screen: a station near the edge keeps its label readable.
    const lx = clamp(x + 14, 8, Math.max(8, W - l.el.offsetWidth - 8));
    l.el.style.transform = `translate(${Math.round(lx)}px, ${Math.round(y - 10)}px)`;
    l.el.classList.toggle('lit', l.lit());
    l.el.classList.toggle('sel', !!l.node && view.sel?.kind === 'node' && view.sel.id === l.node);
    l.el.style.pointerEvents = D.act >= 3 ? '' : 'none';
  }
}

// ------------------------------------------------------------------------------ the run's model

const STEPS = [['mint', 'login'], ['create', 'create'], ['seal', 'seal'], ['run', 'run'], ['logs', 'output'], ['exit', 'exit']];
let cfg = { login: {}, claim: {} };
let demo = false;
let runId = null;
let es = null;
let model = freshModel();

function freshModel() {
  entriesWereSet = false;
  return {
    steps: Object.fromEntries(STEPS.map(([k]) => [k, 'pending'])),
    notes: {},
    data: { mint: {}, create: {}, seal: {}, run: {}, logs: {}, exit: {} },
    phases: {},
    phaseList: [],
    lines: [],
    // Every safety deposit box this run has shown, and when each one went (null while it is there).
    boxSeen: [],
    events: [],
    finished: null,
    sent: false,
  };
}

function handle(e) {
  const s = e.step;
  if (e.kind === 'state') {
    model.steps[s] = e.state;
    if (e.note) model.notes[s] = e.note;
  } else if (e.kind === 'line') {
    if (s === 'logs' && (e.stream === 'stdout' || e.stream === 'stderr')) outputLine(e);
    else model.notes[s] = e.text;
  } else if (e.kind === 'data') {
    const d = e.data || {};
    Object.assign(model.data[s] || (model.data[s] = {}), d);
    if (s === 'run' && Array.isArray(d.phases)) {
      model.phaseList = d.phases;
      for (const p of d.phases) model.phases[p.key] = p.state;
    }
    if (s === 'mint' && 'authorizeUrl' in d) model.authorizeUrl = d.authorizeUrl;
    if (s === 'run' && d.event) { model.events.unshift(d.event); model.events.length = Math.min(model.events.length, 40); }
    if (s === 'run' && d.egress && typeof d.egress.checks === 'number') {
      const before = model.egressSeen || 0;
      model.egressSeen = d.egress.checks;
      tunnelPulses(Math.min(4, d.egress.checks - before));
    }
  } else if (e.kind === 'finished') {
    model.finished = { ok: !!e.ok, note: e.note || '' };
  }
  paintBar();
}

// ------------------------------------------------------------------------------ the scene's state

// The two sheets: 01 (login) where you start, 02 (sandbox create) where the request is written.
// Each follows the form laid over it while that form is on screen.
function mkPaper(home, formId, W, H) {
  return { home, formId, c: home.slice(), W, H, t: 0, morph: 0, stamp: 0, scribbles: [], stampUV: [0.86, 0.06], visible: true, written: false };
}
const PAPERS = { login: mkPaper(ST.you, 'sheet-login', 4.4, 4.6), create: mkPaper(ST.form, 'sheet-create', 6, 6.6) };
// The camera square to each sheet while it is being written.
const POSE = { login: { pos: [0, 0, 9], target: [0, 0, 0] }, create: { pos: add(ST.form, [0, 0, 9]), target: ST.form } };
// flip: 0 the face (the address), 1 the back (the flap and the seal); seal: the wax seal pressed.
const env = { pos: [0, 0, 0], scale: 0, lock: 0, open: 0, sink: 0, flip: 1, seal: 1, color: C.wire, leg: null };
// youCard: sheet 01 turned into your card on its rolodex, from 0 to 1, once you are signed in.
const fx = { packets: [], bursts: [], floats: [], exitShape: null, exitScale: 0, exitColor: C.ok, cageLit: 0, spark: 0, sealLit: 0, failed: false, youCard: 0, floatQueue: [], floatGap: 0 };
const D = { act: 0, busy: false, speed: 1, gen: 0, sheet: 'login' };
const orbit = { yaw: 0, pitch: 0, zoom: 1 };
let clock = 0;

// Tweens driven by the frame loop; each returns a promise. A run reset bumps D.gen, which
// abandons whatever an earlier run's act was still animating.
const tweens = [];
function tween(dur, fn) {
  const gen = D.gen;
  const d = Math.max(0.001, (dur / D.speed) * (REDUCED ? 0.15 : 1));
  return new Promise((res) => tweens.push({ t: 0, d, fn, res, gen }));
}
const wait = (s) => tween(s, () => {});
function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.gen !== D.gen) { tweens.splice(i, 1); continue; }
    tw.t = Math.min(1, tw.t + dt / tw.d);
    tw.fn(tw.t);
    if (tw.t >= 1) { tweens.splice(i, 1); tw.res(); }
  }
}

function packet(leg, { back = false, color, dur = 1.1, size = 1 } = {}) {
  const p = { leg, back, color: color || leg.color, t: 0, size, done: null };
  const gen = D.gen;
  fx.packets.push(p);
  return tween(dur, (k) => { p.t = ease(k); }).then(() => {
    if (gen !== D.gen) return;
    fx.packets.splice(fx.packets.indexOf(p), 1);
  });
}
// New gateway checks of the claim: a packet from the proxy into the gateway that carried it,
// when that is known, else into the tier (a gateway did; which one is not reported).
function tunnelPulses(n) {
  if (n <= 0 || D.act < 7) return;
  const i = carrierIdx();
  const to = i >= 0 ? gwPos(i) : tierPos();
  for (let k = 0; k < n; k++) {
    wait(k * 0.35).then(() => packet({ a: PROXY, b: to, h: 0.8, color: C.carrier, p: 1 }, { dur: 0.9, size: 0.9 }));
  }
  fx.tierPulse = 1;
}

function burst(at, color, r = 2.2, dur = 0.9) { fx.bursts.push({ at, color, r, t: 0, d: dur * (REDUCED ? 0.3 : 1) }); }

// ------------------------------------------------------------------------------ the director

// The act the run has reached, from its state alone.
function targetAct() {
  const s = model.steps, d = model.data, ph = model.phases;
  let a = 0;
  if (s.mint === 'active') a = 1;
  if (s.mint === 'done' || s.mint === 'skipped') a = 2;
  const sent = model.sent || d.create.waiting === false || !!d.create.claim || s.create === 'done';
  if (a >= 2 && sent) a = 4;
  if (a >= 4 && s.create === 'done') a = 5;
  if (a >= 5 && (s.seal === 'active' || s.seal === 'done')) a = 6;
  if (a >= 6 && (ph.build === 'done' || ph.jail === 'done' || (d.seal.memberVm && d.seal.memberVm.name))) a = 7;
  if (a >= 7 && (ph.jail === 'done' || ph.run === 'done' || s.logs === 'active' || s.logs === 'done' || model.lines.length)) a = 8;
  if (a >= 8 && (s.exit !== 'pending' || d.exit.code != null || d.exit.signal != null)) a = 9;
  if (a >= 9 && model.finished && model.finished.ok) a = 10;
  return a;
}

function direct() {
  if (model.finished && !model.finished.ok && !fx.failed && !D.busy) fail();
  if (!signing && !fx.failed && D.act >= 1 && D.act <= 2 && model.data.mint.identity) signedIn();
  if (D.busy || fx.failed) return;
  const t = targetAct();
  if (D.act >= t) return;
  // Hops play at full length even when the run is a step or two ahead; only a page that
  // attaches to a run far along hurries to catch up.
  D.speed = t - D.act > 3 ? 3.5 : 1;
  const next = D.act + 1;
  D.busy = true;
  D.act = next;
  const gen = D.gen;
  (ACTS[next] || (() => Promise.resolve()))().then(() => {
    if (gen === D.gen) D.busy = false;
  });
  paintCaption();
}

function fail() {
  fx.failed = true;
  env.color = C.bad;
  const sheet = PAPERS[D.sheet];
  const at = D.act >= 3 ? env.pos : add(sheet.c, [sheet.W * 0.36, sheet.H * 0.42, 0]);
  burst(at, C.bad, 2.6, 1.2);
  if (D.act < 3) {
    if (D.sheet === 'login') {
      setDisabled(LOGIN_FORM, false);
      $('login-note').textContent = '';
      $('login-error').textContent = model.finished.note || 'the run failed';
    } else {
      $('create-error').textContent = model.finished.note || 'the run failed';
    }
  }
  paintCaption();
}

// Signed in: the identity comes back, stamps sheet 01, and sheet 01 becomes your card on its
// rolodex. Started the moment the token's identity arrives, before the login step is marked
// done, and awaited by act 2 before it moves on to sheet 02.
let signing = null;
function signedIn() {
  if (signing) return signing;
  const L = PAPERS.login;
  signing = (async () => {
    packet(LEGS.login, { back: true, color: C.ident, dur: 0.6 });
    stampSheet();
    burst(add(L.c, [L.W * (L.stampUV[0] - 0.5), L.H * (0.5 - L.stampUV[1]), 0]), C.ident, 1.2, 0.8);
    await tween(0.3, (k) => { L.stamp = easeOut(k); });
    captureScribbles(L);
    L.written = true;
    LOGIN_FORM.classList.add('gone');
    await tween(0.45, (k) => { fx.youCard = ease(k); });
    burst(CARDS.you.c, C.ident, 1.4, 0.6);
  })();
  return signing;
}

const ACTS = {
  // 1. mediatore login: the request leaves for the issuer and comes back, until it is done.
  1: async () => {},
  // 2. Signed: the identity comes back and stamps the sheet; the workload opens.
  2: async () => {
    await signedIn();
    D.sheet = 'create';
    await hopAlong(LEGS.form, POSE.login, POSE.create, 2.4, { move: false, packetColor: C.ident });
    // Sheet 02 opens as the camera settles, not after it has come to a full stop.
    for (let i = 0; i < 6 && !camArrived(); i++) await wait(0.05);
    CREATE_FORM.classList.remove('gone');
    unlockCreate();
  },
  // 3. The sheet crumples into a ball, the ball folds into an envelope with an open lock.
  3: async () => {
    const P = PAPERS.create;
    captureScribbles(P);
    P.written = true;
    CREATE_FORM.classList.add('gone');
    LOGIN_FORM.classList.add('gone');
    D.sheet = 'create';
    LEGS.form.p = 1;
    await tween(1.2, (k) => { P.t = k; });
    burst(P.c, C.wire, 1.6, 0.7);
    // It folds into an envelope, face up: addressed to the broker, the flap still open.
    env.pos = P.c.slice();
    Object.assign(env, { flip: 0, open: 1, seal: 0 });
    await tween(0.6, (k) => { P.morph = ease(k); env.scale = easeOut(k); });
    P.visible = false;
    await wait(0.35);
    // Turned over, the flap shuts, and the seal is pressed on the back.
    await tween(0.8, (k) => { env.flip = ease(k); });
    await tween(0.5, (k) => { env.open = 1 - ease(k); });
    await tween(0.45, (k) => { env.seal = k; });
    burst(add(env.pos, [0, -0.1, 0.1]), C.seal, 1.1, 0.6);
    await wait(0.35);
  },
  // 4. To the broker: POST /v1/claims.
  4: async () => {
    env.leg = LEGS.broker;
    LEGS.broker.a = env.pos.slice();
    await hopAlong(LEGS.broker, POSE.create, restPose(4), 4.2);
    burst(ST.broker, C.wire, 2.6);
  },
  // 5. The broker writes the AgentSandbox into the Kubernetes API.
  5: async () => {
    env.leg = LEGS.api;
    await hopAlong(LEGS.api, restPose(4), restPose(5), 4);
    burst(ST.api, C.wire, 2.8);
  },
  // 6. Sealed: the credentials go into Secrets, sealed at rest; the lock closes.
  6: async () => {
    // The broker asks OpenBao's transit key to encrypt; the envelopes come back.
    const toBao = { a: ST.broker, b: ST.bao, h: 1.4, color: C.seal, p: 0 };
    await packet(toBao, { dur: 0.7 });
    burst(ST.bao, C.seal, 1.3, 0.6);
    await packet(toBao, { dur: 0.6, back: true });
    await tween(0.7, (k) => { env.lock = easeOut(k); });
    burst(env.pos, C.seal, 1.4, 0.7);
    const toVault = { a: ST.api, b: ST.vault, h: 1.2, color: C.seal, p: 0 };
    await Promise.all([0, 0.18, 0.36].map((delay) => wait(delay).then(() => packet(toVault, { dur: 0.8 }))));
    await tween(0.5, (k) => { fx.sealLit = k; });
    burst(ST.vault, C.seal, 1.6, 0.8);
  },
  // 7. To the sandbox VM the pool bound.
  7: async () => {
    env.leg = LEGS.vm;
    await hopAlong(LEGS.vm, restPose(6), restPose(7), 4.2);
    burst(ST.vm, C.wire, 3.2);
  },
  // 8. Unwrapped into the jail: the envelope opens and sinks into the cage; the work runs.
  8: async () => {
    await tween(0.8, (k) => { env.open = easeOut(k); });
    const from = env.pos.slice();
    await tween(0.9, (k) => { env.sink = ease(k); env.pos = mix(from, ST.cage, ease(k)); });
    await tween(0.6, (k) => { fx.cageLit = k; fx.spark = easeOut(k); });
    burst(ST.cage, C.wire, 1.8, 0.8);
    showTermAuto();
  },
  // 9. The exit code, carried to the end.
  9: async () => {
    const x = model.data.exit;
    const code = x.code != null ? String(x.code) : x.signal != null ? `-${x.signal}` : '-';
    fx.exitColor = x.code === 0 ? C.ok : C.bad;
    fx.exitShape = digits(code);
    LEGS.end.color = fx.exitColor;
    await hopAlong(LEGS.end, restPose(8), restPose(9), 4, { move: false, packetColor: fx.exitColor });
    LEGS.end.p = 1;
    burst(ST.end, fx.exitColor, 3.4, 1.1);
    await tween(0.7, (k) => { fx.exitScale = easeOut(k); fx.spark = 1 - k; });
  },
  // 10. Done: the claim was released.
  10: async () => {
    burst(ST.end, fx.exitColor, 4.5, 1.6);
  },
};

// ------------------------------------------------------------------------------ the paper

function crumpleDir(u, v) {
  const th = u * Math.PI * 2 + 0.7 * Math.sin(v * 9.1 + u * 3.7);
  const ph = 0.12 * Math.PI + v * 0.76 * Math.PI + 0.32 * Math.sin(u * 7.3 - v * 5.1);
  return [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
}
const bump = (u, v) => 0.72 + 0.34 * Math.sin(u * 13.7 + v * 5.3) * Math.sin(v * 11.1 - u * 3.3);

// A point of sheet p at (u, v), as crumpled as p.t says and folded away as p.morph.
function paperAt(p, u, v) {
  const c = p.c, t = p.t;
  const flat = [c[0] + (u - 0.5) * p.W, c[1] + (0.5 - v) * p.H, c[2]];
  let q = flat;
  if (t > 0) {
    const R = Math.min(p.W, p.H) * 0.22 * bump(u, v);
    let b = mul(crumpleDir(u, v), R);
    b = rotX(rotY(b, t * 2.4), t * 0.7);
    const k = ease(clamp(t));
    const j = Math.sin(Math.PI * clamp(t)) * Math.min(p.W, p.H) * 0.09;
    const n = [Math.sin(u * 31 + v * 17), Math.sin(v * 23 - u * 7), Math.cos(u * 19 + v * 29)];
    q = add(mix(flat, add(c, b), k), mul(n, j));
  }
  if (p.morph > 0) q = mix(q, c, p.morph);
  return q;
}

const GRID = { cols: 10, rows: 14 };
function drawPaper(p, alpha = 1) {
  if (!p.visible || alpha <= 0) return;
  const { cols, rows } = GRID;
  const at = (u, v) => paperAt(p, u, v);
  const pts = [];
  for (let r = 0; r <= rows; r++) for (let q = 0; q <= cols; q++) pts.push(at(q / cols, r / rows));
  const id = (q, r) => r * (cols + 1) + q;
  const outline = [], rules = [], verts = [];
  for (let r = 0; r <= rows; r++) for (let q = 0; q < cols; q++) (r === 0 || r === rows ? outline : rules).push([id(q, r), id(q + 1, r)]);
  for (let q = 0; q <= cols; q++) for (let r = 0; r < rows; r++) (q === 0 || q === cols ? outline : verts).push([id(q, r), id(q, r + 1)]);
  const t = p.t, fade = (1 - p.morph) * alpha;
  const col = fx.failed && D.act < 3 && PAPERS[D.sheet] === p ? C.bad : C.wire;
  lines(pts, outline, col, 0.95 * fade, 1.2);
  lines(pts, rules, C.wire, (0.14 + 0.7 * t) * fade, 1, { glow: t > 0.2 });
  lines(pts, verts, C.wire, 0.75 * t * fade, 1);
  // The margin rule, as on ruled paper.
  const mpts = [], mN = 14;
  for (let i = 0; i <= mN; i++) mpts.push(at(0.06, i / mN));
  polyline(mpts, C.bad, 0.35 * fade, 1, { glow: false });
  // What was written, once the inputs are gone, in wire.
  if (p.written) for (const sc of p.scribbles) polyline(sc.map(([u, v]) => at(u, v)), C.ink, 0.8 * fade, 1, { glow: false });
  // The issuer's stamp.
  if (p.stamp > 0) {
    const [su, sv] = p.stampUV, n = 28, rr = 0.06;
    const ring1 = [], ring2 = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring1.push(at(su + Math.cos(a) * rr * p.stamp * (p.H / p.W), sv + Math.sin(a) * rr * p.stamp));
      ring2.push(at(su + Math.cos(a) * rr * 0.7 * p.stamp * (p.H / p.W), sv + Math.sin(a) * rr * 0.7 * p.stamp));
    }
    polyline(ring1, C.ident, p.stamp * fade, 1.3);
    polyline(ring2, C.ident, 0.6 * p.stamp * fade, 1);
  }
}

// The camera is square to the sheet being written (the forms line up only then).
const camArrived = () => REDUCED || len(sub(camPos, POSE[D.sheet].pos)) < 0.03;

// A sheet's size and place follow the form laid over it, while it is on screen.
function fitPaper(p) {
  const r = $(p.formId).getBoundingClientRect();
  const pose = POSE[p === PAPERS.login ? 'login' : 'create'];
  const k = len(sub(pose.pos, pose.target)) / cam.F;
  p.W = r.width * k; p.H = r.height * k;
  p.c = add(pose.target, [(r.left + r.width / 2 - cam.cx) * k, -(r.top + r.height / 2 - cam.cy) * k, 0]);
  // The legs leave from the sheets' edges, not through the forms.
  const left = [p.c[0] - p.W / 2, p.c[1] + p.H * 0.22, p.c[2]], right = [p.c[0] + p.W / 2, p.c[1], p.c[2]];
  if (p === PAPERS.login) {
    LEGS.login.a = left;
    LEGS.form.a = right;
    const st = $('stamp').getBoundingClientRect();
    if (st.width) p.stampUV = [(st.left + st.width / 2 - r.left) / r.width, (st.top + st.height / 2 - r.top) / r.height];
  } else {
    LEGS.form.b = [p.c[0] - p.W / 2, p.c[1], p.c[2]];
    LEGS.broker.a = right;
  }
}

// Handwriting in wire: each word a zigzag where its letters were, in the sheet's (u, v).
function captureScribbles(p) {
  const form = $(p.formId);
  const r = form.getBoundingClientRect();
  const out = [];
  const write = (el, text) => {
    const b = el.getBoundingClientRect();
    if (!b.width || !text) return;
    const cw = 7.8, lh = 19;
    const perLine = Math.max(4, Math.floor((b.width - 6) / cw));
    const rowsOf = [];
    for (const para of text.split('\n')) for (let i = 0; i < para.length || i === 0; i += perLine) rowsOf.push(para.slice(i, i + perLine));
    rowsOf.slice(0, Math.max(1, Math.floor(b.height / lh) + 1)).forEach((row, ri) => {
      const v0 = (b.top + 6 + lh * 0.55 + ri * lh - r.top) / r.height;
      let cur = null;
      [...row].forEach((ch, ci) => {
        const u0 = (b.left + 3 + ci * cw - r.left) / r.width;
        if (ch === ' ') { cur = null; return; }
        if (!cur) { cur = []; out.push(cur); }
        const code = ch.charCodeAt(0);
        const up = 0.55 + ((code * 37) % 9) / 18, down = 0.15 + ((code * 11) % 5) / 14;
        const du = cw / r.width, dv = 9 / r.height;
        cur.push([u0, v0 + dv * down], [u0 + du * 0.45, v0 - dv * up], [u0 + du * 0.9, v0 + dv * down * 0.6]);
      });
    });
  };
  // Every field on show that holds something: what was written on this sheet.
  for (const f of form.querySelectorAll('input:not([type=checkbox]), textarea, select')) {
    if (!f.offsetParent) continue; // in a closed drawer
    write(f, f.tagName === 'SELECT' ? f.selectedOptions[0]?.textContent || '' : f.value);
  }
  p.scribbles = out;
}

// ------------------------------------------------------------------------------ envelope and lock

function drawEnvelope() {
  if (env.scale <= 0.001 || env.sink >= 0.999) return;
  const s = env.scale * 0.85 * (1 - env.sink * 0.6), a = 1 - env.sink;
  // A gentle sway, and the turn from the face (flip 0) to the back (flip 1).
  const ry = Math.sin(clock * 0.7) * 0.3 * (1 - env.sink) + Math.PI * (1 - env.flip);
  const toWorld = (p, k = s) => add(rotY(mul(p, k), ry), env.pos);
  const w = 1.6, h = 1.05;
  // How much of each side faces the camera.
  const back = clamp(Math.cos(Math.PI * (1 - env.flip)) * 1.4), face = clamp(-Math.cos(Math.PI * (1 - env.flip)) * 1.4);
  lines([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]].map((p) => toWorld(p)), chain(4, true), env.color, a, 1.3);

  // The face: the address and the stamp.
  if (face > 0.01) {
    const z = -0.01, segs = [];
    for (const [y, x0, x1] of [[-0.06, -0.45, 0.35], [-0.2, -0.45, 0.25], [-0.34, -0.45, 0.3]]) segs.push({ pts: [[x0, y, z], [x1, y, z]], edges: [[0, 1]] });
    segs.push({ pts: [[0.48, 0.38, z], [0.7, 0.38, z], [0.7, 0.12, z], [0.48, 0.12, z]], edges: chain(4, true) });
    segs.push({ pts: [[0.52, 0.34, z], [0.66, 0.34, z], [0.66, 0.16, z], [0.52, 0.16, z]], edges: chain(4, true) });
    segs.push({ pts: [[-0.7, 0.36, z], [-0.35, 0.36, z]], edges: [[0, 1]] });
    // Drawn on the side turned away at flip 1, so mirrored in x to read the right way round.
    for (const g of segs) lines(g.pts.map((p) => toWorld([-p[0], p[1], p[2]])), g.edges, env.color, a * face * 0.85, 1);
  }

  // The back: the flap (open, or shut over the pocket), the folds, and the seal on its tip.
  if (back > 0.01) {
    const apexY = h / 2 - h * 0.58 * Math.cos(env.open * Math.PI);
    const apexZ = Math.sin(env.open * Math.PI) * h * 0.35;
    const pts = [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0], [0, apexY, apexZ], [0, -0.02, 0.01]];
    lines(pts.map((p) => toWorld(p)), [[3, 4], [2, 4], [0, 5], [1, 5]], env.color, a * back, 1.3);
    if (env.seal > 0.001) {
      // Pressed: it drops in from in front of the flap, a little large, and settles.
      const k = env.seal, pop = 1 + (1 - easeOut(k)) * 0.7, dz = (1 - ease(k)) * 0.9;
      const at = [0, -0.1, 0.05 + dz];
      const sealC = fx.failed ? C.bad : C.seal;
      const wax = [];
      for (let i = 0; i < 18; i++) { const t = (i / 18) * Math.PI * 2, r = 0.27 * (1 + 0.06 * Math.sin(t * 5)); wax.push(add(at, [Math.cos(t) * r * pop, Math.sin(t) * r * pop, 0])); }
      lines(wax.map((p) => toWorld(p)), chain(18, true), sealC, a * back * k, 1.4);
      // The lock in the wax: its shackle drops shut when the credentials are sealed.
      const lift = 0.14 * (1 - env.lock);
      const body = box(0.42, 0.32, 0.08);
      const lb = body.pts.map((p) => add(mul(add(p, [0, -0.11, 0.01]), 0.62 * pop), at));
      const arcN = 12, sh = [];
      for (let i = 0; i <= arcN; i++) { const t = Math.PI * (i / arcN); sh.push([Math.cos(t) * 0.13, 0.04 + lift + Math.sin(t) * 0.13, 0.01]); }
      sh.unshift([0.13, 0.04 + (env.lock > 0.5 ? 0 : lift) - 0.04, 0.01]);
      sh.push([-0.13, 0.04 + lift - 0.04 * env.lock, 0.01]);
      const shw = sh.map((p) => add(mul(add(p, [0, -0.05, 0]), 0.62 * pop), at));
      const lc = env.lock > 0.5 ? C.seal : mixColor(C.wire, C.seal, env.lock * 2);
      lines(lb.map((p) => toWorld(p)), body.edges, fx.failed ? C.bad : lc, a * back * k, 1.1);
      lines(shw.map((p) => toWorld(p)), chain(shw.length), fx.failed ? C.bad : lc, a * back * k, 1.1);
    }
  }
}

// ------------------------------------------------------------------------------ stations

function drawStations() {
  const t = clock, act = D.act;
  const lit = (n) => (act >= n ? 1 : 0.32);
  lines(SHAPES.floor.pts, SHAPES.floor.edges, C.dim, 0.55, 1, { glow: false });

  // The vault opens and closes as asked.
  vault.open = clamp(vault.open + Math.sign(vault.want - vault.open) * Math.min(Math.abs(vault.want - vault.open), REDUCED ? 1 : 0.025));

  // You, once the sheet has left.
  if (!PAPERS.login.visible) draw(SHAPES.laptop, ST.you, C.wire, 0.75, { ry: -0.35 });

  // The base theatre's stations: the issuer, the broker, the Kubernetes API and the Secrets
  // vault beside it, lit as the run reaches them.
  drawIssuer(act >= 1 ? 1 : 0.45, t);
  drawBroker(lit(4), t);
  drawApi(lit(5), t);
  drawVault();

  // The sandbox VM, the jail in it, and the egress gateways.
  draw(SHAPES.vm, ST.vm, C.wire, lit(7) * 0.9);
  draw(SHAPES.vmRack, ST.vm, C.wire, lit(7) * 0.6, { glow: false });
  const cc = fx.failed && act >= 8 ? C.bad : C.wire;
  draw(SHAPES.cage, ST.cage, cc, 0.25 + 0.75 * fx.cageLit, { ry: t * 0.2 });
  // Inside the VM, the two pieces the jail touches: the guest agent, and the egress proxy on
  // 127.0.0.1:3128, the jail's only way out.
  const inner = lit(7) * 0.85;
  draw(SHAPES.guest, GUEST, C.wire, inner, { ry: t * 0.3 });
  draw(SHAPES.proxy, PROXY, C.wire, inner, { ry: -t * 0.9 });
  if (fx.cageLit > 0) lines([ST.cage, PROXY], [[0, 1]], C.wire, 0.7 * fx.cageLit, 1.2, { dash: [2, 4], dashOffset: -clock * 24 });

  // The egress gateways, one node each; the one carrying this claim's tunnels lit, when known.
  const gws = gwList().length, carrier = carrierIdx();
  if (gws || act >= 7) {
    for (let i = 0; i < gwCount(); i++) {
      const g = gwPos(i), on = i < gws, carried = i === carrier;
      const col = carried ? C.carrier : C.wire;
      const a = !on ? 0.2 : carrier < 0 ? 0.8 : carried ? 1 : 0.35;
      // Once the carrier is known the others stand back: thin and unlit.
      const unused = carrier >= 0 && !carried;
      draw(SHAPES.gateway, g, col, a, { ry: t * (carried ? 2.2 : 0.8) + i, scale: carried ? 1.35 : 1, width: carried ? 1.6 : 1, glow: !unused });
    }
    // One edge out, and only once there is traffic: to the gateway carrying the tunnels, or,
    // while which one is not reported, to the tier as a whole. No edges to mere candidates.
    const out = egressTo();
    if (out && fx.cageLit > 0) lines([PROXY, out], [[0, 1]], C.carrier, (carrier >= 0 ? 0.95 : 0.6 + 0.35 * (fx.tierPulse || 0)) * fx.cageLit, carrier >= 0 ? 2.2 : 1.8);
    // The tier, outlined once tunnels are seen; brighter as a check arrives.
    if ((egressOf().checks || 0) > 0 && fx.cageLit > 0) {
      fx.tierPulse = Math.max(0, (fx.tierPulse || 0) - 0.012);
      const c = tierPos(), rz = (gwCount() - 1) * 0.45 + 1, ry = (gwCount() - 1) * 0.9 + 1.2, N = 56, pts = [];
      for (let k = 0; k < N; k++) { const a = (k / N) * Math.PI * 2; pts.push(add(c, [0, Math.sin(a) * ry, Math.cos(a) * rz])); }
      // Faint once the carrier is known, so it does not read as an edge to the unused ones.
      if (carrier >= 0) lines(pts, chain(N, true), C.carrier, 0.12 + 0.2 * fx.tierPulse, 1, { glow: false });
      else lines(pts, chain(N, true), C.carrier, 0.35 + 0.6 * fx.tierPulse, 1 + fx.tierPulse);
    }
    // Packets ride the carrier's tunnel while the work runs.
    if (carrier >= 0 && fx.cageLit > 0 && fx.spark > 0) {
      const k = (clock * 0.7) % 1;
      draw(SHAPES.packet, mix(PROXY, gwPos(carrier), k), C.carrier, 1, { ry: clock * 4, scale: 0.8 });
    }
  }

  // The audiences the workload named: where the gateways let it reach.
  const auds = audList();
  if (auds.length && act >= 7) {
    const from = egressTo();
    auds.forEach((_, i) => {
      const a = audPos(i);
      draw(SHAPES.audience, a, C.ident, 0.85, { ry: t * 0.5 + i });
      // An edge only once tunnels are seen, from the one place traffic left by; which audience
      // each tunnel was for is not reported.
      if (from && fx.cageLit > 0) lines([from, a], [[0, 1]], C.carrier, 0.5 * fx.cageLit, 1.2, { glow: false });
    });
  }
  if (fx.spark > 0) {
    draw(SHAPES.spark, ST.cage, C.wire, fx.spark, { ry: t * 2.2, rx: t * 1.3, scale: 0.8 + 0.15 * Math.sin(t * 5) });
    draw(ring(0.55, 24), ST.cage, C.wire, fx.spark * 0.6, { rx: t * 1.7, ry: t });
  }

  // SPIRE: lit once this claim's entries are on the server. One edge in, from the API whose
  // ClusterStaticEntries its controller manager renders, and one out, to the VM, once the
  // guest's agent has attested and holds the identities.
  drawSpire(entriesShown() || attested(), t);
  if (entriesShown() && act >= 5 && act < 9) lines(BASE_EDGES.entries(), [[0, 1]], C.spire, 0.55, 1.2, { glow: false });
  if (svidLive()) lines([add(ST.spire, [0.6, -1.2, 0.4]), add(ST.vm, [-1.6, 1.4, -1.4])], [[0, 1]], C.spire, 0.75, 1.3, { dash: [3, 5], dashOffset: -clock * 14 });
  // OpenBao: the transit key glows once the seal has used it. One edge, from the broker.
  const bOn = act >= 6 && (sealedCount() > 0 || fx.sealLit > 0);
  drawBao(bOn, t);
  if (bOn) lines(BASE_EDGES.transit(), [[0, 1]], C.seal, 0.45, 1, { glow: false });
  // Their one standing link, OpenBao's PKI as SPIRE's upstream CA: not traffic of this run,
  // so drawn only while one of the two is picked.
  if (['spire', 'openbao', 'pki'].includes(view.sel?.id)) lines(BASE_EDGES.pki(), [[0, 1]], C.spire, 0.5, 1, { dash: [4, 6], glow: false });

  // The SandboxPolicy, and the one edge it has: the broker reads its signed bundle.
  const pol = policyOf(), pface = Math.atan2(cam.pos[0] - ST.policy[0], cam.pos[2] - ST.policy[2]);
  draw(SHAPES.policyDoc, ST.policy, C.policy, pol.name ? 0.95 : 0.3, { ry: pface + Math.sin(t * 0.5) * 0.15, scale: 1.1 });
  if (pol.name && act >= 4) lines([add(ST.policy, [0, -1.2, 0]), add(ST.broker, [0, 1.2, 0])], [[0, 1]], C.policy, 0.4, 1, { glow: false });
  // The authorization checkpoints, facing the camera.
  for (const a of authzPoints()) {
    if (!a.show()) continue;
    const col = C[AUTHZ_COLOR[a.state]], f = Math.atan2(cam.pos[0] - a.at[0], cam.pos[2] - a.at[2]);
    const al = a.state === 'pending' ? 0.55 : 1, sel = view.sel?.id === a.id ? 1.25 : 1;
    draw(SHAPES.shield, a.at, a.state === 'pending' ? C.ink : col, al, { ry: f, scale: sel, width: a.state === 'pending' ? 1 : 1.5 });
    draw(a.state === 'ok' ? SHAPES.shieldOk : a.state === 'bad' ? SHAPES.shieldBad : SHAPES.shieldIdle, a.at, a.state === 'pending' ? C.ink : col, al, { ry: f, scale: sel, width: 1.5 });
  }

  // The end: a ring, and the exit code in it.
  // The end faces the camera, so the exit code reads from wherever it is orbited to.
  const face = Math.atan2(cam.pos[0] - ST.end[0], cam.pos[2] - ST.end[2]);
  draw(SHAPES.endRing, ST.end, act >= 9 ? fx.exitColor : C.dim, act >= 9 ? 0.9 : 0.35, { ry: face });
  if (fx.exitShape && fx.exitScale > 0) {
    draw(fx.exitShape, ST.end, fx.exitColor, fx.exitScale, { scale: fx.exitScale * 1.4, ry: face, width: 2 });
  }
}

// The vault's body, its door (hinged on the left edge, swinging open) and, once it is open,
// the wall of safety deposit boxes inside: one per Secret, with a handle.
function drawVault() {
  const lit = fx.sealLit;
  const vc = lit > 0 ? mixColor(C.dim, C.seal, lit) : C.dim;
  const a = 0.4 + 0.6 * lit;
  const body = box(1.5, 1.5, 1.5);
  lines(body.pts.map(vaultAt), body.edges, vc, a, 1);
  const swing = -ease(vault.open) * 1.95, hinge = [-0.75, 0, 0.76];
  const door = (p) => vaultAt(add(hinge, rotY(sub(p, hinge), swing)));
  const plate = { pts: [[-0.75, -0.75, 0.76], [0.75, -0.75, 0.76], [0.75, 0.75, 0.76], [-0.75, 0.75, 0.76]], edges: chain(4, true) };
  lines(plate.pts.map(door), plate.edges, vc, a, 1.1);
  for (const [r, n] of [[0.42, 24], [0.12, 12]]) {
    const rr = ringPts(r, n, 'xy').map((p) => add(p, [0, 0, 0.77]));
    lines(rr.map(door), chain(n, true), vc, a * 0.9, 1);
  }
  // The dial's spokes turn while it opens.
  const spokes = [0, 1, 2].map((k) => { const ang = k * 2.09 + vault.open * 6; return [[0, 0, 0.77], [Math.cos(ang) * 0.42, Math.sin(ang) * 0.42, 0.77]]; }).flat();
  lines(spokes.map(door), [[0, 1], [2, 3], [4, 5]], vc, a * 0.8, 1, { glow: false });
  if (vault.open < 0.15) return;
  const va = clamp((vault.open - 0.15) / 0.6);
  boxes().forEach((k, i) => {
    const g = boxGrid(i), z = -0.3 + boxSlide(i);
    const x0 = g.x - g.w / 2, x1 = g.x + g.w / 2, y0 = g.y - g.h / 2, y1 = g.y + g.h / 2;
    const pts = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [x0, y0, -0.6], [x1, y0, -0.6], [x1, y1, -0.6], [x0, y1, -0.6],
      [g.x - g.w * 0.15, g.y, z + 0.01], [g.x + g.w * 0.15, g.y, z + 0.01]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 5], [2, 6], [3, 7], [8, 9]];
    const sel = view.sel?.id === `box${i}`;
    const sealed = !!(k.annotations || {})['mediatore.io/seal'] || !!(k.labels || {})['mediatore.io/session'];
    lines(pts.map(vaultAt), edges, sel ? C.ink : sealed ? C.seal : C.wire, va * (sel ? 1 : 0.85), sel ? 1.5 : 1.1);
  });
}

function drawLegs() {
  for (const leg of Object.values(LEGS)) {
    const N = 40, pts = [];
    for (let i = 0; i <= N; i++) pts.push(legAt(leg, i / N));
    const cut = Math.round(leg.p * N);
    polyline(pts.slice(cut), C.dim, 0.75, 1, { dash: [2, 6], glow: false });
    if (cut > 0) polyline(pts.slice(0, cut + 1), leg.color, 0.85, 1.4);
  }
}

function drawFx(dt) {
  for (const p of fx.packets) {
    const t = p.back ? 1 - p.t : p.t;
    const at = legAt(p.leg, t);
    draw(SHAPES.packet, at, p.color, 1, { ry: clock * 4, scale: p.size, width: 1.4 });
    const trail = [];
    for (let i = 0; i < 8; i++) trail.push(legAt(p.leg, clamp(t + (p.back ? 1 : -1) * i * 0.012)));
    polyline(trail, p.color, 0.6, 1.5);
  }
  for (let i = fx.bursts.length - 1; i >= 0; i--) {
    const b = fx.bursts[i];
    b.t += dt / b.d;
    if (b.t >= 1) { fx.bursts.splice(i, 1); continue; }
    const r = b.r * easeOut(b.t), n = 40, pts = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      pts.push(add(b.at, add(mul(cam.r, Math.cos(a) * r), mul(cam.u, Math.sin(a) * r))));
    }
    lines(pts, chain(n, true), b.color, 1 - b.t, 1.4);
  }
  // Output lines float up out of the jail and fade, one every 0.4 s at most.
  fx.floatGap = Math.max(0, fx.floatGap - dt);
  if (D.act >= 8 && fx.floatGap === 0 && fx.floatQueue.length && fx.floats.length < 8) {
    const q = fx.floatQueue.shift();
    fx.floats.push({ at: add(ST.cage, [0, 0.6, 0]), dx: 0.25 + Math.random() * 0.4, t: 0, life: 3.2, ...q });
    fx.floatGap = 0.4;
  }
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  for (let i = fx.floats.length - 1; i >= 0; i--) {
    const f = fx.floats[i];
    f.t += dt;
    if (f.t >= f.life) { fx.floats.splice(i, 1); continue; }
    const at = add(f.at, [f.dx * f.t, 0.9 * f.t, 0]);
    const c = toCam(at);
    if (c[2] < NEAR) continue;
    const [x, y] = proj(c);
    const a = clamp(1 - f.t / f.life) * fog(c[2]);
    ctx.fillStyle = rgba(f.color, a);
    ctx.fillText(f.text, x + 8, y);
    ctx.fillRect(x - 6, y - 4, 10, 1);
  }
}

// ------------------------------------------------------------------------------ camera direction

// Live, the director frames the run; free, the camera is the viewer's: it flies to what was
// clicked and pans, orbits and zooms around it until "Follow live" (or Esc) hands it back.
const view = { mode: 'live', sel: null, hover: null, target: [0, 0, 0], off: [-3, 3, 11] };
function wantCamera() {
  if (view.mode === 'free') return { pos: add(view.target, view.off), target: view.target };
  if (hop) return hopPose();
  if (D.act <= 3) return POSE[D.sheet];
  return restPose(D.act);
}

// Where the camera rests in each act, close on the node the run is at.
function restPose(act) {
  const follow = (at, off) => ({ pos: add(at, off), target: at });
  if (act <= 3) return POSE.create;
  if (act === 4) return follow(add(ST.broker, [0.8, 0, 0]), [-3.4, 3.6, 11]);
  if (act === 5) return follow(add(ST.api, [0.8, 0, 0]), [-3.4, 3.6, 11]);
  if (act === 6) return follow(add(ST.api, [1.4, -0.2, 0.6]), [-3, 3.6, 11]);
  if (act === 7) return follow(add(ST.vm, [0.8, 0, 0]), [-3.4, 3.6, 11]);
  if (act === 8) return follow(add(ST.vm, [2.8, 1.4, 0.4]), [-4, 3.6, 15]);
  // From above and behind the VM, so the leg to the exit runs up the screen.
  return follow(add(mix(ST.vm, ST.end, 0.45), [2.5, 0, 0]), [-5, 16, 23]);
}

// A hop from one node to the next: the camera lifts off and pulls back until the whole leg
// and what is around it is in view, the envelope crosses, and the camera settles in on the
// node it arrives at. The scene runs a little behind the run's events for it, on purpose.
let hop = null;
const travelOf = (k) => ease(clamp((k - 0.18) / 0.64));
function hopPose() {
  const { leg, from, to, p } = hop;
  const e = travelOf(p), bell = Math.sin(Math.PI * clamp(p));
  const span = len(sub(leg.b, leg.a));
  const mid = add(mix(leg.a, leg.b, 0.5), [0, leg.h * 0.4, 0]);
  let target = mix(from.target, to.target, e);
  target = mix(target, mid, bell * 0.7);
  let off = mix(sub(from.pos, from.target), sub(to.pos, to.target), e);
  off = add(mul(off, 1 + bell * clamp(span / 6, 1, 2.6)), [0, bell * span * 0.15, 0]);
  return { pos: add(target, off), target };
}
async function hopAlong(leg, from, to, dur, { move = true, packetColor = null } = {}) {
  hop = { leg, from, to, p: 0 };
  const run = tween(dur, (k) => {
    if (!hop) return;
    hop.p = k;
    const e = travelOf(k);
    leg.p = Math.max(leg.p, e);
    if (move) env.pos = legAt(leg, e);
  });
  const ride = packetColor ? wait(dur * 0.18).then(() => packet(leg, { color: packetColor, dur: dur * 0.64, size: 1.3 })) : null;
  await Promise.all([run, ride]);
  hop = null;
}

const navigable = () => D.act >= 3 || view.mode === 'free';
let camPos = POSE.login.pos.slice(), camTarget = POSE.login.target.slice(), shift = 0;
function moveCamera(dt) {
  const want = wantCamera();
  // Tighter tracking while hopping, so the lift-off and the settle read as one move.
  const k = REDUCED ? 1 : 1 - Math.exp(-dt * (hop ? 4.5 : 2.4));
  camPos = mix(camPos, want.pos, k);
  camTarget = mix(camTarget, want.target, k);
  let pos = camPos, target = camTarget;
  // While the sheet's inputs are on screen the camera stays square to them; after, it can be
  // orbited, and drifts a little on its own.
  if (navigable()) {
    let off = sub(camPos, camTarget);
    off = rotY(off, orbit.yaw + (REDUCED || view.mode === 'free' ? 0 : Math.sin(clock * 0.13) * 0.06));
    const right = norm(cross(off, [0, 1, 0]));
    const pitch = clamp(orbit.pitch, -0.6, 0.9);
    off = add(mul(off, Math.cos(pitch)), add(mul(cross(right, off), Math.sin(pitch)), mul(right, dot(right, off) * (1 - Math.cos(pitch)))));
    // A portrait screen sees less across: pull back so the station stays in frame.
    const narrow = clamp(1.3 / (W / Math.max(1, H)), 1, 2.3);
    off = mul(off, orbit.zoom * narrow);
    // With the inspector open the subject sits left of it: slide the camera right.
    const shiftWant = inspOpen() && W > 720 ? ($('insp').offsetWidth / 2 + 8) / cam.F * len(off) : 0;
    shift += (shiftWant - shift) * k;
    const side = mul(norm(cross(mul(off, -1), [0, 1, 0])), shift);
    target = add(camTarget, side);
    pos = add(target, off);
  }
  aim(pos, target);
}

// Into free mode from wherever the live camera is, so nothing jumps.
function freeCamera() {
  if (view.mode === 'free') return;
  view.mode = 'free';
  view.target = camTarget.slice();
  view.off = sub(camPos, camTarget);
  $('follow').hidden = false;
}
function followLive() {
  view.mode = 'live';
  orbit.yaw = 0; orbit.pitch = 0; orbit.zoom = 1;
  $('follow').hidden = true;
}

// ------------------------------------------------------------------------------ nodes and edges

// Every node: id, name, where, its pick radius, the camera's offset when it is picked, and
// when it exists. Gateways, audiences and deposit boxes come from the run's data.
const always = () => true;
const NODES = [
  { id: 'you', name: () => 'You', at: () => PAPERS.login.c, r: 1.6, off: [-2.5, 2.6, 9], show: always },
  { id: 'form', name: () => 'Sandbox create', at: () => (PAPERS.create.visible ? PAPERS.create.c : ST.form), r: 1.8, off: [-2.5, 2.6, 10], show: always },
  { id: 'issuer', name: () => 'OIDC issuer', at: () => ST.issuer, r: 2.2, off: [-3, 3, 11], show: always },
  { id: 'broker', name: () => 'Broker', at: () => ST.broker, r: 2.3, off: [-3, 3, 11], show: always },
  { id: 'api', name: () => 'Kubernetes API', at: () => ST.api, r: 2.3, off: [-3, 3.2, 11], show: always },
  { id: 'vault', name: () => 'Secrets vault', at: () => ST.vault, r: 1.3, off: [-2.4, 2.4, 8], show: always },
  { id: 'openbao', name: () => 'OpenBao', at: () => ST.bao, r: 1.4, off: [-2.4, 2.6, 9], show: always },
  { id: 'spire', name: () => 'SPIRE server', at: () => ST.spire, r: 1.8, off: [-3, 2.6, 11], show: always },
  ...Array.from({ length: MAX_BOX }, (_, i) => ({
    id: `box${i}`, name: () => boxShort(boxes()[i]) || `box ${i + 1}`, at: () => boxAt(i), r: 0.32, off: [-1, 1.2, 5.5],
    show: () => vault.open > 0.6 && i < boxes().length, inside: 'vault',
  })),
  { id: 'vm', name: () => 'Sandbox VM', at: () => ST.vm, r: 2.7, off: [-3.5, 3.6, 12.5], show: always },
  { id: 'guest', name: () => 'Guest agent', at: () => GUEST, r: 0.45, off: [-1.6, 1.8, 6], show: always },
  { id: 'proxy', name: () => 'Egress proxy', at: () => PROXY, r: 0.45, off: [-1.6, 1.8, 6], show: always },
  { id: 'cage', name: () => 'nsjail', at: () => ST.cage, r: 1.05, off: [-2, 2.2, 7], show: always },
  ...Array.from({ length: MAX_GW }, (_, i) => ({
    id: `gw${i}`, name: () => gwList()[i]?.name || `gateway ${i + 1}`, at: () => gwPos(i), r: 0.7, off: [-2, 2.2, 7.5],
    show: () => i < gwCount() && (i < gwList().length || D.act >= 7),
  })),
  ...Array.from({ length: MAX_AUD }, (_, i) => ({
    id: `aud${i}`, name: () => audList()[i] || `audience ${i + 1}`, at: () => audPos(i), r: 0.75, off: [-2, 2.2, 8],
    show: () => i < audList().length && D.act >= 7,
  })),
  { id: 'end', name: () => 'Exit', at: () => ST.end, r: 2.8, off: [-3, 3, 12], show: always },
  { id: 'policy', name: () => 'SandboxPolicy', at: () => ST.policy, r: 1.4, off: [-2.5, 2, 9], show: always },
  ...['authz-broker', 'authz-api', 'authz-gw'].map((id) => ({
    id, name: () => `Authz: ${authzById(id).name}`, at: () => authzById(id).at, r: 0.6, off: [-1.8, 1.4, 7], show: () => authzById(id).show(),
  })),
];
const legPts = (leg) => Array.from({ length: 41 }, (_, i) => legAt(leg, i / 40));
const EDGES = [
  { id: 'login', name: 'You → issuer', pts: () => legPts(LEGS.login), show: always },
  { id: 'form', name: 'Login → create', pts: () => legPts(LEGS.form), show: always },
  { id: 'broker', name: 'You → broker', pts: () => legPts(LEGS.broker), show: always },
  { id: 'api', name: 'Broker → API', pts: () => legPts(LEGS.api), show: always },
  { id: 'vm', name: 'API → VM', pts: () => legPts(LEGS.vm), show: always },
  { id: 'jail', name: 'Jail → proxy', pts: () => [ST.cage, PROXY], show: () => D.act >= 7 },
  { id: 'tunnel', name: 'Proxy → gateway', pts: () => [PROXY, egressTo() || tierPos()], show: () => D.act >= 7 && gwList().length > 0 },
  { id: 'upstream', name: 'Gateway → audience', pts: () => audList().length ? [egressTo() || tierPos(), audPos(0)] : [], show: () => D.act >= 7 && audList().length > 0 },
  { id: 'end', name: 'VM → exit', pts: () => legPts(LEGS.end), show: always },
  { id: 'transit', name: 'Broker → OpenBao', pts: BASE_EDGES.transit, show: () => D.act >= 6 && sealedCount() > 0 },
  { id: 'entries', name: 'API → SPIRE', pts: BASE_EDGES.entries, show: () => entriesShown() && D.act >= 5 && D.act < 9 },
  { id: 'svid', name: 'SPIRE → VM', pts: () => [add(ST.spire, [0.6, -1.2, 0.4]), add(ST.vm, [-1.6, 1.4, -1.4])], show: () => svidLive() },
  { id: 'pki', name: 'OpenBao → SPIRE', pts: BASE_EDGES.pki, show: () => ['spire', 'openbao', 'pki'].includes(view.sel?.id) },
  { id: 'bundle', name: 'Policy → broker', pts: () => [add(ST.policy, [0, -1.2, 0]), add(ST.broker, [0, 1.2, 0])], show: () => !!policyOf().name && D.act >= 4 },
];
const nodeById = (id) => NODES.find((n) => n.id === id);
const edgeById = (id) => EDGES.find((e) => e.id === id);
// Which node each stage chip in the bar goes to.
const STEP_NODE = { mint: 'issuer', create: 'broker', seal: 'vault', run: 'vm', logs: 'cage', exit: 'end' };

function select(kind, id, { fly = true, tab = 'details' } = {}) {
  if (D.act < 3) return; // the sheet is still being written: the camera stays on it
  view.sel = { kind, id };
  if (kind === 'node' && id.startsWith('box') && vault.want < 1) vault.want = 1;
  if (fly) {
    freeCamera();
    if (kind === 'node') {
      const n = nodeById(id);
      view.target = n.at().slice(); view.off = n.off.slice();
      // A deposit box is framed with its vault open around it.
      if (n.inside === 'vault') { view.target = ST.vault.slice(); view.off = [-2.6, 2.2, 12]; }
    } else {
      const pts = edgeById(id).pts(), a = pts[0], b = pts[pts.length - 1], span = Math.max(4, len(sub(b, a)));
      view.target = pts[Math.floor(pts.length / 2)].slice();
      if (pts.length === 2) view.target = mix(a, b, 0.5);
      view.off = [-span * 0.12, span * 0.32, span * 0.72];
    }
    orbit.yaw = 0; orbit.pitch = 0; orbit.zoom = 1;
  }
  openInspector(tab);
  paintNodes();
  if (['issuer'].includes(id) && kind === 'node' || (kind === 'edge' && id === 'login')) ensureTls('issuer');
  if (['broker'].includes(id)) ensureTls('broker');
}

// The vault opens on a double-click (on it or a box in it) and closes on the next.
function toggleVault() {
  vault.want = vault.want ? 0 : 1;
  select('node', 'vault');
  if (vault.want) view.off = [-2.6, 2.2, 12];
}

// What is under the pointer: the nearest node within its on-screen radius, else an edge
// within a few pixels of its line.
function pick(x, y) {
  let best = null;
  for (const n of NODES) {
    if (!n.show()) continue;
    const c = toCam(n.at());
    if (c[2] < NEAR) continue;
    const [px, py] = proj(c);
    const rs = Math.max(n.r < 0.5 ? 12 : 18, n.r * cam.F / c[2]);
    const d = Math.hypot(px - x, py - y);
    if (d > rs) continue;
    const score = d / rs + n.r * 0.01;
    if (!best || score < best.score) best = { kind: 'node', id: n.id, score };
  }
  let edge = null;
  for (const e of EDGES) {
    if (!e.show()) continue;
    let prev = null;
    for (const p of e.pts()) {
      const c = toCam(p);
      if (c[2] < NEAR) { prev = null; continue; }
      const q = proj(c);
      if (prev) {
        const d = distToSeg(x, y, prev, q);
        if (d < 7 && (!edge || d < edge.d)) edge = { kind: 'edge', id: e.id, d };
      }
      prev = q;
    }
  }
  // On a node's centre the node wins; on its rim, a line drawn right there wins.
  if (best && (!edge || best.score < 0.55)) return best;
  return edge || best;
}
function distToSeg(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

// The selected and hovered node or edge, outlined.
function drawSelection() {
  for (const [sel, a] of [[view.hover, 0.45], [view.sel, 0.95]]) {
    if (!sel) continue;
    if (sel.kind === 'node') {
      const n = nodeById(sel.id);
      if (!n || !n.show()) continue;
      const at = n.at(), r = n.r * (n.inside ? 1.6 : 1.3) * (n.inside ? vaultScale() : 1), N = 48, pts = [];
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2 + clock * 0.4;
        pts.push(add(at, add(mul(cam.r, Math.cos(t) * r), mul(cam.u, Math.sin(t) * r))));
      }
      const edges = [];
      for (let i = 0; i < N; i += 4) edges.push([i, i + 1], [i + 1, i + 2]);
      lines(pts, edges, C.ink, a, 1.4);
    } else {
      const e = edgeById(sel.id);
      if (!e || !e.show()) continue;
      polyline(e.pts(), C.ink, a, 2.6);
    }
  }
}

// ------------------------------------------------------------------------------ frame loop

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  stepTweens(dt);
  direct();
  loginLoop();
  moveCamera(dt);
  { const p = PAPERS[D.sheet]; if (D.act <= 3 && p.t === 0 && !$(p.formId).classList.contains('gone') && camArrived()) fitPaper(p); }

  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  drawStations();
  drawLegs();
  // Once the request has left, sheet 01 gives way to your card on its rolodex, and sheet 02
  // to the card of what you asked for, on its stack.
  if (fx.youCard < 1) drawPaper(PAPERS.login, 1 - fx.youCard);
  if (fx.youCard > 0) drawRolodex(CARDS.you, fx.youCard);
  if (D.sheet === 'create') drawPaper(PAPERS.create, 1);
  if (!PAPERS.create.visible) drawCardStack(CARDS.form);
  drawEnvelope();
  drawFx(dt);
  drawSelection();
  ctx.globalCompositeOperation = 'source-over';
  flushTerm();
  updateLabels();
  updateCards();
  placeLabels();
  placeCards();
  requestAnimationFrame(frame);
}

// While the login is under way, the request goes to the issuer and comes back, on a loop.
let loginInFlight = false;
function loginLoop() {
  if (D.act !== 1 || loginInFlight || fx.failed) return;
  loginInFlight = true;
  LEGS.login.p = 1;
  packet(LEGS.login, { color: C.ident, dur: 1.2 })
    .then(() => wait(0.5))
    .then(() => { loginInFlight = false; });
}

// ------------------------------------------------------------------------------ labels in the world

const host = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
// Who signed: the login name when the token carries one, never the raw subject first.
function who(fallback = 'you') {
  const id = model.data.mint.identity || {}, se = model.data.mint.session || {};
  return id.username || se.login || id.email || id.display || id.subject || fallback;
}
const L = {
  issuer: label(add(ST.issuer, [1.6, 1.2, 0]), 'ident', 'issuer'),
  broker: label(add(ST.broker, [2.2, 0.8, 0]), '', 'broker'),
  api: label(add(ST.api, [2.2, 1.2, 0]), '', 'api'),
  vault: label(add(ST.vault, [0.9, 0.9, 0]), 'seal', 'vault'),
  vm: label(add(ST.vm, [2.3, 1.6, 0]), '', 'vm'),
  cage: label(add(ST.cage, [-0.6, -1.3, 1]), '', 'cage'),
  end: label(add(ST.end, [2.8, 1.2, 0]), '', 'end'),
  you: label(add(ST.you, [1.4, 1.0, 0]), '', 'you'),
  env: label(() => add(env.pos, [0.9, 0.5, 0])),
};
L.issuer.lit = () => D.act >= 1;
L.broker.lit = () => D.act >= 4;
L.api.lit = () => D.act >= 5;
L.vault.lit = () => D.act >= 6;
L.vm.lit = () => D.act >= 7;
L.cage.lit = () => D.act >= 8;
L.end.lit = () => D.act >= 9;
L.cage.show = () => D.act >= 7;
// The labels that come with the data: each gateway, audience and deposit box, and the two
// pieces of the guest.
const GWL = Array.from({ length: MAX_GW }, (_, i) => Object.assign(label(() => add(gwPos(i), [0.55, 0.5, 0]), '', `gw${i}`), { show: () => D.act >= 7 && i < gwList().length }));
const AUDL = Array.from({ length: MAX_AUD }, (_, i) => Object.assign(label(() => add(audPos(i), [0.7, 0.5, 0]), 'ident', `aud${i}`), { show: () => D.act >= 7 && i < audList().length }));
const BOXL = Array.from({ length: MAX_BOX }, (_, i) => Object.assign(label(() => add(boxAt(i), [0, -0.05, 0.2]), 'seal box', `box${i}`), { show: () => vault.open > 0.85 && i < boxes().length }));
// Small parts are labelled only when the camera is close enough to read them, or when picked.
const near = (at, dist, id) => len(sub(cam.pos, at)) < dist || view.sel?.id === id || view.hover?.id === id;
L.tier = Object.assign(label(() => add(tierPos(), [0, (gwCount() - 1) * 0.9 + 1.7, 0]), 'carrier', null), { show: () => D.act >= 7 && (egressOf().checks || 0) > 0 });
L.guest = Object.assign(label(add(GUEST, [-0.6, -0.55, 0.3]), '', 'guest'), { show: () => D.act >= 7 && near(GUEST, 15, 'guest') });
L.proxy = Object.assign(label(add(PROXY, [0.3, -0.55, 0.3]), '', 'proxy'), { show: () => D.act >= 7 && near(PROXY, 15, 'proxy') });
L.cage.show = () => D.act >= 7 && near(ST.cage, 17, 'cage');
GWL.forEach((l, i) => { const base = l.show; l.show = () => base() && (near(gwPos(i), 20, `gw${i}`) || i === carrierIdx()); });
L.env.show = () => env.scale > 0.5 && env.sink < 0.5 && D.busy && [4, 5, 7].includes(D.act);
// While the vault is open its boxes have the floor: its own label and its neighbours' step aside.
L.vault.show = () => D.act >= 5 && vault.open < 0.4;
L.api.show = () => vault.open < 0.4;
L.broker.show = () => vault.open < 0.4;
L.you.show = () => D.act >= 4 && !CARDS.you.shown;
L.policy = label(add(ST.policy, [1.3, 1.1, 0]), 'policy', 'policy');
L.spire = label(add(ST.spire, [1.3, 1.6, 0]), 'spire', 'spire');
L.spire.lit = () => entriesSet() || attested();
L.openbao = label(add(ST.bao, [1.1, 1.0, 0]), 'seal', 'openbao');
L.openbao.lit = () => D.act >= 6 && sealedCount() > 0;
L.openbao.show = () => vault.open < 0.4;
const AUTHZL = ['authz-broker', 'authz-api', 'authz-gw'].map((id) => Object.assign(label(() => add(authzById(id).at, [0.55, 0.35, 0]), 'authz', id), { id, show: () => authzById(id).show() && (near(authzById(id).at, 16, id) || authzById(id).state === 'bad') }));
L.form = Object.assign(label(add(ST.form, [2.2, 1.6, 0]), '', 'form'), { show: () => D.act >= 4 && !CARDS.form.shown });
L.you.lit = () => true;

function updateLabels() {
  const d = model.data;
  boxLedger();
  setLabel(L.issuer, 'OIDC issuer', host($('issuer').value || cfg.login.issuer));
  setLabel(L.broker, 'mediatore broker', host(cfg.claim.url));
  const claim = d.create.claim || {};
  setLabel(L.api, 'Kubernetes API', claim.name ? `AgentSandbox ${claim.namespace ? claim.namespace + '/' : ''}${claim.name}` : 'AgentSandbox');
  const ks = (d.seal.kubeSecrets || []).length;
  setLabel(L.vault, 'Secrets', ks ? `${ks} in ${d.seal.brokerNamespace || 'the broker namespace'}, sealed` : 'sealed at rest');
  {
    const sp = spireOf(), es = entries();
    setLabel(L.spire, 'SPIRE', sp.error ? 'entries not readable' : es.length ? `${es.filter((e) => e.set).length} of ${es.length} entries set${attested() ? ' · agent attested' : ''}` : attested() ? 'agent attested' : 'no entry for this claim yet');
    setLabel(L.openbao, 'OpenBao', D.act >= 6 && ks ? `transit key · ${ks} envelope${ks === 1 ? '' : 's'}` : 'transit key');
  }
  const vm = vmOf();
  const ip = (vm.addresses || [])[0]?.split(' ')[0];
  setLabel(L.vm, 'Sandbox VM', [vm.name, ip].filter(Boolean).join(' · ') || 'a member of the pool');
  setLabel(L.cage, 'nsjail', 'jail-exec: Landlock + seccomp');
  const carrier = carrierIdx();
  GWL.forEach((l, i) => {
    const g = gwList()[i] || {};
    const ip = (g.addresses || [])[0]?.split(' ')[0];
    setLabel(l, g.name || 'gateway', i === carrier ? `carries this claim's tunnels${ip ? ' · ' + ip : ''}` : ip || '');
    l.el.classList.toggle('carrier', i === carrier);
    l.el.classList.toggle('idle', carrier >= 0 && i !== carrier);
  });
  AUDL.forEach((l, i) => setLabel(l, audList()[i] || '', 'audience'));
  BOXL.forEach((l, i) => setLabel(l, boxShort(boxes()[i]), ''));
  const eg = egressOf();
  setLabel(L.tier, `${eg.checks || 0} gateway check${eg.checks === 1 ? '' : 's'}`, carrierIdx() >= 0 ? `via ${gwList()[carrierIdx()]?.name}` : 'which gateway: not reported');
  L.tier.el.classList.add('carrier');
  setLabel(L.guest, 'guest agent', 'node SVID');
  setLabel(L.proxy, 'egress proxy', '127.0.0.1:3128');
  const x = d.exit;
  setLabel(L.end, 'Exit', x.code != null ? `code ${x.code}` : x.signal != null ? `signal ${x.signal}` : '');
  setLabel(L.env, claim.name ? `claim ${claim.name}` : 'claim', `as ${who()}`);
  setLabel(L.you, 'You', who('this laptop'));
  setLabel(L.form, 'sandbox create', 'sheet 02');
  const pol = policyOf();
  setLabel(L.policy, 'SandboxPolicy', pol.name ? pol.name + (pol.version ? ` · bundle ${pol.version}` : '') : 'none named');
  const said = { ok: 'allowed', bad: 'refused', gaps: 'allowed, with gaps', pending: 'not yet' };
  for (const l of AUTHZL) {
    const a = authzById(l.id);
    setLabel(l, `authz · ${a.name}`, said[a.state]);
    for (const k of ['ok', 'bad', 'gaps']) l.el.classList.toggle(k, a.state === k);
  }
}

// ------------------------------------------------------------------------------ the two cards

// Who you are and what you asked for, as cards laid over the wireframe: placed and scaled
// every frame from where their world rectangle lands on screen, and shown only while large
// enough to read (the label stands in otherwise). `W` is the card's width in the world; its
// height follows the card's own shape on the page.
const CARDS = {
  you: { node: 'you', px: 300, el: $('card-you'), c: add(ST.you, [0, 0.5, 0]), W: 4.2, H: 2.4, shown: false },
  form: { node: 'form', px: 330, el: $('card-form'), c: ST.form.slice(), W: 4.8, H: 2.2, shown: false },
};
for (const card of Object.values(CARDS)) {
  card.el.addEventListener('click', () => select('node', card.node));
}

// The rolodex: the front card (under the page's card), the cards fanned behind it on the
// rod, the two wheels and the stand.
function drawRolodex(card, alpha = 1) {
  const { c, W } = card, H = card.H, ay = c[1] - H / 2 - 0.3, az = c[2] - 0.55;
  const rect = (pts) => lines(pts, chain(4, true), C.ident, 0.55 * alpha, 1);
  rect([[-W / 2, -H / 2, 0], [W / 2, -H / 2, 0], [W / 2, H / 2, 0], [-W / 2, H / 2, 0]].map((q) => add(c, q)));
  const sway = REDUCED ? 0 : Math.sin(clock * 0.6) * 0.03;
  for (const [i, deg] of [-14, -27, -40, -53, -66].entries()) {
    const a = (deg * Math.PI) / 180 + sway;
    const at = (x, h) => [c[0] + x, ay + h * Math.cos(a), az + h * Math.sin(a)];
    lines([at(-W / 2, 0.3), at(W / 2, 0.3), at(W / 2, H + 0.3), at(-W / 2, H + 0.3)], chain(4, true), C.ident, (0.4 - i * 0.06) * alpha, 1, { glow: false });
  }
  const r = 0.8, n = 28;
  for (const x of [-W / 2 - 0.3, W / 2 + 0.3]) {
    const wheel = Array.from({ length: n }, (_, k) => { const t = (k / n) * Math.PI * 2; return [c[0] + x, ay + Math.cos(t) * r, az + Math.sin(t) * r]; });
    lines(wheel, chain(n, true), C.ident, 0.5 * alpha, 1);
    polyline([[c[0] + x, ay, az], [c[0] + x, ay - r - 0.55, az]], C.ident, 0.45 * alpha, 1);
  }
  polyline([[c[0] - W / 2 - 0.3, ay, az], [c[0] + W / 2 + 0.3, ay, az]], C.ident, 0.6 * alpha, 1.4);
  draw(box(W + 1.4, 0.12, 1.8), [c[0], ay - r - 0.6, az], C.ident, 0.4 * alpha);
}

// The create's card, on a short stack of the ones before it.
function drawCardStack(card) {
  const { c, W } = card, H = card.H;
  for (const [i, o] of [[0, 0], [1, 1], [2, 2]].entries()) {
    const d = [o[0] * 0.16, -o[1] * 0.16, -o[0] * 0.3];
    lines([[-W / 2, -H / 2, 0], [W / 2, -H / 2, 0], [W / 2, H / 2, 0], [-W / 2, H / 2, 0]].map((q) => add(add(c, q), d)), chain(4, true), C.wire, 0.5 - i * 0.16, 1, { glow: i === 0 });
  }
}

function placeCards() {
  for (const [key, card] of Object.entries(CARDS)) {
    const el = card.el;
    const want = key === 'you' ? fx.youCard > 0.4 : D.act >= 4 && !PAPERS.create.visible;
    const c = toCam(card.c), l = toCam(add(card.c, [-card.W / 2, 0, 0])), r = toCam(add(card.c, [card.W / 2, 0, 0]));
    let show = want && c[2] > NEAR && l[2] > NEAR && r[2] > NEAR;
    let s = 0, x = 0, y = 0;
    if (show) {
      const pl = proj(l), pr = proj(r);
      [x, y] = proj(c);
      s = Math.hypot(pr[0] - pl[0], pr[1] - pl[1]) / card.px; // the card's width on the page, even while hidden
      // Too small to read, or under the bar or the caption: the label stands in.
      show = s > 0.34 && y > 60 && y < H - 90 && x > 0 && x < W;
    }
    card.shown = show;
    if (el.hidden === show) el.hidden = !show;
    if (!show) continue;
    s = Math.min(s, 2.2);
    card.H = (card.W * el.offsetHeight) / el.offsetWidth;
    el.style.transform = `translate(${Math.round(x - (el.offsetWidth * s) / 2)}px, ${Math.round(y - (el.offsetHeight * s) / 2)}px) scale(${s.toFixed(3)})`;
    el.style.opacity = String(clamp(fog(c[2]) * 1.25, 0.4, 1) * (key === 'you' ? clamp((fx.youCard - 0.4) / 0.6) : 1));
    el.style.pointerEvents = 'auto';
    el.classList.toggle('sel', view.sel?.kind === 'node' && view.sel.id === card.node);
  }
}

const PROVIDERS = { github: 'GitHub', google: 'Google', microsoft: 'Microsoft', gitlab: 'GitLab', ldap: 'LDAP', saml: 'SAML', oidc: 'OIDC' };
const providerName = (p) => PROVIDERS[p] || (p ? p[0].toUpperCase() + p.slice(1) : '');
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
const initials = (name) => (name.match(/[A-Za-z0-9]+/g) || ['?']).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const clockTime = (sec) => (sec ? new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

function updateCards() {
  const id = model.data.mint.identity || {}, se = model.data.mint.session || {};
  const name = id.name || id.username || se.login || id.email || 'You';
  setText($('you-name'), name);
  const handle = id.username || se.login;
  setText($('you-handle'), [handle && handle !== name ? '@' + handle : '', providerName(id.provider)].filter(Boolean).join(' · ') || 'signed in');
  setText($('you-email'), id.email || '');
  const groups = id.groups || [];
  const chips = groups.slice(0, 4).map((g) => g).concat(groups.length > 4 ? [`+${groups.length - 4}`] : []);
  const gEl = $('you-groups');
  if (gEl.dataset.k !== chips.join('\n')) {
    gEl.dataset.k = chips.join('\n');
    gEl.replaceChildren(...chips.map((g) => { const i = document.createElement('i'); i.textContent = g; return i; }));
  }
  setText($('you-meta'), [id.issuer ? `via ${host(id.issuer)}` : '', id.expiresAt ? `token until ${clockTime(id.expiresAt)}` : ''].filter(Boolean).join(' · ') || 'this laptop');
  setText($('you-mono'), initials(name));
  const img = $('you-img');
  if ((id.avatar || '') !== (img.dataset.src || '')) {
    img.dataset.src = id.avatar || '';
    img.hidden = true;
    $('you-mono').hidden = false;
    if (id.avatar) {
      img.onload = () => { img.hidden = false; $('you-mono').hidden = true; };
      img.onerror = () => { img.hidden = true; $('you-mono').hidden = false; };
      img.src = id.avatar;
    } else img.removeAttribute('src');
  }

  const w = model.data.create.workload || {}, c = createSettings();
  const cmd = (c.workload || [w.image, ...(w.args || [])].filter(Boolean).join(' ')).trim();
  setText($('form-cmd'), cmd.length > 100 ? cmd.slice(0, 99) + '…' : cmd || 'no workload yet');
  const claim = model.data.create.claim || {};
  const aud = w.audiences || [];
  setText($('form-meta'), [
    claim.namespace || c.namespace ? `ns ${claim.namespace || c.namespace}` : '',
    w.ttl || c.ttl ? `ttl ${w.ttl || c.ttl} s` : '',
    aud.length ? `${aud.length} audience${aud.length === 1 ? '' : 's'}` : '',
    (w.logs ?? c.logs) ? '--logs' : '',
  ].filter(Boolean).join(' · ') || 'mediatore sandbox create');
}

// ------------------------------------------------------------------------------ bar and caption

function paintBar() {
  const ol = $('steps');
  if (!ol.children.length) {
    for (const [k, name] of STEPS) {
      const li = document.createElement('li');
      li.textContent = name;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      const go = () => select('node', STEP_NODE[k], { tab: k === 'logs' ? 'output' : 'details' });
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      ol.append(li);
    }
  }
  STEPS.forEach(([k], i) => { ol.children[i].className = model.steps[k]; });
  const pill = $('status');
  const running = !!runId && !model.finished;
  pill.hidden = !runId;
  pill.className = `pill ${model.finished ? (model.finished.ok ? 'ok' : 'bad') : 'running'}`;
  pill.textContent = model.finished ? (model.finished.ok ? 'done' : 'failed') : 'running';
  $('cancel').hidden = !running;
  $('again').hidden = !model.finished;
  $('insp-toggle').hidden = D.act < 3;
  paintCaption();
  if (inspOpen()) paintNodes();
  scheduleDetails();
}

function activePhase() {
  return model.phaseList.find((p) => p.state === 'active') || [...model.phaseList].reverse().find((p) => p.state === 'done');
}

function paintCaption() {
  const act = D.act, d = model.data, n = model.notes;
  const claim = d.create.claim || {};
  let title = '', detail = '';
  if (fx.failed) {
    paintFailure();
    return;
  } else if (act === 0) {
    title = 'Write the request';
    detail = 'Sign in with your issuer first, as mediatore login does; the workload comes second.';
  } else if (act === 1) {
    title = 'mediatore login';
    detail = n.mint || `Authorization code with PKCE at ${host($('issuer').value)}; finish it in the browser tab that opened.`;
  } else if (act === 2) {
    title = `Signed as ${who()}`;
    detail = 'The session is on disk. On sheet 02, mediatore sandbox create: the workload and every option, then seal and send it.';
  } else if (act === 3) {
    title = 'Sealing the request';
    detail = 'The workload, your identity token and any delegation, folded into one claim.';
  } else if (act === 4) {
    title = 'POST /v1/claims';
    detail = n.create || `To the broker at ${host(cfg.claim.url)}.`;
  } else if (act === 5) {
    title = claim.name ? `AgentSandbox ${claim.name}` : 'AgentSandbox created';
    detail = n.create || 'Written to the Kubernetes API; the pool binds a VM to it.';
  } else if (act === 6) {
    const ks = (d.seal.kubeSecrets || []).length;
    title = 'Credentials sealed';
    detail = n.seal || `${ks ? ks + ' Secrets' : 'Secrets'} in ${d.seal.brokerNamespace || 'the broker namespace'}, sealed at rest; the jail holds only a phantom token.`;
  } else if (act === 7 || act === 8) {
    const p = activePhase();
    title = act === 7 ? 'To the sandbox VM' : 'Running in the jail';
    detail = p ? `${p.title}${p.detail ? ' · ' + p.detail : ''}` : n.run || '';
    const gi = carrierIdx(), eg = egressOf();
    if (act === 8 && gi >= 0) detail += `${detail ? ' · ' : ''}egress through ${gwList()[gi]?.name}`;
    else if (act === 8 && (eg.checks || 0) > 0) detail += `${detail ? ' · ' : ''}${eg.checks} gateway check${eg.checks === 1 ? '' : 's'} (which gateway: not reported)`;
  } else if (act >= 9) {
    const x = d.exit;
    title = x.code != null ? `Exit code ${x.code}` : x.signal != null ? `Killed by signal ${x.signal}` : 'Exited';
    detail = model.finished ? model.finished.note : n.exit || n.run || '';
  }
  $('caption').classList.remove('alert');
  $('cap-fix').hidden = true;
  $('cap-title').textContent = title;
  const det = $('cap-detail');
  det.textContent = detail;
  if (act === 1 && model.authorizeUrl) {
    det.textContent = 'Open the issuer to finish the login: ';
    const a = document.createElement('a');
    a.href = model.authorizeUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = host(model.authorizeUrl);
    det.append(a);
  }
  $('cap-hint').hidden = act < 3;
}

// Why the run stopped, impossible to miss: the broker's code, its detail in full, and what to
// do about it when the code is one we know.
function paintFailure() {
  const note = model.finished?.note || 'the run failed';
  const r = brokerError(note);
  $('caption').classList.add('alert');
  const title = $('cap-title');
  title.replaceChildren();
  if (r) {
    title.append(el('span', 'code', `${r.status} ${r.error}`), r.error === 'delegation_expires_first' ? 'Your delegated credential expires before the claim would' : 'The broker refused the claim');
  } else {
    title.append(el('span', 'code', 'stopped'), 'The run stopped');
  }
  $('cap-detail').textContent = r ? r.detail || note : note;
  const fix = [];
  // How far apart the two ends are, when the broker said both.
  const m = r && /expires at (\S+?),? before a claim of (\d+) s/.exec(r.detail || '');
  if (m) {
    const left = Math.round((Date.parse(m[1]) - Date.now()) / 60000);
    fix.push(`It has ${left > 0 ? `${left} min` : 'no time'} left; the claim asks for ${Math.round(+m[2] / 60)} min.`);
  }
  if (r && REFUSAL_HINTS[r.error]) fix.push(REFUSAL_HINTS[r.error]);
  $('cap-fix').textContent = fix.join(' ');
  $('cap-fix').hidden = !fix.length;
  $('cap-hint').hidden = true;
}

// ------------------------------------------------------------------------------ output

// Lines on the page: the latest only (the copy button takes every line, from model.lines).
const TERM_MAX = 2000;
let termPending = [];
function outputLine(e) {
  model.lines.push(e);
  // Written once a frame (flushTerm), not once a line: reading the scroll position after each
  // append forced a layout of the whole output per line, and a burst of pip or mkdocs output
  // dropped the scene to a few frames a second.
  termPending.push(e);
  // Output arrives in batches: the lines queue and float up one at a time (drawFx), the
  // latest few only, so a batch is not drawn as one pile of text.
  fx.floatQueue.push({ text: e.text.slice(0, 40), color: e.stream === 'stderr' ? C.bad : C.wire });
  if (fx.floatQueue.length > 6) fx.floatQueue.splice(0, fx.floatQueue.length - 6);
  if (D.act >= 8) showTermAuto();
}
// The output opens on its own once the work runs, unless the viewer closed the inspector or
// is looking at something else in it.
function flushTerm() {
  if (!termPending.length) return;
  const pre = $('lines'), batch = termPending.slice(-TERM_MAX);
  termPending = [];
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  const frag = document.createDocumentFragment();
  for (const e of batch) {
    const span = document.createElement('span');
    if (e.stream === 'stderr') span.className = 'stderr';
    span.textContent = e.text + '\n';
    frag.append(span);
  }
  pre.append(frag);
  for (let extra = pre.childElementCount - TERM_MAX; extra > 0; extra--) pre.firstChild.remove();
  if (atEnd) pre.scrollTop = pre.scrollHeight;
  $('term-count').textContent = String(model.lines.length);
}
function showTermAuto() {
  if (!inspDismissed && !view.sel && model.lines.length && !inspOpen()) openInspector('output');
}

// ------------------------------------------------------------------------------ the inspector

let inspTab = 'details', inspDismissed = false;
function inspOpen() { return !$('insp').hidden; }
function openInspector(tab = 'details') {
  $('insp').hidden = false;
  inspDismissed = false;
  setTab(tab);
  paintNodes();
}
function closeInspector() {
  $('insp').hidden = true;
  inspDismissed = true;
  view.sel = null;
}
function setTab(tab) {
  inspTab = tab;
  $('tab-details').classList.toggle('on', tab === 'details');
  $('tab-output').classList.toggle('on', tab === 'output');
  $('details').hidden = tab !== 'details';
  $('linewrap').hidden = tab !== 'output';
  if (tab === 'output') { const pre = $('lines'); pre.scrollTop = pre.scrollHeight; } else renderDetails();
}

// The jump list at the top of the inspector: every node that exists now, then every edge.
let navKey = '';
function paintNodes() {
  const nav = $('nodes');
  const nodes = NODES.filter((n) => n.show()), edges = EDGES.filter((e) => e.show());
  const key = nodes.map((n) => n.id + n.name()).join() + '|' + edges.map((e) => e.id).join();
  if (key !== navKey) {
    navKey = key;
    nav.replaceChildren();
    for (const n of nodes) nav.append(navButton(n.name(), () => select('node', n.id), `node:${n.id}`, n.inside ? 'inner' : ''));
    for (const e of edges) nav.append(navButton(e.name, () => select('edge', e.id), `edge:${e.id}`, 'edge'));
  }
  const sel = view.sel ? `${view.sel.kind}:${view.sel.id}` : '';
  for (const b of nav.children) b.classList.toggle('on', b.dataset.key === sel);
}
function navButton(text, fn, key, cls) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = text; b.dataset.key = key; b.className = cls;
  b.addEventListener('click', fn);
  return b;
}

let detailsPending = false;
function scheduleDetails() {
  if (detailsPending || !inspOpen() || inspTab !== 'details') return;
  detailsPending = true;
  setTimeout(() => { detailsPending = false; renderDetails(); }, 250);
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
function fmt(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ') : null;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
const epoch = (t) => (t ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : null);
function dl(rows) {
  const d = el('dl');
  for (const [k, v] of rows) { const f = fmt(v); if (f != null) d.append(el('dt', null, k), el('dd', null, f)); }
  return d.children.length ? d : el('p', 'empty', 'not known yet');
}
function list(items, row) {
  if (!items || !items.length) return el('p', 'empty', 'none yet');
  const ul = el('ul');
  for (const it of items) {
    const [main, sub, cls] = row(it);
    const li = el('li');
    li.append(el('span', cls || null, main));
    if (sub) li.append(el('span', 'sub', sub));
    ul.append(li);
  }
  return ul;
}
const phaseRow = (p) => [`${p.title}  [${p.state}]`, [p.detail, p.at, p.how].filter(Boolean).join(' · '), p.state === 'done' ? 'ok' : p.state === 'failed' ? 'bad' : p.state === 'active' ? 'live' : ''];
const pre = (text) => (text ? el('pre', null, text) : el('p', 'empty', 'not run yet'));

// Which stage each node and edge belongs to, for its state.
function stepOf(sel) {
  const id = sel.id;
  if (sel.kind === 'edge') return { login: 'mint', form: 'create', broker: 'create', api: 'create', vm: 'run', jail: 'run', tunnel: 'run', upstream: 'run', end: 'exit', bundle: 'create', transit: 'seal', pki: 'seal', entries: 'run', svid: 'run' }[id];
  if (id.startsWith('box')) return 'seal';
  if (id === 'authz-gw') return 'run';
  if (id === 'policy' || id.startsWith('authz')) return 'create';
  if (id.startsWith('gw') || id.startsWith('aud')) return 'run';
  return { you: 'mint', form: 'create', issuer: 'mint', broker: 'create', api: 'create', vault: 'seal', openbao: 'seal', spire: 'run', vm: 'run', guest: 'run', proxy: 'run', cage: 'run', end: 'exit' }[id];
}

// ---- TLS, as Recess's own handshake saw it

const tlsSeen = { broker: { state: 'idle' }, issuer: { state: 'idle' } };
async function ensureTls(target) {
  const t = tlsSeen[target];
  if (t.state === 'loading' || (t.state === 'ok' && Date.now() - t.at < 60000)) return;
  t.state = 'loading';
  try {
    const r = await fetch(`/api/tls?target=${target}`);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    Object.assign(t, { state: 'ok', data: body, at: Date.now() });
  } catch (err) {
    Object.assign(t, { state: 'err', error: err.message, at: Date.now() });
  }
  scheduleDetails();
}

// ---- building blocks: facts with where they come from, layers, stacks

// How a fact is known: seen by Recess (its own handshake, the Kubernetes objects it
// watches), reported by mediatore or the guest, derived from those by mediatore's naming
// rules, or by design (what mediatore's code at the pinned version does). In the demo,
// everything seen or reported is the demo's script.
const HOW = { seen: 'seen', reported: 'reported', derived: 'derived', design: 'by design' };
function howChip(how) {
  const k = demo && (how === 'seen' || how === 'reported' || how === 'derived') ? 'demo' : how;
  return el('span', `how how-${k}`, k === 'demo' ? 'demo' : HOW[k] || k);
}
function facts(rows) {
  const d = el('dl', 'facts');
  for (const [k, v, how] of rows) {
    const f = fmt(v);
    if (f == null) continue;
    const dd = el('dd');
    dd.append(el('span', null, f));
    if (how) dd.append(' ', howChip(how));
    d.append(el('dt', null, k), dd);
  }
  return d.children.length ? d : el('p', 'empty', 'not known yet');
}
// A layer: a name, a short line under it, its facts, and the layers inside it.
const layer = (name, sub, rows = [], inner = [], tone = '') => ({ name, sub, rows, inner, tone });
// 'stack' draws layers one above the other (protocols: what rides on what); 'nest' draws each
// inside the one before (containment: the VM, then the guest, then the jail, ...).
function stack(layers, mode = 'stack') {
  const wrap = el('div', `stack ${mode}`);
  const one = (l) => {
    const box = el('div', `layer ${l.tone}`);
    const head = el('div', 'layer-head');
    head.append(el('b', null, l.name));
    if (l.sub) head.append(el('span', null, l.sub));
    box.append(head);
    if (l.rows.length) box.append(facts(l.rows));
    if (l.inner.length) box.append(stack(l.inner, 'nest'));
    return box;
  };
  if (mode === 'nest') {
    // Each inside the one before.
    let outer = null, root = null;
    for (const l of layers) {
      const box = one({ ...l, inner: [] });
      if (outer) outer.append(box); else root = box;
      outer = box;
    }
    if (root) wrap.append(root);
  } else for (const l of layers) wrap.append(one(l));
  return wrap;
}

// The TLS a handshake showed, and the chain it presented, as layers.
function tlsLayers(target, port) {
  const t = tlsSeen[target];
  if (t.state === 'idle' || t.state === 'loading') return [layer('TLS', 'Recess is handshaking with it now…')];
  if (t.state === 'err') return [layer('TLS', 'Recess\'s handshake failed', [['error', t.error, 'seen']])];
  const p = t.data, how = p.demo ? 'demo' : 'seen';
  const chain = (p.chain || []).map((c, i) => layer(
    i === 0 ? 'Certificate (leaf)' : i === p.chain.length - 1 ? 'Certificate (closest to the root)' : 'Certificate (intermediate)',
    c.subject,
    [['issuer', c.issuer, how], ['names', c.sans, how], ['key', c.key, how], ['signature', c.signature, how], ['valid from', c.notBefore, how], ['valid until', c.notAfter, how], ['serial', c.serial, how]],
  ));
  return [
    layer('TLS', `${p.version} · ${p.keyExchange}`, [
      ['version', p.version, how], ['cipher suite', p.cipher, how], ['key exchange', p.keyExchange, how],
      ['ALPN', p.alpn, how], ['verified against', p.verifiedWith, how], ['checked', p.at, how],
    ], chain),
    layer('TCP', `${p.host}:${p.port || port}`, [['host', p.host, how], ['port', p.port, how]]),
  ];
}

// The sandbox leg's TLS, as mediatore pins it (mediatore-tls/src/provider.rs, server.rs).
const SANDBOX_TLS = (client, server) => layer('Mutual TLS', 'the sandbox leg', [
  ['version', 'TLS 1.3 only', 'design'], ['key exchange', 'X25519MLKEM768 only (post-quantum hybrid)', 'design'],
  ['cipher suite', 'TLS13_AES_256_GCM_SHA384 only', 'design'], ['client identity', client, client?.includes('<') ? 'design' : 'derived'],
  ['server identity', server, server?.includes('<') ? 'design' : 'derived'], ['resumption', 'none: every connection runs the SPIFFE verifier', 'design'],
]);

// What the broker's log says about this claim's tunnels, as facts.
function tunnelFacts() {
  const e = egressOf(), how = e.source === 'demo' ? 'reported' : 'seen';
  if (e.error) return [['broker log', e.error, 'seen']];
  if (!e.checks) return [['tunnels', 'none seen yet (each shows as a gateway asking the broker about the claim)', 'design']];
  return [
    ['gateway checks', `${e.checks}: each a gateway asking the broker for this claim's egress, so at least one tunnel; a gateway caches the answer a while`, how],
    ['last', e.last, how],
    ['refused', e.refused ? `${e.refused} (the claim was no longer live)` : null, how],
    ['endpoints allowed', e.endpoints, how],
    ['which gateway', carrierIdx() >= 0 ? gwList()[carrierIdx()]?.name : 'not reported: the gateways reach the broker from one address, and mediatore does not say', carrierIdx() >= 0 ? 'reported' : 'seen'],
    ['which audience', 'not reported: the gateway checks the host itself', 'design'],
  ];
}

// The sandbox VM as far as anything says: banlieue's VirtualMachine, else what the
// AgentSandbox mirrors of it (its name and addresses), which outlives the VM's own lookup.
function vmOf() {
  const vm = model.data.seal.memberVm || {}, st = (model.data.run.object || {}).status || {};
  return {
    ...vm,
    name: vm.name || st.virtualMachineRef?.name || '',
    addresses: vm.addresses?.length ? vm.addresses : st.addresses || [],
  };
}

// The trust domain and this run's SPIFFE IDs, from whatever carries one: the VM's attested
// subject (not every banlieue sets it), the SPIRE agent ID the AgentSandbox records as its
// node (spiffe://<td>/spire/agent/tpm/<ek hash>), or a gateway's subject. The node SVID shares
// the agent's EK hash.
function spiffeOf() {
  const vm = model.data.seal.memberVm || {}, st = (model.data.run.object || {}).status || {};
  const tdOf = (s) => (s || '').match(/^spiffe:\/\/([^/]+)\//)?.[1];
  const agent = st.record?.nodeId || '';
  const td = tdOf(vm.attestationSubject) || tdOf(agent) || gwList().map((g) => tdOf(g.attestationSubject)).find(Boolean) || '';
  const ek = agent.match(/\/spire\/agent\/tpm\/([0-9a-f]+)$/)?.[1];
  const node = vm.attestationSubject || (td && ek ? `spiffe://${td}/banlieue/node/${ek}` : '');
  const claimUid = model.data.create.claim?.uid || st.claimUid || st.record?.claimUid || '';
  return { td, agent, node, nodeSeen: !!vm.attestationSubject, claimUid };
}

// ---- what each node and edge is, from the top down

// The checks, as a list: every one, or those at one place; each marked as Recess sees it.
function authzList(at) {
  const r = claimRefusal(), state = Object.fromEntries(authzPoints().map((a) => [a.id, a.state]));
  // A refusal the broker named marks its check; the checks before it passed, those after it
  // were never reached.
  const hitAt = r ? AUTHZ_CHECKS.findIndex((c) => c.codes.includes(r.error)) : -1;
  const rows = AUTHZ_CHECKS.map((c, i) => ({ c, i })).filter(({ c }) => !at || c.at === at).map(({ c, i }) => {
    const hit = i === hitAt;
    // Some outcomes never reach Recess: those are not marked passed just because the run went on.
    const st = hit ? 'bad' : hitAt >= 0 ? (i < hitAt ? 'ok' : 'skipped') : c.unseen ? 'unseen' : state[c.at];
    return { c, st };
  });
  const where = { 'authz-broker': 'broker', 'authz-api': 'Kubernetes API', 'authz-gw': 'gateway' };
  const mark = { ok: 'passed', bad: 'refused', gaps: 'passed, with gaps', pending: 'not yet', unseen: 'not reported to you', skipped: 'not reached' };
  return list(rows, ({ c, st }) => [`${c.what}  [${r && st === 'bad' && c.codes.includes(r.error) ? r.error : mark[st]}]`, `${at ? '' : where[c.at] + ' · '}on refusal: ${c.how}`, st === 'ok' ? 'ok' : st === 'bad' ? 'bad' : st === 'gaps' ? 'live' : '']);
}
function authzPanel(id, summary) {
  const a = authzById(id), r = claimRefusal(), pol = policyOf(), eg = egressOf();
  const evidence = {
    'authz-broker': [['decision', r ? `${r.status} ${r.error}` : a.state === 'ok' ? 'the claim was taken' : null, 'seen'], ['detail', r?.detail, 'seen'], ['policy named', pol.name || 'none', pol.seenName ? 'seen' : 'reported']],
    'authz-api': [['AgentSandbox', model.data.run.object?.metadata?.uid ? 'admitted' : null, 'seen'], ['PolicyConformant', pol.cond ? `${pol.cond.status} (${pol.cond.reason || ''})` : null, 'seen'], ['refused', pol.refused, 'seen'], ['bundle in the record', pol.version, 'seen']],
    'authz-gw': [['tunnels allowed', eg.checks || null, eg.source === 'demo' ? 'reported' : 'seen'], ['denials', 'not reported to you: the gateway logs them, and ADR-0062 sends them to the broker', 'design']],
  }[id];
  return {
    title: `Authz: ${a.name}`, summary,
    glance: [['state', { ok: 'allowed', bad: 'refused', gaps: 'allowed, with gaps (shadow)', pending: 'not decided yet' }[a.state], 'seen'], ...evidence],
    sections: [['The checks here, in order', authzList(id)]],
    raw: null,
  };
}

function describe(sel) {
  const d = model.data, n = model.notes, id = d.mint.identity || {}, se = d.mint.session || {};
  const w = d.create.workload || {}, claim = d.create.claim || {}, obj = d.run.object || {};
  const vm = vmOf(), pool = d.run.pool || {}, x = d.exit || {};
  const L = cfg.login || {}, Cl = cfg.claim || {};
  const sp = spiffeOf();
  const td = sp.td || '<trust domain>';
  const claimSvid = `spiffe://${td}/banlieue/claim/${sp.claimUid || '<claim uid>'}`;
  const nodeSvid = sp.node || `spiffe://${td}/banlieue/node/<ek hash>`;
  const nodeHow = sp.nodeSeen ? 'seen' : sp.node ? 'derived' : 'design';
  const gwSvid = `spiffe://${td}/gateway`;
  const phase = (key) => model.phaseList.find((p) => p.key === key);
  const build = phase('build');
  const early = model.phaseList.filter((p) => !['jail', 'run', 'exit', 'release'].includes(p.key));
  const late = model.phaseList.filter((p) => ['jail', 'run'].includes(p.key));
  const ending = model.phaseList.filter((p) => ['exit', 'release'].includes(p.key));
  const issuer = $('issuer').value || L.issuer;
  const carrier = carrierIdx(), via = viaOf();
  const delegated = (w.delegate || []).map((s) => String(s).split('=')[0]);
  const workloadLayer = layer('Workload', [w.image, ...(w.args || [])].filter(Boolean).join(' ').slice(0, 80), [
    ['image', w.image, 'reported'], ['user', 'the sandbox uid, global, not root', 'design'],
    ['environment', 'HOME, MEDIATORE_EGRESS_PROXY, MEDIATORE_TOKEN (a phantom)', 'design'], ['output', w.logs ? 'streamed to you, redacted in the VM, sealed at rest' : 'not captured', 'reported'],
  ]);
  const jailLayers = [
    layer('nsjail', 'namespaces and limits', [
      ['namespaces', 'mount, pid, ipc, uts; the VM\'s network and user namespaces (the sandbox uid is global)', 'design'],
      ['root', 'the image\'s rootfs, read-only; /work, /tmp, /home/sandbox writable', 'design'],
      ['/proc', 'subset=pid, hidepid=invisible: its own processes only', 'design'],
      ['limits', 'address space 8 GiB, 512 processes, 4 GiB files, 32 open files', 'design'],
    ]),
    layer('jail-exec', 'Landlock and seccomp, applied to itself before the exec', [
      ['Landlock writes', '/work, /tmp, /home/sandbox, /dev/null', 'design'], ['Landlock connect', 'TCP 3128 only (the egress proxy); no bind', 'design'],
      ['seccomp', 'stream sockets of AF_UNIX, AF_INET, AF_INET6 only; io_uring denied', 'design'],
      ['shared memory', 'no /dev/shm (ADR-0058 proposes one)', 'design'],
    ]),
    workloadLayer,
  ];
  const proxyLayer = layer('Egress proxy', '127.0.0.1:3128, as the sandbox user, outside the jail', [
    ['path form', '$MEDIATORE_EGRESS_PROXY/<host>/<path>; no CONNECT', 'design'],
    ['phantom', 'the jail holds a phantom token; the proxy swaps in the credential per audience, and the phantom never leaves', 'design'],
    ['identity', claimSvid, claim.uid ? 'derived' : 'design'],
    ['upstream TLS', 'TLS 1.3 only, the Mozilla roots, X25519MLKEM768 offered first', 'design'],
  ]);
  const nodes = {
    you: () => ({
      title: 'You', summary: 'This laptop: Recess, the mediatore session file, and the commands it ran as you.',
      glance: [['login', who(''), 'seen'], ['session', se.path, 'seen'], ['ID token', se.idTokenFresh == null ? null : se.idTokenFresh ? `fresh until ${se.idTokenExpiresAt}` : 'expired', 'seen']],
      sections: [
        ['Identity', stack([
          layer('ID token', 'OIDC, minted by the issuer', [['username', id.username, 'seen'], ['email', id.email, 'seen'], ['groups', id.groups, 'seen'], ['subject', id.subject, 'seen'], ['audience', id.audience, 'seen'], ['expires', epoch(id.expiresAt), 'seen'], ['fingerprint', id.fingerprint, 'seen']]),
          layer('Session file', se.path, [['mode', se.mode, 'seen'], ['refresh token', se.refreshToken, 'seen'], ['issuer', se.issuer, 'seen'], ['client id', se.clientId, 'seen']]),
        ])],
        ['Held on this laptop', list((d.seal.secrets || []).filter((x2) => x2.place === 'laptop'), (x2) => [x2.name, [x2.presence, x2.sealed ? 'sealed' : '', x2.location, x2.note].filter(Boolean).join(' · ')])],
        ['mediatore login', pre(d.mint.command)],
        ['mediatore sandbox create', pre(d.create.command)],
      ],
      raw: { session: se, identity: id },
    }),
    form: () => {
      const c = createSettings();
      return {
        title: 'mediatore sandbox create', summary: 'Sheet 02: the request, with every option the CLI takes. Sealed and sent as one POST /v1/claims.',
        glance: [['workload', c.workload, 'seen'], ['broker', c.url, 'seen'], ['as', who(''), 'seen']],
        sections: [
          ['The request, as written', stack([
            layer('Workload', 'what runs in the jail', [['image and args', c.workload, 'seen'], ['restart', c.restart, 'seen'], ['logs', c.logs ? 'captured (--logs)' : 'off', 'seen'], ['ttl', c.ttl ? `${c.ttl} s` : null, 'seen']]),
            layer('Placement', 'where the pool puts it', [['namespace', c.namespace || 'the broker\'s default', 'seen'], ['pool', c.pool, 'seen'], ['pool selector', c.poolSelector, 'seen'], ['strategy', c.strategy || 'banlieue default', 'seen']]),
            layer('Reach', 'what it may talk to, as whom', [['audiences', c.audiences, 'seen'], ['delegate', c.delegate, 'seen'], ['policy', c.policy, 'seen']]),
            layer('Broker', 'where it is sent', [['URL', c.url, 'seen'], ['CA file', c.caFile, 'seen'], ['plain HTTP', c.allowPlainHttp ? 'allowed (--allow-plain-http)' : 'refused', 'seen']]),
          ])],
          ['As the broker accepted it', facts([['image', w.image, 'reported'], ['args', (w.args || []).join(' '), 'reported'], ['claim', claim.name, 'seen']])],
          ['Command', pre(d.create.command || createCommand(c))],
        ],
        raw: c,
      };
    },
    issuer: () => ({
      title: 'OIDC issuer', summary: 'mediatore login signs you in here, in your browser, and gets the ID token the broker checks.',
      glance: [['issuer', issuer, 'seen'], ['client id', L.clientId, 'seen'], ['TLS', tlsSeen.issuer.data ? `${tlsSeen.issuer.data.version} · ${tlsSeen.issuer.data.keyExchange}` : null, 'seen']],
      sections: [
        ['Your connection to it', stack([
          layer('OIDC', 'authorization code with PKCE', [['flow', 'authorization code, PKCE (S256), in your browser', 'design'], ['redirect', `http://${L.redirectHost || 'localhost'}:${(L.redirectPorts || [8000])[0]}${L.redirectPath || ''}, on loopback only`, 'design'], ['scopes', L.scopes, 'seen'], ['authorize URL', model.authorizeUrl, 'seen']]),
          layer('HTTP', 'the authorize page, then the token endpoint', [['token request', 'POST with the code and the PKCE verifier', 'design']]),
          ...tlsLayers('issuer', 443),
        ])],
        ['The ID token it minted', facts([['username', id.username, 'seen'], ['email', id.email, 'seen'], ['groups', id.groups, 'seen'], ['issued', epoch(id.issuedAt), 'seen'], ['expires', epoch(id.expiresAt), 'seen'], ['claims', id.claimNames, 'seen'], ['fingerprint', id.fingerprint, 'seen']])],
      ],
      raw: { identity: id, login: L, tls: tlsSeen.issuer.data },
    }),
    broker: () => ({
      title: 'mediatore broker', summary: 'Checks your ID token, writes the claim, seals your credentials, and answers the guests and gateways.',
      glance: [['URL', Cl.url, 'seen'], ['identity', `spiffe://${td}/mediatore`, td.startsWith('<') ? 'design' : 'derived'], ['TLS', tlsSeen.broker.data ? `${tlsSeen.broker.data.version} · ${tlsSeen.broker.data.cipher}` : null, 'seen'], ['claim', claim.name, 'seen']],
      sections: [
        ['Your connection: the user API', stack([
          layer('HTTP', 'POST /v1/claims', [['auth', 'Authorization: Bearer <your ID token>', 'design'], ['body', 'the workload, the options, any delegated credential (sent once)', 'design']]),
          ...tlsLayers('broker', 443),
        ])],
        ['The sandbox listener: guests and gateways', stack([
          layer('HTTP', 'GET /v1/me, output, the exit report, egress questions', [['ALPN', 'h2, http/1.1', 'design']]),
          SANDBOX_TLS(`a node SVID (${nodeSvid}) or a gateway authorizer SVID`, `spiffe://${td}/mediatore`),
        ])],
        ['At rest', stack([
          layer('Session envelope', 'your refresh token and delegations', [['cipher', 'AES-256-GCM, bound to the sandbox UID', 'design'], ['lifetime', 're-sealed on every refresh, deleted at release', 'design']]),
          layer('Output', 'the workload\'s stdout and stderr', [['sealed', 'per batch, with the transit key (ADR-0052)', 'design'], ['kept', 'for the retention window after the claim', 'design']]),
        ])],
        ['The claim', facts([['name', claim.name, 'seen'], ['namespace', claim.namespace, 'seen'], ['uid', claim.uid, 'seen'], ['sandbox uid', claim.sandbox_uid, 'seen'], ['image', w.image, 'reported'], ['audiences', w.audiences, 'reported'], ['delegate', w.delegate, 'reported'], ['policy', w.policy, 'reported'], ['ttl', w.ttl, 'reported']])],
        ['Command', pre(d.create.command)],
      ],
      raw: { workload: w, claim, tls: tlsSeen.broker.data },
    }),
    policy: () => {
      const pol = policyOf(), c = pol.cond;
      return {
        title: 'SandboxPolicy', summary: 'notaio\'s policy, named by the claim in spec.policyRef. notaio signs it into a bundle beside it; the broker verifies the bundle and authorizes by it. mediatore has no default policy: a claim that names none is held only to the broker\'s own checks.',
        glance: [
          ['name', pol.name || 'none named', pol.seenName ? 'seen' : 'reported'],
          ['bundle version', pol.version, 'seen'], ['policy uid', pol.uid, 'seen'],
          ['conformant', c ? `${c.status} (${c.reason || ''})${c.message ? ': ' + c.message : ''}` : null, 'seen'],
          ['refused', pol.refused, 'seen'],
        ],
        sections: [
          ['Where the claim is authorized, in order', authzList(null)],
          ['The signed bundle', stack([
            layer('ConfigMap', `${pol.name || '<policy>'}-bundle, in the policy's namespace`, [['managed by', 'notaio', 'design'], ['envelope', 'bundle.dsse.json (DSSE), checked against the broker\'s trusted keys', 'design'], ['fresh for', 'about 15 minutes (notAfter); notaio re-signs it', 'design']]),
            layer('Content', 'what the broker reads', [['audiences', 'name, ttlSeconds, rules, endpoints', 'design'], ['lease', 'maxDurationSeconds', 'design'], ['egress', 'direct host:port the claim may reach (ADR-0030)', 'design']]),
          ])],
          ['Not in the policy', facts([['images', 'the registries the pool reaches: broker config', 'design'], ['pools', 'broker config', 'design'], ['who may claim where', 'the namespace\'s groups: broker config (ADR-0046)', 'design']])],
        ],
        raw: { policyRef: pol.name ? { name: pol.name } : null, record: { policyUid: pol.uid || null, bundleVersion: pol.version || null }, condition: c, reason: pol.refused || null },
      };
    },
    'authz-broker': () => authzPanel('authz-broker', 'The broker decides whether to take the claim at all, at POST /v1/claims, before anything is written: who you are, where, what for, under which policy. A refusal comes back to you as the broker\'s error, and nothing is created.'),
    'authz-api': () => authzPanel('authz-api', 'Kubernetes admits the AgentSandbox the broker writes, and the broker\'s reconciler then holds it to the policy: a bundle it has verified, and the sandbox measured against it.'),
    'authz-gw': () => authzPanel('authz-gw', 'While the work runs, every tunnel out and every credential the proxy places is asked of the authorizer on the gateway, which asks the broker for the claim\'s egress. Decided per connection, never once for the run.'),
    api: () => ({
      title: 'Kubernetes API', summary: 'Holds the AgentSandbox, the claim\'s record, which the pool binds a VM to.',
      glance: [['AgentSandbox', obj.metadata?.name || claim.name, 'seen'], ['phase', obj.status?.phase || claim.phase, 'seen'], ['namespace', obj.metadata?.namespace || claim.namespace, 'seen']],
      sections: [
        ['The record', stack([
          layer('AgentSandbox', `${obj.metadata?.namespace || ''}/${obj.metadata?.name || claim.name || ''}`, [['uid', obj.metadata?.uid, 'seen'], ['created', obj.metadata?.creationTimestamp, 'seen'], ['generation', obj.metadata?.generation, 'seen'], ['finalizers', obj.metadata?.finalizers, 'seen']]),
          layer('spec', 'what was asked', [['subject', obj.spec?.subject?.display || obj.spec?.subject?.id, 'seen'], ['ttl', obj.spec?.ttlSeconds, 'seen'], ['image', obj.spec?.workload?.image, 'seen'], ['restart', obj.spec?.workload?.restart, 'seen']]),
          layer('status', 'what happened', [['phase', obj.status?.phase, 'seen'], ['exit', obj.status?.record?.exit ? JSON.stringify(obj.status.record.exit) : null, 'reported']]),
        ], 'nest')],
        ['Events', list(model.events, (e) => [`${e.reason || ''}${e.count > 1 ? ' ×' + e.count : ''}`, [e.message, e.object, e.at].filter(Boolean).join(' · '), e.type === 'Warning' ? 'bad' : 'live'])],
      ],
      raw: obj,
    }),
    spire: () => {
      const sp2 = spireOf(), es = entries();
      const entryLayers = es.map((e) => layer(e.name, e.name.startsWith('mediatore-claim-') ? 'the claim\'s entry: the egress proxy\'s identity' : 'the node\'s entry: the guest agent\'s identity', [
        ['SPIFFE ID', e.spiffeId, 'seen'], ['parent (agent)', e.parentId, 'seen'], ['selectors', (e.selectors || []).join(', '), 'seen'],
        ['SVID lifetime', e.ttl || null, 'seen'], ['class', e.className, 'seen'],
        ['rendered', e.rendered == null ? null : e.rendered ? 'yes' : 'no', 'seen'], ['on the server', e.set == null ? null : e.set ? 'yes (set)' : 'not yet', 'seen'],
        ['masked', e.masked ? 'yes: another entry shadows it' : null, 'seen'], ['declared', e.created, 'seen'],
      ]));
      return {
        title: 'SPIRE server', summary: DESIGN.spire.summary,
        glance: [['trust domain', sp.td || null, sp.agent ? 'seen' : 'derived'], ['entries', sp2.error ? null : es.length ? `${es.filter((e) => e.set).length} of ${es.length} set` : 'none yet', 'seen'],
          ['node agent', sp.agent || null, 'seen'], ['entries readable', sp2.error ? `no: ${sp2.error}` : null, 'seen']],
        sections: [
          ['This claim\'s entries', entryLayers.length ? stack(entryLayers) : el('p', 'empty', sp2.error ? 'This kubeconfig may not read clusterstaticentries (spire.spiffe.io, cluster-scoped).' : entriesWereSet ? 'Deleted at the release: the claim SVID can no longer be issued or renewed.' : 'None yet: the broker declares them when the claim is bound, and deletes them at the release.')],
          ['The identities on this run', stack([
            layer('Broker', `spiffe://${td}/mediatore`, [['from', 'the SPIRE agent on its Kubernetes node, through the SPIFFE CSI driver; in memory only (ADR-0007)', 'design']]),
            layer('Guest agent (node SVID)', nodeSvid, [['selectors', 'unix:uid:0 and unix:path:/usr/bin/mediatore', 'design'], ['used for', 'the broker\'s sandbox listener: GET /v1/me, output, exit', 'design']]),
            layer('Egress proxy (claim SVID)', claimSvid, [['selectors', 'unix:user:<sandbox user>; the jail has none', 'design'], ['lives', 'while the entry exists, at most its SVID lifetime', 'design'], ['used for', 'tunnels to the gateways, tokens from the broker', 'design']]),
            layer('Gateway', `spiffe://${td}/gateway and /gateway/authorizer`, [['used for', 'Envoy\'s listener, and the authorizer asking the broker (ADR-0053)', 'design']]),
          ])],
          ['How the guest gets them', stack([
            layer('Node attestation', 'the VM\'s TPM (ADR-0018), or x509pop with a certificate its host signs (ADR-0049)', [['agent ID', sp.agent || `spiffe://${td}/spire/agent/tpm/<ek hash>`, sp.agent ? 'seen' : 'design'], ['trust bundle', 'fetched at every boot through the gateway relay, port 3131 (ADR-0037)', 'design']]),
            layer('Workload API', 'the agent\'s socket in the guest', [['hands out', 'the node SVID to the guest agent, the claim SVID to the proxy, by the selectors above', 'design']]),
          ])],
          ['Its CA', stack([layer('Upstream authority', 'OpenBao PKI signs the server\'s intermediate CA', [['plugin', 'UpstreamAuthority "vault" (deploy/spire-upstream)', 'design']])])],
        ],
        raw: { entries: es },
      };
    },
    openbao: () => {
      const ks = model.data.seal.kubeSecrets || [];
      const sbUid = obj.metadata?.uid;
      return {
        title: 'OpenBao', summary: DESIGN.openbao.summary,
        glance: [['envelopes', ks.length || null, 'seen'], ['bound to', sbUid ? `the sandbox UID ${sbUid}` : null, 'derived'], ['broker logs in', 'with a projected ServiceAccount token, audience openbao (ADR-0015)', 'design']],
        sections: [
          ['What it sealed for this claim', ks.length ? list(ks, (k) => [boxShort(k), k.name]) : el('p', 'empty', 'nothing yet: the seal comes after the claim is accepted')],
          ['The transit key', stack([
            layer('Transit', 'encrypt and decrypt with a derived key (ADR-0015)', [
              ['context', 'the sandbox UID: an envelope moved onto another claim does not open', 'design'],
              ['envelope', 'key_id transit:<mount>/<key>; the vault:vN: ciphertext OpenBao returns', 'design'],
              ['rotation', 'the version prefix keeps a rotated key readable', 'design'],
              ['seals', 'the issuer session (refresh token), each delegated credential, each stored output batch (ADR-0052)', 'design'],
            ]),
            layer('The broker\'s login', 'Kubernetes auth', [['token', 'a projected ServiceAccount token, audience openbao, exchanged for a short-lived OpenBao token held in memory', 'design'], ['at rest', 'no OpenBao token, no key, nothing in a Secret or on disk', 'design']]),
          ])],
          ['PKI', stack([layer('SPIRE\'s upstream CA', 'signs the SPIRE server\'s intermediate, rotated every ca_ttl', [['used by', 'the SPIRE server, not the broker', 'design']])])],
        ],
        raw: null,
      };
    },
    vault: () => {
      const b = el('button', 'ghost small go', vault.want ? 'Close the vault' : 'Open the vault');
      b.type = 'button'; b.addEventListener('click', toggleVault);
      const ks = boxes();
      const gone = boxLedger().filter((x) => x.gone);
      const boxesList = el('div', 'deposit');
      ks.forEach((k, i) => { const bt = navButton(boxShort(k), () => select('node', `box${i}`), `node:box${i}`, 'boxbtn'); boxesList.append(bt); });
      // The ones the run has emptied: still listed, greyed and struck through.
      for (const x of gone) {
        const r = el('div', 'boxbtn removed');
        r.append(el('s', '', boxShort(x.k)), el('span', 'why', `removed ${x.gone.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`));
        r.title = `${x.k.name}: no longer in ${d.seal.brokerNamespace || 'the broker namespace'}`;
        boxesList.append(r);
      }
      return {
        title: 'Secrets vault', summary: 'Your credentials at rest: Secrets in the broker\'s namespace, each sealed. Double-click it (or the button) to open its safety deposit boxes.',
        glance: [['namespace', d.seal.brokerNamespace, 'seen'], ['Secrets', ks.length || gone.length ? `${ks.length}${gone.length ? ` (${gone.length} removed)` : ''}` : null, 'seen'], ['Recess reads', 'names, labels and annotations only, never the data', 'design'], ['sealed with', 'OpenBao\'s transit key, bound to the sandbox UID', 'design']],
        sections: [
          ['Safety deposit boxes', ks.length || gone.length ? boxesList : el('p', 'empty', 'none yet')], ['', b],
          ['Custody: where each credential is', list(d.seal.secrets, (s2) => [s2.name, [s2.place, s2.presence, s2.sealed ? 'sealed' : '', s2.memory ? 'in memory' : '', s2.location, s2.note].filter(Boolean).join(' · '), s2.presence === 'held' ? 'live' : ''])],
        ],
        raw: { kubeSecrets: d.seal.kubeSecrets },
      };
    },
    vm: () => ({
      title: 'Sandbox VM', summary: 'The pool member bound to this claim: its own kernel, its own guest agent, one jail.',
      glance: [['name', vm.name, 'seen'], ['address', vm.addresses, 'seen'], ['node identity', nodeSvid, nodeHow], ['trust domain', sp.td || null, sp.agent ? 'seen' : 'derived']],
      sections: [
        ['From the VM down to the workload', stack([
          layer('VM', `${vm.provider || ''} ${vm.providerClass || ''}`.trim(), [['class', vm.class, 'seen'], ['image', vm.image, 'seen'], ['failure domain', vm.failureDomain, 'seen'], ['power', vm.power, 'seen'], ['ready', vm.ready, 'seen'], ['pool', pool.name, 'seen']]),
          layer('SPIRE agent', 'attested by the VM\'s TPM', [['agent identity', sp.agent || `spiffe://${td}/spire/agent/tpm/<ek hash>`, sp.agent ? 'seen' : 'design'], ['issues', 'the node SVID, and the claim SVID once the broker registers it', 'design']]),
          layer('Guest agent', 'mediatore guest, as root', [['identity', nodeSvid, nodeHow], ['talks to', 'the broker\'s sandbox listener: GET /v1/me, output, exit', 'design']]),
          layer('Sandbox filesystem', 'a fresh tmpfs per claim', [['mount', '/mnt/sandbox, nosuid, nodev, 0711, half the RAM by default', 'design'], ['image', build?.detail, 'reported']]),
          layer('nftables', 'the ruleset keyed by the sandbox uid', [['ruleset', build?.detail?.match(/ruleset ([0-9a-f]+)/)?.[1], 'reported'], ['allows', 'the relay, the gateways and the proxy, by address', 'design']]),
          proxyLayer, ...jailLayers,
        ], 'nest')],
        ['Getting there', list(early, phaseRow)],
      ],
      raw: { memberVm: vm, pool },
    }),
    guest: () => ({
      title: 'Guest agent', summary: 'mediatore guest on the VM: fetches the sandbox, builds it, starts the proxy and the jail, reports back.',
      glance: [['identity', nodeSvid, nodeHow], ['VM', vm.name, 'seen']],
      sections: [
        ['Its connection to the broker', stack([layer('HTTP', 'GET /v1/me; output batches; the exit report'), SANDBOX_TLS(nodeSvid, `spiffe://${td}/mediatore`)])],
        ['What it did', list(early, phaseRow)],
      ],
      raw: build || null,
    }),
    proxy: () => ({
      title: 'Egress proxy', summary: 'The jail\'s only way out: it takes the workload\'s plain request, places the real credential, and sends it over TLS through a gateway.',
      glance: [['listens', '127.0.0.1:3128', 'design'], ['identity', claimSvid, claim.uid ? 'derived' : 'design'], ['audiences', w.audiences, 'reported']],
      sections: [
        ['Tunnels so far', facts(tunnelFacts())],
        ['One request, from the workload out', stack([
          layer('Workload → proxy', 'plain HTTP on loopback', [['URL', '$MEDIATORE_EGRESS_PROXY/<host>/<path>', 'design'], ['auth', 'the phantom token, which never leaves the VM', 'design']]),
          proxyLayer,
          layer('Proxy → upstream', 'TLS inside the tunnel, end to end', [['TLS', 'TLS 1.3 only, X25519MLKEM768 offered first', 'design'], ['trust', 'the Mozilla roots, or the audience\'s CA', 'design']]),
          layer('Tunnel', 'CONNECT <host>:443 through a gateway', [['gateway', via ? (typeof via === 'string' ? via : via.gateway) : 'one of the gateways, picked per connection; not reported', via ? 'reported' : 'design']]),
          SANDBOX_TLS(claimSvid, gwSvid),
        ])],
      ],
      raw: null,
    }),
    cage: () => {
      const b = el('button', 'ghost small go', 'Open output');
      b.type = 'button'; b.addEventListener('click', () => setTab('output'));
      return {
        title: 'nsjail', summary: 'The jail the workload runs in: namespaces, then Landlock and seccomp, then the workload itself.',
        glance: [['state', late.find((p) => p.state === 'active')?.title || late.at(-1)?.title, 'reported'], ['output lines', model.lines.length, 'seen']],
        sections: [['From the outside in', stack(jailLayers, 'nest')], ['Steps', list(late, phaseRow)], ['', b]],
        raw: late,
      };
    },
    end: () => ({
      title: 'Exit', summary: 'The workload\'s exit as the guest reported it; then the claim is released and its Secrets deleted.',
      glance: [['code', x.code, 'reported'], ['signal', x.signal, 'reported'], ['result', model.finished?.note, 'seen']],
      sections: [
        ['How it got here', stack([
          layer('Exit report', 'guest → broker', [['exited at', x.exitedAt, 'reported'], ['restarts', x.restarts, 'reported']]),
          SANDBOX_TLS(nodeSvid, `spiffe://${td}/mediatore`),
          layer('Recorded', 'status.record.exit on the AgentSandbox', [['seen by Recess', 'from the Kubernetes API', 'seen']]),
        ])],
        ['After', list(ending, phaseRow)],
      ],
      raw: x,
    }),
  };
  const nid = sel.id;
  if (sel.kind === 'node' && nid.startsWith('box')) {
    const k = boxes()[+nid.slice(3)] || {};
    const lb = k.labels || {}, an = k.annotations || {};
    const kind = lb['mediatore.io/logs'] ? 'workload output segment' : lb['mediatore.io/audience'] ? `delegated credential for ${lb['mediatore.io/audience']}` : lb['mediatore.io/session'] ? `session (${lb['mediatore.io/session']})` : 'Secret';
    const custody = (d.seal.secrets || []).find((s2) => (s2.location || '').includes(k.name));
    return {
      title: boxShort(k), summary: `A safety deposit box: ${kind}.`,
      glance: [['Secret', k.name, 'seen'], ['holds', kind, 'seen'], ['namespace', d.seal.brokerNamespace, 'seen'], ['created', k.created, 'seen']],
      sections: [['The box, from the outside in', stack([
        layer('Secret', `${d.seal.brokerNamespace || ''}/${k.name}`, [...Object.entries(lb).map(([a2, b2]) => [a2, b2, 'seen'])]),
        layer('Seal', an['mediatore.io/seal'] ? `sealed, format ${an['mediatore.io/seal']}` : 'sealed by the broker', [
          ...Object.entries(an).map(([a2, b2]) => [a2, b2, 'seen']),
          ['cipher', lb['mediatore.io/logs'] ? 'per batch, with the transit key (ADR-0052)' : 'AES-256-GCM, bound to the sandbox UID', 'design'],
          ['custody', custody ? [custody.presence, custody.note].filter(Boolean).join(' · ') : null, 'seen'],
        ]),
        layer('Contents', 'never read by Recess', [['who opens it', lb['mediatore.io/logs'] ? 'the broker, to serve the output to you' : 'the broker, to refresh or place the credential', 'design']]),
      ], 'nest')]],
      raw: k,
    };
  }
  if (sel.kind === 'node' && nid.startsWith('gw')) {
    const i = +nid.slice(2), g = gwList()[i] || {};
    const carried = i === carrier;
    return {
      title: g.name || `gateway ${i + 1}`, summary: 'An egress gateway: the only way out of the sandbox segment. Envoy, one CONNECT route, each tunnel asked of the authorizer.',
      glance: [['addresses', g.addresses, 'seen'], ['carries this claim', carrier < 0 ? 'not reported: the proxy picks a gateway per connection, and mediatore does not say which' : carried ? 'yes' : 'no', carrier < 0 ? 'design' : 'reported'], ['ready', g.ready, 'seen']],
      sections: [
        ['This claim\'s tunnels, from the broker\'s log', facts(tunnelFacts())],
        ['The VM', facts([['provider', g.provider, 'seen'], ['class', g.providerClass, 'seen'], ['failure domain', g.failureDomain, 'seen'], ['power', g.power, 'seen'], ['VM class', g.class, 'seen'], ['image', g.image, 'seen']])],
        ['A tunnel through it', stack([
          layer('CONNECT', '<host>:443, the only route', [['asked of', `the authorizer (spiffe://${td}/gateway/authorizer), which asks the broker for the claim's egress`, 'design'], ['log', 'one access-log line per tunnel', 'design']]),
          SANDBOX_TLS(claimSvid, gwSvid),
          layer('Upstream', 'dialled from the egress address', [['bytes', 'relayed untouched: the workload\'s TLS runs end to end inside', 'design']]),
        ])],
      ],
      raw: g,
    };
  }
  if (sel.kind === 'node' && nid.startsWith('aud')) {
    const name = audList()[+nid.slice(3)];
    const del = delegated.includes(name);
    return {
      title: name, summary: 'An audience the workload named: a host the broker lets it reach, through the proxy and a gateway.',
      glance: [['credential', del ? 'yours, delegated with the claim' : 'none sent, or one the broker holds', del ? 'reported' : 'design'], ['reached at', `$MEDIATORE_EGRESS_PROXY/<its host>/<path>`, 'design'], ['traffic to it', (egressOf().checks || 0) > 0 ? 'the claim opened tunnels; which audience each was for is not reported' : 'none seen yet', (egressOf().checks || 0) > 0 ? 'seen' : 'design']],
      sections: [['A request to it', stack([
        layer('HTTP', 'the request as the upstream sees it', [['credential', del ? 'placed by the proxy from your delegation' : 'placed by the proxy, if the audience has one', 'design'], ['rules', 'the broker\'s method and path rules for this audience', 'design']]),
        layer('TLS', 'from the proxy, end to end', [['version', 'TLS 1.3 only', 'design'], ['trust', 'the Mozilla roots, or the audience\'s CA', 'design']]),
        layer('Tunnel', via ? `through ${typeof via === 'string' ? via : via.gateway}` : 'through one of the gateways', [['gateway', via ? (typeof via === 'string' ? via : via.gateway) : 'not reported', via ? 'reported' : 'design']]),
      ])]],
      raw: null,
    };
  }
  const edges = {
    transit: () => ({ title: 'Broker → OpenBao', summary: 'The broker asks OpenBao to encrypt each credential with the transit key, the sandbox UID as the key\'s context, and writes the envelope it gets back into a Secret. A read asks it to decrypt.', glance: [['envelopes', sealedCount() || null, 'seen']], sections: [['On the wire', stack([layer('HTTP', 'POST <mount>/encrypt/<key>, POST <mount>/decrypt/<key>', [['context', 'the sandbox UID', 'design'], ['auth', 'a short-lived OpenBao token from the Kubernetes login', 'design']]), layer('TLS', 'to OpenBao', [['trust', 'the configured CA', 'design']])])]], raw: null }),
    entries: () => ({ title: 'Kubernetes API → SPIRE', summary: 'The broker writes ClusterStaticEntry objects; the SPIRE Controller Manager, leader-elected beside the server, renders them into entries over a private socket. The broker never connects to SPIRE.', glance: [['entries', entries().length || null, 'seen'], ['set', entries().filter((e) => e.set).length || null, 'seen']], sections: [['On the wire', stack([layer('Kubernetes API', 'create and delete clusterstaticentries (spire.spiffe.io)', [['as', 'the broker\'s service account; admission allows two shapes under /banlieue/ only (ADR-0006)', 'design']]), layer('Unix socket', 'controller manager → server, never on the network', [], [], '')])]], raw: { entries: entries() } }),
    svid: () => ({ title: 'SPIRE → sandbox VM', summary: 'The guest\'s SPIRE agent attests the VM, then holds the node SVID and, while the claim\'s entry exists, the claim SVID; both rotate before they expire.', glance: [['agent', spiffeOf().agent || null, 'seen'], ['node SVID', spiffeOf().node || null, spiffeOf().nodeSeen ? 'seen' : 'derived']], sections: [['On the wire', stack([layer('SPIRE agent API', 'attestation, then SVID rotation', [['attestor', 'TPM, or x509pop with a host-signed certificate', 'design']]), layer('TLS', 'agent → server, through the gateway relay (ADR-0027)', [['trust', 'the bundle fetched at boot (ADR-0037)', 'design']])])]], raw: null }),
    pki: () => ({ title: 'OpenBao → SPIRE', summary: 'OpenBao\'s PKI is the SPIRE server\'s upstream authority: it signs the server\'s intermediate CA. Not part of any one run, so it is drawn only while SPIRE or OpenBao is picked.', glance: [], sections: [['On the wire', stack([layer('HTTP', 'sign the intermediate CA, every ca_ttl', [['plugin', 'UpstreamAuthority "vault"', 'design']])])]], raw: null }),
    bundle: () => {
      const pol = policyOf();
      return { title: 'SandboxPolicy → broker', summary: 'The broker\'s bundle reflector, on every replica, reads the signed bundle, checks notaio\'s signature, and records the newest version it has taken (a PolicyFloor) so an older bundle is never taken back.', glance: [['policy', pol.name, pol.seenName ? 'seen' : 'reported'], ['bundle version', pol.version, 'seen']], sections: [['On the wire', stack([layer('Kubernetes API', 'watch ConfigMaps labelled app.kubernetes.io/managed-by=notaio', [['as', 'the broker\'s service account: get, list, watch in the policy namespaces', 'design']]), layer('DSSE', 'bundle.dsse.json', [['verified', 'against the broker\'s trusted keys; refused if unsigned, stale or older than the floor', 'design']])])]], raw: null };
    },
    login: () => ({ title: 'You → OIDC issuer', summary: 'Your browser signs you in; Recess takes the code on its loopback redirect and gets the ID token.', glance: [['issuer', issuer, 'seen'], ['state', model.steps.mint, 'seen']], sections: [['On the wire', stack([layer('OIDC', 'authorization code with PKCE', [['redirect', 'http://localhost on loopback', 'design'], ['note', n.mint, 'seen']]), ...tlsLayers('issuer', 443)])]], raw: null }),
    form: () => ({ title: 'Login → sandbox create', summary: 'The session the login wrote is what create sends: your ID token, and the refresh token it delegates. Nothing leaves this laptop until POST /v1/claims.', glance: [['session', se.path, 'seen'], ['ID token', id.fingerprint, 'seen']], sections: [['Handed over', stack([layer('Session file', se.path, [['mode', se.mode, 'seen'], ['ID token', se.idTokenFresh == null ? null : se.idTokenFresh ? 'fresh' : 'expired', 'seen'], ['refresh token', se.refreshToken, 'seen']]), layer('On this laptop', 'one process, no network', [['crossing', 'none: Recess reads the session it wrote', 'design']])])]], raw: null }),
    broker: () => ({ title: 'You → broker', summary: 'POST /v1/claims: the workload, your ID token and any delegated credential, sent once.', glance: [['broker', Cl.url, 'seen'], ['claim', claim.name, 'seen']], sections: [['On the wire', stack([layer('HTTP', 'POST /v1/claims', [['auth', 'Bearer <your ID token>', 'design'], ['delegate', w.delegate, 'reported']]), ...tlsLayers('broker', 443)])], ['Command', pre(d.create.command)]], raw: null }),
    api: () => ({ title: 'Broker → Kubernetes API', summary: 'The broker writes the AgentSandbox and seals the session beside it in Secrets.', glance: [['claim', claim.name, 'seen'], ['phase', obj.status?.phase || claim.phase, 'seen']], sections: [['On the wire', stack([layer('Kubernetes API', 'create AgentSandbox; create Secrets', [['as', 'the broker\'s service account', 'design']]), layer('TLS', 'to the API server', [['trust', 'the cluster CA', 'design']])])]], raw: null }),
    vm: () => ({ title: 'Kubernetes API → sandbox VM', summary: 'banlieue binds a pool member; its guest fetches the sandbox over mutual TLS.', glance: [['pool', pool.name, 'seen'], ['member', vm.name, 'seen']], sections: [['On the wire', stack([layer('HTTP', 'GET /v1/me', [['answer', 'the workload, the audiences, the gateways', 'design']]), SANDBOX_TLS(nodeSvid, `spiffe://${td}/mediatore`)])], ['Steps', list(early, phaseRow)]], raw: null }),
    jail: () => ({ title: 'Jail → egress proxy', summary: 'The only connection the jail may open: loopback TCP to port 3128.', glance: [['to', '127.0.0.1:3128', 'design']], sections: [['On the wire', stack([layer('HTTP', 'plain, on loopback', [['URL', '/<host>/<path>', 'design'], ['auth', 'the phantom token', 'design']]), layer('Allowed by', 'Landlock and seccomp', [['connect', 'TCP 3128 only', 'design'], ['bind', 'none', 'design']])])]], raw: null }),
    tunnel: () => ({ title: 'Egress proxy → gateway', summary: 'A CONNECT tunnel over mutual TLS, as the claim.', glance: [['gateway', via ? (typeof via === 'string' ? via : via.gateway) : 'picked per connection, not reported', via ? 'reported' : 'design']], sections: [['Seen so far', facts(tunnelFacts())], ['On the wire', stack([layer('CONNECT', '<host>:443'), SANDBOX_TLS(claimSvid, gwSvid), layer('TCP', 'to the gateway\'s sandbox address, port 8443', [], [], '')])]], raw: null }),
    upstream: () => ({ title: 'Gateway → audience', summary: 'The tunnel\'s far end: the gateway dials the host and relays bytes; the TLS inside is the proxy\'s, end to end.', glance: [['audiences', w.audiences, 'reported']], sections: [['On the wire', stack([layer('TLS', 'proxy ↔ upstream, end to end', [['version', 'TLS 1.3 only', 'design']]), layer('TCP', 'from the gateway\'s egress address', [])])]], raw: null }),
    end: () => ({ title: 'Sandbox VM → exit', summary: 'The guest reports the exit code to the broker; the claim ends and is released.', glance: [['code', x.code, 'reported']], sections: [['On the wire', stack([layer('HTTP', 'the exit report'), SANDBOX_TLS(nodeSvid, `spiffe://${td}/mediatore`)])]], raw: null }),
  };
  return (sel.kind === 'node' ? nodes : edges)[nid]();
}

function renderDetails() {
  if (!inspOpen() || inspTab !== 'details') return;
  const box = $('details');
  const scroll = box.scrollTop;
  box.replaceChildren();
  if (!view.sel) {
    box.append(el('div', 'kicker', 'the journey'), el('h2', null, 'Pick a node or an edge'));
    box.append(el('p', 'lede', 'Click a station, a path, a label, or a button above; double-click the Secrets vault to open it. The camera flies there; Follow live (or Esc) hands it back to the run.'));
    return;
  }
  const info = describe(view.sel);
  const step = stepOf(view.sel);
  const kicker = el('div', 'kicker');
  kicker.append(`${view.sel.kind} · ${step} `, el('span', `st-${model.steps[step]}`, model.steps[step]));
  box.append(kicker, el('h2', null, info.title), el('p', 'lede', info.summary));
  if (info.glance?.length) box.append(el('h3', null, 'At a glance'), facts(info.glance));
  for (const [title, body] of info.sections) { if (title) box.append(el('h3', null, title)); box.append(body); }
  if (info.raw && (Array.isArray(info.raw) ? info.raw.length : Object.keys(info.raw).length)) {
    const det = el('details');
    det.append(el('summary', null, 'raw (YAML)'), el('pre', null, toYaml(info.raw)));
    box.append(det);
  }
  box.scrollTop = scroll;
}

// ------------------------------------------------------------------------------ the sheets

const LOGIN_FORM = $('sheet-login'), CREATE_FORM = $('sheet-create');
// What each sheet asks for: the server's settings (flags, environment, config file) under
// what the sheet says now, every option the CLI takes.
const loginSettings = () => ({ ...cfg.login, ...readForm(LOGIN_FORM) });
const createSettings = () => ({ ...cfg.claim, ...readForm(CREATE_FORM) });
function previews() {
  $('login-cmd').textContent = loginCommand(loginSettings());
  $('create-cmd').textContent = createCommand(createSettings());
}
function setDisabled(form, off) {
  for (const f of form.querySelectorAll('input, textarea, select, button[type=submit]')) f.disabled = off;
}

// The issuer's stamp on sheet 01, with who signed.
function stampSheet() {
  const st = $('stamp');
  st.textContent = `signed · ${who('you')}`;
  st.hidden = false;
  $('login-note').textContent = '';
}

// Sheet 02 opens once the session has arrived on it.
function unlockCreate() {
  $('signed-as').textContent = `signed · ${who('you')}`;
  setDisabled(CREATE_FORM, false);
  if (!model.sent) $('workload').focus();
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r.status === 202 && r.headers.get('content-type')?.includes('json') ? r.json() : null;
}

// 1. mediatore login, with every option on sheet 01.
async function signIn(ev) {
  ev.preventDefault();
  const l = loginSettings();
  $('login-error').textContent = '';
  if (!demo && !l.issuer) { $('login-error').textContent = 'The issuer is required.'; $('issuer').focus(); return; }
  setDisabled(LOGIN_FORM, true);
  $('login-note').textContent = 'signing in…';
  try {
    const { id } = await post('/api/login', l);
    reset(false);
    attach(id);
  } catch (err) {
    setDisabled(LOGIN_FORM, false);
    $('login-note').textContent = '';
    $('login-error').textContent = err.message;
  }
}

// 2. mediatore sandbox create, with every option on sheet 02.
async function send(ev) {
  ev.preventDefault();
  const c = createSettings();
  $('create-error').textContent = '';
  if (!c.workload) { $('create-error').textContent = 'Write a workload: IMAGE [ARG...]'; $('workload').focus(); return; }
  if (!demo && !c.url) { $('create-error').textContent = 'mediatore\'s URL is required.'; return; }
  setDisabled(CREATE_FORM, true);
  try {
    await post('/api/create', c);
    model.sent = true;
  } catch (err) {
    setDisabled(CREATE_FORM, false);
    $('create-error').textContent = err.message;
  }
}

function attach(id) {
  if (es) es.close();
  runId = id;
  es = new EventSource(`/api/events?run=${encodeURIComponent(id)}`);
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  es.addEventListener('end', () => { es.close(); es = null; });
  paintBar();
}

// Back to the sheet: a new run starts with a new login, as the CLI's one login per claim.
function reset(full) {
  D.gen++;
  D.act = 0; D.busy = false; D.speed = 1; signing = null;
  tweens.length = 0;
  model = freshModel();
  for (const [k, pp] of Object.entries(PAPERS)) Object.assign(pp, { t: 0, morph: 0, stamp: 0, scribbles: [], visible: true, written: false, c: pp.home.slice() });
  D.sheet = 'login';
  hop = null;
  LEGS.form.a = ST.you; LEGS.form.b = ST.form; LEGS.broker.a = ST.form;
  Object.assign(env, { pos: [0, 0, 0], scale: 0, lock: 0, open: 0, sink: 0, flip: 1, seal: 1, color: C.wire, leg: null });
  Object.assign(fx, { packets: [], bursts: [], floats: [], exitShape: null, exitScale: 0, exitColor: C.ok, cageLit: 0, spark: 0, sealLit: 0, failed: false, tierPulse: 0, youCard: 0, floatQueue: [], floatGap: 0 });
  vault.open = 0; vault.want = 0;
  navKey = '';
  for (const leg of Object.values(LEGS)) leg.p = 0;
  LEGS.end.color = C.wire;
  loginInFlight = false;
  orbit.yaw = 0; orbit.pitch = 0; orbit.zoom = 1;
  $('lines').replaceChildren();
  termPending = [];
  $('term-count').textContent = '';
  $('insp').hidden = true;
  inspDismissed = false;
  view.sel = null; view.hover = null;
  followLive();
  if (full) {
    if (es) { es.close(); es = null; }
    runId = null;
    LOGIN_FORM.classList.remove('gone');
    CREATE_FORM.classList.add('gone');
    $('stamp').hidden = true;
    $('signed-as').textContent = '';
    setDisabled(LOGIN_FORM, false);
    setDisabled(CREATE_FORM, true);
    $('login-note').textContent = '';
    $('login-error').textContent = '';
    $('create-error').textContent = '';
  }
  paintBar();
}

// ------------------------------------------------------------------------------ input

function bindOrbit() {
  let drag = null;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (!navigable()) return;
    // Pan: the right button, or the left with Shift or Cmd (Ctrl elsewhere: Ctrl-click is the
    // right button on a Mac).
    const pan = e.button === 2 || e.shiftKey || e.metaKey;
    if (pan) freeCamera();
    drag = { x: e.clientX, y: e.clientY, yaw: orbit.yaw, pitch: orbit.pitch, pan, target: view.target.slice(), moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      // Hover: what a click would pick.
      view.hover = navigable() ? pick(e.clientX, e.clientY) : null;
      canvas.classList.toggle('pick', !!view.hover);
      return;
    }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.pan) {
      panBy(dx, dy, drag.target);
    } else {
      orbit.yaw = drag.yaw - dx * 0.0035;
      orbit.pitch = clamp(drag.pitch + dy * 0.003, -0.6, 0.9);
    }
  });
  const end = (e) => {
    if (drag && !drag.moved && e.type === 'pointerup' && !drag.pan) {
      const hit = pick(e.clientX, e.clientY);
      if (hit) select(hit.kind, hit.id, { tab: hit.kind === 'node' && hit.id === 'cage' && model.lines.length ? 'output' : 'details' });
    }
    drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag) { view.hover = null; canvas.classList.remove('pick'); } });
  canvas.addEventListener('wheel', (e) => {
    if (!navigable()) return;
    e.preventDefault();
    orbit.zoom = clamp(orbit.zoom * Math.exp(e.deltaY * 0.001), 0.3, 3);
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => {
    const hit = navigable() ? pick(e.clientX, e.clientY) : null;
    if (hit?.kind === 'node' && (hit.id === 'vault' || hit.id.startsWith('box'))) { if (hit.id === 'vault') toggleVault(); return; }
    orbit.yaw = 0; orbit.pitch = 0; orbit.zoom = 1;
  });

  // The keyboard: arrows orbit, WASD pans, + and - zoom, [ and ] step through the nodes,
  // Esc follows the run again.
  document.addEventListener('keydown', (e) => {
    if (!navigable() || e.target.closest('input, textarea, button, [role=button], summary') || e.metaKey || e.ctrlKey) return;
    const k = e.key;
    let used = true;
    if (k === 'ArrowLeft') orbit.yaw += 0.12;
    else if (k === 'ArrowRight') orbit.yaw -= 0.12;
    else if (k === 'ArrowUp') orbit.pitch = clamp(orbit.pitch + 0.08, -0.6, 0.9);
    else if (k === 'ArrowDown') orbit.pitch = clamp(orbit.pitch - 0.08, -0.6, 0.9);
    else if ('wasd'.includes(k.toLowerCase()) && k.length === 1) {
      freeCamera();
      const step = 40;
      const [dx, dy] = { w: [0, step], s: [0, -step], a: [step, 0], d: [-step, 0] }[k.toLowerCase()];
      panBy(dx, dy, view.target.slice());
    } else if (k === '+' || k === '=') orbit.zoom = clamp(orbit.zoom / 1.15, 0.3, 3);
    else if (k === '-' || k === '_') orbit.zoom = clamp(orbit.zoom * 1.15, 0.3, 3);
    else if (k === '[' || k === ']') {
      const shown = NODES.filter((n) => n.show());
      const i = view.sel?.kind === 'node' ? shown.findIndex((n) => n.id === view.sel.id) : -1;
      const next = (i + (k === ']' ? 1 : shown.length - 1) + (i < 0 && k === '[' ? 1 : 0)) % shown.length;
      select('node', shown[next].id);
    } else if (k === 'Escape') { followLive(); }
    else used = false;
    if (used) e.preventDefault();
  });
}

// Pan by a screen distance: the point under the pointer stays under it.
function panBy(dx, dy, from) {
  const dist = len(sub(cam.pos, cam.target)) || 10;
  const k = dist / cam.F;
  const right = norm([cam.r[0], 0, cam.r[2]]);
  const fwd = norm([cam.f[0], 0, cam.f[2]]);
  // Horizontal drags slide sideways; vertical ones move along the ground, as on a table.
  view.target = add(from, add(mul(right, -dx * k), mul(fwd, dy * k)));
}

async function init() {
  resize();
  window.addEventListener('resize', resize);
  bindOrbit();
  LOGIN_FORM.addEventListener('submit', signIn);
  CREATE_FORM.addEventListener('submit', send);
  for (const f of [LOGIN_FORM, CREATE_FORM]) { f.addEventListener('input', previews); f.addEventListener('change', previews); }
  $('cancel').addEventListener('click', () => {
    if (model.sent && !confirm('Cancel this run? Its claim is released (mediatore sandbox delete).')) return;
    // A cancelled run ends without an exit; the engine reports it, the demo only stops.
    post('/api/cancel')
      .then(() => { if (!model.finished) { model.finished = { ok: false, note: 'Cancelled; the claim was released.' }; paintBar(); } })
      .catch((err) => alert(err.message));
  });
  $('again').addEventListener('click', () => reset(true));
  $('insp-toggle').addEventListener('click', () => { if (inspOpen()) closeInspector(); else openInspector('details'); });
  $('insp-close').addEventListener('click', closeInspector);
  $('tab-details').addEventListener('click', () => setTab('details'));
  $('tab-output').addEventListener('click', () => setTab('output'));
  $('follow').addEventListener('click', followLive);
  $('linewrap').append(copyButton(() => model.lines.map((l) => l.text).join('\n')));

  cfg = await (await fetch('/api/config')).json();
  cfg.login = cfg.login || {}; cfg.claim = cfg.claim || {};
  demo = !!cfg.demo;
  if (demo) document.title = 'Recess AgentSandbox (demo)';
  // The sheets start from the server's settings (flags, environment, config file).
  fillForm(LOGIN_FORM, cfg.login);
  fillForm(CREATE_FORM, cfg.claim);
  setDisabled(CREATE_FORM, true);
  previews();
  paintBar();
  if (cfg.run && !cfg.run.finished) {
    setDisabled(LOGIN_FORM, true);
    attach(cfg.run.id);
  } else {
    $('issuer').focus();
  }
  requestAnimationFrame((t) => { last = t; frame(t); });
}

init().catch((err) => { $('cap-title').textContent = 'Could not reach the server'; $('cap-detail').textContent = err.message; });
