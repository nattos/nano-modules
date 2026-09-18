/**
 * Vite plugin: keep dev-only assets out of a shipped build.
 *
 * `public/` is the dev server's junk drawer as well as the app's asset
 * directory. It holds the standalone e2e runner pages, ~2 MB of sample media
 * referenced only by a testbed, and — on a dev machine — a `test-videos`
 * symlink pointing at a personal directory. `vite build` copies `public/`
 * verbatim and FOLLOWS that symlink: one recent `dist/` was 485 MB, 394 MB of
 * it somebody's Desktop.
 *
 * Vite has no exclude option for `publicDir`, so the copy is narrowed after the
 * fact. Deleting from `dist/` rather than staging a filtered copy keeps the dev
 * server's view of `public/` completely untouched — nothing here runs on
 * `serve`.
 *
 * Set NANO_BUILD_TESTBEDS=1 to keep them (matches the rollup inputs in
 * vite.config.ts).
 */

import type { Plugin } from 'vite';
import { resolve } from 'path';
import { existsSync, rmSync } from 'fs';

/**
 * Served from the SHARED RESOURCE ROOT instead of from inside the app, so a
 * copy in `dist/` would be pure duplication (and, via the symlink, would drag
 * in ~46 MB of native-only `.aot` sidecars as well). `nano://app/wasm/...`
 * resolves to `<root>/wasm` — see electron/app-protocol.cjs.
 *
 * Pruned unconditionally: unlike the entries below, these are not dev-only, so
 * NANO_BUILD_TESTBEDS must not bring them back.
 */
const ROOT_SERVED_ASSETS = ['wasm'];

/** Paths under `public/`, relative, that a shipping build must not carry. */
const DEV_ONLY_ASSETS = [
  // Personal symlink; enormous and machine-specific.
  'test-videos',
  // Sample clips used only by video-compositor-testbed.
  'media',
  // Standalone harness pages, served directly by the e2e suites.
  'dxv-test-runner.html',
  'engine-test-runner.html',
  'gpu-test-runner.html',
  'video-service-test-runner.html',
  'video-testbed.html',
];

export function shipPrunePlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'nano-modules:ship-prune',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const prune = (rel: string) => {
        const path = resolve(outDir, rel);
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      };
      for (const rel of ROOT_SERVED_ASSETS) prune(rel);
      if (process.env.NANO_BUILD_TESTBEDS === '1') return;
      for (const rel of DEV_ONLY_ASSETS) prune(rel);
    },
  };
}
