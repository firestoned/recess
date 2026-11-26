// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// Record the Kubernetes view's demo for the README, driven like a person would: the cluster as
// it opens, a namespace, a pod risen on its containers, the vault and one drawer read, the pin
// board and a note peeled, then the admission policies beside the API with their hits flying, and
// the cupboard opened on a namespace's shelf of denials. Writes the PNG frames and frames.txt
// into OUT_DIR; scripts/record.sh encodes.
//
// usage: node scripts/record-kubernetes.mjs URL OUT_DIR [WIDTH HEIGHT]
import { open } from './record-lib.mjs';

const [url, outDir, W = '1280', H = '760'] = process.argv.slice(2);
const s = await open(url, outDir, +W, +H, 9342);
const { ev, sleep } = s;
await s.start();
// The link signs the browser in; the view is a page of its own.
await s.call('Page.navigate', { url });
await sleep(1500);
await s.call('Page.navigate', { url: url.replace(/\/(\?.*)?$/, '/kubernetes') });
await s.until(`nodes.has('cupboard') && S.vapfail.size > 2`);
await sleep(800);
await s.record();
await sleep(2500);

// 1. The cluster: a slow turn round it.
await s.drag(700, 420, -180, -20, 50);
await sleep(1500);

// 2. A namespace, then a pod in it, risen on its containers.
await ev(`select('ns/team-a')`); await sleep(2800);
const pod = await ev(`[...nodes.values()].find((n) => n.kind === 'pod' && n.ns === 'team-a' && !n.gone)?.key`);
await ev(`select('${pod}')`); await sleep(3200);
await s.scroll(320); await sleep(2000);

// 3. Its vault, one drawer opened and a value shown (read with the person's own credentials,
// as the demo answers).
await ev(`select('vault/team-a')`); await sleep(2600);
await ev(`select('vault/team-a', 'api-db-credentials')`); await sleep(2400);
await s.clickEl('#details button.ghost.small'); await sleep(2600);

// 4. The pin board, a note peeled and one of its keys shown.
await ev(`select('board/team-a')`); await sleep(2600);
await ev(`select('board/team-a', 'api-config')`); await sleep(2400);
await s.clickEl('#details button.ghost.small'); await sleep(2600);
await s.key('Escape'); await s.key('Escape'); await sleep(1800);

// 5. The admission policies beside the API: their hits fly in, and what they turn away goes on
// into the cupboard.
await ev(`select('vapgate')`);
await s.until(`PULSES.length > 0`, 15000);
await sleep(3500);
await ev(`select('vap/require-non-root')`); await sleep(3500);
await s.scroll(260); await sleep(1800);
await ev(`select('cupboard')`); await sleep(3000);
await ev(`select('cupboard', 'team-b')`); await sleep(3500);
await ev(`select('cupboard', '*')`); await sleep(3000);

// 6. Back out to the whole cluster.
await s.key('Escape'); await s.key('Escape'); await sleep(2000);
await s.drag(560, 420, 160, 10, 40);
await sleep(2200);
await s.finish();
process.exit(0);
