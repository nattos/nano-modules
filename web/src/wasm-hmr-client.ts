/**
 * Main-thread HMR client. Receives `wasm:reload` events from the
 * `wasm-hmr` Vite plugin and forwards them to the engine worker.
 *
 * Imported from both entry points (effect-ide-app.ts, resolume-app.ts) so
 * either page picks up WASM changes during development. No-op in production
 * (import.meta.hot is undefined).
 */

import { appController } from './state/controller';

if (import.meta.hot) {
  import.meta.hot.on('wasm:reload', (data: { url: string }) => {
    if (!data?.url) return;
    console.log('[wasm-hmr] reload', data.url);
    appController.reloadWasm(data.url);
  });
}
