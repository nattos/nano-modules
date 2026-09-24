/**
 * Desktop settings live in files — one per surface, in a folder shared with
 * the FFGL plugin — and an outside edit (a person, a script, a coding agent)
 * applies to a running app live.
 *
 * Drives the REAL electron/main.cjs in packaged mode through
 * fixtures/desktop-settings-probe.cjs, with NANO_DATA_DIR pointing at a temp
 * folder and every launch on its OWN fresh profile: an empty IndexedDB is the
 * point — only the files may carry the settings. SKIPS when the resource root
 * hasn't been staged (`npm run build:stage`), like packaged-app.test.ts.
 */

import { spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const ROOT = resolve(REPO, 'build');
const STAGED = existsSync(resolve(ROOT, 'app', 'arrangement.html')) &&
               existsSync(resolve(ROOT, 'wasm', 'core.wasm'));
const PROBE = resolve(__dirname, 'fixtures', 'desktop-settings-probe.cjs');

let work = '';

function runPhase(
  phase: 'arrangement' | 'relaunch' | 'remote', product: 'arrangement' | 'remote',
): Promise<any> {
  const profile = mkdtempSync(join(work, 'profile-'));
  return new Promise((res, rej) => {
    const child = spawn(
      resolve(__dirname, '..', 'node_modules', '.bin', 'electron'), [PROBE],
      {
        cwd: resolve(__dirname, '..'),
        env: {
          ...process.env, NANO_FORCE_PACKAGED: '1', NANO_URL: '', NANO_PRODUCT: product,
          NANO_DATA_DIR: join(work, 'data'), PHASE: phase, PROFILE: profile,
          MAIN_CJS: resolve(__dirname, '..', 'electron', 'main.cjs'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error('probe timed out:\n' + out));
    }, 90000);
    child.on('close', () => {
      clearTimeout(timer);
      const marker = out.lastIndexOf('PROBE ');
      if (marker < 0) return rej(new Error('probe produced no result:\n' + out));
      try { res(JSON.parse(out.slice(marker + 6))); }
      catch (e) { rej(new Error(`unparseable probe output: ${e}\n${out}`)); }
    });
  });
}

(STAGED ? describe : describe.skip)('desktop settings: one file per surface, edited live', () => {
  beforeAll(() => { work = mkdtempSync(join(tmpdir(), 'nano-desktop-settings-')); });
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it('the arrangement app saves its layout, and applies an outside edit without echoing it', async () => {
    const r = await runPhase('arrangement', 'arrangement');
    expect(r.error).toBeUndefined();
    expect(r.saved).toBe(333);
    expect(r.readme).toBe(true);
    expect(r.applied).toBe(222);
    expect(r.untouched).toBe(true);
    // Its next save keeps a key the outside tool added.
    expect(r.afterInApp).toEqual({ width: 250, agentNote: 'kept' });
  }, 120000);

  it('a fresh profile restores the layout from the file alone', async () => {
    const r = await runPhase('relaunch', 'arrangement');
    expect(r.error).toBeUndefined();
    expect(r.width).toBe(250);
  }, 120000);

  it('Remote Control applies outside edits to its settings and the MIDI library', async () => {
    const r = await runPhase('remote', 'remote');
    expect(r.error).toBeUndefined();
    expect(r.written).toBe(60);
    expect(r.fps).toBe(77);
    expect(r.midi).toContain('agent-device');
  }, 120000);
});
