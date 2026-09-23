#!/usr/bin/env node
/**
 * surface_profile.mjs — the Live preview path through the REAL desktop shell,
 * shared GPU surfaces (NBPS) against the socket lanes (NBPV), same load.
 *
 *   1. spawn `ffgl_runner --serve`: the NanoBarrel plugin + its bridge, paced
 *      like Resolume, no Resolume.
 *   2. For each transport, launch web/electron/main.cjs as Remote Control
 *      against the dev server (NANO_DISABLE_SURFACES=1 forces the lanes), drive
 *      it over the DevTools protocol, point it at the runner's bridge, and ask
 *      for ONE full-size sketch_output preview in that transport.
 *   3. Measure over the window: previews delivered to the page, bytes the page
 *      received, and CPU seconds of the runner and of the Electron process tree.
 *
 * Run from the repo root, with the dev server up and the addon built
 * (web/native/build.sh):
 *   node web/test-tools/surface_profile.mjs --w 1920 --h 1080 --secs 10
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

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const W = Number(arg('w', '1920'));
const H = Number(arg('h', '1080'));
const SECS = Number(arg('secs', '10'));
const HZ = Number(arg('hz', '30'));
const DEVURL = arg('dev-url', 'http://localhost:5173');
const PORT = Number(arg('port', '8191'));
let debugPort = Number(arg('debug-port', '9478'));
const MODES = (arg('modes', 'lanes,surfaces')).split(',');
const RUNNER = path.join(REPO, 'native/build/ffgl_runner');
const BUNDLE = path.join(REPO, 'native/build/NanoBarrel.bundle');
// The real binary, not the npm wrapper: killing the wrapper leaves Electron
// running on the debug port and the profile lock for the next leg.
const RUNNER_LOG = path.join(REPO, 'build', 'surface_profile_runner.log');
const ELECTRON = require(path.join(WEB, 'node_modules', 'electron'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const cleanup = () => { for (const c of children) { try { c.kill('SIGTERM'); } catch {} } };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const descendants = (pid) => {
  const out = [pid];
  const kids = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout.trim();
  if (kids) for (const c of kids.split(/\s+/)) out.push(...descendants(Number(c)));
  return out;
};
const cpuSeconds = (pids) => {
  const r = spawnSync('ps', ['-o', 'cputime=', '-p', pids.join(',')], { encoding: 'utf8' });
  return r.stdout.trim().split('\n').filter(Boolean).reduce((a, l) => {
    const [d, rest] = l.includes('-') ? l.trim().split('-') : [0, l.trim()];
    const parts = rest.split(':').map(Number);
    const sec = parts.pop() || 0, min = parts.pop() || 0, hr = parts.pop() || 0;
    return a + Number(d) * 86400 + hr * 3600 + min * 60 + sec;
  }, 0);
};

async function runMode(mode) {
  const env = {
    ...process.env,
    NANO_PRODUCT: 'remote',
    NANO_URL: DEVURL,
    NANO_DISABLE_SURFACES: mode === 'lanes' ? '1' : '',
  };
  const port = debugPort++;
  // A throwaway profile per leg: no lock contention with anything else, and
  // no settings (e.g. a remembered offline mode) leaking between legs.
  const profile = fs.mkdtempSync(path.join(REPO, 'build', '.surface-profile-'));
  const app = spawn(ELECTRON, [path.join(WEB, 'electron/main.cjs'),
                               `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
                    { cwd: WEB, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(app);
  // Drain (a full pipe blocks the child), keeping the tail for errors.
  let appOut = '';
  const keep = (d) => { appOut = (appOut + d.toString()).slice(-4000); };
  app.stdout.on('data', keep);
  app.stderr.on('data', keep);
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }); }
    catch { await sleep(500); }
  }
  if (!browser) throw new Error('electron never exposed DevTools:\n' + appOut);
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith(DEVURL));
    if (!page) await sleep(250);
  }
  if (!page) {
    throw new Error('no app page; saw: ' +
      (await browser.pages()).map((p) => p.url()).join(', '));
  }
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.evaluateOnNewDocument(() => {
    try { sessionStorage.removeItem('nano.liveOffline'); } catch {}
    const S = (window.__prof = { rx: 0, nbps: 0 });
    const Native = window.WebSocket;
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      ws.addEventListener('message', (ev) => {
        const d = ev.data;
        if (typeof d === 'string') { S.rx += d.length; return; }
        const count = (buf) => {
          S.rx += buf.byteLength;
          const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
          if (b[0] === 0x4e && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53) S.nbps++;
        };
        if (d instanceof ArrayBuffer) count(d); else if (d?.arrayBuffer) d.arrayBuffer().then(count);
      });
      return ws;
    }
    Patched.prototype = Native.prototype;
    for (const k of ['OPEN', 'CLOSED', 'CONNECTING', 'CLOSING']) Patched[k] = Native[k];
    window.WebSocket = Patched;
  });
  await sleep(2000);
  await page.evaluate((u) => { location.href = u; },
    `${DEVURL}/index.html?barrel=${encodeURIComponent(`ws://localhost:${PORT}`)}`);
  await sleep(1500);
  await page.waitForFunction(() => window.__barrel && window.__barrel.isOpen, { timeout: 30000, polling: 250 })
    .catch((e) => { throw new Error(`${mode}: bridge never opened (${e.message})\n` +
                                    logs.slice(-15).join('\n')); });
  const key = await page.waitForFunction(() => {
    const raw = window.__barrelInstances;
    const scan = (o) => {
      if (!o || typeof o !== 'object') return null;
      for (const kk of ['key', 'uuid', 'id']) if (typeof o[kk] === 'string' && o[kk]) return o[kk];
      for (const v of Array.isArray(o) ? o : Object.values(o)) { const r = scan(v); if (r) return r; }
      return null;
    };
    return scan(raw);
  }, { timeout: 30000, polling: 250 }).then((h) => h.jsonValue());

  await page.evaluate((k, w, h, surface) => {
    const push = () => window.__barrel.patch(`/plugins/${k}/state`, [{
      op: 'add', path: '/preview_requests',
      value: { prof: { target: { type: 'sketch_output', sketchId: k }, width: w, height: h,
                       ...(surface ? { transport: 'surface' } : {}) } },
    }]);
    push();
    window.__profRepush = setInterval(push, 1000);
    window.appState.local.selectedBarrelKey = k;  // route the frames to this page
  }, key, W, H, mode === 'surfaces');

  await sleep(3000);
  const tree = descendants(app.pid);
  const runnerPids = [children[0].pid];
  const c0 = cpuSeconds(tree), r0 = cpuSeconds(runnerPids);
  const g0 = await page.evaluate(() => {
    window.__prof.rx = 0; window.__prof.nbps = 0;
    return window.appState.local.engine.frameGeneration;
  });
  const t0 = Date.now();
  await sleep(SECS * 1000);
  const secs = (Date.now() - t0) / 1000;
  const g1 = await page.evaluate(() => ({
    gen: window.appState.local.engine.frameGeneration, rx: window.__prof.rx, nbps: window.__prof.nbps,
    tex: (() => { const f = window.appState.local.engine.tracedFrames.prof; return f ? `${f.width}x${f.height}` : null; })(),
    ss: window.__previewSurfaces ? { ...window.__previewSurfaces.stats } : null,
  }));
  const c1 = cpuSeconds(descendants(app.pid)), r1 = cpuSeconds(runnerPids);
  browser.disconnect();
  app.kill('SIGTERM');
  await new Promise((r) => {
    if (app.exitCode !== null || app.signalCode !== null) return r();
    const t = setTimeout(() => { try { app.kill('SIGKILL'); } catch {} }, 5000);
    app.once('exit', () => { clearTimeout(t); r(); });
  });
  fs.rmSync(profile, { recursive: true, force: true });
  return {
    mode,
    previewFps: +((g1.gen - g0) / secs).toFixed(1),
    frame: g1.tex,
    pageMBps: +(g1.rx / secs / 1e6).toFixed(2),
    nbpsPerSec: +(g1.nbps / secs).toFixed(1),
    runnerCpuPct: +((r1 - r0) / secs * 100).toFixed(1),
    electronCpuPct: +((c1 - c0) / secs * 100).toFixed(1),
    surfaceLog: logs.some((l) => l.includes('previews: shared GPU surfaces')),
    perFrameMs: g1.ss && g1.ss.frames ? [g1.ss.importMs, g1.ss.copyMs, g1.ss.gpuWaitMs]
      .map((v) => +(v / g1.ss.frames).toFixed(2)).join(' / ') : '',
  };
}

(async () => {
  for (const p of [RUNNER, BUNDLE]) if (!fs.existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
  // Serve until killed (0 = forever): a leg's length depends on how fast the
  // shell comes up and goes down, which is not ours to budget.
  const runner = spawn(RUNNER, [BUNDLE, String(W), String(H), '--serve', '60', '0',
                                '--gen-chain', '3'],
                       { cwd: REPO, env: { ...process.env, NANO_BRIDGE_PORT: String(PORT),
                                           NANO_BARREL_PREVIEW_HZ: String(HZ) },
                         stdio: ['ignore', 'ignore', fs.openSync(RUNNER_LOG, 'w')] });
  children.push(runner);
  await sleep(2500);
  const rows = [];
  for (const mode of MODES) rows.push(await runMode(mode));
  console.table(rows);
  cleanup();
  process.exit(0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
