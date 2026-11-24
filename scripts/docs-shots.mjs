// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// The docs' screenshots, from the demo (placeholder values only): the AgentSandbox view as it
// opens, the same run while it runs, and the Admin view. Headless Chrome over the DevTools
// protocol, as scripts/record-agentsandbox.mjs; `make docs-media` starts the demo and runs it.
//
// usage: node scripts/docs-shots.mjs URL OUT_DIR
// CHROME names the browser binary (Chrome or Chromium); the macOS path by default.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const W = 1280, H = 760;
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const p = spawn(chrome, ['--headless=new', '--remote-debugging-port=9343', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs;
for (let i = 0; i < 30 && !tabs; i++) { await sleep(500); try { tabs = await (await fetch('http://127.0.0.1:9343/json')).json(); } catch { /* not up yet */ } }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const ev = async (e) => (await call('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expr, ms = 120000) => { const t0 = Date.now(); while (!(await ev(expr)) && Date.now() - t0 < ms) await sleep(100); };
const shot = async (name) => {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'));
  console.log(`wrote ${join(outDir, name)}`);
};
const click = async (sel) => {
  const [x, y] = await ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};

await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// AgentSandbox: as it opens (sheet 01, the issuer beside it), then the run on its way.
await call('Page.navigate', { url });
await sleep(2500);
await shot('agentsandbox-open.png');
await ev(`(() => { const i = document.getElementById('issuer'); i.value = 'https://dex.example.com'; previews(); })()`);
await click('#sign');
await until(`!document.getElementById('send').disabled`);
await sleep(1200);
// Sheet 02 is taller than the window: send it as its button would.
await ev(`document.getElementById('send').click()`);
await until('D.act >= 10 || fx.failed');
await sleep(1500);
// Pulled back from the finished run, the panel closed, to see the whole journey.
await ev(`(() => { closeInspector(); freeCamera(); view.target = [14, 0, -6]; view.off = [-4, 30, 34]; orbit.yaw = 0; orbit.pitch = 0; orbit.zoom = 1; })()`);
await sleep(3000);
await shot('agentsandbox-run.png');

// Admin: every live agent of the demo's scripted fleet.
await call('Page.navigate', { url: url.replace(/\/(\?|$)/, '/admin$1') });
await sleep(6000);
await shot('admin.png');

p.kill();
process.exit(0);
