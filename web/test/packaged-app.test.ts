/**
 * The packaged app boots and renders — WITHOUT the dev server.
 *
 * Everything else in this directory runs against Vite, which hides the three
 * ways a shipping build breaks:
 *
 *   - /wasm/* comes from a serve-only middleware, so a build that ships no
 *     bundles 404s silently and the app starts but renders nothing;
 *   - /__naga/wgsl is a serve-only plugin, so without the in-process
 *     translator every shader fails to compile;
 *   - root-absolute URLs and module workers resolve differently outside an
 *     http origin.
 *
 * So this drives the REAL electron/main.cjs in packaged mode (NANO_FORCE_PACKAGED)
 * over the nano:// scheme, against the staged resource root.
 *
 * SKIPS (loudly) when the root hasn't been staged. `npm run build:stage` is not
 * something the normal e2e loop does, and failing here would just tell people
 * to run a build they didn't ask for.
 */

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const ROOT = resolve(REPO, 'build');
const STAGED = existsSync(resolve(ROOT, 'app', 'index.html')) &&
               existsSync(resolve(ROOT, 'wasm', 'core.wasm'));

/** Run a probe script under electron and return what it printed after PROBE. */
function runElectronProbe(script: string, timeoutMs: number): Promise<any> {
  // electron's CLI takes an app PATH, not `-e` like node's — a `-e` is treated
  // as a path, the app never starts, and the probe just times out silently.
  const dir = mkdtempSync(join(tmpdir(), 'nano-pkg-probe-'));
  const scriptPath = join(dir, 'probe.cjs');
  writeFileSync(scriptPath, script);
  return new Promise((res, rej) => {
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
    const child = spawn(
      resolve(__dirname, '..', 'node_modules', '.bin', 'electron'),
      [scriptPath],
      {
        cwd: resolve(__dirname, '..'),
        env: { ...process.env, NANO_FORCE_PACKAGED: '1', NANO_URL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      cleanup();
      rej(new Error('probe timed out:\n' + out));
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      cleanup();
      const marker = out.lastIndexOf('PROBE ');
      if (marker < 0) return rej(new Error('probe produced no result:\n' + out));
      try { res(JSON.parse(out.slice(marker + 6))); }
      catch (e) { rej(new Error(`unparseable probe output: ${e}\n${out}`)); }
    });
  });
}

const PROBE = `
const { app, BrowserWindow } = require('electron');
require(${JSON.stringify(resolve(__dirname, '..', 'electron', 'main.cjs'))});
const logs = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => logs.push(
    typeof ev === 'object' && ev.message ? ev.message : String(ev)));
});
app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2000));
  const win = BrowserWindow.getAllWindows()[0];
  await win.loadURL('nano://app/index.html?playground');
  await new Promise((r) => setTimeout(r, 20000));
  let probe = {};
  try {
    probe = await win.webContents.executeJavaScript(\`(async () => {
      const head = async (u) => { try { const r = await fetch(u); return r.status; } catch { return 0; } };
      const st = window.appState;
      const eff = st && st.local && st.local.availableEffects;
      return {
        origin: location.origin,
        webgpu: !!navigator.gpu,
        secure: window.isSecureContext,
        idb: !!window.indexedDB,
        tag: document.body.firstElementChild ? document.body.firstElementChild.tagName : null,
        core: await head('/wasm/core.wasm'),
        naga: await head('/wasm/naga_spv.wasm'),
        effects: Array.isArray(eff) ? eff.length : (eff ? Object.keys(eff).length : 0),
      };
    })()\`);
  } catch (e) { probe = { error: String(e) }; }
  const bad = logs.filter((m) => /naga bridge|not registered|Out of memory|Failed to fetch/i.test(m));
  console.log('PROBE ' + JSON.stringify({ ...probe, bad: bad.slice(0, 8) }));
  app.exit(0);
});
`;

describe('packaged app (no dev server)', () => {
  jest.setTimeout(120000);

  let probe: any;

  beforeAll(async () => {
    if (!STAGED) return;
    probe = await runElectronProbe(PROBE, 100000);
  });

  it('serves itself over the nano:// scheme', () => {
    if (!STAGED) { console.warn('resource root not staged — run `npm run build:stage`'); return; }
    expect(probe.error).toBeUndefined();
    expect(probe.origin).toBe('nano://app');
  });

  it('is a secure context with storage and WebGPU', () => {
    if (!STAGED) return;
    // All three are required and all three depend on the scheme's privileges;
    // losing any one of them is a silent, total failure at runtime.
    expect(probe.secure).toBe(true);
    expect(probe.idb).toBe(true);
    expect(probe.webgpu).toBe(true);
  });

  it('serves the wasm bundles from the shared root', () => {
    if (!STAGED) return;
    expect(probe.core).toBe(200);
    // Without this one a packaged build has NO shader pipeline at all.
    expect(probe.naga).toBe(200);
  });

  it('boots the sketch editor and loads effects from the bundles', () => {
    if (!STAGED) return;
    expect(probe.tag).toBe('SKETCH-APP');
    // The real assertion: module_init ran for every bundle, which means the
    // wasm loaded AND its shaders translated.
    expect(probe.effects).toBeGreaterThan(100);
    expect(probe.bad).toEqual([]);
  });
});
