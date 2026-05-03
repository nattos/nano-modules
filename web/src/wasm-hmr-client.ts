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
  console.log('[wasm-hmr] client listener installed (waiting for `wasm:reload` events)');
  import.meta.hot.on('wasm:reload', (data: { url: string }) => {
    if (!data?.url) {
      console.warn('[wasm-hmr] received reload event with no URL — ignoring');
      return;
    }
    const t = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    console.log(`[wasm-hmr] ${new Date().toLocaleTimeString()} reload requested for ${data.url} → forwarding to worker`);
    appController.reloadWasm(data.url);
    // Couldn't easily await the worker side; record dispatch time so the
    // engine's "[engine] reloaded WASM" log can be cross-referenced.
    (window as any).__lastWasmReloadDispatch = { url: data.url, t };
  });
}
