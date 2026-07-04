/**
 * Resolume sketch editor entry point. Mounted at /resolume/.
 *
 * Boots the shared engine and mounts the <sketch-app> shell in one of two modes:
 *
 *   - BARREL (the default): bound to the shared NanoBarrel server over WS; the
 *     remote bridge is the source of truth, nothing simulates locally.
 *   - PLAYGROUND (`?playground`): a local simulation of the shared server —
 *     fake "instances" (one sketch each, all running simultaneously in the
 *     worker) persisted in their own IndexedDB store, for testing
 *     multi-instance routings without Resolume.
 */

import { boot } from './boot';
import { decideMode } from './resolume-mode';
import { loadAllPlaygroundInstances } from './state/playground-store';
import { appController } from './state/controller';
import { appState } from './state/app-state';
import type { Sketch } from './sketch-types';
import { PLAYGROUND_ID_PREFIX, type BarrelInstanceInfo } from './state/types';
import { WsBridgeClient } from './ws-bridge-client';
import { normalizeSketchChains } from './sketch-types';
import { EFFECT_BUNDLES } from './effect-bundles';

// Import the root component (self-registering)
import './views/sketch-app';

// Dev-only WASM HMR listener (no-op in production).
import './wasm-hmr-client';

/**
 * The sketch ID we use locally to mirror the barrel's single sketch.
 * Doesn't need to match the plugin key — it's just the row index in
 * `appState.database.sketches` that the edit tab will hand to its
 * children.
 */
const BARREL_SKETCH_ID = 'barrel';

async function main() {
  // Decide the mode from the URL, BEFORE booting — boot needs it so it can
  // skip the IndexedDB project load in both modes (stale effect-IDE sketches
  // must never feed the engine sync here).
  const { mode, barrelUrl } = decideMode(location.search);
  const barrelMode = mode === 'barrel';

  // The playground simulates sketches in-worker — render at full 1920×1080
  // (the boot default is a tiny 320×180). Barrel mode never simulates (the
  // plugin renders), so the size is irrelevant there.
  await boot({ width: 1920, height: 1080, mode });
  appController.setBarrelMode(barrelMode);

  if (!barrelMode) {
    appController.setPlaygroundMode(true);

    // Playground: every playground instance (`pg:` sketch) runs in the worker
    // simultaneously — that's the point (test multi-instance routings as if
    // Resolume were running). The `editingSketchId` disjunct additionally
    // admits ad-hoc sketches created directly by tests/devtools.
    appController.setEngineSketchFilter(
      (id) => id.startsWith(PLAYGROUND_ID_PREFIX) || id === appState.local.editingSketchId);

    // Load every effect bundle so all effects are reachable. Barrel mode
    // skips this — the worker never instantiates anything; the plugin list
    // comes from the barrel's WS state subtree (see connectBarrel).
    for (const bundle of EFFECT_BUNDLES) appController.loadModule(bundle);

    // Selecting a playground instance just opens its sketch (the barrel-mode
    // twin of this handler rewires the WS transport instead). Register BEFORE
    // loading instances so the boot-time default pick opens something.
    appController.setBarrelSelectHandler((key) => appController.editSketch(key));
    try {
      appController.loadInitialPlaygroundInstances(await loadAllPlaygroundInstances());
    } catch (err) {
      console.warn('[playground] failed to load instances', err);
    }
    // Persistence goes live only after the load, so loaded state isn't
    // immediately echoed back to the playground store.
    appController.enablePersistence();
  }

  if (barrelMode) connectBarrel(barrelUrl);
}

/**
 * Connect to the shared NanoBarrel server (one WS server on a fixed port,
 * multiplexing every plugin instance under `/plugins/<uuid>/state`).
 *
 * Flow:
 *   - Observe `/global/plugins` → maintain the live instance list (the
 *     Organize tab renders it; the controller picks/persists a selection).
 *   - For the SELECTED instance, observe its `/plugins/<key>/state`, mirror
 *     its sketch into `appState.database.sketches[BARREL_SKETCH_ID]`, and
 *     wire the editor→bridge push + preview-request relay at that key.
 *   - Switching instances (Organize tab) re-points all of the above.
 *
 * We deliberately observe only `/global/plugins` + the selected state path
 * (not the doc root) so the native `key_observed` gate does real work:
 * only the instance being edited produces per-frame telemetry/preview data.
 *
 * Exposed on `window.__barrel` for ad-hoc devtools patching.
 */
function connectBarrel(url: string) {
  const barrel = new WsBridgeClient(url);
  (window as any).__barrel = barrel;

  // The instance currently wired for editing, and the state path we have an
  // active `observe` on (so we can unobserve when switching).
  let currentKey: string | null = null;
  let observedStatePath: string | null = null;
  // Snapshot handlers are keyed by exact path; register each instance's
  // handlers once and have them bail if they're no longer the selected key.
  const handlersWired = new Set<string>();

  const applySketchFromSnapshot = (sketch: any) => {
    appController.setBarrelSketch(BARREL_SKETCH_ID, coerceSketch(sketch));
    appController.editSketch(BARREL_SKETCH_ID);
  };

  /**
   * Adopt the barrel's published effect schemas. The controller derives
   * `params` / `io` from the raw schema fields so its inspector + augmenter
   * behave the same as local mode — except no WasmHost runs on the web.
   */
  const applyPluginSchemasFromSnapshot = (schemasObj: any) => {
    if (!schemasObj || typeof schemasObj !== 'object') return;
    const remotePlugins = Object.values(schemasObj)
      .filter((v: any) => v && typeof v === 'object' && typeof v.id === 'string') as any[];
    appController.setBarrelPlugins(remotePlugins);
  };

  // Per-frame float-rail telemetry (native mirror of the local executor's
  // /sketch_state), a JSON string carried in one patch op.
  const ingestRailState = (jsonStr: any) => {
    if (typeof jsonStr !== 'string') return;
    let railState: any;
    try { railState = JSON.parse(jsonStr); } catch { return; }
    if (!railState || typeof railState !== 'object') return;
    appController.applySketchStateDiff({
      changed: { [BARREL_SKETCH_ID]: railState }, removed: [],
    });
  };

  // Per-instance control.barrel_macros output values (live macro knobs).
  const ingestMacroOutputs = (jsonStr: any) => {
    if (typeof jsonStr !== 'string') return;
    let states: any;
    try { states = JSON.parse(jsonStr); } catch { return; }
    if (!states || typeof states !== 'object') return;
    appController.applyPluginStatesDiff({ changed: states, removed: [] });
  };

  // Apply a full /plugins/<key>/state object (schemas first — the sketch
  // apply path backfills instance defaults from them).
  const applyInstanceState = (state: any) => {
    if (!state || typeof state !== 'object') return;
    applyPluginSchemasFromSnapshot(state.plugin_schemas);
    applySketchFromSnapshot(state.sketch ?? {});
    ingestRailState(state.sketch_state);
    ingestMacroOutputs(state.macro_outputs);
  };

  // Parse /global/plugins (array of {key, metadata, schema, ...}) into the
  // NanoBarrel instance list for the Organize tab.
  const parseInstances = (arr: any): BarrelInstanceInfo[] => {
    if (!Array.isArray(arr)) return [];
    const out: BarrelInstanceInfo[] = [];
    for (const p of arr) {
      const key = p?.key;
      const id = p?.metadata?.id;
      if (typeof key !== 'string' || id !== 'com.nano.nanobarrel') continue;
      out.push({ key, id, label: key.split('-')[0] || key });
    }
    return out;
  };

  // (Re)wire the bridge for the selected instance key. Registered as the
  // controller's barrel select handler, and also called for the initial pick.
  const wireInstance = (key: string) => {
    if (currentKey === key && observedStatePath) {
      // Already wired — just refetch so the editor reflects latest.
      barrel.get(`/plugins/${key}/state`);
      return;
    }
    currentKey = key;
    const statePath = `/plugins/${key}/state`;
    const sketchPath = `${statePath}/sketch`;

    // Move the active observation to this instance (precise gating).
    if (observedStatePath && observedStatePath !== statePath) {
      barrel.unobserve(observedStatePath);
    }
    barrel.observe(statePath);
    observedStatePath = statePath;

    // Register snapshot handlers once per key; they no-op once superseded.
    if (!handlersWired.has(key)) {
      handlersWired.add(key);
      barrel.onSnapshot(statePath, (state) => {
        if (key !== currentKey) return;
        applyInstanceState(state);
      });
      barrel.onSnapshot(sketchPath, (latest) => {
        if (key !== currentKey) return;
        applySketchFromSnapshot(latest);
      });
    }

    // Editor → bridge push for this instance's sketch.
    appController.setBarrelPusher(BARREL_SKETCH_ID, (snapshot) => {
      if (currentKey !== key) return;
      barrel.patch(statePath, [{ op: 'replace', path: '/sketch', value: snapshot }]);
    });

    // Trace controller → bridge preview-request relay for this instance.
    let lastPushedRequestsJson: string | null = null;
    appController.setBarrelPreviewPusher((tracePoints) => {
      if (currentKey !== key) return;
      const requests: Record<string, any> = {};
      for (const tp of tracePoints) {
        const target = tp.target;
        let serialized: any = null;
        if (target.type === 'sketch_output') {
          serialized = { type: 'sketch_output', sketchId: target.sketchId };
        } else if (target.type === 'chain_entry') {
          serialized = {
            type: 'chain_entry',
            sketchId: target.sketchId,
            colIdx: target.colIdx,
            chainIdx: target.chainIdx,
            side: target.side,
          };
        } else {
          continue;  // plugin_output not yet supported in barrel mode
        }
        requests[tp.id] = {
          target: serialized,
          width:  tp.size?.width  ?? 0,
          height: tp.size?.height ?? 0,
        };
      }
      const json = JSON.stringify(requests);
      if (json === lastPushedRequestsJson) return;
      lastPushedRequestsJson = json;
      barrel.patch(statePath, [{ op: 'add', path: '/preview_requests', value: requests }]);
    });

    // Fetch the newly selected instance's full state.
    barrel.get(statePath);
    console.log(`[barrel] editing instance ${key}`);
  };

  // The controller drives instance selection (Organize tab + default pick);
  // it calls back here to rewire the transport.
  appController.setBarrelSelectHandler(wireInstance);

  // Maintain the live instance list from /global/plugins.
  barrel.onSnapshot('/global/plugins', (arr) => {
    (window as any).__barrelInstances = arr;
    appController.setBarrelInstances(parseInstances(arr));
  });

  // Binary preview frames — the controller decodes (NBPV v2) and drops any
  // frame whose key isn't the selected instance.
  barrel.onBinaryFrame = (buf) => {
    void appController.ingestBarrelPreviewFrame(buf);
  };

  barrel.onPatch((ops) => {
    let globalTouched = false;
    const statePath = currentKey ? `/plugins/${currentKey}/state` : null;
    const sketchPath = statePath ? `${statePath}/sketch` : null;
    const sketchStatePath = statePath ? `${statePath}/sketch_state` : null;
    const macroOutputsPath = statePath ? `${statePath}/macro_outputs` : null;
    let sketchTouched = false;
    for (const op of ops) {
      const p = typeof op?.path === 'string' ? op.path : '';
      if (p === '/global/plugins' || p.startsWith('/global/plugins')) {
        globalTouched = true;          // instance added/removed
      } else if (sketchPath && (p === sketchPath || p.startsWith(sketchPath + '/'))) {
        sketchTouched = true;
      } else if (p === sketchStatePath) {
        ingestRailState(op.value);
      } else if (p === macroOutputsPath) {
        ingestMacroOutputs(op.value);
      }
    }
    if (globalTouched) barrel.get('/global/plugins');  // refresh the list
    if (sketchTouched && sketchPath) barrel.get(sketchPath);
  });

  const subscribe = () => {
    barrel.get('/global/plugins');
    barrel.observe('/global/plugins');
    // If a selection already exists (reconnect), rewire it.
    const sel = appController.getSelectedBarrelKey();
    if (sel) wireInstance(sel);
  };
  if (barrel.isOpen) subscribe();
  else barrel.onOpen = subscribe;

  console.log(`[barrel] connecting ${url} (window.__barrel / __barrelInstances)`);
}

/**
 * Force the remote state.sketch blob into a minimally-valid Sketch
 * shape. The barrel's persisted state is just opaque JSON from the
 * plugin's perspective — early bring-up sometimes leaves arbitrary
 * payloads in there (eg the `{hello:'world'}` round-trip test) that
 * would crash the edit tab's chain reads. We bridge the gap by filling
 * in defaults for any missing fields; the editor then renders an empty
 * sketch instead of throwing.
 */
function coerceSketch(remote: any): Sketch {
  const r = (remote && typeof remote === 'object' && !Array.isArray(remote))
              ? remote
              : {};
  const draft: Sketch = {
    anchor: typeof r.anchor === 'string' ? r.anchor : null,
    // Accept either the canonical `chain` or any legacy `columns` blob;
    // normalizeSketchChains flattens whichever is present into `chain`.
    chain: Array.isArray(r.chain) ? r.chain : undefined,
    wires: Array.isArray(r.wires) ? r.wires : undefined,
    instances: (r.instances && typeof r.instances === 'object' && !Array.isArray(r.instances))
                  ? r.instances
                  : undefined,
  };
  // Carry any legacy multi-column blob through untyped so normalize can flatten it.
  if (!draft.chain && Array.isArray(r.columns)) (draft as any).columns = r.columns;
  // Strip any legacy explicit I/O chain entries — texture input/output
  // are implicit in the current model — and flatten to the single `chain`.
  return normalizeSketchChains(draft);
}

main();
