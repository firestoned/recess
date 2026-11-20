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
  { id: 'mint', title: 'Mint token', sub: 'OIDC with PKCE at the issuer; the session kept on disk' },
  { id: 'create', title: 'Create workload', sub: 'POST /v1/claims: the broker creates the AgentSandbox' },
  { id: 'seal', title: 'Seal credentials', sub: 'your refresh token and delegated credentials, sealed into Secrets' },
  { id: 'run', title: 'Run in the sandbox', sub: 'claim a VM, attest, build the jail, nsjail enter, exec' },
  { id: 'logs', title: 'Output', sub: 'redacted in the VM, streamed by the broker as it runs' },
  { id: 'exit', title: 'Exit code', sub: 'status.record.exit, reported by the guest' },
];

const $ = (id) => document.getElementById(id);

function el(tag, cls, ...kids) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const k of kids) {
    if (k == null || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

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
let quietUntil = 0;
let demo = false;

function freshModel() {
  const m = { steps: {}, finished: null };
  for (const s of STEPS) {
    m.steps[s.id] = { state: 'pending', note: '', started: null, ended: null, data: {}, notes: [], lines: [], timeline: [], obj: null, phases: [], header: null, counts: { stdout: 0, stderr: 0 } };
  }
  return m;
}

// ---------------------------------------------------------------- DOM

function buildFlow() {
  const flow = $('flow');
  flow.replaceChildren();
  STEPS.forEach((s, i) => {
    if (i > 0) {
      const li = el('li', 'link');
      li.id = `link-${i}`;
      li.setAttribute('aria-hidden', 'true');
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '64');
      const mk = (tag, attrs) => {
        const n = document.createElementNS(ns, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
        svg.append(n);
      };
      mk('line', { class: 'track', x1: 10, y1: 0, x2: 10, y2: 64 });
      mk('line', { class: 'fill', x1: 10, y1: 0, x2: 10, y2: 64 });
      mk('circle', { class: 'dot', cx: 10, cy: 0, r: 4 });
      li.append(svg);
      flow.append(li);
    }
    const card = el('li', 'stage pending');
    card.id = `stage-${s.id}`;
    card.append(
      el('div', 'stage-head',
        el('div', 'num', i + 1),
        el('div', null, el('div', 'stage-title', s.title), el('div', 'stage-sub', s.sub)),
        el('div', 'stage-right', el('span', 'spinner'), el('span', 'timer'), el('span', 'badge', 'pending'))),
      el('div', 'stage-body', el('p', 'note'), el('div', 'content')));
    flow.append(card);
  });
  const fin = el('li', 'finish');
  fin.id = 'finish';
  fin.hidden = true;
  flow.append(fin);
}

const card = (id) => $(`stage-${id}`);
const content = (id) => card(id).querySelector('.content');

function paintState(id) {
  const st = model.steps[id];
  const c = card(id);
  c.className = `stage ${st.state}`;
  c.querySelector('.badge').textContent = st.state;
  const note = c.querySelector('.note');
  note.textContent = st.note || '';
  note.hidden = !st.note;
  paintLinks();
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
    const t = card(s.id)?.querySelector('.timer');
    if (!t) continue;
    t.textContent = st.started ? dur((st.ended ?? Date.now()) - st.started) : '';
  }
}
setInterval(tickTimers, 250);

function maybeScroll(id) {
  if (!follow || Date.now() < quietUntil) return;
  card(id).scrollIntoView({ behavior: 'smooth', block: 'center' });
}
for (const ev of ['wheel', 'touchmove']) {
  window.addEventListener(ev, () => { quietUntil = Date.now() + 6000; }, { passive: true });
}

// ---------------------------------------------------------------- renderers

function vmCard(v, kind, secrets) {
  const holds = (secrets || []).filter((x) => x.place === kind && (x.presence === 'held' || x.presence === 'possible'));
  const c = el('div', 'vm vm-' + kind,
    el('div', 'vm-head',
      el('span', 'vm-kind', kind === 'vm' ? 'sandbox VM' : 'gateway'),
      el('span', 'vm-name', v.name),
      el('span', 'vm-power ' + (v.power === 'PoweredOn' ? 'on' : ''), v.power || '?')),
    ips(v.addresses),
    facts([
      ['namespace', v.namespace],
      ['ready', v.ready],
      ['provider', [v.provider, v.providerClass].filter(Boolean).join(' · ')],
      ['failure domain', v.failureDomain],
      ['class / image', [v.class, v.image].filter(Boolean).join(' / ')],
      ['attestation', v.attestationSubject],
    ]));
  if (holds.length) {
    const h = el('div', 'holds', el('span', 'lane-sub', kind === 'vm' ? 'holds ' : 'may hold '));
    for (const x of holds) h.append(secretTag(x.name, x.sealed, x.presence), ' ');
    c.append(h);
  }
  return c;
}

const render = {
  mint(st) {
    const d = st.data;
    const frag = document.createDocumentFragment();
    const login = d.login || {};
    const l = section('login',
      login.reused ? el('p', 'note', 'A fresh session with its delegation unspent was reused.') : null,
      facts([
        ['issuer', login.issuer],
        ['client', login.clientId],
        ['scopes', login.scopes ? chips(login.scopes) : null],
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
          ['issuer', id.issuer],
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
    const w = st.data.workload || {};
    const c = st.data.claim;
    const frag = document.createDocumentFragment();
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
    // The sub-steps, in the guest's order.
    const rail = el('ol', 'subflow');
    const created = ts(o?.metadata?.creationTimestamp);
    for (const p of st.phases) {
      const rel = p.at && isFinite(created) ? '+' + dur(ts(p.at) - created) : '';
      rail.append(el('li', 'sub ' + p.state,
        el('span', 'sub-dot'),
        el('div', 'sub-main',
          el('div', 'sub-title', p.title, p.state !== 'pending' && p.how !== 'observed' ? el('span', 'how how-' + p.how, p.how) : null),
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
    // The VMs, from the Kubernetes API.
    const seal = model.steps.seal.data;
    const vms = el('div', 'vms');
    if (seal.memberVm && seal.memberVm.name) vms.append(vmCard(seal.memberVm, 'vm', seal.secrets));
    for (const g of seal.gateways || []) vms.append(vmCard(g, 'gateway', seal.secrets));
    if (vms.childElementCount) frag.append(section('virtual machines (banlieue.io/v1alpha1)', vms));
    else if (seal.gatewayQuery) frag.append(el('p', 'note', `No gateway VM matched ${seal.gatewayQuery.selector || 'no selector'}${seal.gatewayQuery.prefix ? ' or the name prefix ' + seal.gatewayQuery.prefix : ''}.`));
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
    frag.append(term);
    requestAnimationFrame(() => { term.scrollTop = term.scrollHeight; });
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

function logLine(l) {
  return el('div', 'l ' + l.stream, el('span', 'ts', l.ts ? clock(l.ts) : ''), el('span', 'tx', l.text));
}

function repaint(id) {
  const st = model.steps[id];
  const c = content(id);
  c.replaceChildren(render[id](st));
  if (!['logs', 'run', 'create', 'seal'].includes(id) && st.notes.length) {
    for (const n of st.notes) c.append(el('p', 'note', n));
  }
}

// ---------------------------------------------------------------- events

function handle(e) {
  if (e.kind === 'finished') return finish(e);
  const st = model.steps[e.step];
  if (!st) return;
  const at = ts(e.at);
  if (e.kind === 'state') {
    st.state = e.state;
    if (e.note) st.note = e.note;
    if (e.state === 'active') { st.started = at; st.ended = null; maybeScroll(e.step); }
    else st.ended = at;
    paintState(e.step);
    repaint(e.step);
    return;
  }
  if (e.kind === 'data') {
    const d = e.data || {};
    if (e.step === 'run') {
      if (d.phases) st.phases = d.phases;
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
  $('run').disabled = false;
  const fin = $('finish');
  fin.hidden = false;
  fin.replaceChildren(el('div', null, e.ok ? `Run finished: ${e.note}.` : `Run stopped: ${e.note}`));
  const again = el('button', 'ghost', 'New run');
  again.type = 'button';
  again.addEventListener('click', () => { window.scrollTo({ top: 0 }); $('workload').focus(); $('workload').select(); });
  fin.append(el('div', null, again));
  if (follow && Date.now() >= quietUntil) {
    const target = e.ok ? card('exit') : document.querySelector('.stage.failed') || fin;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function attach(id) {
  if (es) es.close();
  model = freshModel();
  buildFlow();
  paintLinks();
  const pill = $('run-status');
  pill.hidden = false;
  pill.className = 'run-status running';
  pill.textContent = 'running';
  $('cancel').hidden = false;
  $('delete').hidden = false;
  $('run').disabled = true;
  es = new EventSource(`/api/events?run=${encodeURIComponent(id)}`);
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  es.addEventListener('end', () => { es.close(); es = null; });
}

// ---------------------------------------------------------------- settings and actions

const STORE = 'low-tide.settings';

function readForm() {
  const s = { workload: $('workload').value };
  for (const input of document.querySelectorAll('[data-k]')) {
    const k = input.dataset.k;
    if (input.type === 'checkbox') s[k] = input.checked;
    else if (input.type === 'number') s[k] = Number(input.value) || 0;
    else if ('list' in input.dataset) s[k] = input.value.split(',').map((x) => x.trim()).filter(Boolean);
    else s[k] = input.value.trim();
  }
  return s;
}

function fillForm(s) {
  if (s.workload) $('workload').value = s.workload;
  for (const input of document.querySelectorAll('[data-k]')) {
    const v = s[input.dataset.k];
    if (v == null) continue;
    if (input.type === 'checkbox') input.checked = !!v;
    else if (Array.isArray(v)) input.value = v.join(', ');
    else input.value = v;
  }
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r.status === 204 ? null : r.json();
}

async function start() {
  const s = readForm();
  $('hero-error').textContent = '';
  if (!s.workload.trim()) { $('hero-error').textContent = 'Type a workload: IMAGE [ARG...]'; return; }
  if (!demo && (!s.issuer || !s.url)) { $('settings').open = true; $('hero-error').textContent = 'Set the issuer and the mediatore URL.'; return; }
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage off */ }
  try {
    const { id } = await post('/api/run', s);
    attach(id);
  } catch (err) {
    $('hero-error').textContent = err.message;
  }
}

async function init() {
  const cfg = await (await fetch('/api/config')).json();
  const d = cfg.defaults || {};
  demo = !!cfg.demo;
  if (demo) document.title = 'Low Tide (demo)';
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* storage off */ }
  const merged = { ...d };
  for (const [k, v] of Object.entries(stored)) {
    if (v !== '' && !(Array.isArray(v) && v.length === 0)) merged[k] = v;
  }
  fillForm(merged);
  $('env-hint').textContent = `Session file ${cfg.sessionPath || '?'} · kube context ${cfg.kubeContext || 'current'}${cfg.kubeconfig ? ' · ' + cfg.kubeconfig : ''}. Defaults come from MEDIATORE_* in the server's environment.`;
  if (demo) {
    $('env-hint').textContent = 'Demo mode: a scripted run with placeholder values. Nothing is logged in, claimed or read from a cluster.';
  } else if (!merged.issuer || !merged.url) {
    $('settings').open = true;
  }
  if (cfg.run) attach(cfg.run.id);
  $('workload').focus();
}

$('run').addEventListener('click', start);
$('workload').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('run').disabled) start(); });
$('cancel').addEventListener('click', () => post('/api/cancel').catch((err) => alert(err.message)));
$('delete').addEventListener('click', () => {
  if (!confirm('Delete this sandbox now? The claim is released and the VM returned to the pool.')) return;
  post('/api/delete').catch((err) => alert(err.message));
});
$('follow').addEventListener('click', () => {
  follow = !follow;
  $('follow').classList.toggle('on', follow);
  quietUntil = 0;
});

init().catch((err) => { $('hero-error').textContent = `could not reach the server: ${err.message}`; });
