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
// The points of that arc, `n` segments: for an edge that should not cut through what lies between.
const arcPts = (a, b, h, n = 14) => Array.from({ length: n + 1 }, (_, i) => arc(a, b, h, i / n));

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
// How far the fog reaches, and whether a line glows unless told: off, as the glow pass (a
// second, wide stroke) is most of a frame's cost. What is picked glows: a view sets `focus` (a
// world point) and `focusR`, and every line drawn within that of it gets the glow pass, whatever
// shape it belongs to; a picked edge asks for it itself.
const THEATRE = { fogFar: 62, glow: false, focus: null, focusR: 0 };
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
  let glow = opts.glow || THEATRE.glow;
  if (!glow && THEATRE.focus && opts.focus !== false) {
    let x = 0, y = 0, z = 0;
    for (const p of pts) { x += p[0]; y += p[1]; z += p[2]; }
    const f = THEATRE.focus, k = pts.length;
    glow = (x / k - f[0]) ** 2 + (y / k - f[1]) ** 2 + (z / k - f[2]) ** 2 < THEATRE.focusR ** 2;
  }
  if (glow) {
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

// The frame loop, on demand: nothing is drawn while nothing moves. A frame runs when something
// asks for one (wake(): input, data from the server, a change of view), and the next only while
// `step` says it is still moving (it returns true) or a wake asked for a while (`ms`). An error
// in a frame is reported (once while it repeats) and does not stop the next wake.
const FRAMES = { tick: null, raf: 0, until: 0 };
function wake(ms = 0) {
  if (ms) FRAMES.until = Math.max(FRAMES.until, performance.now() + ms);
  if (!FRAMES.raf && FRAMES.tick) FRAMES.raf = requestAnimationFrame(FRAMES.tick);
}
function runFrames(step) {
  let reported = '';
  FRAMES.tick = (now) => {
    FRAMES.raf = 0;
    let more = false;
    try {
      more = !!step(now);
    } catch (err) {
      const what = String(err?.stack || err);
      if (what !== reported) { reported = what; console.error('recess: a frame failed; the next one runs', err); }
    }
    if (more || now < FRAMES.until) FRAMES.raf = requestAnimationFrame(FRAMES.tick);
  };
  return FRAMES.tick;
}
// Anything you do may change the picture: a frame, and a few after it for what eases.
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'input', 'change', 'resize', 'focus']) {
  window.addEventListener(type, () => wake(300), { capture: true, passive: true });
}
document.addEventListener('visibilitychange', () => wake(300));
// A slow beat for what changes with time alone (an agent's age, a timer): one frame a second.
setInterval(() => { if (!document.hidden) wake(); }, 1000);

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

// Where the infrastructure stands, the same in every view. The issuer stands low, toward the
// provider plane. The Kubernetes API stands south toward SPIRE, so its edge to SPIRE (the
// entries it declares) runs nearly north-south: about 97 degrees to the Admin view's row of
// providers, which runs east-west. Its Secrets vault goes with it.
const ST = {
  issuer: [-15, 0.7, 2],
  broker: [12, 0.4, -7],
  api: [18.5, 0, -3.5],
  // SPIRE on the same plane as OpenBao.
  spire: [17, 0.6, 8],
};
ST.vault = add(ST.api, [5.6, -1.0, 3.6]);
// The SandboxPolicy (notaio's signed bundle), above the road between the broker that reads it
// and the API that holds the claim it governs.
ST.policy = [15.5, 5.2, -9];
// Its ExposureCeiling (notaio ADR-0007), the approved maximum it is linted against, above it.
const CEILING_DY = 3.2;
ST.ceiling = add(ST.policy, [0, CEILING_DY, 0]);
// OpenBao, as far from the API as from SPIRE (whose PKI it is the upstream CA of), a little
// west of the line between them so the entries edge passes it by.
ST.bao = [15.3, 0.6, 1.9];

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
  // The ExposureCeiling: a lid, a bound pressed down on what is under it (the three ticks), and
  // Security's approval as a seal on its top.
  ceiling: merge(
    { pts: [[-1.1, -0.35, 0], [-1.1, 0, 0], [1.1, 0, 0], [1.1, -0.35, 0]], edges: chain(4) },
    ...[-0.55, 0, 0.55].map((x) => ({ pts: [[x, -0.05, 0], [x, -0.4, 0], [x - 0.12, -0.28, 0], [x + 0.12, -0.28, 0]], edges: [[0, 1], [1, 2], [1, 3]] })),
    moved(ring(0.2, 16, 'xy'), [0, 0.32, 0]), moved(ring(0.1, 10, 'xy'), [0, 0.32, 0]),
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

// The stations as each view draws them: `a` how lit. `t`, the clock, no longer moves them: the
// theatre stands still unless something happens in it.
function drawIssuer(a, t) {
  draw(SHAPES.issuer, ST.issuer, C.ident, a, { ry: 0.3 });
  draw(SHAPES.issuerRing, add(ST.issuer, [0, 1.6, 0]), C.ident, a * 0.8, { rx: 0.25 });
}
function drawBroker(a, t) {
  draw(SHAPES.brokerCore, ST.broker, C.wire, a, { ry: 0.6, rx: 0.3 });
  draw(SHAPES.brokerRing, ST.broker, C.wire, a * 0.8, { rx: 0.5 });
}
function drawApi(a, t) {
  for (const [i, y] of [-0.85, 0, 0.85].entries()) {
    draw(SHAPES.apiPlate, add(ST.api, [0, y, 0]), C.wire, a, { ry: i % 2 ? 0.26 : 0 });
  }
}
// SPIRE: lit once it holds identities for what is shown.
function drawSpire(on, t) {
  const a = on ? 0.95 : 0.35;
  draw(SHAPES.spire, ST.spire, C.spire, a);
  draw(SHAPES.spireOrbit, add(ST.spire, [0, 0.4, 0]), C.spire, a * 0.5, { rx: 0.35, glow: false });
}
// OpenBao: the transit key over its safe, turned to face the camera; lit once it has sealed.
function drawBao(on, t) {
  const a = on ? 0.95 : 0.35;
  draw(SHAPES.baoBody, ST.bao, C.seal, a * 0.8, { glow: false });
  const kf = Math.atan2(cam.pos[0] - ST.bao[0], cam.pos[2] - ST.bao[2]);
  draw(SHAPES.baoKey, add(ST.bao, [0, 1.55, 0]), C.seal, a, { ry: kf, width: on ? 1.5 : 1 });
}
// A policy's ceiling at c (its policy below it): solid with its approval, dashed and red when
// there is none, as notaio then refuses to publish the policy (Ready=False, NoApprovedCeiling).
// The line between them is the bound.
function drawCeiling(c, have, a, t, picked = false) {
  const face = Math.atan2(cam.pos[0] - c[0], cam.pos[2] - c[2]);
  const col = have ? C.policy : C.bad;
  draw(SHAPES.ceiling, c, col, (have ? 0.9 : 0.6) * a, { ry: face, width: picked ? 1.8 : 1.2, glow: picked, dash: have ? null : [3, 4] });
  lines([add(c, [0, -0.45, 0]), add(c, [0, -CEILING_DY + 1.25, 0])], [[0, 1]], col, (have ? 0.45 : 0.3) * a, 1, { dash: [2, 3], glow: false });
}
// An authorization checkpoint at p, facing the camera: a shield, and in it a tick, a cross, or
// a keyhole while nothing is decided. `state` as AUTHZ_COLOR's keys.
function drawShield(p, state, picked = false) {
  const col = C[AUTHZ_COLOR[state]], f = Math.atan2(cam.pos[0] - p[0], cam.pos[2] - p[2]);
  const al = state === 'pending' ? 0.55 : 1, sc = picked ? 1.25 : 1, ink = state === 'pending' ? C.ink : col;
  draw(SHAPES.shield, p, ink, al, { ry: f, scale: sc, width: state === 'pending' ? 1 : 1.5 });
  draw(state === 'ok' ? SHAPES.shieldOk : state === 'bad' ? SHAPES.shieldBad : SHAPES.shieldIdle, p, ink, al, { ry: f, scale: sc, width: 1.5 });
}
const AUTHZ_COLOR = { ok: 'ok', bad: 'bad', gaps: 'seal', pending: 'dim' };
// Every check on a claim's way, from mediatore's code and ADRs: where it runs, what it
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
// Where the policy reaches, as both views draw it: the broker's reflector verifies its bundle
// and the claim's admission decides by it; the reconciler holds the sandbox to it; the gateway's
// authorizer asks the broker for the claim's allowlist, built from it (ADR-0030, ADR-0053).
const AUTHZ_WHERE = { 'authz-broker': 'broker', 'authz-api': 'Kubernetes API', 'authz-gw': 'gateway' };
const AUTHZ_SAYS = {
  'authz-broker': 'The broker decides whether to take the claim at all, at POST /v1/claims, before anything is written: who you are, where, what for, under which policy. A refusal comes back as the broker\'s error, and nothing is created.',
  'authz-api': 'Kubernetes admits the AgentSandbox the broker writes, and the broker\'s reconciler then holds it to the policy: a bundle it has verified, and the sandbox measured against it.',
  'authz-gw': 'While the work runs, every tunnel out and every credential the proxy places is asked of the authorizer on the gateway, which asks the broker for the claim\'s egress. Decided per connection, never once for the run.',
};

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

// ------------------------------------------------------------------------------ the layout

// Ctrl (or Alt, Option on a Mac) and press on a station takes hold of it: drag it and let go,
// or click and click again where it goes; Esc puts it back. It moves across the floor when the
// camera looks down on it, in the upright plane facing the camera when it looks level (Shift
// swaps the two). Ctrl-double-click puts it back where the code stands it. Each move is kept
// as an offset from that place, per view, and saved by the server on your machine (layout.json
// beside config.env), so the next load stands it there again. A shared Recess shows the layout as shipped and saves nothing.
const LAYOUT = { view: '', moved: {}, editable: false, timer: 0 };
async function loadLayout(viewName) {
  LAYOUT.view = viewName;
  try {
    const r = await fetch('/api/layout');
    if (r.ok) {
      const j = await r.json();
      LAYOUT.editable = !!j.editable;
      LAYOUT.moved = (j.views && j.views[viewName]) || {};
    }
  } catch { /* no layout: the code's own places */ }
  for (const h of document.querySelectorAll('.layout-hint')) h.hidden = !LAYOUT.editable;
  return LAYOUT.moved;
}
// The offset of `id`, plus `d`; one back to nothing is dropped. Saved a moment later.
function noteMove(id, d) {
  const o = add(LAYOUT.moved[id] || [0, 0, 0], d);
  if (o.every((v) => Math.abs(v) < 0.005)) delete LAYOUT.moved[id]; else LAYOUT.moved[id] = o;
  saveLayout();
}
function saveLayout() {
  if (!LAYOUT.editable) return;
  clearTimeout(LAYOUT.timer);
  LAYOUT.timer = setTimeout(() => {
    fetch('/api/layout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ view: LAYOUT.view, moved: LAYOUT.moved }, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)),
    }).catch(() => {});
  }, 200);
}
// Move each point in place (a point listed twice, or shared by two lists, moves once).
function shiftPoints(points, d) {
  for (const p of new Set(points)) { p[0] += d[0]; p[1] += d[1]; p[2] += d[2]; }
}
// The ray from the camera through the screen point (x, y).
const screenRay = (x, y) => norm(add(cam.f, add(mul(cam.r, (x - cam.cx) / cam.F), mul(cam.u, (cam.cy - y) / cam.F))));
// Where that ray meets the floor at height p[1], or (upright) the plane through p facing the camera.
function rayHit(x, y, p, upright) {
  const n = upright ? norm([cam.f[0], 0, cam.f[2]]) : [0, 1, 0];
  const d = screenRay(x, y), dn = dot(d, n);
  if (Math.abs(dn) < 1e-3) return null;
  const t = dot(sub(p, cam.pos), n) / dn;
  return t > 0 ? add(cam.pos, mul(d, t)) : null;
}
// Whether a move goes in the upright plane: when the camera looks about level, unless Shift
// (or the thing only stands on the floor).
const moveUpright = (shift, flat = false) => !flat && (Math.abs(cam.f[1]) < 0.35) !== shift;
// Whether this pointer event asks for a move.
const moveKey = (e) => (e.ctrlKey || e.altKey) && LAYOUT.editable;
// A move begun at (x, y) on a station at p; step() gives how far it went since the last step.
function beginMove(x, y, p, upright) {
  const m = { upright, p: p.slice(), last: rayHit(x, y, p, upright) };
  if (!m.last) return null;
  m.step = (x2, y2) => {
    const h = rayHit(x2, y2, m.p, m.upright);
    if (!h) return [0, 0, 0];
    const d = sub(h, m.last);
    m.last = h;
    return m.upright ? d : [d[0], 0, d[2]];
  };
  return m;
}

// The station in hand. The window follows the pointer, not the canvas: macOS makes Ctrl-click a
// right click, and a browser may then send the rest of the press elsewhere, or not at all; a
// station taken up by a click follows the pointer with no button down, over the labels too.
// `shift(d)` moves it; `records` when shift() notes the offset itself (noteMove).
const HAND = { m: null, key: '', shift: null, records: false, total: [0, 0, 0], x: 0, y: 0, carry: false, dropped: 0 };
function takeHold(e, key, p, flat, shift, records = false) {
  const m = beginMove(e.clientX, e.clientY, p, moveUpright(e.shiftKey, flat));
  if (!m) return false;
  Object.assign(HAND, { m, key, shift, records, total: [0, 0, 0], x: e.clientX, y: e.clientY, carry: false });
  canvas.classList.add('moving');
  return true;
}
function letGo(keep) {
  if (!HAND.m) return;
  if (!keep) HAND.shift(mul(HAND.total, -1));
  else if (!HAND.records && len(HAND.total) > 0) noteMove(HAND.key, HAND.total);
  // A drop by a second click is not the double-click that puts a station back.
  if (keep && len(HAND.total) > 0) HAND.dropped = performance.now();
  HAND.m = null;
  canvas.classList.remove('moving');
}
window.addEventListener('pointermove', (e) => {
  if (!HAND.m) return;
  const d = HAND.m.step(e.clientX, e.clientY);
  if (len(d) > 0) { HAND.shift(d); HAND.total = add(HAND.total, d); }
});
window.addEventListener('pointerup', (e) => {
  if (!HAND.m) return;
  // Let go after a drag; after a click, carry it to the next click.
  if (HAND.carry || Math.hypot(e.clientX - HAND.x, e.clientY - HAND.y) > 4) letGo(true);
  else HAND.carry = true;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && HAND.m) { letGo(false); e.stopImmediatePropagation(); }
}, true);

// Marking several, to move them together. Shift-Cmd-drag draws a square that marks every
// movable thing inside it; Cmd-click marks or unmarks one; a Shift-Cmd click, or Esc, clears.
// A move (Ctrl- or Option-drag) of a marked thing carries every marked one by the same amount,
// each kept under its own key. Only where moves are kept; elsewhere Cmd still pans. Each view
// says what a key is (Admin: a group; AgentSandbox: a station) and shows what is marked.
const MARK = { keys: new Set(), box: null, el: null };
const markKey = (e) => e.metaKey && LAYOUT.editable;
function markToggle(key) {
  if (key && !MARK.keys.delete(key)) MARK.keys.add(key);
}
function markDraw(e) {
  const b = MARK.box;
  MARK.el.style.cssText = `left:${Math.min(b.x, e.clientX)}px;top:${Math.min(b.y, e.clientY)}px;width:${Math.abs(e.clientX - b.x)}px;height:${Math.abs(e.clientY - b.y)}px`;
}
// A Shift-Cmd press begins the square; true when it did.
function markBegin(e) {
  if (!e.shiftKey || !markKey(e)) return false;
  if (!MARK.el) {
    MARK.el = document.createElement('div');
    MARK.el.id = 'marquee';
    document.body.append(MARK.el);
  }
  MARK.box = { x: e.clientX, y: e.clientY };
  markDraw(e);
  MARK.el.hidden = false;
  canvas.setPointerCapture(e.pointerId);
  return true;
}
// While the square is up it follows the pointer; true while it is.
function markMove(e) {
  if (!MARK.box) return false;
  markDraw(e);
  return true;
}
// Let go of the square: what `keysIn(x0, y0, x1, y1)` finds inside it (canvas pixels) is the
// marked set; a click with no square clears it. True when a square was up.
function markEnd(e, keysIn) {
  if (!MARK.box) return false;
  const r = canvas.getBoundingClientRect(), b = MARK.box;
  const x0 = Math.min(b.x, e.clientX) - r.left, x1 = Math.max(b.x, e.clientX) - r.left;
  const y0 = Math.min(b.y, e.clientY) - r.top, y1 = Math.max(b.y, e.clientY) - r.top;
  MARK.keys = new Set(e.type === 'pointerup' && x1 - x0 > 4 && y1 - y0 > 4 ? keysIn(x0, y0, x1, y1) : []);
  MARK.box = null;
  MARK.el.hidden = true;
  return true;
}
// Whether the screen point (x, y) of a world point p lies in a square (canvas pixels).
function inSquare(p, x0, y0, x1, y1) {
  const c = toCam(p);
  if (c[2] <= NEAR) return false;
  const [x, y] = proj(c);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !HAND.m && MARK.keys.size) MARK.keys = new Set();
});
