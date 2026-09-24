/**
 * electron-builder — packaging the two desktop products for macOS and Windows.
 *
 *   NANO_PRODUCT=arrangement  NanoModules — the arrangement / video editor.
 *   NANO_PRODUCT=remote       NanoModules Remote Control — the live-show app
 *                             (Remote Control + Playground) and the owner of
 *                             the FFGL plugin.
 *
 * One shell (electron/main.cjs) and one vite build serve both; the product is
 * injected into the packaged package.json as `nanoProduct` (extraMetadata),
 * which is how main.cjs knows which page to open. A JS config rather than two
 * YAML files with `extends`, because what differs between the two is exactly
 * the extraResources arrays, and a merge of those should not be left to
 * guesswork.
 *
 *   npm run build:stage                 # vite build + scripts/stage_resources.sh
 *   npm run package:remote:mac -- --extras ../../nano-modules-extras
 *   npm run package:remote:mac -- --no-extras
 *
 * Packaging goes through scripts/package.sh, which REQUIRES one of those two:
 * the co-packaged effect bundles (nano, lights, legacy) live in the
 * nano-modules-extras repository, and a package either carries a fresh build
 * of a named checkout or says explicitly that it carries none. This config
 * enforces the same thing on a direct electron-builder run (NANO_PACKAGE_EXTRAS).
 *
 * WHAT SHIPS
 *
 * The app's own code is tiny (electron/*.cjs); everything else rides in
 * `extraResources` as the SHARED RESOURCE ROOT at Contents/Resources/nano
 * (Windows: resources\nano). One directory serves the renderer over nano://app/
 * AND, in Remote Control, the native NanoBarrel plugin, which reads the same
 * wasm and fonts — see native/src/platform/resource_root.h.
 *
 * Only Remote Control carries ffgl/ (and, on macOS, the AOT sidecars that only
 * the native barrel reads). The two plugin directories are staged separately
 * (../build/ffgl for the .bundle, ../build/ffgl-win for the .dll) so neither
 * package contains the other platform's binaries. The Windows barrel is a
 * cross-compiled artifact of this same tree (native/build-win), so a Windows
 * package is still built from a Mac.
 *
 * Windows carries no .aot sidecars: the Windows build sets NANO_WASM_AOT=OFF
 * because a sidecar is per-ABI as well as per-arch.
 *
 * There are NO native node modules here, so a Windows target cross-builds from
 * macOS without a rebuild step.
 */

const PRODUCTS = {
  arrangement: {
    appId: 'com.nano.modules',
    productName: 'NanoModules',
    plugin: false,
  },
  remote: {
    appId: 'com.nano.modules.remote',
    productName: 'NanoModules Remote Control',
    plugin: true,
  },
};

const productKey = process.env.NANO_PRODUCT;
const product = PRODUCTS[productKey];
if (!product) {
  throw new Error(`set NANO_PRODUCT to one of: ${Object.keys(PRODUCTS).join(', ')}`);
}

/**
 * The wasm the renderer fetches. MUST KEEP IN STEP WITH SHIPPED_WASM in
 * src/vite-plugins/wasm-hmr.ts, which is what fails the build when one is
 * missing; this is what actually lands in the package. An ALLOWLIST, not a
 * copy: build/wasm also holds testonly.wasm (test fixtures) and ~46 MB of
 * per-arch AOT sidecars.
 */
const SHIPPED_WASM = [
  'core', 'text', 'richtext',
  'executor', 'bridge_core', 'dxv_decoder', 'text_engine', 'text_blitz', 'naga_spv',
].map((n) => `wasm/${n}.wasm`);

/**
 * The bundles a package CARRIES but does not load from its own wasm/: they are
 * seeded into the per-user modules directory on first launch
 * (module-dirs.cjs seedDefaultModules), where both apps and the native barrel
 * find them — and where a user can delete or replace them. Both products carry
 * the same set, since whichever launches first seeds it.
 *
 * They are the extras (nano-modules-extras), and which ones is whatever
 * build_extras.sh recorded in build/wasm/extras.json — scripts/package.sh
 * builds them fresh from the checkout it was given and sets
 * NANO_PACKAGE_EXTRAS=built. NANO_PACKAGE_EXTRAS=none packages without them.
 * Anything else refuses, so a package never picks up whatever stale extras
 * happen to be lying in build/wasm.
 */
function extraBundles() {
  const mode = process.env.NANO_PACKAGE_EXTRAS;
  if (mode === 'none') return [];
  if (mode !== 'built') {
    throw new Error(
      'package through scripts/package.sh with --extras <nano-modules-extras dir> '
      + 'or --no-extras (NANO_PACKAGE_EXTRAS must be "built" or "none")');
  }
  const record = require('path').resolve(__dirname, '..', 'build', 'wasm', 'extras.json');
  let stems;
  try {
    stems = JSON.parse(require('fs').readFileSync(record, 'utf8')).stems;
  } catch (err) {
    throw new Error(`NANO_PACKAGE_EXTRAS=built but ${record} is unreadable: ${err.message}`);
  }
  if (!Array.isArray(stems) || stems.length === 0) {
    throw new Error(`${record} names no bundles`);
  }
  return stems;
}
const EXTRA_BUNDLES = extraBundles();

/** AOT sidecars the native barrel prefers over a .wasm beside them. Only this
 *  slice's arch — the other would never be selected, and costs 20 MB. */
const aot = (stems) => stems.map((n) => `${n}-aarch64.aot`);

module.exports = {
  appId: product.appId,
  productName: product.productName,
  copyright: '',
  extraMetadata: { nanoProduct: productKey },

  directories: {
    // Per product, so building one never clobbers or mixes with the other.
    output: `release/${productKey}`,
    buildResources: 'build-resources',
  },

  // Only the shell itself. The renderer is not in app.asar — it is in the
  // shared root, because the plugin has to be able to read the same files and
  // cannot read an asar. node_modules is excluded explicitly: the main process
  // requires nothing but electron and node builtins, and the renderer deps are
  // already bundled into app/ by rollup.
  files: ['electron/**/*', 'package.json', '!node_modules/**/*'],

  extraResources: [
    {
      from: '../build',
      to: 'nano',
      filter: ['nano-resources.json', 'app/**/*', 'fonts/**/*', ...SHIPPED_WASM],
    },
    // (An empty filter would mean "everything", so no extras means no entry.)
    ...(EXTRA_BUNDLES.length ? [{
      from: '../build/wasm',
      to: 'nano/extra-modules',
      filter: EXTRA_BUNDLES.map((n) => `${n}.wasm`),
    }] : []),
  ],

  mac: {
    category: 'public.app-category.graphics-design',
    // arm64 ONLY, deliberately: NanoBarrel.bundle and libbridge_server.dylib are
    // single-architecture, so an x64 package would ship a plugin Resolume
    // cannot load. Add x64/universal once the native side builds fat.
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    // Ad-hoc for now. Set CSC_NAME / NANOBARREL_CODESIGN_IDENTITY for a real
    // Developer ID; notarization is a separate follow-up.
    identity: null,
    // OFF deliberately: incompatible with the nodeIntegration the renderer
    // needs for real filesystem paths (see electron/main.cjs).
    hardenedRuntime: false,
    extraResources: [
      // Seeded beside their .wasm, for the barrel — whichever app seeds.
      ...(EXTRA_BUNDLES.length
        ? [{ from: '../build/wasm', to: 'nano/extra-modules', filter: aot(EXTRA_BUNDLES) }]
        : []),
      ...(product.plugin ? [
        // libbridge_server.dylib MUST stay a direct sibling of the bundle:
        // dlopen shares one image only for the same path, so two copies means
        // two WsServers fighting over :8081.
        { from: '../build/ffgl', to: 'nano/ffgl', filter: ['**/*'] },
        { from: '../build/wasm', to: 'nano/wasm', filter: aot(['core', 'text', 'richtext']) },
        // The addon that opens the plugin's shared preview surfaces for
        // Electron's sharedTexture import (web/native/, src/preview-surfaces.ts).
        // Without it the app keeps the socket transport.
        { from: '../build/native/darwin-arm64', to: 'nano/native/darwin-arm64',
          filter: ['nano_shared_surface.node'] },
      ] : []),
    ],
  },

  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    extraResources: product.plugin ? [
      // Lands at the SAME nano/ffgl path as on macOS, so resource_root.h's
      // walk-up finds the root from either. libbridge_server.dll must stay
      // NanoBarrel.dll's direct sibling for the same one-image-per-path reason.
      { from: '../build/ffgl-win', to: 'nano/ffgl', filter: ['**/*'] },
    ] : [],
  },

  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
};
