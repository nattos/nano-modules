/**
 * Where the app's read-only payload lives, and telling the FFGL plugin about it.
 *
 * The shared resource root holds the built web app, the effect WASM bundles and
 * the fonts — one copy serving both the renderer and the native NanoBarrel
 * plugin. See native/src/platform/resource_root.h for the other half; the
 * layout and the `nano-resources.json` marker are a contract between the two.
 *
 *   <root>/nano-resources.json
 *   <root>/app/                  vite dist
 *   <root>/wasm/*.wasm           (+ *.aot on macOS, for the native barrel)
 *   <root>/fonts/*.ttf
 *   <root>/ffgl/NanoBarrel.bundle        macOS only
 *   <root>/ffgl/libbridge_server.dylib   SIBLING of the bundle, non-negotiable
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/** A directory only counts as a root if it actually carries the payload. */
function looksLikeRoot(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'nano-resources.json')) &&
           fs.existsSync(path.join(dir, 'wasm', 'core.wasm'));
  } catch {
    return false;
  }
}

/**
 * Resolve the resource root.
 *
 * Packaged, it is `process.resourcesPath/nano` (electron-builder's
 * extraResources destination). Unpackaged — running `npm run electron` out of
 * the source tree — it is the repo's `build/`, which is the SAME directory the
 * native plugin finds by walking up from its own image, so the two halves agree
 * without either being told.
 *
 * NANO_RESOURCE_ROOT overrides, matching the native env var of the same name,
 * so a test harness can point both at one tree.
 */
function resolveResourceRoot() {
  const candidates = [
    process.env.NANO_RESOURCE_ROOT,
    process.resourcesPath ? path.join(process.resourcesPath, 'nano') : null,
    // Unpackaged: web/electron -> web -> repo -> build
    path.resolve(__dirname, '..', '..', 'build'),
  ];
  for (const c of candidates) {
    if (looksLikeRoot(c)) return c;
  }
  return null;
}

/**
 * Record where we are, so a NanoBarrel that has been COPIED OUT of this app
 * (into a host's own plug-ins folder, which is the normal Resolume setup) can
 * still find the wasm and fonts.
 *
 * A plugin still sitting inside the app doesn't need this — it finds the root
 * by walking up from itself. This record is the fallback, and on the native
 * side it is ranked LAST, below the image-relative walk, precisely so it can't
 * hijack a dev-tree test run. Writing it is therefore best-effort: a failure
 * costs a copied-out plugin its resources, nothing else, so it must never keep
 * the app from starting.
 *
 * ONLY A PACKAGED APP WRITES IT. Running the shell from a source tree would
 * otherwise repoint an installed user's record at a developer's build/
 * directory — a directory that can be half-rebuilt, or deleted — and they would
 * have no idea why their plugin started loading different effects. A dev tree
 * needs no record anyway: the plugin finds it by walking up from its own image.
 */
function writeInstallRecord(root) {
  if (!root) return null;
  if (!app.isPackaged && process.env.NANO_WRITE_INSTALL_RECORD !== '1') return null;
  try {
    // app.getPath('appData') is ~/Library/Application Support on macOS and
    // %APPDATA% on Windows — the same directories nano_paths::supportDir()
    // computes, so neither side has to know about the other's convention.
    const dir = path.join(app.getPath('appData'), 'NanoBarrel');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'electron_app.json');
    fs.writeFileSync(file, JSON.stringify({
      appPath: app.getAppPath(),
      exePath: process.execPath,
      resourceRoot: root,
      version: app.getVersion(),
      updatedAt: Date.now(),
    }, null, 2));
    return file;
  } catch (err) {
    console.warn('[electron] could not record the install location:', err.message);
    return null;
  }
}

/** The bundled FFGL plugin, or null where there isn't one (Windows). */
function ffglPluginPath(root) {
  if (!root || process.platform !== 'darwin') return null;
  const p = path.join(root, 'ffgl', 'NanoBarrel.bundle');
  return fs.existsSync(p) ? p : null;
}

module.exports = { resolveResourceRoot, writeInstallRecord, ffglPluginPath, looksLikeRoot };
