// Copyright (c) 2026 Erick Bourgeois, Low Tide
// SPDX-License-Identifier: Apache-2.0
//
// The page follows the mediatore CLI's process: mint the token, create the workload, seal the
// credentials, run it in the sandbox, stream its output, read its exit code. Each stage is a
// card; the connector to the next draws itself down when that stage starts and darkens once
// the run has passed it. Everything shown comes from the server's event stream; nothing here
// ever sees a token. All text is set with textContent, never as HTML.

'use strict';

const STEPS = [
  { id: 'mint', title: 'mediatore login', sub: 'mint the token: OIDC with PKCE at the issuer, the session kept on disk' },
  { id: 'create', title: 'mediatore sandbox create', sub: 'the workload: POST /v1/claims, the broker creates the AgentSandbox' },
  { id: 'seal', title: 'Seal credentials', sub: 'your refresh token and delegated credentials, sealed into Secrets' },
  { id: 'run', title: 'Run in the sandbox', sub: 'claim a VM, attest, build the jail, nsjail enter, exec' },
  { id: 'logs', title: 'Output', sub: 'redacted in the VM, streamed by the broker as it runs' },
  { id: 'exit', title: 'Exit code', sub: 'status.record.exit, reported by the guest' },
];

const $ = (id) => document.getElementById(id);

// The two forms, held by reference: they move into their cards, and a rebuild of the flow
// detaches the old cards (getElementById no longer finds what they held).
const LOGIN_FORM = document.getElementById('login-form');
const CREATE_FORM = document.getElementById('create-form');
const RUN_BUTTON = document.getElementById('run');

function el(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) {
    if (k == null || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

// A copy-to-clipboard button: the two-sheet icon, a check for a moment once copied. `text`
// is called at click time, so a live stream copies what has arrived by then.
function copyButton(text) {
  const NS = 'http://www.w3.org/2000/svg';
  const icon = (paths) => {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  };
  const sheets = ['M5.5 5.5h7v8h-7z', 'M3.5 10.5v-8h7'];
  const check = ['M3 8.5l3 3 7-7'];
  const b = el('button', 'copy', icon(sheets));
  b.type = 'button';
  b.title = 'Copy output';
  b.setAttribute('aria-label', 'Copy output');
  b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const s = text();
    let ok = false;
    try {
      await navigator.clipboard.writeText(s);
      ok = true;
    } catch {
      const ta = el('textarea');
      ta.value = s;
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    }
    b.replaceChildren(icon(ok ? check : sheets));
    b.classList.toggle('done', ok);
    b.title = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => {
      b.replaceChildren(icon(sheets));
      b.classList.remove('done');
      b.title = 'Copy output';
    }, 1400);
  });
  return b;
}

// The output box runs from where it starts to the bottom of the window, whatever the font
// size or zoom: its top is measured on the page, not the viewport, so scrolling does not
// change it. Called on each render and on resize (zooming is a resize).
function fitTerm() {
  const term = $('term');
  if (!term || !term.isConnected || term.offsetParent === null) return;
  const top = term.getBoundingClientRect().top + window.scrollY;
  term.style.height = `${Math.max(160, window.innerHeight - top - 16)}px`;
}
window.addEventListener('resize', () => requestAnimationFrame(fitTerm));

function facts(pairs) {
  const dl = el('dl', 'facts');
  for (const [k, v] of pairs) {
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    dl.append(el('dt', null, k), el('dd', null, v instanceof Node ? v : Array.isArray(v) ? v.join(', ') : String(v)));
  }
  return dl;
}

function chips(list, cls) {
  const d = el('div', 'chips');
  for (const x of list) d.append(el('span', 'chip' + (cls ? ' ' + cls : ''), x));
  return d;
}

// A secret's name, in red, with a lock when it is sealed at rest.
function secretTag(name, sealed, presence) {
  const s = el('span', 'secret' + (presence ? ' ' + presence : ''), name);
  if (sealed) {
    const sup = el('sup', 'lock', '🔒');
    sup.title = 'sealed at rest (AES-256-GCM envelope)';
    s.append(sup);
  }
  return s;
}

// Addresses as chips: "198.51.100.40 (InternalIP)" becomes the address, typed.
function ips(list) {
  const d = el('div', 'chips');
  for (const a of list || []) {
    const m = /^(\S+)(?: \((.+)\))?$/.exec(a) || [a, a, ''];
    const c = el('span', 'ip', m[1]);
    if (m[2]) c.append(el('span', 'ip-type', m[2]));
    d.append(c);
  }
  return d;
}

// The broker's refusal, as the CLI reports it: "mediatore: 400 Bad Request {"error": ..., "detail": ...}".
function brokerError(note) {
  const m = /^mediatore: (\d{3})[^{]*(\{.*\})\s*$/s.exec(note || '');
  if (!m) return null;
  try {
    const j = JSON.parse(m[2]);
    return { status: m[1], error: j.error || '', detail: j.detail || j.message || '' };
  } catch { return null; }
}

// What to do about a refusal the broker names.
const REFUSAL_HINTS = {
  unreachable_registry: 'The pool pulls only from the registries the broker lists for it (registries[].reach, ADR-0029). Use an image from one of them; set your default with LOW_TIDE_WORKLOAD in the config file.',
  namespace_required: 'This broker serves several namespaces: name one (MEDIATORE_NAMESPACE).',
  forbidden: 'The broker does not allow this claim for your identity: check who may claim in the namespace (ADR-0046) and the policy it names.',
  not_implemented: 'The broker has this feature off (for --logs: logs.enabled in its config).',
};

// 🔒 with what it means; only for what has happened (a stage done, an envelope that exists).
function lockIcon(why) {
  const l = el('span', 'lock-ic', '🔒');
  l.title = why;
  l.setAttribute('aria-label', why);
  return l;
}

function urlLock(url) {
  return /^https:\/\//i.test(url || '') ? lockIcon('TLS: an https URL') : null;
}

// Why a stage carries a lock, or null.
function lockFor(id) {
  if (!model) return null;
  const s = model.steps;
  const st = s[id];
  if (id === 'mint' && st.state === 'done') return `Authorized: the issuer minted your ID token (OIDC with PKCE, over TLS)${s.mint.data.identity ? ' for ' + (s.mint.data.identity.username || s.mint.data.identity.subject) : ''}`;
  if (id === 'create' && s.create.data.claim) return 'Authorized: the broker verified your ID token and pinned you as the sandbox\'s subject';
  const sealed = (s.seal.data.secrets || []).some((x) => x.sealed && x.presence === 'held' && x.place === 'kube');
  if (id === 'seal' && sealed) return 'Encrypted at rest: AES-256-GCM envelopes bound to the sandbox UID, in the broker\'s Secrets';
  if (id === 'run' && s.run.obj && s.run.obj.status && s.run.obj.status.record && s.run.obj.status.record.entryId) return 'Authorized: the claim\'s SPIRE entry is set (the claim SVID); the guest talks to the broker over mTLS with its node SVID';
  if (id === 'logs' && (s.seal.data.kubeSecrets || []).some((k) => (k.labels || {})['mediatore.io/logs'] && (k.annotations || {})['mediatore.io/seal'])) return 'Encrypted at rest: the output is sealed per batch';
  return null;
}

function paintLock(id) {
  const why = lockFor(id);
  for (const slot of [card(id)?.querySelector('.stage-right .lock-slot'), node(id)?.querySelector('.lock-slot')]) {
    if (!slot) continue;
    slot.replaceChildren(...(why ? [lockIcon(why)] : []));
  }
}

// The run's sub-steps that are authorizations or encrypted channels.
const PHASE_LOCKS = {
  entry: 'Authorized: SPIRE issues the claim SVID to this VM only',
  attest: 'Attested: the node identity comes from the VM\'s TPM endorsement key',
  build: 'mTLS: the guest fetched its sandbox from the broker with its node SVID',
};

function section(title, ...kids) {
  return el('div', 'section', el('p', 'subhead', title), ...kids);
}

const ts = (s) => (s ? new Date(s).getTime() : NaN);
function clock(s) {
  const d = new Date(s);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour12: false });
}
function dur(ms) {
  if (!isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}
function epoch(n) {
  if (!n) return '';
  const d = new Date(n * 1000);
  const mins = Math.round((d - Date.now()) / 60000);
  return `${d.toLocaleString()} (${mins >= 0 ? 'in ' + mins + ' min' : Math.abs(mins) + ' min ago'})`;
}
function quoteArgs(args) {
  return (args || []).map((a) => (a === '' || /[\s'"\\$`;&|<>()*?[\]#~]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}
function safeLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const a = el('a', 'authlink', url.length > 140 ? url.slice(0, 140) + '…' : url);
    a.href = u.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  } catch { return null; }
}

// ---------------------------------------------------------------- model

let model = null;
let es = null;
let follow = true;
let demo = false;
let runId = null;

function freshModel() {
  const m = { steps: {}, finished: null };
  for (const s of STEPS) {
    m.steps[s.id] = { state: 'pending', note: '', started: null, ended: null, data: {}, notes: [], lines: [], timeline: [], obj: null, phases: [], header: null, counts: { stdout: 0, stderr: 0 } };
  }
  return m;
}

// ---------------------------------------------------------------- DOM

function svgLink(i, h) {
  const li = el('li', 'link');
  li.id = `link-${i}`;
  li.setAttribute('aria-hidden', 'true');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', String(h));
  const mk = (tag, attrs) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  };
  mk('line', { class: 'track', x1: 10, y1: 0, x2: 10, y2: h });
  mk('line', { class: 'fill', x1: 10, y1: 0, x2: 10, y2: h, pathLength: 1 });
  mk('circle', { class: 'dot', cx: 10, cy: 0, r: 3.5 });
  li.append(svg);
  return li;
}

// The rail on the left holds every stage as a small node, joined by connectors that draw and
// darken as the run passes; the focus area on the right holds one stage's full card at a time.
function buildFlow() {
  const rail = $('rail');
  const flow = $('flow');
  rail.replaceChildren();
  flow.replaceChildren();
  STEPS.forEach((s, i) => {
    if (i > 0) rail.append(svgLink(i, 22));
    const node = el('li', 'node pending',
      el('span', 'num', i + 1),
      el('span', 'n-main', el('span', 'n-title', el('span', 'n-text', s.title), el('span', 'lock-slot')), el('span', 'n-note', '')),
      el('span', 'n-side', el('span', 'spinner'), el('span', 'n-timer', '')));
    node.id = `node-${s.id}`;
    node.tabIndex = 0;
    node.addEventListener('click', () => pickStage(s.id));
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickStage(s.id); } });
    node.addEventListener('mouseenter', () => showTip(s.id, node));
    node.addEventListener('mouseleave', hideTip);
    node.addEventListener('focus', () => showTip(s.id, node));
    node.addEventListener('blur', hideTip);
    rail.append(node);

    const card = el('li', 'stage pending');
    card.id = `stage-${s.id}`;
    card.hidden = true;
    card.append(
      el('div', 'stage-head',
        el('div', 'num', i + 1),
        el('div', null, el('div', 'stage-title', s.title), el('div', 'stage-sub', s.sub)),
        el('div', 'stage-right', el('span', 'lock-slot'), el('span', 'spinner'), el('span', 'timer'), el('span', 'badge', 'pending'))),
      el('div', 'form-slot'),
      el('div', 'stage-body', el('p', 'note'), el('div', 'content')));
    flow.append(card);
  });
  $('finish').hidden = true;
  // The forms are the same nodes across rebuilds: what was typed stays.
  card('mint').querySelector('.form-slot').append(LOGIN_FORM);
  card('create').querySelector('.form-slot').append(CREATE_FORM);
  shown = null;
  paintForms();
  applyFocus(false);
}

// Which form is open: login before a run (and after one ends, for the next claim: one login
// per claim); the workload once the token is minted, until it is handed over.
function paintForms() {
  if (!model) return;
  const running = runId && !model.finished;
  const loginOpen = !running;
  const createOpen = running && !model.steps.create.submitted;
  LOGIN_FORM.hidden = !loginOpen;
  CREATE_FORM.hidden = !createOpen;
  card('mint').classList.toggle('has-form', loginOpen);
  card('create').classList.toggle('has-form', createOpen);
  LOGIN_FORM.querySelector('button[type=submit]').disabled = running;
  $('delete').hidden = !(running && model.steps.create.submitted);
  const waiting = running && model.steps.create.waiting;
  RUN_BUTTON.disabled = !waiting;
  RUN_BUTTON.textContent = waiting ? 'Run' : 'Run (after login)';
}

const card = (id) => $(`stage-${id}`);
const node = (id) => $(`node-${id}`);
const content = (id) => card(id).querySelector('.content');

function paintState(id) {
  const st = model.steps[id];
  const c = card(id);
  c.className = `stage ${st.state}`;
  c.querySelector('.badge').textContent = st.state;
    const note = c.querySelector('.note');
  const refused = st.state === 'failed' ? brokerError(st.note) : null;
  note.textContent = refused ? `${refused.status} ${refused.error}` : (st.note || '');
  note.hidden = !st.note;
  paintNode(id);
  paintLinks();
  paintForms();
}

function paintNode(id) {
  const st = model.steps[id];
  const n = node(id);
  if (!n) return;
  n.className = `node ${st.state}${id === shown ? ' focused' : ''}`;
    const refused = st.state === 'failed' ? brokerError(st.note) : null;
    const stalled = id === 'run' && st.stall && st.state === 'active';
  n.classList.toggle('stalled', !!stalled);
  n.querySelector('.n-note').textContent = stalled ? `⚠ stalled at ${st.stall.title}`
    : refused ? `${refused.status} ${refused.error}` : st.note || (st.state === 'pending' ? '' : st.state);
}

function paintLinks() {
  STEPS.forEach((s, i) => {
    if (i === 0) return;
    const a = model.steps[STEPS[i - 1].id].state;
    const b = model.steps[s.id].state;
    let cls = 'link';
    if (b === 'failed') cls += ' failed';
    else if (b === 'done' || b === 'skipped') cls += ' passed';
    else if (b === 'active' || a === 'done' || a === 'skipped') cls += ' drawing';
    $(`link-${i}`).className = cls;
  });
}

function tickTimers() {
  if (!model) return;
  for (const s of STEPS) {
    const st = model.steps[s.id];
    const text = st.started ? dur((st.ended ?? Date.now()) - st.started) : '';
    const t = card(s.id)?.querySelector('.timer');
    if (t) t.textContent = text;
        const nt = node(s.id)?.querySelector('.n-timer');
    if (nt) nt.textContent = text;
  }
  for (const sp of document.querySelectorAll('.since[data-since]')) sp.textContent = dur(Date.now() - ts(sp.dataset.since));
  pump();
}
setInterval(tickTimers, 250);

// ---------------------------------------------------------------- focus

// Stages pop into focus in the order they start; one that starts while another is fresh waits
// its turn (seal and run start together), so each is on screen for a moment. A click on the
// rail pins a stage; "Back to live" (or Follow) unpins.
const DWELL_MS = 1600;
let shown = null;
let shownAt = 0;
let pinned = null;
let queue = [];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// An event older than this is a replay (a reload, or attaching to a run under way): the focus
// catches up at once, without animation or turns.
const REPLAY_MS = 3000;
let replaying = false;

function enqueue(id) {
  if (replaying) {
    queue = [];
    if (!pinned && follow) focusOn(id, false);
    return;
  }
  if (!queue.includes(id) && id !== shown) queue.push(id);
  pump();
}

function pump() {
  if (!model || pinned || !follow) return;
  if (!queue.length) return;
  const cur = shown && model.steps[shown];
  const settled = !cur || cur.state !== 'active' || (shown === 'create' && model.steps.create.waiting === false);
  if (settled || Date.now() - shownAt >= DWELL_MS) {
    const next = queue.shift();
    focusOn(next);
  }
}

function focusOn(id, animate = true) {
  if (id === shown) return;
  const prev = shown;
  shown = id;
  shownAt = Date.now();
  applyFocus(animate && !replaying, prev);
  // The focus animation moves the output box; size it again where it lands.
  if (id === 'logs') for (const ms of [0, 450]) setTimeout(() => requestAnimationFrame(fitTerm), ms);
}

function pickStage(id) {
  const st = model.steps[id];
  if (st.state === 'pending' && !card(id).classList.contains('has-form')) return;
  pinned = id;
  focusOn(id);
  paintFocusBar();
}

function unpin() {
  pinned = null;
  follow = true;
  $('follow').classList.add('on');
  // Back to the newest stage under way, else the last one reached.
  const live = [...STEPS].reverse().find((s) => model.steps[s.id].state === 'active')
    || [...STEPS].reverse().find((s) => model.steps[s.id].state !== 'pending');
  queue = [];
  focusOn(model.finished ? (model.steps.exit.state !== 'pending' ? 'exit' : failedStep() || 'mint') : (live ? live.id : 'mint'));
  paintFocusBar();
}

function failedStep() {
  const f = STEPS.find((s) => model.steps[s.id].state === 'failed');
  return f && f.id;
}

function paintFocusBar() {
  const bar = $('focus-bar');
  if (pinned) {
    const back = el('button', 'ghost', 'Back to live');
    back.type = 'button';
    back.addEventListener('click', unpin);
    bar.replaceChildren(el('span', null, `Viewing ${STEPS.find((s) => s.id === pinned).title}`), back);
    bar.hidden = false;
  } else {
    bar.replaceChildren();
    bar.hidden = true;
  }
}

// The leaving card shrinks into its node on the rail; the arriving one pops up.
function applyFocus(animate, prev) {
  if (!shown) shown = 'mint';
  for (const s of STEPS) paintNode(s.id);
  const next = card(shown);
  const from = prev && card(prev);
  if (!animate || reduced || !from || from.hidden) {
        for (const s of STEPS) card(s.id).hidden = s.id !== shown;
    next.hidden = false;
    next.querySelectorAll('.net').forEach((n) => requestAnimationFrame(() => drawWires(n)));
    return;
  }
  const a = from.getBoundingClientRect();
  const b = node(prev).getBoundingClientRect();
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const scale = Math.max(0.06, b.width / a.width);
  from.classList.add('leaving');
  const leave = from.animate(
    [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0 }],
    { duration: 480, easing: 'cubic-bezier(.55,0,.25,1)' });
  leave.onfinish = () => { from.hidden = true; from.classList.remove('leaving'); };
  node(prev).animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
    { duration: 420, delay: 380, easing: 'ease-out' });
  setTimeout(() => {
    for (const s of STEPS) if (s.id !== shown && s.id !== prev) card(s.id).hidden = true;
        next.hidden = false;
    next.querySelectorAll('.net').forEach((n) => requestAnimationFrame(() => drawWires(n)));
    next.animate(
      [{ opacity: 0, transform: 'translateY(26px) scale(.96)' }, { opacity: 1, transform: 'none' }],
      { duration: 460, easing: 'cubic-bezier(.2,.9,.3,1.15)' });
  }, 220);
}

// ---------------------------------------------------------------- tooltips

function summary(id) {
  const s = model.steps;
  const st = s[id];
  const lines = [];
  if (id === 'mint') {
    const idn = s.mint.data.identity;
    const ses = s.mint.data.session;
    if (idn) lines.push(`${idn.username || idn.subject} · ${(idn.groups || []).length} groups`, (idn.groups || []).join(', '));
    if (ses) lines.push(`token: ${ses.path} (0${ses.mode})`);
    if (!idn && s.mint.data.login) lines.push(`issuer ${s.mint.data.login.issuer}`);
  } else if (id === 'create') {
    const c = s.create.data.claim;
    const w = s.create.data.workload;
    if (c) lines.push(`AgentSandbox ${c.namespace}/${c.name}`);
    if (w) lines.push(`${w.image} ${quoteArgs(w.args)}`.slice(0, 120));
    if (s.create.state === 'failed') lines.push(brokerError(s.create.note)?.detail || s.create.note);
  } else if (id === 'seal') {
    const xs = s.seal.data.secrets || [];
    const sealed = xs.filter((x) => x.sealed && x.presence === 'held').length;
    const ram = xs.filter((x) => x.memory && x.presence === 'possible').length;
    if (xs.length) lines.push(`${sealed} sealed envelope${sealed === 1 ? '' : 's'} · ${ram} possibly in memory`);
    const vm = s.seal.data.memberVm;
    if (vm && vm.name) lines.push(`VM ${vm.name} ${(vm.addresses || [])[0] || ''}`);
    if ((s.seal.data.gateways || []).length) lines.push(`${s.seal.data.gateways.length} gateways`);
  } else if (id === 'run') {
    const o = s.run.obj;
    if (o) lines.push(`phase ${o.status?.phase || 'Pending'}${(o.status?.addresses || []).length ? ' · ' + o.status.addresses.join(', ') : ''}`);
    const cur = s.run.phases.find((p) => p.state === 'active' || p.state === 'failed');
    const done = s.run.phases.filter((p) => p.state === 'done').length;
        if (s.run.phases.length) lines.push(`${done}/${s.run.phases.length} steps${cur ? ' · now: ' + cur.title : ''}`);
    if (s.run.stall) lines.push(`⚠ no progress for ${dur(Date.now() - ts(s.run.stall.since))}: ${s.run.stall.hint}`);
    if (s.run.pool && !s.run.pool.missing) lines.push(`pool ${s.run.pool.name}: ${s.run.pool.available} available, ${s.run.pool.provisioning} provisioning`);
  } else if (id === 'logs') {
    lines.push(`${st.lines.length} lines (stdout ${st.counts.stdout}, stderr ${st.counts.stderr})`);
    const last = st.lines[st.lines.length - 1];
    if (last) lines.push(`last: ${last.text.slice(0, 100)}`);
  } else if (id === 'exit') {
    const d = s.exit.data;
    if (d.code != null) lines.push(`exit code ${d.code}${d.restarts ? ' · ' + d.restarts + ' restarts' : ''}`);
    else if (d.signal != null) lines.push(`killed by signal ${d.signal}`);
  }
  if (st.note && !lines.includes(st.note)) lines.unshift(st.note);
  return lines.filter(Boolean);
}

function showTip(id, anchor) {
  if (!model) return;
  const tip = $('tip');
  const st = model.steps[id];
  const s = STEPS.find((x) => x.id === id);
  const lines = summary(id);
  tip.replaceChildren(
    el('div', 'tip-head', el('span', null, s.title), el('span', 'tip-state ' + st.state, st.state)),
    ...lines.map((l) => el('div', 'tip-line', l)),
    el('div', 'tip-hint', st.state === 'pending' ? 'not reached yet' : 'click to bring into focus'));
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const wide = window.innerWidth > 820;
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 12, wide ? r.right + 12 : r.left)}px`;
  tip.style.top = `${Math.max(8, wide ? r.top + window.scrollY : r.bottom + window.scrollY + 8)}px`;
}

function hideTip() {
  $('tip').hidden = true;
}

// ---------------------------------------------------------------- renderers

const render = {
  mint(st) {
    const d = st.data;
        const frag = document.createDocumentFragment();
    if (d.command && model.steps.mint.state !== 'pending') frag.append(el('pre', 'cmd ran', d.command));
    const login = d.login || {};
    const l = section('login',
      login.reused ? el('p', 'note', 'A fresh session with its delegation unspent was reused.') : null,
      facts([
        ['issuer', login.issuer ? el('span', null, login.issuer, ' ', urlLock(login.issuer)) : null],
        ['client', login.clientId],
                ['scopes', login.scopes ? chips(login.scopes) : null],
        ['auth params', login.authParams],
        ['login hint', login.loginHint],
        ['redirect', login.redirect],
        ['private CA', login.privateCa ? 'yes: nothing else is trusted' : null],
        ['client secret', login.clientSecret ? secretTag('from file, sent to the token endpoint') : null],
      ]));
    if (d.authorizeUrl) {
      l.append(el('p', 'note', 'Waiting for you to finish in the browser. If no tab opened:'));
      const a = safeLink(d.authorizeUrl);
      if (a) l.append(a);
    }
    const s = d.session;
    const tok = s ? section('token stored',
      facts([
        ['file', s.path],
        ['mode', s.mode ? el('span', 'chip ' + (s.mode === '600' ? 'ok' : 'warn'), '0' + s.mode) : null],
        [secretTag('ID token'), s.idTokenExpiresAt ? `in this file, in the clear · ${s.idTokenFresh ? 'valid' : 'expired'} until ${new Date(s.idTokenExpiresAt).toLocaleString()}` : ''],
        ['fingerprint', s.idTokenFingerprint ? `sha256:${s.idTokenFingerprint}…` : ''],
        [secretTag('refresh token'), s.refreshToken ? `in this file, in the clear · ${s.refreshToken}` : ''],
      ])) : null;
    const id = d.identity;
    let who = null;
    if (id) {
      const name = id.username || id.name || id.subject || '?';
      who = section('identity & groups',
        el('div', 'who', el('div', 'avatar', name.slice(0, 1).toUpperCase()),
          el('div', null, el('div', 'name', name), el('div', 'mail', id.email || id.subject || ''))),
        (id.groups || []).length ? chips(id.groups) : el('p', 'note', 'The ID token carries no groups claim.'),
        facts([
          ['subject', id.subject],
          ['issuer', id.issuer ? el('span', null, id.issuer, ' ', urlLock(id.issuer)) : null],
          ['audience', id.audience],
          ['expires', epoch(id.expiresAt)],
          ['claims', id.claimNames],
        ]),
        el('p', 'note', 'Decoded for display; the broker verifies the signature on every call.'));
    }
    frag.append(el('div', 'cols3', l, tok, who));
    return frag;
  },
    create(st) {
    const frag = document.createDocumentFragment();
    if (!st.data.workload) return frag; // the form is the content until the workload is given
    const w = st.data.workload;
    const c = st.data.claim;
    if (st.data.command) frag.append(el('pre', 'cmd ran', st.data.command));
    for (const n of st.notes) frag.append(el('p', 'note', n));
    const left = section('workload', facts([
      ['image', w.image],
      ['args', quoteArgs(w.args)],
      ['restart', w.restart || 'never'],
      ['output', w.logs ? 'captured' : 'not captured'],
      ['ttl', w.ttl ? `${w.ttl} s` : ''],
      ['namespace', w.namespace || 'broker default'],
      ['pool', w.pool || (w.poolSelector?.length ? w.poolSelector.join(', ') : 'any in the namespace')],
      ['strategy', w.strategy],
      ['audiences', w.audiences],
      ['delegated', (w.delegate || []).length ? el('span', null, ...w.delegate.map((a) => secretTag(a + ' credential'))) : null],
      ['policy', w.policy],
    ]));
        const refused = st.state === 'failed' && !c ? brokerError(st.note) : null;
    if (st.state === 'failed' && !c) {
      const box = el('div', 'refusal',
        el('div', 'refusal-head', el('span', 'refusal-code', refused ? `${refused.status} ${refused.error}` : 'refused'), 'the broker refused the claim; nothing was created'),
        refused && refused.detail ? el('div', 'refusal-detail', refused.detail) : null,
        refused && REFUSAL_HINTS[refused.error] ? el('div', 'refusal-hint', REFUSAL_HINTS[refused.error]) : null);
      frag.append(el('div', 'cols', left, box));
      return frag;
    }
    const right = c ? section('AgentSandbox created', facts([
      ['name', c.name],
      ['namespace', c.namespace],
      ['sandbox uid', c.sandbox_uid],
      ['claim uid', c.uid],
      ['phase', c.phase],
    ])) : section('AgentSandbox', el('p', 'note', 'POST /v1/claims in flight; your refresh token goes with it, once.'));
    frag.append(el('div', 'cols', left, right));
    return frag;
  },
  seal(st) {
    const d = st.data;
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'legend secrets-legend',
      el('span', null, secretTag('secret'), ' observed'),
      el('span', null, secretTag('secret', false, 'possible'), ' possible (in a process, not observable)'),
      el('span', null, secretTag('', true), ' sealed at rest'),
      el('span', null, el('span', 'ram', 'RAM'), ' memory only'),
      el('span', null, secretTag('secret', false, 'gone'), ' gone')));
    const secrets = d.secrets || [];
    const vmName = d.memberVm?.name;
    const vmIp = (d.memberVm?.addresses || [])[0]?.split(' ')[0];
    const lanes = [
      ['laptop', 'Your machine', 'plain files, owner-only'],
      ['kube', `Kubernetes API · ${d.brokerNamespace || '?'}`, 'etcd, through the broker\'s sealer'],
      ['broker', 'Broker', 'process memory'],
      ['vm', `Sandbox VM${vmName ? ' · ' + vmName : ''}${vmIp ? ' · ' + vmIp : ''}`, 'the member banlieue bound'],
      ['gateway', `Egress gateways${(d.gateways || []).length ? ' · ' + d.gateways.length : ''}`, 'the authorizer\'s cache'],
    ];
    const map = el('div', 'lanes');
    for (const [place, title, sub] of lanes) {
      const items = secrets.filter((x) => x.place === place);
      if (!items.length) continue;
      const lane = el('div', 'lane lane-' + place, el('div', 'lane-head', el('span', 'lane-title', title), el('span', 'lane-sub', sub)));
      for (const x of items) {
        lane.append(el('div', 'srow ' + x.presence,
          el('div', 'srow-top', secretTag(x.name, x.sealed, x.presence), x.memory ? el('span', 'ram', 'RAM') : null, el('span', 'presence', x.presence)),
          el('div', 'swhere', x.where),
          x.note ? el('div', 'snote', x.note) : null));
      }
      map.append(lane);
    }
    frag.append(map);
    if ((d.kubeSecrets || []).length) {
      const list = el('ul', 'timeline');
      for (const k of d.kubeSecrets) {
        const lab = k.labels || {};
        const kind = lab['mediatore.io/logs'] ? 'output' : lab['mediatore.io/audience'] ? `delegation · ${lab['mediatore.io/audience']}` : `session · ${lab['mediatore.io/session'] || ''}`;
        const sealedMark = lab['mediatore.io/logs'] ? !!(k.annotations || {})['mediatore.io/seal'] : true;
        list.append(el('li', null, el('span', 't', clock(k.created)), el('span', 'what', secretTag(k.name, sealedMark), el('span', 'arrow', `  ${kind}`))));
      }
      frag.append(section(`Secrets in ${d.brokerNamespace} (metadata only, never data)`, list));
    }
    for (const n of st.notes) frag.append(el('p', 'note', n));
    return frag;
  },
    run(st) {
    const o = st.obj;
    const frag = document.createDocumentFragment();
    if (st.stall) {
      frag.append(el('div', 'stall',
        el('div', 'stall-head', '⚠ No progress for ', sinceSpan(st.stall.since), ` at “${st.stall.title}”`),
        el('div', 'stall-hint', st.stall.hint)));
    }
        if (st.pool && !st.pool.missing) frag.append(poolLine(st.pool, !!(o && o.status && o.status.boundAt)));
    // The sub-steps, in the guest's order.
    const rail = el('ol', 'subflow');
    const created = ts(o?.metadata?.creationTimestamp);
        for (const p of st.phases) {
      const rel = p.at && isFinite(created) ? '+' + dur(ts(p.at) - created) : '';
      // While the claim waits, banlieue's reason goes on the step it explains.
      if (p.key === 'bind' && p.state === 'active' && st.pool && st.pool.claim && st.pool.claim.status !== 'True') {
        p.detail = `${st.pool.claim.reason}: ${st.pool.claim.message}`;
      }
      rail.append(el('li', 'sub ' + p.state,
        el('span', 'sub-dot'),
        el('div', 'sub-main',
          el('div', 'sub-title', p.title, p.state === 'done' && PHASE_LOCKS[p.key] ? lockIcon(PHASE_LOCKS[p.key]) : null, p.state !== 'pending' && p.how !== 'observed' ? el('span', 'how how-' + p.how, p.how) : null),
          p.detail ? el('div', 'sub-detail', p.detail) : null),
        el('span', 'sub-time', rel ? `${clock(p.at)}  ${rel}` : '')));
    }
    frag.append(rail);
    if (!o) return frag;
    const md = o.metadata || {}, sp = o.spec || {}, sx = o.status || {}, rec = sx.record || {};
    const left = el('div', null,
      section('AgentSandbox',
        facts([
          ['name', `${md.namespace}/${md.name}`],
          ['uid', md.uid],
          ['created', md.creationTimestamp ? `${clock(md.creationTimestamp)} (${md.creationTimestamp})` : ''],
          ['generation', md.generation],
          ['finalizers', md.finalizers],
          ['subject', sp.subject ? `${sp.subject.display || sp.subject.id}` : ''],
          ['ttl', sp.ttlSeconds ? `${sp.ttlSeconds} s` : ''],
          ['deleting', md.deletionTimestamp],
        ])),
      section('status',
        facts([
          ['phase', sx.phase],
          ['ready', sx.ready != null ? `${sx.ready} (entry set: ${!!sx.entrySet})` : ''],
          ['claim', sx.claimRef?.name],
          ['vm', sx.virtualMachineRef?.name],
          ['pool', sx.poolRef?.name],
          ['addresses', (sx.addresses || []).length ? ips(sx.addresses) : null],
          ['bound', sx.boundAt ? `${clock(sx.boundAt)}  +${dur(ts(sx.boundAt) - created)}` : ''],
          ['expires', sx.expiresAt ? clock(sx.expiresAt) : ''],
          ['node', rec.nodeId],
          ['image digest', rec.report?.image_digest],
          ['reason', sx.reason],
          ['conditions', (sx.conditions || []).map((c) => `${c.type}=${c.status}${c.reason ? ' (' + c.reason + ')' : ''}`)],
        ])));
    const tl = el('ul', 'timeline');
    for (const item of st.timeline) {
      const rel = isFinite(created) && isFinite(item.at) ? '+' + dur(item.at - created) : clock(item.at);
      let what;
      if (item.kind === 'change') {
        what = el('span', 'what', el('span', 'path', item.path), ' ',
          item.from ? el('span', 'arrow', `${item.from} → `) : el('span', 'arrow', '= '), item.to);
      } else if (item.kind === 'event') {
        what = el('span', 'what', el('span', 'ev' + (item.type === 'Warning' ? ' warning' : ''), `${item.reason}`), ` ${item.object}: ${item.message || ''}`);
      } else {
        what = el('span', 'what', el('span', 'arrow', item.text));
      }
      tl.append(el('li', null, el('span', 't', rel), what));
    }
    frag.append(el('div', 'cols', left, section(`timeline (${st.timeline.length})`, tl)));
    requestAnimationFrame(() => { tl.scrollTop = tl.scrollHeight; });
        // The network: the sandbox VM, its path to the egress gateways, where it may go.
    const net = netGraph(model.steps.seal.data);
    if (net) frag.append(section('network (banlieue.io/v1alpha1 VMs)', net));
    return frag;
  },
  logs(st) {
    const frag = document.createDocumentFragment();
    const h = st.header;
    frag.append(el('div', 'termbar',
      el('span', null, `${st.lines.length} lines · stdout ${st.counts.stdout} · stderr ${st.counts.stderr}`),
      el('span', null, h && h.truncated_before ? `older output dropped before seq ${h.truncated_before}` : 'best-effort redaction in the VM')));
    const term = el('div', 'term');
    term.id = 'term';
    for (const l of st.lines) term.append(logLine(l));
    if (st.state === 'active') term.append(el('span', 'cursor'));
    frag.append(el('div', 'termwrap', term, copyButton(() => st.lines.map((l) => l.text).join('\n'))));
    requestAnimationFrame(() => { fitTerm(); term.scrollTop = term.scrollHeight; });
    return frag;
  },
  exit(st) {
    const d = st.data;
    const frag = document.createDocumentFragment();
    if (d.code == null && d.signal == null) return frag;
    const ok = d.code === 0;
    frag.append(el('div', 'exit',
      el('div', 'code' + (ok ? '' : ' bad'), d.code != null ? d.code : `S${d.signal}`),
      facts([
        ['exited at', d.exitedAt ? `${clock(d.exitedAt)} (${d.exitedAt})` : ''],
        ['signal', d.signal],
        ['restarts', d.restarts],
        ['result', ok ? 'success' : d.code != null ? 'non-zero exit' : 'killed'],
      ])));
    // Where the time went.
    const s = model.steps;
    const sx = s.run.obj?.status || {};
    const created = ts(s.run.obj?.metadata?.creationTimestamp);
    const report = ts(sx.record?.report?.reported_at);
    const segs = [
      ['mint token', s.mint.started && s.mint.ended ? s.mint.ended - s.mint.started : 0, 'var(--accent-2)'],
      ['claim → bound', ts(sx.boundAt) - created, 'var(--accent)'],
      ['bound → jail built', report - ts(sx.boundAt), 'var(--warn)'],
      ['running', ts(d.exitedAt) - (isFinite(report) ? report : ts(sx.boundAt)), 'var(--ok)'],
    ].filter(([, ms]) => isFinite(ms) && ms > 0);
    const total = segs.reduce((a, [, ms]) => a + ms, 0);
    if (total > 0) {
      const bars = el('div', 'bars');
      const legend = el('div', 'legend');
      for (const [name, ms, color] of segs) {
        const b = el('span');
        b.style.width = `${(ms / total) * 100}%`;
        b.style.background = color;
        bars.append(b);
        const i = el('i');
        i.style.background = color;
        legend.append(el('span', null, i, `${name} ${dur(ms)}`));
      }
      frag.append(bars, legend);
    }
    return frag;
  },
};

// A live "2m 05s" since a timestamp; tickTimers keeps it current.
function sinceSpan(t) {
  const sp = el('span', 'since', dur(Date.now() - ts(t)));
  sp.dataset.since = t;
  return sp;
}

function poolLine(p, bound) {
  const booting = (p.members || []).filter((m) => !m.guestReady);
  const line = el('div', 'pool-line',
    el('span', 'pool-name', `pool ${p.name}`),
    el('span', 'pchip ' + (p.available > 0 ? 'ok' : 'warn'), `${p.available} available`),
    el('span', 'pchip', `${p.claimed} claimed`),
    el('span', 'pchip' + (p.provisioning ? ' live' : ''), `${p.provisioning} provisioning`));
  for (const m of booting) line.append(el('span', 'pool-boot', `${m.name} booting `, sinceSpan(m.created)));
    if (p.claim && p.claim.status !== 'True') {
    line.append(el('div', 'pool-claim', el('span', 'pool-reason', p.claim.reason || 'waiting'), ' ', p.claim.message || ''));
    } else if (!bound && p.available === 0 && booting.length) {
    line.append(el('span', 'pool-why', 'a claim waits here until a member is warm'));
  }
  return line;
}

// The sandbox VM on top, one arrow down to the gateway that carries its tunnel, the
// destinations below. Which gateway carries a tunnel is chosen per connection by the guest's
// egress proxy (random start, failover) and is not observable from Kubernetes: until it is,
// the arrow lands on the gateway row, labelled so. A workload that names no audience opens no
// tunnel: the arrow is dashed and says so.
function netGraph(seal) {
  const vm = seal.memberVm;
  const gws = seal.gateways || [];
  if (!(vm && vm.name) && !gws.length) return null;
  const w = model.steps.create.data.workload || {};
  const audiences = w.audiences || [];
  const via = seal.via || null; // a gateway name, once something reports it
  const holds = (place) => (seal.secrets || []).filter((x) => x.place === place && (x.presence === 'held' || x.presence === 'possible'));
  const net = el('div', 'net');
  const ipList = (v) => ips((v.addresses || []).filter((a) => !/ExternalIP/.test(a)).slice(0, 2));
    const sbx = el('div', 'nnode sbx',
    el('div', 'nn-kind', 'sandbox VM', vm && vm.name ? el('span', 'nn-lock', lockIcon('mTLS: node SVID to the broker, claim SVID to the gateways')) : null),
    el('div', 'nn-name', vm && vm.name ? vm.name : 'not bound yet'),
    vm && vm.name ? ipList(vm) : null,
    vm && vm.name ? el('div', 'nn-meta', [vm.failureDomain, vm.provider].filter(Boolean).join(' · ')) : null);
  const sh = holds('vm');
  if (sh.length) sbx.append(el('div', 'nn-secrets', ...sh.map((x) => secretTag(x.name.replace(/ \(.*\)$/, ''), x.sealed, x.presence))));
  sbx.id = 'net-sbx';
  const top = el('div', 'net-row', sbx);
  const label = audiences.length
    ? (via ? `tunnel via ${via}` : 'one gateway carries each tunnel (picked per connection; not observable yet)')
    : 'no egress: the workload named no audience';
    const mid = el('div', 'net-label ' + (audiences.length ? 'on' : 'off'), audiences.length ? lockIcon('mTLS tunnel: claim SVID to the gateway') : null, audiences.length ? ' ' : null, label);
  const row = el('div', 'net-row gws');
  for (const g of gws) {
        const n = el('div', 'nnode gw' + (via === g.name ? ' via' : ''),
      el('div', 'nn-kind', 'egress gateway', el('span', 'nn-lock', lockIcon('mTLS: the gateway checks the claim SVID; it asks the broker over mTLS what the claim may reach'))),
      el('div', 'nn-name', g.name),
      ipList(g),
      el('div', 'nn-meta', `${g.power === 'PoweredOn' ? '●' : '○'} ${[g.failureDomain, g.provider].filter(Boolean).join(' · ')}`));
    n.id = `net-gw-${g.name}`;
    row.append(n);
  }
  const gh = holds('gateway');
  const out = el('div', 'net-row',
    el('div', 'nnode cloud' + (audiences.length ? '' : ' off'),
      el('div', 'nn-kind', 'destinations'),
      el('div', 'nn-name', audiences.length ? audiences.join(', ') : 'none'),
      gh.length ? el('div', 'nn-secrets', ...gh.map((x) => secretTag('credential placed at the gateway', false, x.presence))) : null));
  out.firstChild.id = 'net-out';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'net-wires');
  net.append(svg, top, mid, row, out);
  net.dataset.target = via ? `net-gw-${via}` : '';
  net.dataset.egress = audiences.length ? '1' : '';
  requestAnimationFrame(() => drawWires(net));
  return net;
}

function drawWires(net) {
  if (!net || !net.isConnected) return;
  const svg = net.querySelector('.net-wires');
  const box = net.getBoundingClientRect();
  if (!box.width) return;
  const NS = 'http://www.w3.org/2000/svg';
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  svg.replaceChildren();
  const defs = document.createElementNS(NS, 'defs');
  for (const [id, cls] of [['arrow-on', 'head on'], ['arrow-off', 'head off']]) {
    const m = document.createElementNS(NS, 'marker');
    for (const [k, v] of Object.entries({ id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })) m.setAttribute(k, v);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    p.setAttribute('class', cls);
    m.append(p);
    defs.append(m);
  }
  svg.append(defs);
  const rel = (e) => { const r = e.getBoundingClientRect(); return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height }; };
  const wire = (from, to, on, dashedTo) => {
    const a = rel(from), b = rel(to);
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y - 3;
    const p = document.createElementNS(NS, 'path');
    const my = (y1 + y2) / 2;
    p.setAttribute('d', `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`);
    p.setAttribute('class', 'wire ' + (on ? 'on' : 'off') + (dashedTo ? ' pending' : ''));
    p.setAttribute('marker-end', `url(#arrow-${on ? 'on' : 'off'})`);
    svg.append(p);
  };
  const sbx = net.querySelector('#net-sbx');
  const row = net.querySelector('.gws');
  const target = net.dataset.target ? net.querySelector('#' + CSS.escape(net.dataset.target)) : null;
  const egress = !!net.dataset.egress;
    const out = net.querySelector('#net-out');
  if (sbx && row && target) {
    // Known: one arrow to the gateway that carries the tunnel, one from it.
    wire(sbx, target, egress, false);
    if (out) wire(target, out, egress, false);
  } else if (sbx && row) {
    // Unknown: the one arrow meets a bracket over the whole row (one of these carries it),
    // never a particular gateway; a bracket under the row leads on to the destinations.
    const gws = [...row.querySelectorAll('.nnode')].map(rel);
    if (!gws.length) return;
    const x1 = gws[0].x + gws[0].w / 2, x2 = gws[gws.length - 1].x + gws[gws.length - 1].w / 2;
    const top = Math.min(...gws.map((g) => g.y)) - 10, bottom = Math.max(...gws.map((g) => g.y + g.h)) + 10;
    const bracket = (y, dir) => {
      const p = document.createElementNS(NS, 'path');
      const ticks = gws.map((g) => `M${g.x + g.w / 2},${y} L${g.x + g.w / 2},${y + dir * 8}`).join(' ');
      p.setAttribute('d', `M${x1},${y} L${x2},${y} ${ticks}`);
      p.setAttribute('class', 'bracket ' + (egress ? 'on' : 'off'));
      svg.append(p);
    };
    bracket(top, 1);
    bracket(bottom, -1);
    const mid = (x1 + x2) / 2;
    const a = rel(sbx);
    const p1 = document.createElementNS(NS, 'path');
    p1.setAttribute('d', `M${a.x + a.w / 2},${a.y + a.h} C${a.x + a.w / 2},${(a.y + a.h + top) / 2} ${mid},${(a.y + a.h + top) / 2} ${mid},${top - 3}`);
    p1.setAttribute('class', 'wire ' + (egress ? 'on pending' : 'off'));
    p1.setAttribute('marker-end', `url(#arrow-${egress ? 'on' : 'off'})`);
    svg.append(p1);
    if (out) {
      const b = rel(out);
      const p2 = document.createElementNS(NS, 'path');
      p2.setAttribute('d', `M${mid},${bottom} C${mid},${(bottom + b.y) / 2} ${b.x + b.w / 2},${(bottom + b.y) / 2} ${b.x + b.w / 2},${b.y - 3}`);
      p2.setAttribute('class', 'wire ' + (egress ? 'on pending' : 'off'));
      p2.setAttribute('marker-end', `url(#arrow-${egress ? 'on' : 'off'})`);
      svg.append(p2);
    }
  }
}
window.addEventListener('resize', () => document.querySelectorAll('.net').forEach(drawWires));

// ---------------------------------------------------------------- recent sandboxes

async function loadRecent() {
  try {
    const r = await fetch('/api/recent');
    const d = await r.json();
    const list = $('recent');
    if (!r.ok) { list.replaceChildren(el('li', 'recent-err', d.error || `${r.status}`)); return; }
    $('recent-ns').textContent = `${d.namespace}${d.mine ? '' : ' (all)'}`;
    const current = model && model.steps.create.data.claim && model.steps.create.data.claim.name;
    list.replaceChildren(...(d.items || []).map((x) => {
      const li = el('li', 'recent-item ' + x.tone + (x.name === current ? ' current' : ''),
        el('span', 'r-dot'),
        el('span', 'r-main', el('span', 'r-name', x.name), el('span', 'r-status', x.status)),
        el('span', 'r-age', ago(x.created)));
      li.tabIndex = 0;
      const lines = [
        `${x.image} ${quoteArgs(x.args)}`.slice(0, 140),
        x.vm ? `VM ${x.vm} ${(x.addresses || []).join(', ')}` : 'no VM yet',
        x.reportedAt ? `guest report ${clock(x.reportedAt)}` : null,
        x.exitedAt ? `exited ${clock(x.exitedAt)}` : null,
      ].filter(Boolean);
      const show = () => showTipLines(x.name, x.status, x.tone, lines, li);
      li.addEventListener('mouseenter', show);
      li.addEventListener('focus', show);
      li.addEventListener('mouseleave', hideTip);
      li.addEventListener('blur', hideTip);
      return li;
    }));
    if (!(d.items || []).length) list.replaceChildren(el('li', 'recent-empty', 'none yet'));
  } catch { /* the next poll retries */ }
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - ts(t)) / 1000));
  if (!isFinite(s)) return '';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function showTipLines(title, state, tone, lines, anchor) {
  const tip = $('tip');
  tip.replaceChildren(
    el('div', 'tip-head', el('span', null, title), el('span', 'tip-state ' + (tone === 'ok' ? 'done' : tone === 'bad' ? 'failed' : 'active'), state)),
    ...lines.map((l) => el('div', 'tip-line', l)));
  tip.hidden = false;
  const r = anchor.getBoundingClientRect();
  const wide = window.innerWidth > 820;
  tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 12, wide ? r.right + 12 : r.left)}px`;
  tip.style.top = `${Math.max(8, wide ? r.top + window.scrollY : r.bottom + window.scrollY + 8)}px`;
}

function logLine(l) {
  return el('div', 'l ' + l.stream, el('span', 'ts', l.ts ? clock(l.ts) : ''), el('span', 'tx', l.text));
}

function repaint(id) {
  for (const s of STEPS) paintLock(s.id);
  const st = model.steps[id];
  const c = content(id);
  c.replaceChildren(render[id](st));
  if (!['logs', 'run', 'create', 'seal'].includes(id) && st.notes.length) {
    for (const n of st.notes) c.append(el('p', 'note', n));
  }
}

// ---------------------------------------------------------------- events

function handle(e) {
  replaying = Date.now() - ts(e.at) > REPLAY_MS;
  if (e.kind === 'finished') return finish(e);
  const st = model.steps[e.step];
  if (!st) return;
  const at = ts(e.at);
  if (e.kind === 'state') {
    st.state = e.state;
    if (e.note) st.note = e.note;
    if (e.state === 'active') { st.started = at; st.ended = null; enqueue(e.step); }
        else st.ended = at;
    if (e.state === 'failed' && !model.steps[e.step].stopped) {
      // The stage that failed takes the focus; the ones it stopped do not.
      if (e.note === 'stopped') st.stopped = true;
      else if (!pinned) { queue = []; focusOn(e.step); }
    }
    paintState(e.step);
    repaint(e.step);
    return;
  }
  if (e.kind === 'data') {
    const d = e.data || {};
    if (e.step === 'run') {
            if (d.phases) st.phases = d.phases;
      if ('stall' in d) { st.stall = d.stall; paintNode('run'); }
      if (d.pool) st.pool = d.pool;
      if (d.object) {
        st.obj = d.object;
        for (const c of d.changes || []) {
          if (c.path.startsWith('status.') || c.path.startsWith('metadata.deletion') || c.path === 'metadata.finalizers') {
            st.timeline.push({ kind: 'change', at, path: c.path.replace(/^status\./, ''), from: c.from, to: c.to });
          }
        }
      }
      if (d.event) st.timeline.push({ kind: 'event', at: ts(d.event.at) || at, ...d.event });
    } else if (e.step === 'logs') {
      st.header = d;
    } else if (e.step === 'seal') {
      st.data = d;
      repaint('run');
        } else {
      Object.assign(st.data, d);
      if (e.step === 'create' && 'waiting' in d) {
        st.waiting = d.waiting;
        if (!d.waiting) st.submitted = true;
        paintForms();
      }
    }
    repaint(e.step);
    return;
  }
  if (e.kind === 'line') {
    if (e.step === 'logs') {
      const l = { stream: e.stream, text: e.text, ts: e.ts };
      st.lines.push(l);
      if (st.counts[e.stream] != null) st.counts[e.stream]++;
      const term = $('term');
      if (term) {
        const near = term.scrollHeight - term.scrollTop - term.clientHeight < 60;
        term.insertBefore(logLine(l), term.querySelector('.cursor'));
        if (near) term.scrollTop = term.scrollHeight;
        const bar = card('logs').querySelector('.termbar span');
        if (bar) bar.textContent = `${st.lines.length} lines · stdout ${st.counts.stdout} · stderr ${st.counts.stderr}`;
      } else {
        repaint('logs');
      }
    } else if (e.step === 'run') {
      st.timeline.push({ kind: 'note', at, text: e.text });
      repaint('run');
    } else {
      st.notes.push(e.text);
      repaint(e.step);
    }
  }
}

function finish(e) {
  model.finished = e;
  const pill = $('run-status');
  pill.hidden = false;
  pill.className = 'run-status ' + (e.ok ? 'ok' : 'bad');
  pill.textContent = e.ok ? `finished · ${e.note}` : 'stopped';
    $('cancel').hidden = true;
  paintForms();
  const fin = $('finish');
  fin.hidden = false;
  const refused = e.ok ? null : brokerError(e.note);
  fin.replaceChildren(el('div', null, e.ok ? `Run finished: ${e.note}.`
    : refused ? `Run stopped: the broker refused the claim (${refused.status} ${refused.error}). Your session file still holds its refresh token: tick "Reuse a fresh, unspent session" to skip the next login.`
      : `Run stopped: ${e.note}`));
  const again = el('button', 'ghost', 'New run');
  again.type = 'button';
  again.addEventListener('click', () => {
    pinned = null;
    paintFocusBar();
    $('finish').hidden = true;
    focusOn('mint');
    window.scrollTo({ top: 0 });
    LOGIN_FORM.querySelector('[data-k=issuer]').focus();
  });
  fin.append(el('div', null, again));
      queue = [];
  if (!pinned) focusOn(e.ok ? 'exit' : failedStep() || shown);
  loadRecent();
}

function attach(id) {
  if (es) es.close();
    runId = id;
  model = freshModel();
  queue = [];
  pinned = null;
  paintFocusBar();
  buildFlow();
  paintLinks();
  const pill = $('run-status');
  pill.hidden = false;
  pill.className = 'run-status running';
  pill.textContent = 'running';
    $('cancel').hidden = false;
  paintForms();
  es = new EventSource(`/api/events?run=${encodeURIComponent(id)}`);
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  es.addEventListener('end', () => { es.close(); es = null; });
}

// ---------------------------------------------------------------- settings and actions

// Keys earlier versions kept the forms under; removed at load.
const STORE = { login: 'low-tide.login', create: 'low-tide.create' };

function readForm(form) {
  const s = {};
  for (const input of form.querySelectorAll('[data-k]')) {
    const k = input.dataset.k;
    if (input.type === 'checkbox') s[k] = input.checked;
    else if (input.type === 'number') s[k] = Number(input.value) || 0;
    else if ('list' in input.dataset) {
      const xs = input.value.split(',').map((x) => x.trim()).filter(Boolean);
      s[k] = 'num' in input.dataset ? xs.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 65536) : xs;
    } else s[k] = input.value.trim();
  }
  return s;
}

function fillForm(form, s) {
  for (const input of form.querySelectorAll('[data-k]')) {
    const v = s[input.dataset.k];
    if (v == null) continue;
    if (input.type === 'checkbox') input.checked = !!v;
    else if (Array.isArray(v)) input.value = v.join(', ');
    else input.value = v;
  }
}

// The command each form is equivalent to, as the CLI spells it. The server sends the one it
// actually ran; this is the preview while typing.
function sh(w) {
  return w !== '' && /^[A-Za-z0-9\-_./:=@,+%]+$/.test(w) ? w : `'${String(w).replace(/'/g, "'\\''")}'`;
}
function splitWords(line) {
  const out = []; let cur = ''; let inWord = false; let q = null; let esc = false;
  for (const c of line) {
    if (esc) { cur += c; esc = false; continue; }
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === '\\') esc = true; else cur += c; continue; }
    if (c === '\\') { esc = true; inWord = true; } else if (c === "'" || c === '"') { q = c; inWord = true; }
    else if (/\s/.test(c)) { if (inWord) { out.push(cur); cur = ''; inWord = false; } } else { cur += c; inWord = true; }
  }
  if (q || esc) return null;
  if (inWord) out.push(cur);
  return out;
}
function loginCommand(l) {
  const o = ['mediatore login', `--issuer ${sh(l.issuer || '<required>')}`];
  if (l.clientId && l.clientId !== 'mediatore') o.push(`--client-id ${sh(l.clientId)}`);
  for (const x of l.scopes || []) o.push(`--scope ${sh(x)}`);
  for (const x of l.authParams || []) o.push(`--auth-param ${sh(x)}`);
  if (l.loginHint) o.push(`--login-hint ${sh(l.loginHint)}`);
  if (l.caFile) o.push(`--ca-file ${sh(l.caFile)}`);
  if (l.clientSecretFile) o.push(`--client-secret-file ${sh(l.clientSecretFile)}`);
  const ports = l.redirectPorts || [];
  if (ports.length && ports.join(',') !== '8000,18000') for (const p of ports) o.push(`--redirect-port ${p}`);
  if (l.redirectHost && l.redirectHost !== 'localhost') o.push(`--redirect-host ${sh(l.redirectHost)}`);
  if (l.redirectPath) o.push(`--redirect-path ${sh(l.redirectPath)}`);
  if (l.noBrowser) o.push('--no-browser');
  return o.join(' \\\n    ');
}
function createCommand(c) {
  const o = ['mediatore sandbox create', `--mediatore ${sh(c.url || '<required>')}`];
  if (c.caFile) o.push(`--ca-file ${sh(c.caFile)}`);
  if (c.allowPlainHttp) o.push('--allow-plain-http');
  if (c.namespace) o.push(`--namespace ${sh(c.namespace)}`);
  if (c.pool) o.push(`--pool ${sh(c.pool)}`);
  for (const x of c.poolSelector || []) o.push(`--pool-selector ${sh(x)}`);
  if (c.strategy) o.push(`--strategy ${c.strategy}`);
  if (c.ttl && c.ttl !== 3600) o.push(`--ttl ${c.ttl}`);
  for (const x of c.audiences || []) o.push(`--audience ${sh(x)}`);
  for (const x of c.delegate || []) o.push(`--delegate ${sh(x)}`);
  if (c.policy) o.push(`--policy ${sh(c.policy)}`);
  if (c.restart && c.restart !== 'always') o.push(`--restart ${c.restart}`);
  if (c.logs) o.push('--logs');
  const words = splitWords(c.workload || '');
  if (words && words.length) {
    o.push(`--image ${sh(words[0])}`);
    for (const a of words.slice(1)) o.push(`--arg=${sh(a)}`);
  } else o.push('--image <IMAGE>');
  return o.join(' \\\n    ');
}
function previews() {
  $('login-cmd').textContent = loginCommand(readForm(LOGIN_FORM));
  $('create-cmd').textContent = createCommand(readForm(CREATE_FORM));
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

function formError(form, msg) {
  form.querySelector('.form-error').textContent = msg || '';
}

// 1. `mediatore login`: a new run, which mints the token, then waits for the workload.
async function login(ev) {
  ev.preventDefault();
  const form = LOGIN_FORM;
  const l = readForm(form);
  formError(form, '');
  if (!demo && !l.issuer) { formError(form, 'The issuer is required.'); form.querySelector('[data-k=issuer]').focus(); return; }
  
  try {
    const { id } = await post('/api/login', l);
    attach(id);
  } catch (err) {
    formError(form, err.message);
  }
}

// 2. `mediatore sandbox create`: the workload, handed to the run that waits for it.
async function create(ev) {
  ev.preventDefault();
  const form = CREATE_FORM;
  const c = readForm(form);
  formError(form, '');
  if (!c.workload) { formError(form, 'Type a workload: IMAGE [ARG...]'); return; }
  if (!demo && !c.url) { formError(form, 'mediatore\'s URL is required.'); return; }
  
  try {
    await post('/api/create', c);
    model.steps.create.submitted = true;
    paintForms();
  } catch (err) {
    formError(form, err.message);
  }
}



async function init() {
  const cfg = await (await fetch('/api/config')).json();
  demo = !!cfg.demo;
  if (demo) document.title = 'Low Tide (demo)';
    // The forms start from the server's values (flags, then environment, then the config
  // file), never from what this browser typed last: a remembered value would silently beat
  // the config (it once kept a workload the broker refuses).
  for (const k of ['low-tide.settings', STORE.login, STORE.create]) {
    try { localStorage.removeItem(k); } catch { /* storage off */ }
  }
  fillForm(LOGIN_FORM, cfg.login || {});
  fillForm(CREATE_FORM, cfg.claim || {});
  $('env-hint').textContent = demo
    ? 'Demo mode: a scripted run with placeholder values. Nothing is logged in, claimed or read from a cluster.'
        : `Session file ${cfg.sessionPath || '?'} · kube context ${cfg.kubeContext || 'current'}${cfg.kubeconfig ? ' · ' + cfg.kubeconfig : ''} · defaults from flags, then the environment, then ${cfg.configFile ? 'the config file ' + cfg.configFile : 'a config file (none found: low-tide config init)'}.`;
  model = freshModel();
  buildFlow();
  paintLinks();
  previews();
      loadRecent();
  setInterval(loadRecent, 15000);
  if (cfg.run) attach(cfg.run.id);
  // `#run` (any stage id) opens the page on that stage, pinned.
  const want = location.hash.slice(1);
  if (STEPS.some((s) => s.id === want)) setTimeout(() => pickStage(want), 300);
  else LOGIN_FORM.querySelector('[data-k=issuer]').focus();
}

for (const f of [LOGIN_FORM, CREATE_FORM]) f.addEventListener('input', previews);
LOGIN_FORM.addEventListener('submit', login);
CREATE_FORM.addEventListener('submit', create);
$('cancel').addEventListener('click', () => {
  if (model && model.steps.create.submitted && !confirm('Cancel this run? Its claim is released (mediatore sandbox delete), so it does not wait for the pool\'s next VM.')) return;
  post('/api/cancel').catch((err) => alert(err.message));
});
$('delete').addEventListener('click', () => {
  if (!confirm('Delete this sandbox now? The claim is released and the VM returned to the pool.')) return;
  post('/api/delete').catch((err) => alert(err.message));
});
$('follow').addEventListener('click', () => {
  if (pinned || !follow) { unpin(); return; }
  follow = false;
  $('follow').classList.remove('on');
});

init().catch((err) => { $('env-hint').textContent = `could not reach the server: ${err.message}`; });
