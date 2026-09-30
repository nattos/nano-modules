#!/usr/bin/env node
// surface_check.mjs — do the arrangement's previews really arrive as shared GPU
// surfaces, and are they the right pixels? Against a RUNNING desktop app (the
// arrangement, native engine) with a remote-debugging port — locally, or on
// another machine through an SSH tunnel:
//
//   NanoModules --remote-debugging-port=9333 ...          (NANO_ARRANGEMENT_ENGINE=native)
//   ssh -N -L 9333:127.0.0.1:9333 user@host               (a remote one)
//   node test-tools/surface_check.mjs [port=9333]
//
// Builds a known frame — an orange quadrant, top left, over nothing — waits for
// surface frames, reads the monitor's preview texture back (window.__previewGpu)
// and compares it with the engine's own readback of the composite
// (sampleComposite): same colours, same corner, so channel order and
// orientation both survive the trip. Exits non-zero on a mismatch.
//
// Speaks raw CDP (Runtime.evaluate only): puppeteer switches on the Network
// domain, which streams every lane frame back through the tunnel.

import WebSocket from 'ws';

const port = Number(process.argv[2] || 9333);

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((p) => p.url.includes('arrangement'));
  if (!target) throw new Error('no arrangement page on that port');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const pending = new Map();
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const evaluate = (fn, ...args) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (m) => {
      if (m.error) return reject(new Error(m.error.message));
      if (m.result.exceptionDetails) {
        return reject(new Error(m.result.exceptionDetails.exception?.description ?? 'evaluate threw'));
      }
      resolve(m.result.result.value);
    });
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      awaitPromise: true, returnByValue: true,
    } }));
  });
  return { evaluate, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = await connect();

const active = await c.evaluate(() => !!window.__previewSurfaces?.active);
console.log(`surfaces active: ${active}`);
if (!active) { console.log('FAIL: the app is not using shared surfaces'); process.exit(1); }

await c.evaluate(() => {
  // A fresh track, soloed, so whatever the composition already holds stays out.
  const store = window.arrangementStore;
  const before = new Set(store.composition.tracks.map((t) => t.id));
  store.addTrack();
  const track = store.composition.tracks.find((t) => t.kind === 'track' && !before.has(t.id));
  store.toggleSolo(track.id);
  const path = store.createEmptyClip(track.id, 0, 256);
  const [, tId, cId] = path.split('/');
  store.addClipDeviceType(tId, cId, 'source.solid_color');
  store.addClipDeviceType(tId, cId, 'warp.crop');
  const clip = store.trackById(tId).clips.find((cl) => cl.id === cId);
  Object.assign(clip.sketch.devices[0].state ??= {}, { color: [1, 0.25, 0] });
  Object.assign(clip.sketch.devices[1].state ??= {},
    { mode: 1, inset_right: 0.5, inset_bottom: 0.5 });
  store.docRev++;  // direct mutation — mirror the doc to the engine
  store.setPosition(1);
});

const s0 = await c.evaluate(() => ({ ...window.__previewSurfaces.stats }));
await sleep(3000);
const s1 = await c.evaluate(() => ({ ...window.__previewSurfaces.stats }));
const fps = (s1.frames - s0.frames) / 3;
console.log(`surface frames: ${fps.toFixed(1)}/s, imports ${s1.imports}`);

const uvs = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
const got = await c.evaluate(async (uvs) => {
  const gpu = window.__previewGpu;
  const id = gpu.traceIds()[0];
  const px = id ? await gpu.readPixels(id) : null;
  if (!px) return { error: 'no preview texture' };
  const at = ([u, v]) => {
    const x = Math.min(px.width - 1, Math.floor(u * px.width));
    const y = Math.min(px.height - 1, Math.floor(v * px.height));
    const o = (y * px.width + x) * 4;
    return Array.from(px.data.subarray(o, o + 4));
  };
  const engine = await window.__engineBridge.sampleComposite(uvs.map(([u, v]) => ({ u, v })));
  return {
    traceId: id, width: px.width, height: px.height,
    surface: uvs.map(at),
    engine: engine?.map((p) => [p.r, p.g, p.b, p.a]) ?? null,
  };
}, uvs);
c.close();
if (got.error) { console.log(`FAIL: ${got.error}`); process.exit(1); }

console.log(`monitor ${got.traceId}: ${got.width}x${got.height}`);
let ok = fps > 0;
const close = (a, b) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= 6);
uvs.forEach((uv, i) => {
  const s = got.surface[i];
  const e = got.engine?.[i];
  const want = i === 0 ? [255, 64, 0] : null;  // the orange quadrant is top left only
  const match = e ? close(s, e) : true;
  const orange = close(s, [255, 64, 0]);
  const pass = match && (want ? orange : !orange);
  ok &&= pass;
  console.log(`  uv ${uv.join(',')}: surface ${s.join(',')}  engine ${e?.join(',') ?? '-'}  ${pass ? 'ok' : 'MISMATCH'}`);
});
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
