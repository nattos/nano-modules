/**
 * Desktop media bindings — the arrangement app finds its clips WITHOUT any
 * library set up, and streams them from disk.
 *
 * In the desktop app a clip records where its file really is
 * (`clip.source.file = {abs, rel}`, rel = relative to the document's folder),
 * and the decoders read it over `nano://app/__media/` with Range requests
 * instead of an in-memory blob. Library paths are left for interop with
 * browser-made documents, whose ids are foreign here: those are adopted once.
 *
 * Drives the REAL electron/main.cjs as the arrangement product in packaged
 * mode (fixtures/desktop-media-probe.cjs), each launch with its OWN fresh
 * profile — an empty IndexedDB is the point: only the document may locate the
 * media. The cases run in order against one project folder. SKIPS when the
 * resource root hasn't been staged (`npm run build:stage`), like
 * packaged-app.test.ts.
 */

import { spawn } from 'child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const ROOT = resolve(REPO, 'build');
const STAGED = existsSync(resolve(ROOT, 'app', 'arrangement.html')) &&
               existsSync(resolve(ROOT, 'wasm', 'core.wasm'));
const CLIP = resolve(__dirname, '..', 'public', 'media', 'test_h264.mp4');
const PROBE = resolve(__dirname, 'fixtures', 'desktop-media-probe.cjs');

let work = '';

function runPhase(phase: 'save' | 'reopen' | 'adopt', proj: string): Promise<any> {
  const profile = mkdtempSync(join(work, 'profile-'));
  return new Promise((res, rej) => {
    const child = spawn(
      resolve(__dirname, '..', 'node_modules', '.bin', 'electron'), [PROBE],
      {
        cwd: resolve(__dirname, '..'),
        env: {
          ...process.env, NANO_FORCE_PACKAGED: '1', NANO_URL: '', NANO_PRODUCT: 'arrangement',
          PHASE: phase, PROFILE: profile, PROJ: proj,
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

(STAGED ? describe : describe.skip)('desktop media: documents carry real file locations', () => {
  let proj = '';

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'nano-desktop-media-'));
    proj = join(work, 'proj');
    mkdirSync(join(proj, 'media'), { recursive: true });
    copyFileSync(CLIP, join(proj, 'media', 'clip.mp4'));
  });
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  it('streams local media with Range requests, from the page and from a worker', async () => {
    const r = await runPhase('save', proj);
    expect(r.error).toBeUndefined();
    expect(r.page).toMatchObject({ status: 206, len: 100, type: 'video/mp4' });
    expect(r.page.cr).toMatch(/^bytes 0-99\/\d+$/);
    expect(r.worker).toEqual([206, 10]);
    // Imported straight from disk: the clip's url is the media route, not a blob.
    expect(r.import.url.startsWith('nano://app/__media/')).toBe(true);
    expect(r.import.w).toBe(1280);
    // The saved document carries the real location, relative to its own
    // folder (acts/) too — and no library ref, since none was set up.
    const saved = JSON.parse(readFileSync(join(proj, 'acts', 'show.nano-arr'), 'utf8'));
    const src = saved.composition.tracks.flatMap((t: any) => t.clips).find((c: any) => c.source).source;
    expect(src.file.rel).toEqual(['..', 'media', 'clip.mp4']);
    expect(src.file.abs.endsWith('/proj/media/clip.mp4')).toBe(true);
    expect(src.url).toBeUndefined();
    expect(src.ref).toBeUndefined();
  }, 120000);

  it('reopens from a fresh profile, and the <video> frames upload to the GPU', async () => {
    const r = await runPhase('reopen', proj);
    expect(r.error).toBeUndefined();
    expect(r.missing).toBe(false);
    expect(r.url.startsWith('nano://app/__media/')).toBe(true);
    // crossOrigin video over the custom scheme: a tainted frame would throw here.
    expect(r.video).toMatchObject({ w: 1280, gpuUpload: 'ok' });
  }, 120000);

  it('follows a moved project folder through file.rel, and records the new path', async () => {
    const moved = join(work, 'proj-moved');
    renameSync(proj, moved);
    proj = moved;
    const r = await runPhase('reopen', proj);
    expect(r.error).toBeUndefined();
    expect(r.missing).toBe(false);
    expect(r.file.abs.endsWith('/proj-moved/media/clip.mp4')).toBe(true);
  }, 120000);

  it("adopts a browser document's library once, for every document using it", async () => {
    const r = await runPhase('adopt', proj);
    expect(r.error).toBeUndefined();
    expect(r.before.missing).toBe(true);
    expect(r.before.unknown).toEqual({ 'web-profile-uuid': 'Footage' });
    expect(r.afterAdopt.missing).toBe(false);
    expect(r.afterAdopt.unknown).toEqual({});
    // Found through the library → from now on it carries the real path too.
    expect(r.afterAdopt.file.abs.endsWith('/media/clip.mp4')).toBe(true);
    expect(r.secondDoc.missing).toBe(false);
  }, 120000);
});
