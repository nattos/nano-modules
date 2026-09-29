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
      beforeAll(async () => {
        if (backend === 'native') {
          const started = await startCompositor();
          proc = started.child;
          live = { backend, url: started.url };
        } else {
          live = { backend };
        }
      }, 60_000);
      afterAll(async () => {
        live = { backend: 'worker' };
        if (proc) await stopCompositor(proc);
        proc = null;
      }, 15_000);
      body(backend);
    });
  }
}

/** A port block per jest worker (main port + 8 lanes), clear of 8081 and the
 *  ctest compositor ports. */
function portFor(): number {
  const worker = Number(process.env.JEST_WORKER_ID ?? '1');
  return 8400 + worker * 20;
}

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

async function startCompositor(): Promise<{ child: ChildProcess; url: string }> {
  const dbg = (m: string) => { if (process.env.DEBUG_COMPOSITOR) process.stderr.write(`[comp-backend] ${m}\n`); };
  dbg('startCompositor');
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
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (d) => {
    stderr += d.toString();
    if (process.env.DEBUG_COMPOSITOR) process.stderr.write(d);
  });
  dbg(`spawned pid ${child.pid} on ${port}`);
  await new Promise<void>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`nano_compositor not ready in 60 s\n${stderr.slice(-2000)}`)), 60_000);
    child.stdout!.on('data', (d) => {
      out += d.toString();
      if (out.includes('nano_compositor ready')) { clearTimeout(timer); resolve(); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`nano_compositor exited (${code}) before ready\n${stderr.slice(-2000)}`));
    });
  });
  return { child, url: `ws://127.0.0.1:${port}` };
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
