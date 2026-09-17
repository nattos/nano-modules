/**
 * Vite plugin: WASM serving + HMR.
 *
 * The bundles are built by the per-bundle scripts under `native/wasm_modules`
 * into the repo-root `build/wasm/` — outside the Vite root. Two halves:
 *
 * - **Serving.** `/wasm/<name>.wasm` is served straight out of `build/wasm/`.
 *   A `web/public/wasm` symlink used to carry this, but it is untracked local
 *   setup — absent on a fresh clone, and not creatable at all on a Windows
 *   checkout without symlink support, which 404s every bundle. Reading the real
 *   directory here means nothing has to be linked.
 * - **HMR.** A change to any `.wasm` emits a `wasm:reload` custom event with
 *   the served URL, which the main thread forwards to the engine worker (see
 *   `wasm-hmr-client.ts`).
 *
 * Dev-only — disabled in production builds.
 */

import type { Plugin } from 'vite';
import { resolve, normalize, sep } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';

export function wasmHmrPlugin(): Plugin {
  return {
    name: 'nano-modules:wasm-hmr',
    apply: 'serve',
    configureServer(server) {
      // `build/wasm` at the repo root — one level above the Vite root (`web/`).
      const wasmDir = resolve(server.config.root, '..', 'build', 'wasm');

      server.middlewares.use('/wasm', (req, res, next) => {
        // Strip the query/hash, then resolve inside wasmDir and confirm the
        // result stayed there (no `..` escapes).
        const rel = decodeURIComponent((req.url ?? '').split(/[?#]/)[0]);
        const file = resolve(wasmDir, '.' + rel);
        if (!normalize(file).startsWith(wasmDir + sep)) return next();
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'application/wasm');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });

      // Watch the real directory (the symlink may not exist).
      server.watcher.add(resolve(wasmDir, '**/*.wasm'));

      const fire = (file: string) => {
        if (!file.endsWith('.wasm')) return;
        // Convert absolute file path to served URL — slice everything from
        // (and including) `/wasm/`. Cross-platform: handle both `/` and `\`.
        const norm = file.replace(/\\/g, '/');
        const idx = norm.lastIndexOf('/wasm/');
        if (idx < 0) return;
        const url = norm.slice(idx);
        server.ws.send({
          type: 'custom',
          event: 'wasm:reload',
          data: { url },
        });
        server.config.logger.info(`[wasm-hmr] reload ${url}`);
      };

      server.watcher.on('change', fire);
      server.watcher.on('add', fire);
    },
  };
}
