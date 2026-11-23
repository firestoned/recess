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
  delegation_required: 'This audience is served from your own credential, so it must travel with the claim. On sheet 02, add it to Delegate as audience=source: env:VAR (a token in a variable set where recess web runs, e.g. github-git=env:GITHUB_TOKEN with GITHUB_TOKEN=$(gh auth token)), file:PATH (a token file), or store (the Keychain item the mediatore CLI saved); claude-code for anthropic. Or drop the audience from Audiences.',
  delegation_refused: 'The broker did not accept the delegated credential as it is. An audience that signs in with a user name and a password (git over HTTPS, as github-git) takes them as user:secret: for GitHub, a file holding your-github-user:your-token, delegated as github-git=file:PATH (chmod 600).',
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

// The View menu every page carries: the server picks the page by ?view= and remembers it,
// and the run lives on the server, so switching reloads the page onto the same run.
document.addEventListener('DOMContentLoaded', () => {
  const pick = document.getElementById('view');
  if (!pick) return;
  pick.addEventListener('change', () => {
    location.assign('/?view=' + encodeURIComponent(pick.value));
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

// YAML for reading, as kubectl prints objects: block mappings and sequences, two spaces a
// level, strings quoted only when plain YAML would read them as something else, multi-line
// strings as literal blocks. Values are JSON (what the API and the broker return).
function toYaml(v) {
  const plain = /^[A-Za-z0-9_./][A-Za-z0-9_./ :@+-]*$/;
  const special = /^(true|false|yes|no|on|off|y|n|null|~|[-+]?(\.?\d[\d_]*\.?\d*([eE][-+]?\d+)?|0x[0-9a-fA-F]+|\.inf|\.nan))$/i;
  const str = (s) => (s !== '' && plain.test(s) && !special.test(s) && !/:\s|\s#|\s$|: *$/.test(s) ? s : JSON.stringify(s));
  const key = (k) => (plain.test(k) && !special.test(k) && !k.includes(': ') ? k : JSON.stringify(k));
  const scalar = (x, ind) => {
    if (x === null || x === undefined) return 'null';
    if (typeof x === 'string') {
      if (x.includes('\n')) {
        const chomp = x.endsWith('\n') ? '' : '-';
        const body = x.replace(/\n$/, '').split('\n').map((l) => (l ? ind + '  ' + l : '')).join('\n');
        return `|${chomp}\n${body}`;
      }
      return str(x);
    }
    return String(x);
  };
  const isBlock = (x) => x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length);
  const empty = (x) => (Array.isArray(x) ? '[]' : '{}');
  const emit = (x, ind) => {
    const out = [];
    if (Array.isArray(x)) {
      for (const item of x) {
        if (isBlock(item)) {
          // The first line of a nested block shares the dash.
          const inner = emit(item, ind + '  ');
          out.push(ind + '- ' + inner.slice(ind.length + 2));
        } else out.push(ind + '- ' + (item && typeof item === 'object' ? empty(item) : scalar(item, ind)));
      }
    } else {
      for (const [k, val] of Object.entries(x)) {
        if (isBlock(val)) out.push(`${ind}${key(k)}:\n${emit(val, Array.isArray(val) ? ind : ind + '  ')}`);
        else out.push(`${ind}${key(k)}: ${val && typeof val === 'object' ? empty(val) : scalar(val, ind)}`);
      }
    }
    return out.join('\n');
  };
  return isBlock(v) ? emit(v, '') : v && typeof v === 'object' ? empty(v) : scalar(v, '');
}
