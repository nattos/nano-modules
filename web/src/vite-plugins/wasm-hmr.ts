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
import { resolve, normalize, sep, join } from 'path';
import { createReadStream, existsSync, statSync } from 'fs';
import { createRequire } from 'module';

// The module-directory rules are shared with the Electron main process, which
// is plain CJS; see electron/module-dirs.cjs.
const moduleDirs = createRequire(import.meta.url)('../../electron/module-dirs.cjs');

/**
 * What a BUILD must ship. Everything the web actually fetches from /wasm/,
 * named explicitly rather than globbed, because `build/wasm/` also holds ~46 MB
 * of per-arch `.aot` sidecars that only the native barrel reads and a
 * `testonly.wasm` of test fixtures. Copying the directory wholesale would put
 * all of that in the installer.
 *
 * KEEP IN STEP WITH `web/electron-builder.config.cjs`'s SHIPPED_WASM allowlist —
 * that is what actually lands in the package, this is what refuses to build
 * without it. A bundle here but not there ships an app that starts and renders
 * nothing; a bundle there but not here ships one nothing validated.
 */
export const SHIPPED_WASM = [
  // Effect bundles the app loads from its own wasm/ — SHIPPED_EFFECT_BUNDLES in
  // src/effect-bundles.ts. (nano, lights and legacy ride along as
  // extra-modules/ for seeding the per-user modules directory; see
  // electron-builder.config.cjs.)
  'core.wasm',
  'text.wasm',
  'richtext.wasm',
  'nano.wasm',
  'lights.wasm',
  'legacy.wasm',
  // Hosts + services.
  'executor.wasm',
  'bridge_core.wasm',
  'dxv_decoder.wasm',
  'text_engine.wasm',
  // Optional: the app degrades without these rather than failing to start.
  'text_blitz.wasm',   // rich-text complex layout
  'naga_spv.wasm',     // SPIR-V -> WGSL; a packaged build renders NOTHING without it
] as const;

/** Ones whose absence is fatal to a packaged build, so the copy must shout. */
const REQUIRED_WASM = new Set([
  'core.wasm', 'nano.wasm', 'lights.wasm', 'text.wasm', 'richtext.wasm',
  'legacy.wasm', 'executor.wasm', 'bridge_core.wasm', 'text_engine.wasm',
  'naga_spv.wasm',
]);

/**
 * Build-time half: make sure the bundles a shipping app needs actually exist.
 *
 * It deliberately does NOT copy them into `dist/`. The effect bundles are 33 MB
 * and the NATIVE plugin reads the same files (plus another 46 MB of per-arch
 * `.aot` sidecars the web never touches), so putting a second copy inside the
 * web app would reinstate exactly the duplication the shared resource root
 * exists to remove. The packaging step stages `build/wasm/` beside `dist/`
 * instead, and `nano://app/wasm/...` is served from there — see
 * electron/app-protocol.cjs and scripts/stage_resources.sh.
 *
 * So `dist/` alone is not a runnable app, and that is the point: this plugin
 * fails the build when a required bundle is missing, rather than letting one
 * ship that starts up and then renders nothing.
 */
export function wasmBuildPlugin(): Plugin {
  let wasmSrc = '';
  return {
    name: 'nano-modules:wasm-build',
    apply: 'build',
    configResolved(config) {
      wasmSrc = resolve(config.root, '..', 'build', 'wasm');
    },
    closeBundle() {
      const missing = SHIPPED_WASM.filter((n) => !existsSync(join(wasmSrc, n)));
      const fatal = missing.filter((m) => REQUIRED_WASM.has(m));
      if (missing.length) {
        this.warn(`[wasm-build] not found in ${wasmSrc}: ${missing.join(', ')}`);
      }
      if (fatal.length) {
        this.error(
          `[wasm-build] refusing to ship a build missing ${fatal.join(', ')} — ` +
          `run native/wasm_modules/build_all.sh first`);
      }
    },
  };
}

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

      // Effect module directories (electron/module-dirs.cjs), the same way the
      // packaged app serves them: a listing, `/modules/<n>/<file>`, and an
      // editor for the mapped set so Settings works against the dev server.
      server.middlewares.use('/__nano/modules', (req, res) => {
        const send = () => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({
            bundles: moduleDirs.resolveBundles(wasmDir),
            defaultDir: moduleDirs.defaultModulesDir(),
            paths: moduleDirs.readModulePaths(),
          }));
        };
        if (req.method !== 'POST') return send();
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            moduleDirs.writeModulePaths(JSON.parse(body));
            watchServedDirs();
            send();
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
      server.middlewares.use('/modules', (req, res, next) => {
        const file = moduleDirs.resolveModuleUrl('/modules' + (req.url ?? ''));
        if (!file || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', 'application/wasm');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
      const watchServedDirs = () => {
        for (const dir of moduleDirs.servedDirs()) {
          if (existsSync(dir)) server.watcher.add(resolve(dir, '*.wasm'));
        }
      };
      watchServedDirs();

      // Watch the real directory (the symlink may not exist).
      server.watcher.add(resolve(wasmDir, '**/*.wasm'));

      const fire = (file: string) => {
        if (!file.endsWith('.wasm')) return;
        // A module-directory bundle is served at /modules/<n>/..., not /wasm/.
        const moduleUrl = moduleDirs.urlForModuleFile(file);
        if (moduleUrl) {
          server.ws.send({ type: 'custom', event: 'wasm:reload', data: { url: moduleUrl } });
          server.config.logger.info(`[wasm-hmr] reload ${moduleUrl}`);
          return;
        }
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
