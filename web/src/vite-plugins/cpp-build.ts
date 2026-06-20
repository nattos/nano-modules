/**
 * Vite plugin: C++ → WASM auto-build.
 *
 * The `.wasm` bundles are compiled from C++ by per-bundle `build.sh` scripts
 * (see `native/wasm_modules/<bundle>/build.sh`). Their output lands in
 * `build/wasm/`, which `web/public/wasm` symlinks to — so the existing
 * `wasm-hmr` plugin already reloads the engine worker whenever a `.wasm`
 * changes. The missing half was *compiling* the C++ in the first place: edit a
 * source, and the served `.wasm` silently goes stale until you remember to run
 * `build.sh` by hand (the classic "is `executor_register_capabilities` missing?
 * — no, the wasm is just old" footgun).
 *
 * This plugin closes that gap. For each registered bundle it:
 *   - on dev-server startup, rebuilds the `.wasm` if any watched source is newer
 *     than the output (or the output is missing) — fast no-op when up to date;
 *   - watches the bundle's C++ sources and rebuilds (debounced) on change.
 * The rebuild rewrites `build/wasm/<bundle>.wasm`, and `wasm-hmr` takes it from
 * there. Build failures are logged, never fatal — the server stays up.
 *
 * Dev-only (`apply: 'serve'`). Adding a bundle is a one-line entry in `BUNDLES`.
 */

import type { Plugin } from 'vite';
import { resolve, dirname } from 'path';
import { spawn } from 'child_process';
import { statSync, existsSync, readdirSync } from 'fs';

interface CppBundle {
  /** Display name (also the output basename: `<name>.wasm`). */
  name: string;
  /** Build script, run with cwd = its own directory. */
  script: string;
  /** Source dirs/files (recursively) whose C/C++ changes trigger a rebuild. */
  watch: string[];
  /** Output `.wasm` path — used for the startup staleness check. */
  output: string;
}

const SOURCE_RE = /\.(c|cc|cpp|cxx|h|hpp|hh)$/;

export function cppBuildPlugin(): Plugin {
  return {
    name: 'nano-modules:cpp-build',
    apply: 'serve',
    async configureServer(server) {
      const repo = resolve(server.config.root, '..');
      const native = resolve(repo, 'native');
      const log = server.config.logger;

      // Registered bundles. To add an effect bundle, point `script` at its
      // build.sh and `watch` at its source dir(s) — e.g.:
      //   { name: 'nano', script: resolve(native, 'wasm_modules/nano/build.sh'),
      //     watch: [resolve(native, 'wasm_modules/nano')],
      //     output: resolve(repo, 'build/wasm/nano.wasm') }
      // (effect bundles also compile shaders via DXC, so their builds are slower).
      const BUNDLES: CppBundle[] = [
        {
          name: 'executor',
          script: resolve(native, 'wasm_modules/executor/build.sh'),
          // The shared single-source executor + its augment/API translation units.
          watch: [resolve(native, 'src/sketch')],
          output: resolve(repo, 'build/wasm/executor.wasm'),
        },
      ];

      const building = new Set<string>();
      const pending = new Map<string, NodeJS.Timeout>();

      const newestSourceMtime = (paths: string[]): number => {
        let newest = 0;
        const walk = (p: string) => {
          if (!existsSync(p)) return;
          const st = statSync(p);
          if (st.isDirectory()) {
            for (const e of readdirSync(p)) walk(resolve(p, e));
          } else if (SOURCE_RE.test(p)) {
            newest = Math.max(newest, st.mtimeMs);
          }
        };
        for (const p of paths) walk(p);
        return newest;
      };

      const build = (b: CppBundle, reason: string): Promise<void> => {
        // Coalesce: a rebuild already running picks up no new work; the change
        // that arrived mid-build re-triggers via scheduleBuild's debounce.
        if (building.has(b.name)) return Promise.resolve();
        building.add(b.name);
        log.info(`[cpp-build] building ${b.name}.wasm (${reason})…`);
        const t0 = Date.now();
        return new Promise((done) => {
          const child = spawn('bash', [b.script], { cwd: dirname(b.script) });
          let err = '';
          child.stderr.on('data', (d) => { err += d.toString(); });
          child.on('error', (e) => {
            building.delete(b.name);
            log.error(`[cpp-build] ${b.name}: could not run build.sh — ${e.message}`);
            done();
          });
          child.on('close', (code) => {
            building.delete(b.name);
            if (code === 0) {
              log.info(`[cpp-build] ${b.name}.wasm built in ${Date.now() - t0}ms`);
            } else {
              log.error(`[cpp-build] ${b.name}.wasm FAILED (exit ${code})\n${err.trim()}`);
            }
            done();
          });
        });
      };

      const scheduleBuild = (b: CppBundle) => {
        const existing = pending.get(b.name);
        if (existing) clearTimeout(existing);
        // Debounce the burst of fs events from a single save.
        pending.set(b.name, setTimeout(() => {
          pending.delete(b.name);
          void build(b, 'source change');
        }, 150));
      };

      // Watch sources and map a change back to its bundle.
      for (const b of BUNDLES) {
        for (const w of b.watch) server.watcher.add(w);
      }
      const onFsEvent = (file: string) => {
        if (!SOURCE_RE.test(file)) return;
        const norm = file.replace(/\\/g, '/');
        for (const b of BUNDLES) {
          if (b.watch.some((w) => norm.startsWith(w.replace(/\\/g, '/')))) {
            scheduleBuild(b);
          }
        }
      };
      server.watcher.on('change', onFsEvent);
      server.watcher.on('add', onFsEvent);

      // Startup: rebuild anything stale so the first page load gets a fresh wasm.
      for (const b of BUNDLES) {
        const outMtime = existsSync(b.output) ? statSync(b.output).mtimeMs : 0;
        if (newestSourceMtime(b.watch) > outMtime) {
          await build(b, outMtime === 0 ? 'missing output' : 'stale output');
        } else {
          log.info(`[cpp-build] ${b.name}.wasm up to date`);
        }
      }
    },
  };
}
