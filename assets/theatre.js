// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

// The base theatre both 3D views stand on: the small wireframe renderer (perspective, near-plane
// clipping, depth fog, a glow pass, on a 2D canvas), the shapes, and the infrastructure every
// claim passes through, in one place for both: the issuer, the broker, the Kubernetes API and its
// Secrets vault, the SandboxPolicy, OpenBao and SPIRE. AgentSandbox (agentsandbox.js) adds one run's
// journey to it; Admin (admin.js) adds every live agent. Loaded first, as a classic script: what it
// declares at the top level is shared with the view loaded after it.

'use strict';

const $ = (id) => document.getElementById(id);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------------------ math

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function rotY(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; }
function rotX(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; }
function rotZ(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; }

// A quadratic arc from a to b, lifted by h at the middle: the legs of the journey.
function arc(a, b, h, t) {
  const c = add(mix(a, b, 0.5), [0, h, 0]);
  const u = 1 - t;
  return [
    u * u * a[0] + 2 * u * t * c[0] + t * t * b[0],
    u * u * a[1] + 2 * u * t * c[1] + t * t * b[1],
    u * u * a[2] + 2 * u * t * c[2] + t * t * b[2],
  ];
}

// ------------------------------------------------------------------------------ palette

const C = {
  wire: [94, 231, 255],
  ident: [167, 139, 250],
  seal: [251, 191, 36],
  ok: [74, 222, 128],
  carrier: [244, 114, 182],
  policy: [251, 146, 60],
  spire: [45, 212, 191],
  bad: [248, 113, 113],
  dim: [52, 66, 90],
  ink: [219, 231, 245],
  muted: [125, 139, 163],
};
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(3)})`;

// ------------------------------------------------------------------------------ canvas and camera

const canvas = $('scene');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;
const NEAR = 0.3;
const cam = { pos: [0, 0, 9], target: [0, 0, 0], r: [1, 0, 0], u: [0, 1, 0], f: [0, 0, -1], F: 1, cx: 0, cy: 0 };

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cam.cx = W / 2; cam.cy = H / 2;
  cam.F = (H / 2) / Math.tan((50 * Math.PI / 180) / 2);
}

function aim(pos, target) {
  cam.pos = pos; cam.target = target;
  const f = norm(sub(target, pos));
  let r = cross(f, [0, 1, 0]);
  r = len(r) < 1e-6 ? [1, 0, 0] : norm(r);
  cam.f = f; cam.r = r; cam.u = cross(r, f);
}
const toCam = (p) => { const d = sub(p, cam.pos); return [dot(d, cam.r), dot(d, cam.u), dot(d, cam.f)]; };
const proj = (c) => [cam.cx + c[0] * cam.F / c[2], cam.cy - c[1] * cam.F / c[2]];
// How far the fog reaches, and whether a line glows unless told: each view sets its own.
const THEATRE = { fogFar: 62, glow: true };
const fog = (z) => clamp(1.25 - z / THEATRE.fogFar, 0.07, 1);

// One segment in camera space, clipped at the near plane.
function seg(a, b) {
  if (a[2] < NEAR && b[2] < NEAR) return;
  if (a[2] < NEAR) a = mix(a, b, (NEAR - a[2]) / (b[2] - a[2]));
  else if (b[2] < NEAR) b = mix(b, a, (NEAR - b[2]) / (a[2] - b[2]));
  const p = proj(a), q = proj(b);
  ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
}

// A set of edges over world points, in one colour: a soft glow pass, then the crisp line.
function lines(pts, edges, color, alpha = 1, width = 1, opts = {}) {
  if (alpha <= 0.01 || !edges.length) return;
  const cs = pts.map(toCam);
  let z = 0, n = 0;
  for (const c of cs) if (c[2] > NEAR) { z += c[2]; n++; }
  if (!n) return;
  const a = alpha * fog(z / n);
  ctx.beginPath();
  for (const [i, j] of edges) seg(cs[i], cs[j]);
  if (opts.dash) ctx.setLineDash(opts.dash);
  if (opts.dashOffset) ctx.lineDashOffset = opts.dashOffset;
  if (opts.glow ?? THEATRE.glow) {
    ctx.strokeStyle = rgba(color, a * 0.16); ctx.lineWidth = width * 4.5; ctx.stroke();
  }
  ctx.strokeStyle = rgba(color, a); ctx.lineWidth = width; ctx.stroke();
  if (opts.dash) { ctx.setLineDash([]); ctx.lineDashOffset = 0; }
}
const chain = (n, closed = false) => {
  const e = [];
  for (let i = 0; i < n - 1; i++) e.push([i, i + 1]);
  if (closed && n > 2) e.push([n - 1, 0]);
  return e;
};
function polyline(pts, color, alpha, width, opts) { lines(pts, chain(pts.length), color, alpha, width, opts); }

// ------------------------------------------------------------------------------ shapes (local)

function box(w, h, d) {
  const x = w / 2, y = h / 2, z = d / 2, pts = [];
  for (const sx of [-x, x]) for (const sy of [-y, y]) for (const sz of [-z, z]) pts.push([sx, sy, sz]);
  const edges = [];
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const k = i ^ j; if (k === 1 || k === 2 || k === 4) edges.push([i, j]); }
  return { pts, edges };
}
function ringPts(r, n, plane = 'xz') {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
    pts.push(plane === 'xz' ? [c, 0, s] : [c, s, 0]);
  }
  return pts;
}
function ring(r, n = 48, plane = 'xz') { return { pts: ringPts(r, n, plane), edges: chain(n, true) }; }
function prism(n, r, h, phase = 0) {
  const pts = [], edges = [];
  for (let i = 0; i < n; i++) { const a = phase + (i / n) * Math.PI * 2; pts.push([Math.cos(a) * r, -h / 2, Math.sin(a) * r]); }
  for (let i = 0; i < n; i++) { const a = phase + (i / n) * Math.PI * 2; pts.push([Math.cos(a) * r, h / 2, Math.sin(a) * r]); }
  for (let i = 0; i < n; i++) { edges.push([i, (i + 1) % n], [n + i, n + ((i + 1) % n)], [i, n + i]); }
  return { pts, edges };
}
function octa(r) {
  const pts = [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]];
  const edges = [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]];
  return { pts, edges };
}
function merge(...shapes) {
  const pts = [], edges = [];
  for (const s of shapes) {
    const o = pts.length;
    pts.push(...s.pts);
    for (const [i, j] of s.edges) edges.push([i + o, j + o]);
  }
  return { pts, edges };
}
function moved(s, d) { return { pts: s.pts.map((p) => add(p, d)), edges: s.edges }; }
// Local to world: scale, rotate (x, then y), translate.
function place(s, at, o = {}) {
  const k = o.scale ?? 1, ry = o.ry ?? 0, rx = o.rx ?? 0, rz = o.rz ?? 0;
  return s.pts.map((p) => add(rotY(rotX(rotZ(mul(p, k), rz), rx), ry), at));
}
function draw(s, at, color, alpha = 1, o = {}) { lines(place(s, at, o), s.edges, color, alpha, o.width ?? 1, o); }
const mixColor = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * clamp(t)));

// ------------------------------------------------------------------------------ the base stations

// Where the infrastructure stands, the same in every view.
const ST = {
  issuer: [-15, 3.2, -15],
  broker: [12, 0.4, -7],
  api: [23, 0, -13],
};
ST.vault = add(ST.api, [5.6, -1.0, 3.6]);
// The SandboxPolicy (notaio's signed bundle), above the road between the broker that reads it
// and the API that holds the claim it governs.
ST.policy = [17.5, 5.2, -16];
// OpenBao, south of the road, beside the broker that asks it to seal; SPIRE south of OpenBao,
// whose PKI is its upstream CA.
ST.bao = [16, 0.6, 0.5];
ST.spire = [17, 1.6, 8];

const SHAPES = {
  issuer: merge(prism(5, 1.1, 2.4, Math.PI / 10), prism(5, 0.55, 3.4, Math.PI / 10)),
  issuerRing: ring(1.9, 40),
  brokerCore: octa(1.15),
  brokerRing: ring(2.1, 56),
  apiPlate: prism(6, 1.9, 0.32, Math.PI / 6),
  vault: merge(box(1.5, 1.5, 1.5), moved(ring(0.42, 24, 'xy'), [0, 0, 0.76]), moved(ring(0.12, 12, 'xy'), [0, 0, 0.76])),
  gateway: octa(0.38),
  packet: octa(0.17),
  audience: merge(ring(0.55, 28, 'xy'), octa(0.22)),
  // The SandboxPolicy: a sheet with a folded corner, its rules, and the signature's seal.
  policyDoc: merge(
    { pts: [[-0.8, 1.05, 0], [0.5, 1.05, 0], [0.8, 0.75, 0], [0.8, -1.05, 0], [-0.8, -1.05, 0]], edges: chain(5, true) },
    { pts: [[0.5, 1.05, 0], [0.5, 0.75, 0], [0.8, 0.75, 0]], edges: chain(3) },
    ...[0.55, 0.3, 0.05, -0.2].map((y, i) => ({ pts: [[-0.55, y, 0], [i === 3 ? 0.1 : 0.5, y, 0]], edges: [[0, 1]] })),
    moved(ring(0.26, 20, 'xy'), [0.38, -0.66, 0]), moved(ring(0.14, 12, 'xy'), [0.38, -0.66, 0]),
  ),
  // The SPIRE server: a spire, its tip the CA, a ring at its waist.
  spire: (() => {
    const n = 6, base = [], edges = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; base.push([Math.cos(a) * 1.0, -1.5, Math.sin(a) * 1.0]); }
    const pts = [...base, [0, 1.9, 0]];
    for (let i = 0; i < n; i++) edges.push([i, (i + 1) % n], [i, n]);
    return merge({ pts, edges }, moved(ring(0.62, 24), [0, -0.3, 0]), moved(octa(0.22), [0, 2.15, 0]));
  })(),
  spireOrbit: ring(1.65, 48),
  // OpenBao: a round safe, and the transit key that floats over it.
  baoBody: merge(prism(10, 0.85, 1.3), moved(ring(0.38, 20), [0, 0.66, 0])),
  baoKey: merge(
    moved(ring(0.3, 18, 'xy'), [-0.7, 0, 0]), moved(ring(0.13, 10, 'xy'), [-0.7, 0, 0]),
    { pts: [[-0.4, 0, 0], [0.75, 0, 0]], edges: [[0, 1]] },
    { pts: [[0.45, 0, 0], [0.45, -0.24, 0], [0.62, 0, 0], [0.62, -0.18, 0], [0.75, 0, 0], [0.75, -0.28, 0]], edges: [[0, 1], [2, 3], [4, 5]] },
  ),
  // An authorization checkpoint: a shield; a tick once it let the claim through, a cross if it
  // refused it, a keyhole while it has not decided.
  shield: { pts: [[-0.42, 0.5, 0], [0.42, 0.5, 0], [0.42, 0.05, 0], [0, -0.58, 0], [-0.42, 0.05, 0]], edges: chain(5, true) },
  shieldIdle: merge(moved(ring(0.09, 10, 'xy'), [0, 0.12, 0]), { pts: [[0, 0.03, 0], [0, -0.2, 0]], edges: [[0, 1]] }),
  shieldOk: { pts: [[-0.2, 0.02, 0], [-0.05, -0.16, 0], [0.22, 0.24, 0]], edges: chain(3) },
  shieldBad: { pts: [[-0.17, 0.25, 0], [0.17, -0.12, 0], [0.17, 0.25, 0], [-0.17, -0.12, 0]], edges: [[0, 1], [2, 3]] },
};

// The stations as each view draws them: `a` how lit, `t` the clock.
function drawIssuer(a, t) {
  draw(SHAPES.issuer, ST.issuer, C.ident, a, { ry: t * 0.25 });
  draw(SHAPES.issuerRing, add(ST.issuer, [0, 1.6 + Math.sin(t * 1.3) * 0.15, 0]), C.ident, a * 0.8, { ry: -t * 0.4, rx: 0.25 });
}
function drawBroker(a, t) {
  draw(SHAPES.brokerCore, ST.broker, C.wire, a, { ry: t * 0.6, rx: t * 0.3 });
  draw(SHAPES.brokerRing, ST.broker, C.wire, a * 0.8, { rx: 0.5, ry: t * 0.2 });
}
function drawApi(a, t) {
  for (const [i, y] of [-0.85, 0, 0.85].entries()) {
    draw(SHAPES.apiPlate, add(ST.api, [0, y, 0]), C.wire, a, { ry: t * 0.15 * (i % 2 ? -1 : 1) });
  }
}
// SPIRE: lit once it holds identities for what is shown.
function drawSpire(on, t) {
  const a = on ? 0.95 : 0.35;
  draw(SHAPES.spire, ST.spire, C.spire, a, { ry: t * 0.2, glow: on });
  draw(SHAPES.spireOrbit, add(ST.spire, [0, 0.4 + Math.sin(t) * 0.25, 0]), C.spire, a * 0.5, { rx: 0.35, ry: t * 0.5, glow: false });
}
// OpenBao: the transit key over its safe, turned to face the camera; lit once it has sealed.
function drawBao(on, t) {
  const a = on ? 0.95 : 0.35;
  draw(SHAPES.baoBody, ST.bao, C.seal, a * 0.8, { ry: -t * 0.15, glow: false });
  const kf = Math.atan2(cam.pos[0] - ST.bao[0], cam.pos[2] - ST.bao[2]);
  draw(SHAPES.baoKey, add(ST.bao, [0, 1.55 + Math.sin(t * 1.1) * 0.12, 0]), C.seal, a, { ry: kf, rz: Math.sin(t * 0.7) * 0.15, glow: on, width: on ? 1.5 : 1 });
}
// The fixed edges between stations, where both views draw them.
const BASE_EDGES = {
  transit: () => [add(ST.broker, [0.8, -0.6, 0.8]), add(ST.bao, [-0.8, 0, 0])],
  entries: () => [add(ST.api, [0, 1, 0]), add(ST.spire, [0, -1.4, 0])],
  pki: () => [add(ST.bao, [0, 0.8, 0]), add(ST.spire, [0, -1.4, 0])],
};

// ------------------------------------------------------------------------------ what both views say

// mediatore's design, as both views' details panels state it: rows of [what, value].
const DESIGN = {
  spire: {
    summary: 'Issues every SPIFFE identity on the sandbox path. The broker never talks to it: it declares entries as ClusterStaticEntry objects in the Kubernetes API, and the SPIRE Controller Manager puts them on the server (ADR-0006).',
    attestation: [
      ['attestor', "the VM's TPM (ADR-0018), or x509pop with a certificate its host signs (ADR-0049)"],
      ['trust bundle', 'fetched at every boot through the gateway relay, port 3131 (ADR-0037)'],
      ['Workload API', 'the node SVID to the guest agent, the claim SVID to the egress proxy, by their selectors'],
    ],
    ca: [['upstream authority', 'OpenBao PKI signs the server\'s intermediate CA (UpstreamAuthority "vault", deploy/spire-upstream)']],
  },
  openbao: {
    summary: 'Holds the transit key that seals your credentials and the workload\'s stored output. The key never leaves it: the broker sends plaintext in and gets an envelope back, bound to the sandbox. Recess cannot reach OpenBao; what it sees is the envelopes.',
    transit: [
      ['context', 'the sandbox UID: an envelope moved onto another claim does not open'],
      ['envelope', 'key_id transit:<mount>/<key>; the vault:vN: ciphertext OpenBao returns'],
      ['rotation', 'the version prefix keeps a rotated key readable'],
      ['seals', 'the issuer session (refresh token), each delegated credential, each stored output batch (ADR-0052)'],
    ],
    login: [
      ['token', 'a projected ServiceAccount token, audience openbao, exchanged for a short-lived OpenBao token held in memory (ADR-0015)'],
      ['at rest', 'no OpenBao token, no key, nothing in a Secret or on disk'],
    ],
    pki: [['used by', "the SPIRE server, as its upstream CA: it signs the server's intermediate, rotated every ca_ttl"]],
  },
};
