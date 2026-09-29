/**
 * The arrangement's native composition engine — a `nano_compositor` process
 * this shell starts on demand and keeps alive.
 *
 * The renderer asks over IPC (`nano.compositor`) when it wants the native
 * engine; the first ask spawns the process on a free port and resolves once it
 * prints its ready line. The renderer then talks to it directly over the
 * bridge WebSocket (src/views/arrangement/engine/remote-comp-engine.ts), the
 * same way Remote Control talks to a NanoBarrel — this module carries no
 * protocol at all.
 *
 * The process exits when its stdin closes, so it never outlives the shell.
 * If it dies while the shell runs, it is restarted on the SAME port: the
 * renderer's socket reconnects and replays the document.
 *
 * Where the binary is: `<root>/bin/nano_compositor` when packaged; from the
 * tree, `native/build/nano_compositor` first (the staged copy may be stale).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const EXE = process.platform === 'win32' ? 'nano_compositor.exe' : 'nano_compositor';
/** Ports scanned for the main socket; the process takes the next 8 for lanes. */
const FIRST_PORT = 8091;
const PORT_STRIDE = 10;
const PORT_TRIES = 20;

function binaryPath(resourceRoot, packaged) {
  // Unpackaged: web/electron -> web -> repo -> native/build. Preferred over the
  // staged <root>/bin copy when running from the tree, which is only as fresh
  // as the last `npm run stage` — a stale one silently lacks new actions.
  const devBuild = path.resolve(__dirname, '..', '..', 'native', 'build', EXE);
  const staged = resourceRoot ? path.join(resourceRoot, 'bin', EXE) : null;
  const candidates = packaged
    ? [process.env.NANO_COMPOSITOR_BIN, staged, devBuild]
    : [process.env.NANO_COMPOSITOR_BIN, devBuild, staged];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

/** Is `port` free on the loopback? */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** A free main port whose lane block is free too. */
async function pickPort() {
  for (let i = 0; i < PORT_TRIES; i++) {
    const base = FIRST_PORT + i * PORT_STRIDE;
    let ok = true;
    for (let p = base; p <= base + 8 && ok; p++) ok = await portFree(p);
    if (ok) return base;
  }
  throw new Error('no free port block for the compositor');
}

class Compositor {
  /** `packaged`: the app bundle (or NANO_FORCE_PACKAGED) — its staged binary
   *  wins; from the tree, native/build's does. */
  constructor(resourceRoot, packaged = true) {
    this.resourceRoot = resourceRoot;
    this.packaged = packaged;
    this.child = null;
    this.port = 0;
    this.starting = null;
    this.stopping = false;
    this.restarts = 0;
  }

  /** Start (once) and resolve {url, key}. */
  ensure() {
    if (!this.starting) this.starting = this.start().catch((err) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  async start() {
    const bin = binaryPath(this.resourceRoot, this.packaged);
    if (!bin) throw new Error('nano_compositor not found (build native/build or package bin/)');
    if (!this.port) this.port = await pickPort();
    await this.spawnOnce(bin);
    return { url: `ws://127.0.0.1:${this.port}`, key: 'compositor' };
  }

  spawnOnce(bin) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, NANO_BRIDGE_PORT: String(this.port) };
      if (this.resourceRoot) env.NANO_RESOURCE_ROOT = this.resourceRoot;
      // A hidden (test / automation) launch never opens display windows either:
      // they present offscreen (for NANO_FAKE_SCREENS, if the caller set any).
      if (process.env.NANO_WINDOW === 'hidden' && !env.NANO_DISPLAY_REDIRECT) {
        env.NANO_DISPLAY_REDIRECT = 'offscreen';
      }
      const child = spawn(bin, ['--port', String(this.port)], { env, stdio: ['pipe', 'pipe', 'inherit'] });
      this.child = child;
      let ready = false;
      let out = '';
      child.stdout.on('data', (chunk) => {
        if (ready) return;
        out += chunk.toString();
        if (out.includes('nano_compositor ready')) {
          ready = true;
          console.log(`[electron] compositor ready on port ${this.port} (pid ${child.pid})`);
          resolve();
        }
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        if (!ready) {
          reject(new Error(`nano_compositor exited before ready (code ${code}, signal ${signal})`));
          return;
        }
        if (this.stopping) return;
        // Died under us: bring it back on the same port, with a backoff so a
        // crash at startup doesn't spin.
        const delay = Math.min(10_000, 250 * 2 ** this.restarts++);
        console.warn(`[electron] compositor exited (code ${code}, signal ${signal}); restarting in ${delay} ms`);
        setTimeout(() => {
          if (this.stopping) return;
          this.spawnOnce(bin).then(() => { this.restarts = 0; })
            .catch((err) => console.error('[electron] compositor restart failed:', err.message));
        }, delay);
      });
    });
  }

  stop() {
    this.stopping = true;
    // Closing stdin is its shutdown signal.
    try { this.child?.stdin.end(); } catch { /* gone */ }
  }
}

module.exports = { Compositor };
