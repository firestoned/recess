// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// Record the AgentSandbox demo for the README: Chrome's screencast frames with their timestamps,
// driven like a person would (type the issuer, sign in, fill sheet 02 and send, drill into the gateway and the
// vault while it runs, follow it to the exit, then tour the layers and orbit). Writes the PNG
// frames and an ffmpeg concat list (frames.txt) into OUT_DIR; scripts/record-agentsandbox.sh encodes.
//
// usage: node scripts/record-agentsandbox.mjs URL OUT_DIR [WIDTH HEIGHT]
// CHROME names the browser binary (Chrome or Chromium); the macOS path by default.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
const [url, outDir, W = '1280', H = '760'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const p = spawn(chrome, ['--headless=new', '--remote-debugging-port=9340', `--user-data-dir=${mkdtempSync('/tmp/cdp-')}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 30; i++) { await sleep(500); try { tabs = await (await fetch('http://127.0.0.1:9340/json')).json(); break; } catch {} }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map(); const frames = [];
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Page.screencastFrame') {
    const f = `${outDir}/f${String(frames.length).padStart(5, '0')}.png`;
    writeFileSync(f, Buffer.from(d.params.data, 'base64'));
    frames.push({ f, t: d.params.metadata.timestamp });
    call('Page.screencastFrameAck', { sessionId: d.params.sessionId });
  }
  if (d.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(d.params.exceptionDetails).slice(0, 400));
});
const ev = async (e) => (await call('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expr, ms = 120000) => { const t0 = Date.now(); while (!(await ev(expr)) && Date.now() - t0 < ms) await sleep(100); };
const at = (expr) => ev(`(() => { const q = proj(toCam(${expr})); return [Math.round(q[0]), Math.round(q[1])]; })()`);
const click = async (x, y) => {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(120);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const clickEl = async (sel) => { const r = await ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`); await click(r[0], r[1]); };
await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride', { width: +W, height: +H, deviceScaleFactor: 1, mobile: false });
await call('Page.navigate', { url });
await sleep(1500);
await call('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: +W, maxHeight: +H });
await sleep(1200);
// 1. Write the issuer, sign in.
await ev(`(() => { const i = document.getElementById('issuer'); i.value = ''; i.focus(); previews(); })()`);
for (const ch of 'https://dex.example.com') { await call('Input.insertText', { text: ch }); await sleep(55); }
await sleep(500);
await clickEl('#sign');
await until(`!document.getElementById('send').disabled`);
await sleep(1600);
// 2. Seal and send; watch the journey until the work runs.
// Sheet 02: a few of its options, then the button, scrolled into view as a person would.
await ev(`(() => { const f = document.getElementById('sheet-create'); const set = (k, v) => { const i = f.querySelector('[data-k=' + k + ']'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('ttl', 1200); set('audiences', 'anthropic'); })()`);
await sleep(900);
await ev(`document.getElementById('send').scrollIntoView({ block: 'nearest', behavior: 'smooth' })`);
await sleep(900);
await clickEl('#send');
await until(`D.act >= 8 && !D.busy`);
await sleep(1200);
// 3. While it runs: the gateway carrying the tunnels, then the vault and a deposit box.
const clickAt = async (expr) => { const [x, y] = await at(expr); await click(x, y); };
await clickAt(`gwPos(carrierIdx() >= 0 ? carrierIdx() : 1)`); await sleep(2800);
await ev(`select('node', 'vault')`); await sleep(1600);
{ const [x, y] = await at('ST.vault');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2 }); }
await sleep(2600);
await clickAt('boxAt(0)'); await sleep(2800);
// 4. Back to the run, to its exit.
await clickEl('#follow');
await until(`D.act >= 10 || fx.failed`);
await sleep(2500);
// 5. The theatre: drill into the VM's layers, the proxy, the broker's TLS.
await ev(`select('node', 'vm')`); await sleep(1800);
await ev(`document.getElementById('details').scrollTo({ top: 420, behavior: 'smooth' })`); await sleep(1800);
await ev(`select('node', 'proxy')`); await sleep(2600);
await ev(`select('node', 'broker')`); await sleep(1500);
await ev(`document.getElementById('details').scrollTo({ top: 300, behavior: 'smooth' })`); await sleep(2200);
// Your card on its rolodex, and the vault after the release: the boxes it emptied, struck through.
await ev(`select('node', 'you')`); await sleep(2600);
await ev(`select('node', 'vault')`); await sleep(1400);
await ev(`(() => { const d = document.getElementById('details'); const b = d.querySelector('.deposit'); if (b) d.scrollTo({ top: d.scrollTop + b.getBoundingClientRect().top - d.getBoundingClientRect().top - 60, behavior: 'smooth' }); })()`); await sleep(2400);
const [ox, oy] = [360, 430];
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: ox, y: oy, button: 'left', clickCount: 1 });
for (let i = 1; i <= 40; i++) { await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ox - i * 6, y: oy - i, button: 'left', buttons: 1 }); await sleep(45); }
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ox - 240, y: oy - 40, button: 'left', clickCount: 1 });
await sleep(1600);
await clickEl('#follow');
await sleep(2500);
await call('Page.stopScreencast');
await sleep(500);
// The concat list ffmpeg reads: each frame shown until the next one arrived.
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const dur = i + 1 < frames.length ? Math.max(0.005, frames[i + 1].t - frames[i].t) : 0.5;
  lines.push(`file '${frames[i].f}'`, `duration ${dur.toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].f}'`);
writeFileSync(`${outDir}/frames.txt`, lines.join('\n') + '\n');
console.log('frames', frames.length, 'seconds', (frames[frames.length - 1].t - frames[0].t).toFixed(1));
p.kill(); process.exit(0);
