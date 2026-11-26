// Copyright (c) 2026 Erick Bourgeois, Recess
// SPDX-License-Identifier: Apache-2.0
//
// Record the AgentSandbox Admin view's demo for the README, driven like a person would: every
// live agent as it opens, the youngest running agent's namespace, that agent framed with its
// gateway and its output followed, a gateway, the agent's policy and ceiling, a pool of VMs and
// the host under them. Writes the PNG frames and frames.txt into OUT_DIR; scripts/record.sh
// encodes.
//
// usage: node scripts/record-admin.mjs URL OUT_DIR [WIDTH HEIGHT]
import { open } from './record-lib.mjs';

const [url, outDir, W = '1280', H = '760'] = process.argv.slice(2);
const s = await open(url, outDir, +W, +H, 9343);
const { ev, sleep } = s;
await s.start();
await s.call('Page.navigate', { url });
await sleep(1500);
await s.call('Page.navigate', { url: url.replace(/\/(\?.*)?$/, '/admin') });
// The youngest running agent: demo agents live a minute or so, and this one has the most left.
const running = `[...nodes.values()].filter((n) => n.kind === 'agent' && !n.gone && stateOf(n.obj) === 'running').sort((a, b) => String(b.obj.metadata?.creationTimestamp).localeCompare(String(a.obj.metadata?.creationTimestamp)))[0]`;
await s.until(`nodes.has('gw/gateway-01') && !!${running}`);
await sleep(800);
await s.record();
await sleep(2500);

// 1. The fleet: a slow turn round it.
await s.drag(700, 420, -160, -20, 50);
await sleep(1500);

// 2. A namespace, then a running agent in it, framed with the gateway that carries it.
const agent = await ev(`${running}.key`);
await ev(`select('ns/' + nsOf(nodes.get('${agent}').obj))`); await sleep(2800);
await ev(`select('${agent}')`); await sleep(3200);
await s.scroll(300); await sleep(2000);
// Its output, as it runs.
await s.clickEl('#tab-output'); await sleep(3500);
await s.clickEl('#tab-details'); await sleep(800);

// 3. A gateway, then the agent's policy and its ceiling where it has one.
await ev(`select('gw/gateway-01')`); await sleep(3200);
const policy = await ev(`policyKeyOf(nodes.get('${agent}').obj)`);
for (const k of policy ? [policy, policy.replace(/^policy\//, 'ceiling/')] : []) {
  if (await ev(`nodes.has('${k}')`)) { await ev(`select('${k}')`); await sleep(3000); }
}

// 4. Where the agents run: a pool of VMs, one VM, and the host under them.
await ev(`select('pool/banlieue-system/pool-standard')`); await sleep(3000);
const vm = await ev(`[...nodes.values()].find((n) => n.kind === 'vm' && !n.gone && index().agentOnVm.get(n.key))?.key`);
if (vm) { await ev(`select('${vm}')`); await sleep(3000); }
await ev(`select('provider/banlieue-system/host-1')`); await sleep(3000);

// 5. Back out to every agent.
await s.key('Escape'); await sleep(2000);
await s.drag(560, 420, 150, 10, 40);
await sleep(2200);
await s.finish();
process.exit(0);
