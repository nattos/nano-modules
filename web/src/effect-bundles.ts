/**
 * Effect bundles — which exist, and where each is fetched from.
 *
 * A bundle is `<stem>.wasm` with id `com.nano.<stem>`. The engine `loadModule()`s
 * each one so its effects become reachable. They come from three kinds of
 * directory (electron/module-dirs.cjs, native/src/bridge/module_dirs.h):
 *
 *   - the app's own `wasm/` — a package ships core, text and richtext there;
 *   - the per-user modules directory the installer seeds (nano, lights, legacy);
 *   - directories the user maps (Settings → Modules), e.g. their own effects.
 *
 * `discoverEffectBundles()` asks whoever knows — the Electron main process, or
 * the dev server — and records each bundle's URL, which `bundleUrl()` hands to
 * the engine worker. A plain static host knows nothing and gets the built-ins.
 *
 * `com.nano.testonly` is never listed — it holds fixtures for integration tests.
 */

import { electronIpc } from './state/paths';

/** What a package carries in its own wasm/. Keep in step with
 *  builtinBundleStems() in native/src/bridge/module_dirs.h (whose longer list
 *  also names the bundles a DEV TREE carries there). */
export const SHIPPED_EFFECT_BUNDLES = [
  'com.nano.core',
  'com.nano.text', // source.text.plain
  'com.nano.richtext', // source.text.rich (Blitz HTML/CSS)
] as const;

/** Every bundle this repo builds into build/wasm. Only for dev-server-only
 *  pages (testbeds, the comp test runner) that want the lot without asking. */
export const REPO_EFFECT_BUNDLES = [
  ...SHIPPED_EFFECT_BUNDLES,
  'com.nano.nano',
  'com.nano.lights',
  'com.nano.legacy', // ports of shipped NanoGraph effects
] as const;

/** Human-readable label for a bundle id, e.g. for the smart-input's "browse by
 *  bundle" top-level entries. Unlisted ids (a user's own bundle) are labelled
 *  by their stem. */
export const EFFECT_BUNDLE_NAMES: Record<string, string> = {
  'com.nano.core': 'Core',
  'com.nano.nano': 'Nano',
  'com.nano.lights': 'Lights',
  'com.nano.text': 'Text',
  'com.nano.richtext': 'Rich Text',
  'com.nano.legacy': 'Legacy',
  'com.nano.testonly': 'Test Only',
};

export function bundleLabel(id: string): string {
  return EFFECT_BUNDLE_NAMES[id] ?? id.replace(/^com\.[^.]+\./, '');
}

export type BundleOrigin = 'builtin' | 'default' | 'mapped';

export interface EffectBundleInfo {
  id: string;
  /** Where the engine fetches it: `/wasm/<stem>.wasm` or `/modules/<n>/<file>`. */
  url: string;
  origin: BundleOrigin;
  /** Absolute file path, when the lister knows it. */
  path?: string;
}

export interface ModulePathRow { path: string; enabled: boolean }

export interface ModuleListing {
  bundles: EffectBundleInfo[];
  /** The per-user modules directory, or null when nobody could say. */
  defaultDir: string | null;
  /** The mapped directories, enabled or not. */
  paths: ModulePathRow[];
  /** Whether `setModulePaths` can persist anything here. */
  editable: boolean;
}

/** id → URL, filled by discovery. Unknown ids fall back to the built-in path. */
const urls = new Map<string, string>();

/** The URL the engine should fetch bundle `id` from. */
export function bundleUrl(id: string): string {
  const known = urls.get(id);
  if (known) return known;
  const stem = id.replace(/^com\.[^.]+\./, '').replace(/\./g, '_');
  return `/wasm/${stem}.wasm`;
}

function remember(listing: ModuleListing): ModuleListing {
  urls.clear();
  for (const b of listing.bundles) urls.set(b.id, b.url);
  return listing;
}

/** Ask the desktop shell, then the dev server; failing both, the built-ins. */
export async function listModules(): Promise<ModuleListing> {
  const ipc = electronIpc();
  if (ipc) {
    try {
      const r = await ipc.invoke('nano.listModules');
      if (r && Array.isArray(r.bundles)) return remember({ ...r, editable: true });
    } catch { /* an old shell without the handler: fall through */ }
  }
  try {
    const res = await fetch('/__nano/modules', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
      const r = await res.json();
      if (r && Array.isArray(r.bundles)) return remember({ ...r, editable: true });
    }
  } catch { /* no dev server */ }
  return remember({
    bundles: SHIPPED_EFFECT_BUNDLES.map((id) => ({ id, url: bundleUrl(id), origin: 'builtin' })),
    defaultDir: null,
    paths: [],
    editable: false,
  });
}

let discovery: Promise<string[]> | null = null;

/** The ids of every bundle to load, discovered once per session. */
export function discoverEffectBundles(): Promise<string[]> {
  discovery ??= listModules().then((l) => l.bundles.map((b) => b.id));
  return discovery;
}

/** Persist the mapped directories (desktop shell or dev server). Takes effect
 *  for the app on the next launch; the native barrel reads it when Resolume
 *  next loads the plugin. */
export async function setModulePaths(rows: ModulePathRow[]): Promise<ModuleListing> {
  const clean = JSON.parse(JSON.stringify(rows)) as ModulePathRow[];
  const ipc = electronIpc();
  if (ipc) {
    await ipc.invoke('nano.setModulePaths', clean);
    return listModules();
  }
  const res = await fetch('/__nano/modules', { method: 'POST', body: JSON.stringify(clean) });
  if (!res.ok) throw new Error(`setModulePaths: ${res.status} ${await res.text()}`);
  return remember({ ...(await res.json()), editable: true });
}
