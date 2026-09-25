/**
 * Where effect bundles come from — the JS half of native/src/bridge/module_dirs.h.
 * KEEP THE TWO IN STEP: the barrel (inside Resolume) and the app resolve the same
 * set from the same config file, and a disagreement means an effect that
 * renders in one and is missing in the other.
 *
 * An effect bundle is `<stem>.wasm`, bundle id `com.nano.<stem>`. Three kinds of
 * directory, rising priority:
 *
 *   1. built-in  the resource root's wasm/. Never scanned — a dev tree's
 *                build/wasm also holds service modules (executor, naga_spv, ...)
 *                — so only the known shipping stems are taken, if present.
 *   2. default   the per-user modules directory the installer seeds. Supplies
 *                only stems the built-in directory lacks, so a seeded release
 *                copy can never shadow a dev tree's fresh build.
 *   3. mapped    the user's directories (module_paths.json). Every *.wasm is a
 *                bundle and REPLACES the same stem from below; a later mapping
 *                beats an earlier one, and an unchecked one takes no part.
 *
 * Plain node (no electron import), because the vite dev server uses it too.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataRoot, settingsDir } = require('./data-root.cjs');

/** Keep in step with builtinBundleStems() in module_dirs.h. */
const BUILTIN_STEMS = ['core', 'text', 'richtext', 'nano', 'lights', 'legacy'];

/** The per-user modules directory. NANO_MODULES_DIR overrides, as natively. */
function defaultModulesDir() {
  return process.env.NANO_MODULES_DIR || path.join(dataRoot(), 'Modules');
}

/** The mapped-directories config — a shared settings file (data-root.cjs). */
function modulePathsFile() {
  return process.env.NANO_MODULE_PATHS_FILE || path.join(settingsDir(), 'module-paths.json');
}

/** Every configured row, enabled or not: [{ path, enabled }]. */
function readModulePaths(file = modulePathsFile()) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || !Array.isArray(doc.paths)) return [];
    return doc.paths
      .filter((r) => r && typeof r.path === 'string' && r.path)
      .map((r) => ({ path: r.path, enabled: r.enabled !== false }));
  } catch {
    return [];
  }
}

function writeModulePaths(rows, file = modulePathsFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clean = rows
    .filter((r) => r && typeof r.path === 'string' && r.path)
    .map((r) => ({ path: r.path, enabled: r.enabled !== false }));
  fs.writeFileSync(file, JSON.stringify({ paths: clean }, null, 2));
  return clean;
}

function wasmFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.wasm') && e.name.length > 5)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The directories served under /modules/<key>/: the default directory first,
 * then every enabled mapped one. Position 0 is what makes a directory the
 * default one; the URL does not depend on position (see dirKey).
 */
function servedDirs(rows = readModulePaths()) {
  return [defaultModulesDir(), ...rows.filter((r) => r.enabled).map((r) => r.path)];
}

/**
 * The URL segment a directory is served under: a hash of its absolute path.
 * NOT its position — checking or unchecking one folder would renumber every
 * folder after it, and the engine caches bundles by URL, so `/modules/1/x.wasm`
 * meaning a different file after a toggle made it keep the wrong copy.
 */
function dirKey(dir) {
  return crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

function moduleUrl(dir, name) {
  return `/modules/${dirKey(dir)}/${encodeURIComponent(name)}`;
}

/**
 * Resolve the bundle set: one entry per stem, built-in stems first in
 * BUILTIN_STEMS order, then the rest by first appearance. Each entry carries
 * the URL the renderer fetches it from — `/wasm/<file>` for the built-in
 * directory, `/modules/<key>/<file>` for a served one.
 */
function resolveBundles(builtinDir, dirs = servedDirs()) {
  const out = [];
  const find = (stem) => out.find((b) => b.stem === stem);
  if (builtinDir) {
    for (const stem of BUILTIN_STEMS) {
      const file = path.join(builtinDir, `${stem}.wasm`);
      if (fs.existsSync(file)) {
        out.push({ stem, path: file, url: `/wasm/${stem}.wasm`, origin: 'builtin' });
      }
    }
  }
  dirs.forEach((dir, n) => {
    const isDefault = n === 0;
    for (const name of wasmFiles(dir)) {
      const stem = name.slice(0, -'.wasm'.length);
      const entry = {
        stem,
        path: path.join(dir, name),
        url: moduleUrl(dir, name),
        origin: isDefault ? 'default' : 'mapped',
      };
      const existing = find(stem);
      if (existing) {
        if (!isDefault) Object.assign(existing, entry);  // default never shadows
      } else {
        out.push(entry);
      }
    }
  });
  return out.map((b) => ({ id: `com.nano.${b.stem}`, ...b }));
}

/** `/modules/<key>/<file>` → an absolute file inside that served directory, or null. */
function resolveModuleUrl(urlPath, dirs = servedDirs()) {
  const m = /^\/?modules\/([0-9a-f]+)\/([^/]+)$/.exec(decodeURIComponent(urlPath.split(/[?#]/)[0]));
  if (!m) return null;
  const dir = dirs.find((d) => dirKey(d) === m[1]);
  if (!dir || !m[2].endsWith('.wasm')) return null;
  const file = path.resolve(dir, m[2]);
  if (path.dirname(file) !== path.resolve(dir)) return null;  // no escapes
  return file;
}

/** The inverse, for hot reload: which URL is this file served at, if any? */
function urlForModuleFile(file, dirs = servedDirs()) {
  const dir = path.resolve(path.dirname(file));
  const served = dirs.find((d) => path.resolve(d) === dir);
  return served ? moduleUrl(served, path.basename(file)) : null;
}

/**
 * Is `file` a bundle that some OTHER copy overrides — a deployed copy under a
 * checked dev folder, or a built-in one a mapped folder replaces? Hot reload
 * must ignore those: reloading the hidden copy would put it back in front of
 * the one that is supposed to win. Files that aren't candidate bundles at all
 * (executor.wasm, a file in no served directory) are never shadowed.
 */
function isShadowed(file, builtinDir, dirs = servedDirs()) {
  const name = path.basename(file);
  if (!name.endsWith('.wasm')) return false;
  const stem = name.slice(0, -'.wasm'.length);
  const dir = path.resolve(path.dirname(file));
  const candidate =
    (builtinDir && path.resolve(builtinDir) === dir && BUILTIN_STEMS.includes(stem)) ||
    dirs.some((d) => path.resolve(d) === dir);
  if (!candidate) return false;
  const winner = resolveBundles(builtinDir, dirs).find((b) => b.stem === stem);
  return !!winner && path.resolve(winner.path) !== path.resolve(file);
}

/** a < b for dotted numeric versions ('1.2.10' > '1.2.9'). */
function versionLess(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

const SEED_MARKER = '.nano-seeded.json';

/**
 * Copy the bundles the app carries but does not load itself (`<root>/extra-modules`:
 * nano, lights, legacy, plus their AOT sidecars on macOS) into the default
 * modules directory — the installer step, done on first launch so macOS and
 * Windows share one code path.
 *
 * Once per app VERSION, recorded in a marker: an upgrade refreshes the seeded
 * copies (they must match the executor's ABI), while a bundle the user deleted
 * is not resurrected on every launch. An OLDER app never downgrades what a
 * newer one seeded. Returns the files copied.
 */
function seedDefaultModules(extraDir, version, targetDir = defaultModulesDir()) {
  if (!extraDir || !fs.existsSync(extraDir)) return [];
  const marker = path.join(targetDir, SEED_MARKER);
  try {
    const seeded = JSON.parse(fs.readFileSync(marker, 'utf8')).version;
    if (seeded && !versionLess(seeded, version)) return [];
  } catch { /* never seeded */ }
  fs.mkdirSync(targetDir, { recursive: true });
  const copied = [];
  for (const name of fs.readdirSync(extraDir)) {
    if (!/\.(wasm|aot)$/.test(name)) continue;
    const src = path.join(extraDir, name);
    const dst = path.join(targetDir, name);
    fs.copyFileSync(src, dst);
    // Keep the timestamps: the barrel ignores an .aot sidecar older than its
    // .wasm (a stale one would run old code), and a copy stamps both "now".
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
    copied.push(name);
  }
  fs.writeFileSync(marker, JSON.stringify({ version, files: copied }, null, 2));
  return copied;
}

module.exports = {
  seedDefaultModules,
  versionLess,
  BUILTIN_STEMS,

  defaultModulesDir,
  modulePathsFile,
  readModulePaths,
  writeModulePaths,
  servedDirs,
  dirKey,
  resolveBundles,
  isShadowed,
  resolveModuleUrl,
  urlForModuleFile,
};
