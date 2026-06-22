import { defineConfig } from 'vite';
import { resolve } from 'path';
import { cppBuildPlugin } from './src/vite-plugins/cpp-build';
import { wasmHmrPlugin } from './src/vite-plugins/wasm-hmr';
import { udpBridgePlugin } from './src/vite-plugins/udp-bridge';
import { nagaBridgePlugin } from './src/vite-plugins/naga-bridge';

export default defineConfig({
  root: '.',
  appType: 'mpa',
  server: { port: 5173 },
  plugins: [
    // Compile C++ → build/wasm/*.wasm on startup (if stale) and on source
    // change. The output feeds wasmHmrPlugin below, which reloads the worker.
    cppBuildPlugin(),
    wasmHmrPlugin(),
    // SPIR-V → WGSL on demand. Effects bundle SPV; runtime POSTs to
    // /__naga/wgsl to translate. See plugin file for details.
    nagaBridgePlugin(),
    // UDP / non-browser protocol bridge — currently a no-op stub. See the
    // plugin file for the intended design.
    udpBridgePlugin(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        resolume: resolve(__dirname, 'resolume/index.html'),
        moduleTest: resolve(__dirname, 'module-test-app.html'),
        arrangement: resolve(__dirname, 'arrangement.html'),
        workspaceTestbed: resolve(__dirname, 'workspace-testbed.html'),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
