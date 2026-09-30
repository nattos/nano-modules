/**
 * Run an arrangement UI suite against BOTH composition engines.
 *
 *   - `worker`: executor.wasm in the page's engine worker (the browser app);
 *   - `native`: a `nano_compositor` process (native/build/nano_compositor)
 *     spawned for the suite, which the page reaches over its bridge WebSocket
 *     (`arrangement.html?compositor=ws://…`, see engine-select.ts).
 *
 * Usage:
 *   forEachCompBackend((backend) => {
 *     describe(`thing (${backend})`, () => {
 *       it('works', async () => {
 *         await page.goto(arrangementUrl(BASE));
 *         ...
 *       });
 *     });
 *   });
 *
 * The body is REGISTERED once per backend; which one is live is decided when
 * tests RUN (beforeAll/afterAll), so `arrangementUrl()` must be called inside
 * a hook or test, never at module scope. (A helper that only set the backend
 * around the synchronous body would leave every test running on whichever
 * backend was set last — the trap forEachFusionMode once fell into.)
 *
 * The native leg needs `cmake --build native/build --target nano_compositor`;
 * without the binary it fails with that instruction rather than skipping.
 * `COMP_BACKENDS=worker` (or `native`) runs one leg only; `DEBUG_COMPOSITOR=1`
 * echoes the process's log.
 *
 * REMOTE: `NANO_REMOTE_COMPOSITOR=user@host` runs the native leg on ANOTHER
 * machine — a Windows box reached over SSH, where `native/tools/win_remote.sh
 * push` staged the compositor. It listens on 8091 (lanes 8092–8099, which that
 * machine's firewall must admit), and fetches media from the page's own origin,
 * so the page must be served somewhere that machine can reach:
 * `GPU_TEST_BASE_URL=http://<this machine's LAN address>:<port>` (and
 * jest-puppeteer.config.js treats that origin as secure). Run with `-i`: there
 * is one port block. `windowsGap(backend, reason)` names what the Windows
 * compositor can't do yet.
 *
 * Gaps: `nativeGap(backend, reason)` returns `it.skip` on the native leg (the
 * reason is in the test name), `it` otherwise — for the things the native host
 * can't do yet, named rather than silently absent.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type CompBackend = 'worker' | 'native';

const NATIVE_COMPOSITOR = path.resolve(__dirname, '..', '..', 'native', 'build', 'nano_compositor');
const RESOURCE_ROOT = path.resolve(__dirname, '..', '..', 'build');

let live: { backend: CompBackend; url?: string } = { backend: 'worker' };

/** The backend the running test is on. */
export function currentCompBackend(): CompBackend {
  return live.backend;
}

/** `<base>/arrangement.html` for the running backend (plus `extra` query). */
export function arrangementUrl(base: string, extra = ''): string {
  const q = new URLSearchParams(extra);
  if (live.backend === 'native' && live.url) q.set('compositor', live.url);
  const s = q.toString();
  return `${base}/arrangement.html${s ? `?${s}` : ''}`;
}

/** `it`, or `it.skip` on the native leg with the reason named. */
export function nativeGap(backend: CompBackend, reason: string): jest.It {
  if (backend !== 'native') return it;
  const skip = ((name: string, fn?: jest.ProvidesCallback, timeout?: number) =>
    it.skip(`${name} [native gap: ${reason}]`, fn, timeout)) as unknown as jest.It;
  return skip;
}

/** `it`, or `it.skip` when the native leg is the REMOTE (Windows) compositor
 *  and the test needs what Windows doesn't do yet — named, e.g. H.264 decode
 *  (COMPOSITOR.md M4 step 4). `base` composes it with nativeOnly. */
export function windowsGap(backend: CompBackend, reason: string, base: jest.It = it): jest.It {
  if (backend !== 'native' || !remoteHost()) return base;
  const skip = ((name: string, fn?: jest.ProvidesCallback, timeout?: number) =>
    it.skip(`${name} [windows gap: ${reason}]`, fn, timeout)) as unknown as jest.It;
  return skip;
}

/** `it` on the native leg, `it.skip` on the worker (the reason named) — for
 *  what only the native compositor does (light output: no UDP in a browser). */
export function nativeOnly(backend: CompBackend, reason: string): jest.It {
  if (backend === 'native') return it;
  const skip = ((name: string, fn?: jest.ProvidesCallback, timeout?: number) =>
    it.skip(`${name} [native only: ${reason}]`, fn, timeout)) as unknown as jest.It;
  return skip;
}

function backendsToRun(): CompBackend[] {
  const only = process.env.COMP_BACKENDS;
  const all: CompBackend[] = ['worker', 'native'];
  return only ? all.filter((b) => only.split(',').includes(b)) : all;
}

export function forEachCompBackend(body: (backend: CompBackend) => void): void {
  for (const backend of backendsToRun()) {
    describe(`[${backend} engine]`, () => {
      let proc: ChildProcess | null = null;
      let restorePage: (() => void) | null = null;
      beforeAll(async () => {
        if (backend === 'native') {
          const started = await startCompositor();
          proc = started.child;
          live = { backend, url: started.url };
          restorePage = awaitCatalogOnNavigation();
        } else {
          live = { backend };
        }
      }, 90_000);
      afterAll(async () => {
        live = { backend: 'worker' };
        restorePage?.();
        restorePage = null;
        if (proc) await stopCompositor(proc);
        proc = null;
      }, 15_000);
      body(backend);
    });
  }
}

/**
 * On the native leg the page learns the effect catalog from the compositor
 * (its plugin_schemas, ~600 kB) some time AFTER it boots — and a test that
 * creates a device before then gets nothing (catalogEffect() is undefined, so
 * store.addClipDeviceType silently no-ops). Locally it lands in a few ms and the
 * race is invisible; across a LAN (REMOTE) it loses every time. So after every
 * navigation to the arrangement, wait for the catalog — as a user would, who
 * can't pick an effect before the list exists.
 */
function awaitCatalogOnNavigation(): () => void {
  const pg = page as any;
  const goto = pg.goto.bind(pg);
  const reload = pg.reload.bind(pg);
  const settle = async () => {
    if (!String(pg.url()).includes('/arrangement.html')) return;
    await pg.waitForFunction(
      () => Object.keys((window as any).arrangementStore?.enginePlugins ?? {}).length > 0,
      { timeout: 60_000 });
  };
  pg.goto = async (...a: unknown[]) => { const r = await goto(...a); await settle(); return r; };
  pg.reload = async (...a: unknown[]) => { const r = await reload(...a); await settle(); return r; };
  return () => { pg.goto = goto; pg.reload = reload; };
}

/** A port block per jest worker (main port + 8 lanes), clear of 8081 and the
 *  ctest compositor ports. */
function portFor(): number {
  const worker = Number(process.env.JEST_WORKER_ID ?? '1');
  return 8400 + worker * 20;
}

/**
 * The screens the test compositor pretends to have (NANO_FAKE_SCREENS): the
 * machine's own (main) screen and a 4:3 projector, so Display 1 lands on the
 * projector by itself and a 16:9 show letterboxes under Fit.
 */
export const FAKE_SCREENS = [
  { uuid: 'FAKE-MAIN', name: 'Built-in Display', w: 1440, h: 900, hz: 60, main: true },
  { uuid: 'FAKE-PROJ', name: 'Test Projector', w: 1024, h: 768, hz: 60, main: false },
];

/**
 * Where the test compositor's Art-Net OUTPUT goes (NANO_ARTNET_REDIRECT):
 * every light device's DMX lands on this loopback port instead of its
 * configured node or the LAN broadcast — a suite can listen here, and no test
 * ever lights (or confuses) real fixtures.
 */
export function artnetRedirectPort(): number {
  const worker = Number(process.env.JEST_WORKER_ID ?? '1');
  return 36400 + worker;
}

/** `user@host` of a remote compositor (see REMOTE above), or undefined. */
function remoteHost(): string | undefined {
  return process.env.NANO_REMOTE_COMPOSITOR || undefined;
}

/**
 * The remote leg: the same process on another machine, started over SSH in
 * its staged folder. Closing ssh's stdin reaches the compositor as EOF, so
 * stopCompositor works unchanged. Its data root is fresh per suite; the D3D11
 * shader cache (NANO_CACHE_DIR) is shared, or every suite pays ~25 s of FXC.
 */
function spawnRemote(target: string, port: number): ChildProcess {
  const dir = process.env.NANO_WIN_DIR || 'nano-work\\comp';
  const run = `nano-compositor-${Date.now()}-${process.pid}`;
  const env: Record<string, string> = {
    NANO_DATA_DIR: `%TEMP%\\${run}`,
    NANO_CACHE_DIR: '%USERPROFILE%\\nano-work\\cache',
    NANO_ARTNET_REDIRECT: `127.0.0.1:${artnetRedirectPort()}`,
    NANO_DISPLAY_REDIRECT: 'offscreen',
    // cmd keeps the inner quotes of `set "K=v"` — JSON has none of & | < > ^ %.
    NANO_FAKE_SCREENS: JSON.stringify(FAKE_SCREENS),
  };
  const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"`).join(' && ');
  const cmd = `cd /d "%USERPROFILE%\\${dir}" && ${sets} && nano_compositor.exe --port ${port}`;
  return spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', target, cmd],
               { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function startCompositor(): Promise<{ child: ChildProcess; url: string }> {
  const dbg = (m: string) => { if (process.env.DEBUG_COMPOSITOR) process.stderr.write(`[comp-backend] ${m}\n`); };
  dbg('startCompositor');
  const remote = remoteHost();
  if (remote) {
    const port = 8091;
    const child = spawnRemote(remote, port);
    await waitReady(child, dbg);
    return { child, url: `ws://${remote.split('@').pop()}:${port}` };
  }
  if (!fs.existsSync(NATIVE_COMPOSITOR)) {
    throw new Error(
      `nano_compositor not found at ${NATIVE_COMPOSITOR}.\n` +
      'Build it first: cmake --build native/build --target nano_compositor');
  }
  const port = portFor();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-compositor-'));
  const child = spawn(NATIVE_COMPOSITOR, ['--port', String(port)], {
    env: {
      ...process.env, NANO_DATA_DIR: dataDir, NANO_RESOURCE_ROOT: RESOURCE_ROOT,
      NANO_ARTNET_REDIRECT: `127.0.0.1:${artnetRedirectPort()}`,
      // Display devices present OFFSCREEN for fake screens: no test ever opens
      // a window on a real screen (FAKE_SCREENS).
      NANO_DISPLAY_REDIRECT: 'offscreen',
      NANO_FAKE_SCREENS: JSON.stringify(FAKE_SCREENS),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  dbg(`spawned pid ${child.pid} on ${port}`);
  await waitReady(child, dbg);
  return { child, url: `ws://127.0.0.1:${port}` };
}

/** Until the process prints its ready line (a cold Windows start compiles
 *  every shader: allow a minute). */
async function waitReady(child: ChildProcess, dbg: (m: string) => void): Promise<void> {
  let stderr = '';
  child.stderr!.on('data', (d) => {
    stderr += d.toString();
    if (process.env.DEBUG_COMPOSITOR) process.stderr.write(d);
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`nano_compositor not ready in 60 s\n${stderr.slice(-2000)}`)), 60_000);
    child.stdout!.on('data', (d) => {
      out += d.toString();
      if (out.includes('nano_compositor ready')) { clearTimeout(timer); dbg('ready'); resolve(); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`nano_compositor exited (${code}) before ready\n${stderr.slice(-2000)}`));
    });
  });
}

/** Close its stdin (the shutdown signal) and wait for the exit, so the next
 *  suite in this worker can take the port. */
async function stopCompositor(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdin?.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}
