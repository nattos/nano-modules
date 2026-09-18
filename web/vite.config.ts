import { defineConfig } from 'vite';
import { resolve } from 'path';
import { cppBuildPlugin } from './src/vite-plugins/cpp-build';
import { wasmHmrPlugin, wasmBuildPlugin } from './src/vite-plugins/wasm-hmr';
import { udpBridgePlugin } from './src/vite-plugins/udp-bridge';
import { nagaBridgePlugin } from './src/vite-plugins/naga-bridge';
import { shipPrunePlugin } from './src/vite-plugins/ship-prune';

/**
 * The surfaces a SHIPPING build contains. `index.html` picks between effect-dev,
 * Playground and Live at boot (see src/main.ts); `arrangement.html` is the video
 * editor, a separate entry sharing the same engine worker.
 */
const SHIPPING_INPUTS = {
  main: resolve(__dirname, 'index.html'),
  // Behaves identically to index.html; kept as a stable deep-link/e2e path.
  resolume: resolve(__dirname, 'resolume/index.html'),
  arrangement: resolve(__dirname, 'arrangement.html'),
};

/**
 * Testbeds and runners. Useful to have built when working on them, dead weight
 * (and a bigger attack surface) in an installer, so they are opt-in:
 *
 *   NANO_BUILD_TESTBEDS=1 npm run build
 */
const TESTBED_INPUTS = {
  moduleTest: resolve(__dirname, 'module-test-app.html'),
  workspaceTestbed: resolve(__dirname, 'workspace-testbed.html'),
  arrStateTestbed: resolve(__dirname, 'arr-state-testbed.html'),
  arrEngineTestbed: resolve(__dirname, 'arr-engine-testbed.html'),
  thumbnailTestbed: resolve(__dirname, 'thumbnail-testbed.html'),
  thumbnailMipTestbed: resolve(__dirname, 'thumbnail-mip-testbed.html'),
  opfsThumbTestbed: resolve(__dirname, 'opfs-thumb-testbed.html'),
  warpTestbed: resolve(__dirname, 'warp-testbed.html'),
  videoCompositorTestbed: resolve(__dirname, 'video-compositor-testbed.html'),
  compTestRunner: resolve(__dirname, 'comp-test-runner.html'),
};

const withTestbeds = process.env.NANO_BUILD_TESTBEDS === '1';

export default defineConfig({
  root: '.',
  appType: 'mpa',
  server: { port: 5173 },
  // `public/` also holds the e2e runner pages, ~2 MB of sample media, and — on
  // a dev machine — a `test-videos` symlink pointing at a personal directory,
  // which `vite build` happily follows (394 MB of one recent dist). None of it
  // belongs in an installer. Dev still serves all of it; only the COPY is
  // narrowed, via the deny list below.
  publicDir: 'public',
  plugins: [
    // Compile C++ → build/wasm/*.wasm on startup (if stale) and on source
    // change. The output feeds wasmHmrPlugin below, which reloads the worker.
    cppBuildPlugin(),
    wasmHmrPlugin(),
    // Ship build/wasm/*.wasm into dist/wasm/ so a built app resolves the same
    // /wasm/... URLs the dev server answers. Without it, nothing loads.
    wasmBuildPlugin(),
    // SPIR-V → WGSL on demand. Effects bundle SPV; the runtime translates in
    // process (src/naga-wgsl.ts) and falls back to this endpoint when
    // naga_spv.wasm hasn't been built. See the plugin file.
    nagaBridgePlugin(),
    // UDP / non-browser protocol bridge — currently a no-op stub. See the
    // plugin file for the intended design.
    udpBridgePlugin(),
    // Drop the dev-only contents of public/ back out of dist/ (see the file:
    // Vite has no exclude for publicDir, and one of the entries is a symlink
    // into a personal directory that build happily follows).
    shipPrunePlugin(),
  ],
  build: {
    rollupOptions: {
      input: withTestbeds
        ? { ...SHIPPING_INPUTS, ...TESTBED_INPUTS }
        : SHIPPING_INPUTS,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
