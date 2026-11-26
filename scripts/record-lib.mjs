// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// The harness the view recordings share: headless Chrome over the DevTools protocol, its
// screencast frames saved with their timestamps, and an ffmpeg concat list (frames.txt) that
// shows each frame until the next one arrived. scripts/record.sh encodes.
//
// CHROME names the browser binary (Chrome or Chromium); the macOS path by default.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function open(url, outDir, W = 1280, H = 760, port = 9341) {
  mkdirSync(outDir, { recursive: true });
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 30 && !tabs; i++) { await sleep(500); try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pend = new Map(), frames = [];
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
  const mouse = (type, x, y, o = {}) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...o });
  const s = {
    call, ev, sleep,
    async until(expr, ms = 60000) { const t0 = Date.now(); while (!(await ev(expr)) && Date.now() - t0 < ms) await sleep(100); },
    // A place in the scene, on screen.
    at: (expr) => ev(`(() => { const q = proj(toCam(${expr})); return [Math.round(q[0]), Math.round(q[1])]; })()`),
    async click(x, y) {
      await mouse('mouseMoved', x, y, { button: 'none' });
      await sleep(120);
      await mouse('mousePressed', x, y, { clickCount: 1 });
      await mouse('mouseReleased', x, y, { clickCount: 1 });
    },
    async clickEl(sel) {
      const r = await ev(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`);
      await s.click(r[0], r[1]);
    },
    // A slow drag across the canvas: orbit by default, shift to pan.
    async drag(x, y, dx, dy, steps = 40, shift = false) {
      const modifiers = shift ? 8 : 0;
      await mouse('mousePressed', x, y, { clickCount: 1, modifiers });
      for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, { buttons: 1, modifiers }); await sleep(45); }
      await mouse('mouseReleased', x + dx, y + dy, { clickCount: 1, modifiers });
    },
    async key(key) {
      await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 });
      await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0 });
    },
    // The details pane scrolled, smoothly, as a person reads it.
    scroll: (top) => ev(`document.getElementById('details').scrollTo({ top: ${top}, behavior: 'smooth' })`),
    async start() {
      await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    },
    async record() { await call('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: W, maxHeight: H }); },
    async finish() {
      await call('Page.stopScreencast');
      await sleep(500);
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const dur = i + 1 < frames.length ? Math.max(0.005, frames[i + 1].t - frames[i].t) : 0.5;
        lines.push(`file '${frames[i].f}'`, `duration ${dur.toFixed(4)}`);
      }
      lines.push(`file '${frames[frames.length - 1].f}'`);
      writeFileSync(`${outDir}/frames.txt`, lines.join('\n') + '\n');
      console.log('frames', frames.length, 'seconds', (frames[frames.length - 1].t - frames[0].t).toFixed(1));
      ws.close();
      browser.kill();
    },
  };
  return s;
}
