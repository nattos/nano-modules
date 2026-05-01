import { defineConfig } from 'vite';
import { resolve } from 'path';
import { wasmHmrPlugin } from './src/vite-plugins/wasm-hmr';
import { udpBridgePlugin } from './src/vite-plugins/udp-bridge';

export default defineConfig({
  root: '.',
  appType: 'mpa',
  server: { port: 5173 },
  plugins: [
    wasmHmrPlugin(),
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
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
