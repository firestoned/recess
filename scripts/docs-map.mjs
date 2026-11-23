// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// The docs' map of the theatre: where each station stands, seen from above, drawn from the
// coordinates the views themselves use (assets/theatre.js, and the run's own places at the top
// of assets/agentsandbox.js). Writes docs/media/layout-map.svg; `make docs-media` runs it.
//
// usage: node scripts/docs-map.mjs [OUT]
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const out = process.argv[2] || 'docs/media/layout-map.svg';

// theatre.js is a classic script for a page: give it just enough of one to run its top level.
const stub = { getContext: () => ({ setTransform() {} }), addEventListener() {} };
const ctx = vm.createContext({
  document: { getElementById: () => stub, querySelectorAll: () => [] },
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 760, devicePixelRatio: 1 },
  matchMedia: () => ({ matches: false }),
  performance: { now: () => 0 },
  setTimeout, clearTimeout, fetch: async () => ({ ok: false }),
});
const theatre = readFileSync('assets/theatre.js', 'utf8');
vm.runInContext(`${theatre}\n;globalThis.__base = JSON.parse(JSON.stringify(ST));`, ctx);
const base = ctx.__base;

// The run's places: the block from `Object.assign(ST, {` to the line that stands OpenBao.
const as = readFileSync('assets/agentsandbox.js', 'utf8');
const from = as.indexOf('Object.assign(ST, {');
const to = as.indexOf('\n', as.indexOf('ST.bao = add(ST.spire'));
if (from < 0 || to < 0) throw new Error("agentsandbox.js: the run's places moved; update scripts/docs-map.mjs");
vm.runInContext(`${as.slice(from, to)}\n;globalThis.__run = JSON.parse(JSON.stringify(ST));`, ctx);
const run = ctx.__run;

// The palette of theatre.js, as CSS colours.
const C = { wire: '#5ee7ff', ident: '#a78bfa', seal: '#fbbf24', ok: '#4ade80', policy: '#fb923c', spire: '#2dd4bf', carrier: '#f472b6', ink: '#dbe7f5', muted: '#7d8ba3', faint: '#34425a', bg: '#05080f' };
const STATIONS = [
  ['issuer', 'OIDC issuer', C.ident, 'prism'],
  ['broker', 'Broker', C.wire, 'octa'],
  ['api', 'Kubernetes API', C.wire, 'hex'],
  ['vault', 'Secrets', C.seal, 'box'],
  ['bao', 'OpenBao', C.seal, 'box'],
  ['spire', 'SPIRE', C.spire, 'spire'],
  ['policy', 'SandboxPolicy', C.policy, 'doc'],
];
const RUN = [
  ['you', 'Sheet 01 (you)', C.ink, 'sheet'],
  ['form', 'Sheet 02', C.ink, 'sheet'],
  ['vm', 'Sandbox VM', C.wire, 'box'],
  ['end', 'Exit', C.ok, 'ring'],
];

// Which side of its glyph each name goes on, so none sits on a neighbour; the run's panel
// differs where its own places crowd the base's.
const SIDE = { issuer: 'below', broker: 'left', api: 'right', vault: 'right', bao: 'left', spire: 'below', policy: 'above' };
const RUN_SIDE = { ...SIDE, issuer: 'left', you: 'below', form: 'above', api: 'right', vault: 'below', spire: 'right', bao: 'below', vm: 'right', end: 'left' };
const glyph = (kind, x, y, c) => {
  const s = `fill="none" stroke="${c}" stroke-width="1.4"`;
  switch (kind) {
    case 'octa': return `<path d="M${x} ${y - 9}L${x + 9} ${y}L${x} ${y + 9}L${x - 9} ${y}Z" ${s}/><circle cx="${x}" cy="${y}" r="14" ${s} opacity=".45"/>`;
    case 'hex': return `<path d="${[0, 1, 2, 3, 4, 5].map((i) => { const a = Math.PI / 3 * i + Math.PI / 6; return `${i ? 'L' : 'M'}${(x + Math.cos(a) * 11).toFixed(1)} ${(y + Math.sin(a) * 11).toFixed(1)}`; }).join('')}Z" ${s}/>`;
    case 'box': return `<rect x="${x - 7}" y="${y - 7}" width="14" height="14" ${s}/>`;
    case 'spire': return `<path d="M${x} ${y - 11}L${x + 8} ${y + 7}L${x - 8} ${y + 7}Z" ${s}/>`;
    case 'doc': return `<path d="M${x - 6} ${y - 8}H${x + 3}L${x + 6} ${y - 5}V${y + 8}H${x - 6}Z" ${s}/>`;
    case 'prism': return `<path d="${[0, 1, 2, 3, 4].map((i) => { const a = Math.PI * 2 / 5 * i - Math.PI / 2; return `${i ? 'L' : 'M'}${(x + Math.cos(a) * 9).toFixed(1)} ${(y + Math.sin(a) * 9).toFixed(1)}`; }).join('')}Z" ${s}/><circle cx="${x}" cy="${y}" r="15" ${s} opacity=".45"/>`;
    case 'sheet': return `<rect x="${x - 9}" y="${y - 6}" width="18" height="12" ${s}/>`;
    default: return `<circle cx="${x}" cy="${y}" r="10" ${s}/>`;
  }
};

// One panel: the stations at (x, z) seen from above (north up), the legs between them dashed.
function panel(title, sub, st, list, legs, ox, W, H, side) {
  const pts = list.map(([k]) => st[k]).filter(Boolean);
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[2]);
  const x0 = Math.min(...xs) - 5, x1 = Math.max(...xs) + 5, z0 = Math.min(...zs) - 5, z1 = Math.max(...zs) + 5;
  const k = Math.min((W - 60) / (x1 - x0), (H - 110) / (z1 - z0));
  const at = (p) => [ox + 30 + (p[0] - x0) * k, 80 + (p[2] - z0) * k];
  let g = `<text x="${ox + 30}" y="34" class="t">${title}</text><text x="${ox + 30}" y="54" class="s">${sub}</text>`;
  for (const [a, b, c] of legs) {
    if (!st[a] || !st[b]) continue;
    let [ax, ay] = at(st[a]), [bx, by] = at(st[b]);
    // Stopped short of each glyph, so a line never crosses the shape it joins.
    const d = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / d * 16, uy = (by - ay) / d * 16;
    ax += ux; ay += uy; bx -= ux; by -= uy;
    g += `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${c}" stroke-width="1" stroke-dasharray="4 5" opacity=".55"/>`;
  }
  for (const [key, name, c, kind] of list) {
    const p = st[key];
    if (!p) continue;
    const [x, y] = at(p);
    g += glyph(kind, x, y, c);
    const sd = side[key] || 'below';
    const [lx, ly, anchor] = { below: [x, y + 30, 'middle'], above: [x, y - 32, 'middle'], left: [x - 20, y - 2, 'end'], right: [x + 20, y - 2, 'start'] }[sd];
    const a = `text-anchor="${anchor}"`;
    g += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="n" fill="${c}" ${a}>${name}</text>`;
    g += `<text x="${lx.toFixed(1)}" y="${(ly + 15).toFixed(1)}" class="c" ${a}>${p[0].toFixed(1)}, ${p[2].toFixed(1)}</text>`;
  }
  return g;
}

// The run spans half again as far east to west as the base theatre: its panel gets the room.
const W = 1440, H = 560, half = 540;
const legsBase = [['issuer', 'broker', C.ident], ['broker', 'api', C.wire], ['api', 'spire', C.spire], ['bao', 'spire', C.seal], ['policy', 'broker', C.policy], ['api', 'vault', C.seal]];
const legsRun = [['you', 'issuer', C.ident], ['you', 'form', C.ident], ['form', 'broker', C.wire], ['broker', 'api', C.wire], ['api', 'vm', C.wire], ['vm', 'end', C.wire], ['vm', 'spire', C.spire], ['policy', 'broker', C.policy]];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="The theatre seen from above: where each station stands in the Admin and AgentSandbox views">
<style>
.t{font:600 17px ui-monospace,'JetBrains Mono',Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;fill:${C.wire}}
.s{font:13px ui-monospace,'JetBrains Mono',Menlo,monospace;fill:${C.muted}}
.n{font:600 13px ui-monospace,'JetBrains Mono',Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}
.c{font:11px ui-monospace,'JetBrains Mono',Menlo,monospace;fill:${C.muted}}
</style>
<defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${C.faint}" stroke-width=".5" opacity=".6"/></pattern></defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/><rect width="${W}" height="${H}" fill="url(#grid)"/>
<line x1="${half}" y1="20" x2="${half}" y2="${H - 20}" stroke="${C.faint}"/>
${panel('Admin', 'the base theatre: the stations every view shares', base, STATIONS, legsBase, 0, half, H, SIDE)}
${panel('AgentSandbox', 'one run: your sheets, the VM and the exit added', run, [...STATIONS, ...RUN], legsRun, half, W - half, H, RUN_SIDE)}
<text x="${W - 20}" y="34" class="s" text-anchor="end">north up · x east, z south · the defaults: Ctrl-drag moves any of them</text>
</svg>
`;
writeFileSync(out, svg);
console.log(`wrote ${out}`);
