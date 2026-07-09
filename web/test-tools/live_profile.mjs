#!/usr/bin/env node
/**
 * live_profile.mjs — end-to-end profile of the Live-preview path with the REAL
 * web editor driving a headless FFGL host (no Resolume).
 *
 * This is the faithful counterpart to native/tools/preview_sweep.py: the sweep
 * measures the barrel's CPU headlessly with a fake in-process editor; this drives
 * the ACTUAL browser editor over the real transport so you also get the browser
 * side (the "+100% CPU" half) and can `sample` the FFGL host under real load.
 *
 * Pipeline (all real code — nothing simulated on the web side):
 *   1. spawn `ffgl_runner --serve` → hosts the NanoBarrel FFGL plugin + its shared
 *      bridge (ws://localhost:8081) + preview fan-out lanes, paced like Resolume.
 *   2. point puppeteer at the already-running vite dev server (default :5173):
 *      /index.html?barrel=ws://localhost:8081 → boot-resolume connectBarrel()
 *      runs unmodified (observes /global/plugins, opens the fan-out lanes,
 *      reassembles NBPV frames, decodes via createImageBitmap → canvas).
 *   3. inject ONE preview_request (the exact editor shape) for the served
 *      instance, re-pushed each second so the editor's own pusher can't clear it.
 *   4. measure, in-page: preview FPS + wire bandwidth across all lanes, main-thread
 *      browser CPU (page.metrics TaskDuration), control-plane RTT. FFGL-side ground
 *      truth (served fps, ProcessOpenGL ms) is parsed from the runner's stderr, and
 *      `--sample` attaches macOS `sample` to the runner PID for a hotspot dump.
 *
 * Run from the repo root:
 *   node web/test-tools/live_profile.mjs
 *   node web/test-tools/live_profile.mjs --w 1920 --h 1080 --preview 1920x1080 --secs 20 --sample
 *   node web/test-tools/live_profile.mjs --hz 30 --fanout 8 --headful   # watch it
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(REPO, 'web');
const puppeteer = require(path.join(WEB, 'node_modules', 'puppeteer'));

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const W = Number(arg('w', '1280'));
const H = Number(arg('h', '720'));
const [PW, PH] = (arg('preview', `${W}x${H}`)).split('x').map(Number);
const HZ = Number(arg('hz', '30'));
const FANOUT = Number(arg('fanout', '8'));
const SECS = Number(arg('secs', '15'));
const DEVURL = arg('dev-url', 'http://localhost:5173');
const BRIDGE = arg('bridge', 'ws://localhost:8081');
const BUNDLE = path.resolve(REPO, arg('bundle', 'native/build/NanoBarrel.bundle'));
const RUNNER = path.resolve(REPO, arg('runner', 'native/build/ffgl_runner'));
const GEN_CHAIN = arg('gen-chain', '3');
const DO_SAMPLE = has('sample');
const HEADFUL = has('headful');

for (const [label, p] of [['runner', RUNNER], ['bundle', BUNDLE]]) {
  if (!fs.existsSync(p)) {
    console.error(`[live_profile] missing ${label}: ${p}` +
      (label === 'runner' ? '\n  build: (cd native && cmake --build build --target ffgl_runner)' : ''));
    process.exit(1);
  }
}

const children = [];
const track = (c) => { children.push(c); return c; };
const cleanup = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whole-browser CPU: page.metrics().TaskDuration is main-thread only, but the
// heavy Live-preview work (createImageBitmap decode + GPU upload) runs in the
// renderer/GPU child processes. Sum cumulative CPU-time across the chrome
// process tree so we capture it — this is the number Activity Monitor shows.
const descendants = (pid) => {
  const out = [pid];
  const kids = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim();
  if (kids) for (const c of kids.split(/\s+/)) out.push(...descendants(Number(c)));
  return out;
};
const parseCpuTime = (s) => {  // ps cputime: [[dd-]hh:]mm:ss(.ff)
  const neg = s.includes('-') ? s.split('-') : [null, s];
  const days = neg[0] ? Number(neg[0]) : 0;
  const parts = neg[1].split(':').map(Number);
  let sec = parts.pop() || 0;
  const min = parts.pop() || 0;
  const hr = parts.pop() || 0;
  return days * 86400 + hr * 3600 + min * 60 + sec;
};
const treeCpuSeconds = (rootPid) => {
  const pids = descendants(rootPid);
  const r = spawnSync('ps', ['-o', 'cputime=', '-p', pids.join(',')], { encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean).reduce((a, l) => a + parseCpuTime(l.trim()), 0);
};

// ---- 1. ffgl_runner --serve ---------------------------------------------
// Runner env: preview cadence + fan-out lane count knobs (same as the barrel).
const runnerEnv = { ...process.env, NANO_BARREL_PREVIEW_HZ: String(HZ), NANO_PREVIEW_FANOUT: String(FANOUT) };
const runnerArgs = [BUNDLE, String(W), String(H), '--serve', '60', String(SECS + 30), '--gen-chain', GEN_CHAIN];
console.log(`[live_profile] runner: ffgl_runner ${path.basename(BUNDLE)} ${W}x${H} --serve 60 ${SECS + 30} --gen-chain ${GEN_CHAIN}  (hz=${HZ} fanout=${FANOUT})`);
const runner = track(spawn(RUNNER, runnerArgs, { cwd: REPO, env: runnerEnv }));
const RUNNER_PID = runner.pid;
const serveSamples = [];  // { fps, procMs }
const RE_SERVE = /serve:\s*([\d.]+)\s*fps,\s*ProcessOpenGL avg\s*([\d.]+)\s*ms/;
let rbuf = '';
runner.stderr.on('data', (d) => {
  rbuf += d.toString();
  let nl;
  while ((nl = rbuf.indexOf('\n')) >= 0) {
    const line = rbuf.slice(0, nl); rbuf = rbuf.slice(nl + 1);
    const m = RE_SERVE.exec(line);
    if (m) serveSamples.push({ fps: +m[1], procMs: +m[2] });
  }
});
runner.on('exit', (code) => { if (code) console.log(`[live_profile] runner exited early (${code})`); });

// ---- helpers -------------------------------------------------------------
const waitUrl = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
};

(async () => {
  // Wait for the runner's bridge to be up (main port listening).
  await sleep(1500);
  if (!(await waitUrl(`${DEVURL}/index.html`))) {
    console.error(`[live_profile] dev server not reachable at ${DEVURL} — start it (cd web && npm run dev) or pass --dev-url`);
    cleanup(); process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (/error|barrel|preview|offline/i.test(t)) console.log('  [page]', t); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // Inject WS byte/frame counters BEFORE any app socket opens, and make sure we
  // don't boot into offline sim (barrelRemoteEnabled defaults true; just clear
  // the offline sessionStorage flag).
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.removeItem('nano.liveOffline'); } catch {}
    const S = (window.__prof = { rx: 0, tx: 0, frames: 0, msgs: 0, laneMsgs: 0,
      cibN: 0, cibMs: 0, drawN: 0, drawMs: 0 });

    // Time the two dominant browser-side stages of the preview ingest, both
    // globally wrappable: createImageBitmap (decode + premultiply, resolves when
    // the decode worker finishes) and ctx.drawImage of an ImageBitmap (GPU
    // upload/blit). Per-frame ms tells us where the off-main-thread CPU lives.
    const nativeCIB = window.createImageBitmap.bind(window);
    window.createImageBitmap = (...a) => {
      const t = performance.now();
      return nativeCIB(...a).then((r) => { S.cibN++; S.cibMs += performance.now() - t; return r; });
    };
    const proto = CanvasRenderingContext2D.prototype;
    const nativeDraw = proto.drawImage;
    proto.drawImage = function (...a) {
      const t = performance.now();
      const r = nativeDraw.apply(this, a);
      S.drawN++; S.drawMs += performance.now() - t;
      return r;
    };
    const partials = new Map();
    const isNBPC = (dv) => dv.byteLength >= 12 && dv.getUint8(0) === 0x4e && dv.getUint8(1) === 0x42 && dv.getUint8(2) === 0x50 && dv.getUint8(3) === 0x43;
    const countBinary = (buf) => {
      S.rx += buf.byteLength; S.laneMsgs++;
      const dv = new DataView(buf);
      if (!isNBPC(dv)) { S.frames++; return; }
      const seq = dv.getUint32(4, true), cnt = dv.getUint16(10, true);
      if (cnt === 0) return;
      let p = partials.get(seq); if (!p) { p = { got: 0, cnt }; partials.set(seq, p); }
      if (++p.got >= cnt) { S.frames++; partials.delete(seq); }
      if (partials.size > 128) partials.clear();
    };
    const Native = window.WebSocket;
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      const send = ws.send.bind(ws);
      ws.send = (data) => { try { S.tx += typeof data === 'string' ? data.length : (data.byteLength ?? data.size ?? 0); } catch {} return send(data); };
      ws.addEventListener('message', (ev) => {
        S.msgs++;
        const d = ev.data;
        if (typeof d === 'string') S.rx += d.length;
        else if (d instanceof ArrayBuffer) countBinary(d);
        else if (d && d.arrayBuffer) d.arrayBuffer().then(countBinary);
      });
      return ws;
    }
    Patched.prototype = Native.prototype;
    for (const k of ['OPEN', 'CLOSED', 'CONNECTING', 'CLOSING']) Patched[k] = Native[k];
    window.WebSocket = Patched;
  });

  const target = `${DEVURL}/index.html?barrel=${encodeURIComponent(BRIDGE)}`;
  console.log('[live_profile] navigating editor →', target);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Bridge open + served instance visible.
  await page.waitForFunction(() => window.__barrel && window.__barrel.isOpen, { timeout: 30000 })
    .catch(() => { throw new Error('bridge never opened — did it boot offline? check barrelRemoteEnabled'); });
  const key = await page.waitForFunction(() => {
    const raw = window.__barrelInstances;
    if (!raw) return null;
    // /global/plugins snapshot: find the first UUID-ish key on any entry.
    const scan = (o) => {
      if (!o || typeof o !== 'object') return null;
      for (const v of Array.isArray(o) ? o : Object.values(o)) {
        if (typeof v === 'string' && /^[0-9A-Fa-f-]{36}$/.test(v)) return v;
      }
      for (const kk of ['key', 'id', 'instanceKey']) if (typeof o[kk] === 'string' && o[kk]) return o[kk];
      for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = scan(v); if (r) return r; }
      return null;
    };
    return scan(raw);
  }, { timeout: 30000 }).then((h) => h.jsonValue());
  console.log('[live_profile] served instance key =', key);

  // Push ONE full-res sketch_output preview request (the exact editor shape),
  // re-pushed each second (the editor's own pusher writes {} when no UI trace
  // point is open, which would clear ours).
  await page.evaluate((k, pw, ph) => {
    const push = () => window.__barrel.patch(`/plugins/${k}/state`, [{
      op: 'add', path: '/preview_requests',
      value: { prof: { target: { type: 'sketch_output', sketchId: k }, width: pw, height: ph } },
    }]);
    push();
    window.__profRepush = setInterval(push, 1000);
    // Control-plane RTT: get(/global/plugins) → next snapshot.
    window.__rtt = [];
    window.__barrel.onSnapshot('/global/plugins', () => {
      if (window.__rttPending != null) { window.__rtt.push(performance.now() - window.__rttPending); window.__rttPending = null; }
    });
    window.__rttTimer = setInterval(() => {
      if (window.__rttPending == null) { window.__rttPending = performance.now(); window.__barrel.get('/global/plugins'); }
    }, 500);
  }, key, PW, PH);

  // Let previews start flowing, then reset counters + snapshot CPU baseline.
  await sleep(2000);
  const browserPid = browser.process()?.pid;
  const cpu0 = browserPid ? treeCpuSeconds(browserPid) : NaN;
  const m0 = await page.metrics();
  const t0 = Date.now();
  await page.evaluate(() => { const s = window.__prof; s.rx = s.tx = s.frames = s.msgs = s.laneMsgs = s.cibN = s.cibMs = s.drawN = s.drawMs = 0; });

  // Attach the native sampler for the measurement window. NOT tracked in
  // `children` — cleanup() would SIGTERM it before it flushes the file; instead
  // we await its own exit below (it self-terminates after its duration).
  const samplers = [];  // { name, proc, out }
  const dur = Math.round(SECS);
  const startSample = (pid, tag) => {
    const out = path.join(REPO, 'native', 'build', `live_profile_sample_${tag}.txt`);
    const proc = spawn('sample', [String(pid), String(dur), '-file', out], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
    samplers.push({ name: tag, proc, out });
    console.log(`[live_profile] sampling ${tag} pid ${pid} → ${out}`);
  };
  if (DO_SAMPLE) startSample(RUNNER_PID, `ffgl_${W}x${H}`);
  // --web-sample: sample the chrome GPU process (does the texture upload +
  // canvas composite) and the renderer (JS + reassembly copies + decode
  // dispatch) — the ~120% the JS-level wrappers can't see.
  if (has('web-sample') && browserPid) {
    for (const pid of descendants(browserPid)) {
      const argsStr = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
      if (/--type=gpu-process/.test(argsStr)) startSample(pid, `chrome_gpu_${W}x${H}`);
      else if (/--type=renderer/.test(argsStr)) startSample(pid, `chrome_renderer_${W}x${H}`);
    }
  }

  console.log(`[live_profile] measuring ${SECS}s (comp ${W}x${H}, preview ${PW}x${PH}, hz ${HZ}, fanout ${FANOUT})…`);
  await sleep(SECS * 1000);
  for (const s of samplers) await new Promise((res) => { s.proc.on('exit', res); setTimeout(res, 8000); });
  const sampleOut = samplers.length ? samplers.map((s) => s.out) : null;

  const m1 = await page.metrics();
  const cpu1 = browserPid ? treeCpuSeconds(browserPid) : NaN;
  const wall = (Date.now() - t0) / 1000;
  const client = await page.evaluate(() => {
    clearInterval(window.__profRepush); clearInterval(window.__rttTimer);
    const s = window.__prof, rtt = window.__rtt.slice().sort((a, b) => a - b);
    const pct = (q) => rtt.length ? rtt[Math.min(rtt.length - 1, Math.floor(q * rtt.length))] : NaN;
    return { rx: s.rx, tx: s.tx, frames: s.frames, msgs: s.msgs, laneMsgs: s.laneMsgs,
      cibN: s.cibN, cibMs: s.cibMs, drawN: s.drawN, drawMs: s.drawMs, rttP50: pct(0.5), rttP95: pct(0.95) };
  });
  await browser.close();

  // ---- report ------------------------------------------------------------
  const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  const ffFps = avg(serveSamples.map((s) => s.fps));
  const ffMs = avg(serveSamples.map((s) => s.procMs));
  const cpuMainPct = ((m1.TaskDuration - m0.TaskDuration) / wall) * 100;
  console.log('\n================ live_profile ================');
  console.log(`  window                  : ${wall.toFixed(1)} s   comp ${W}x${H}  preview ${PW}x${PH}  hz ${HZ}  fanout ${FANOUT}`);
  console.log(`  FFGL ProcessOpenGL      : ${isFinite(ffMs) ? ffMs.toFixed(2) + ' ms/frame' : '(no serve: lines)'}  ${isFinite(ffFps) ? '(' + ffFps.toFixed(1) + ' fps served)' : ''}`);
  console.log(`  client preview FPS      : ${(client.frames / wall).toFixed(1)} fps   (${client.frames} NBPV frames reassembled)`);
  console.log(`  preview bandwidth (rx)  : ${(client.rx / wall / 1e6).toFixed(1)} MB/s   (${client.laneMsgs} lane msgs)`);
  console.log(`  editor→bridge (tx)      : ${(client.tx / wall / 1e3).toFixed(2)} KB/s   (${client.msgs} rx msgs total)`);
  const cpuTreePct = isFinite(cpu1) ? ((cpu1 - cpu0) / wall) * 100 : NaN;
  console.log(`  browser CPU (whole proc): ${isFinite(cpuTreePct) ? cpuTreePct.toFixed(0) + ' %' : 'n/a'}   (chrome process tree — incl. decode + GPU upload)`);
  console.log(`  browser CPU (main thread): ${cpuMainPct.toFixed(0)} %   (page.metrics TaskDuration)`);
  const per = (ms, n) => n ? (ms / n).toFixed(2) : 'n/a';
  const share = (ms) => wall ? ((ms / 1000 / wall) * 100).toFixed(0) : '?';
  console.log(`  createImageBitmap       : ${per(client.cibMs, client.cibN)} ms/frame  (${client.cibN} calls, ~${share(client.cibMs)}% of one thread — decode+premultiply)`);
  console.log(`  ctx.drawImage           : ${per(client.drawMs, client.drawN)} ms/frame  (${client.drawN} calls, ~${share(client.drawMs)}% of one thread — GPU upload/blit)`);
  console.log(`  browser JS heap         : ${(m1.JSHeapUsedSize / 1e6).toFixed(0)} MB`);
  console.log(`  control RTT p50 / p95   : ${client.rttP50.toFixed(1)} / ${client.rttP95.toFixed(1)} ms`);
  if (sampleOut) for (const s of samplers) console.log(`  hotspot profile         : ${s.name} → ${s.out}`);
  console.log('==============================================\n');
  cleanup();
  process.exit(0);
})().catch((err) => { console.error('[live_profile]', err.stack || err); cleanup(); process.exit(1); });
