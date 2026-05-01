/**
 * Vite plugin: WASM HMR.
 *
 * Watches `public/wasm/*.wasm` and emits a `wasm:reload` custom event with
 * the served URL ('/wasm/<name>.wasm') whenever a file changes. The main
 * thread listens via `import.meta.hot.on('wasm:reload', ...)` and forwards
 * to the engine worker (see `wasm-hmr-client.ts`).
 *
 * Dev-only — disabled in production builds.
 */

import type { Plugin } from 'vite';
import { resolve } from 'path';

export function wasmHmrPlugin(): Plugin {
  return {
    name: 'nano-modules:wasm-hmr',
    apply: 'serve',
    configureServer(server) {
      const wasmGlob = resolve(server.config.root, 'public/wasm/**/*.wasm');
      server.watcher.add(wasmGlob);

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
