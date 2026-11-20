// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0

// Shared by the classic page and the 3D one: the command each form is equivalent to, as the
// mediatore CLI spells it. The server sends the one it actually ran; these are the previews.
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
  unreachable_registry: 'The pool pulls only from the registries the broker lists for it (registries[].reach, ADR-0029). Use an image from one of them; set your default with RECESS_WORKLOAD in the config file.',
  namespace_required: 'This broker serves several namespaces: name one (MEDIATORE_NAMESPACE).',
  forbidden: 'The broker does not allow this claim for your identity: check who may claim in the namespace (ADR-0046) and the policy it names.',
  not_implemented: 'The broker has this feature off (for --logs: logs.enabled in its config).',
  delegation_expires_first: 'The credential you delegate (your Claude login, read from the Keychain) runs out before the claim would. Run Claude Code once so it refreshes its login, then start a new run; or ask for a shorter claim (RECESS_TTL, --ttl) that ends before the credential does.',
};

// A form's values by data-k: lists (data-list, numbers with data-num), numbers, checkboxes.
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

// The Theme dropdown both pages carry: the server picks the page by ?theme= and remembers it,
// and the run lives on the server, so switching reloads the page onto the same run.
document.addEventListener('DOMContentLoaded', () => {
  const pick = document.getElementById('theme');
  if (!pick) return;
  pick.addEventListener('change', () => {
    location.assign('/?theme=' + encodeURIComponent(pick.value));
  });
});

// A copy-to-clipboard button, for the output box of either page: the two-sheet icon, a check for a moment once copied. `text`
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
  const b = document.createElement('button');
  b.className = 'copy';
  b.append(icon(sheets));
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
      const ta = document.createElement('textarea');
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
