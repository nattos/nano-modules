/**
 * Main-thread HMR client. Receives `wasm:reload` events from the
 * `wasm-hmr` Vite plugin and forwards them to the engine worker.
 *
 * Imported from both surface boots (boot-effect-dev.ts, boot-resolume.ts) so
 * either picks up WASM changes during development.
 *
 * A PACKAGED desktop app has no Vite, but still hot-reloads bundles in its
 * module directories — someone developing an effect maps their build output
 * there. The shell watches those directories and sends the same event over IPC
 * as `nano:wasm-reload` (electron/main.cjs).
 */

import { appController } from './state/controller';
import { electronIpc } from './state/paths';

const ipc = electronIpc();
if (ipc && !import.meta.hot) {
  ipc.on('nano:wasm-reload', (_e: unknown, data: { url?: string }) => {
    if (!data?.url) return;
    console.log(`[wasm-hmr] ${new Date().toLocaleTimeString()} module directory changed: ${data.url}`);
    appController.reloadWasm(data.url);
  });
}

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
