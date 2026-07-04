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

// Global (document-level) Line Awesome load: <ui-icon> inlines the CSS into
// its shadow root, but @font-face only registers at document level — without
// this import every glyph in this entry renders as a blank box.
import 'line-awesome/dist/line-awesome/css/line-awesome.css';

import { boot } from './boot';
import {
  decideMode, OFFER_LIVE_DISMISSED_KEY,
  groupPreviewRequests, instanceKeyFromThumbTraceId,
} from './resolume-mode';
import { traceController } from './state/trace-controller';
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

    // Quietly watch for Resolume coming up so the shell can offer Live mode.
    startBarrelProbe(barrelUrl);
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
 * We deliberately observe only `/global/plugins` + the state paths that are
 * actually in use — the selected instance, plus any instance with a live
 * Instances-tab thumbnail — so the native `key_observed` gate does real work:
 * unwatched instances produce no per-frame telemetry/preview data.
 *
 * Exposed on `window.__barrel` for ad-hoc devtools patching.
 */
function connectBarrel(url: string) {
  const barrel = new WsBridgeClient(url);
  (window as any).__barrel = barrel;

  // The instance currently wired for editing.
  let currentKey: string | null = null;
  // Snapshot handlers are keyed by exact path; register each instance's
  // handlers once and have them bail if they're no longer the selected key.
  const handlersWired = new Set<string>();

  // -- Instance-state observations (single ownership) -------------------
  // The native `key_observed` gate only lets an instance do preview/telemetry
  // work while some client observes its `/plugins/<key>/state`. Two things
  // want that: the instance wired for editing, and every instance with a live
  // Instances-tab thumbnail. The client's subscription set is not refcounted,
  // so one reconciler owns ALL instance-state observations — computing the
  // desired set from (currentKey ∪ thumbKeys) and diffing against what's
  // actually observed. Never observe/unobserve these paths elsewhere.
  const observedInstancePaths = new Set<string>();
  let thumbKeys = new Set<string>();
  const reconcileObservations = () => {
    const desired = new Set<string>();
    if (currentKey) desired.add(`/plugins/${currentKey}/state`);
    for (const k of thumbKeys) desired.add(`/plugins/${k}/state`);
    for (const p of desired) {
      if (!observedInstancePaths.has(p)) {
        barrel.observe(p);
        observedInstancePaths.add(p);
      }
    }
    for (const p of [...observedInstancePaths]) {
      if (!desired.has(p)) {
        barrel.unobserve(p);
        observedInstancePaths.delete(p);
      }
    }
  };

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

  // Telemetry values arrive as real JSON objects: BridgeServer::set_at parses
  // the native side's dump() before storing, so both the snapshot fields and
  // the patch-op values are objects. Accept a string too (defensive — older
  // paths double-encoded).
  const coerceJsonObject = (data: any): Record<string, any> | null => {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return null; }
    }
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  };

  // Per-frame float-rail telemetry (native mirror of the local executor's
  // /sketch_state), carried in one patch op.
  const ingestRailState = (data: any) => {
    const railState = coerceJsonObject(data);
    if (!railState) return;
    appController.applySketchStateDiff({
      changed: { [BARREL_SKETCH_ID]: railState }, removed: [],
    });
  };

  // Per-instance control.barrel_macros output values (live macro knobs).
  const ingestMacroOutputs = (data: any) => {
    const states = coerceJsonObject(data);
    if (!states) return;
    appController.applyPluginStatesDiff({ changed: states, removed: [] });
  };

  // Per-instance live set_val outputs (effect broadcasts — e.g. shape_fold's
  // autopilot_x/_y), the native mirror of the worker's pluginStates channel.
  // Keyed by bare instance_key.
  const ingestPluginStates = (data: any) => {
    const states = coerceJsonObject(data);
    if (!states) return;
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
    ingestPluginStates(state.plugin_states);
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
    const statePath = `/plugins/${key}/state`;
    if (currentKey === key && observedInstancePaths.has(statePath)) {
      // Already wired — just refetch so the editor reflects latest.
      barrel.get(statePath);
      return;
    }
    currentKey = key;
    const sketchPath = `${statePath}/sketch`;

    // Move the active observation to this instance (precise gating).
    reconcileObservations();

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
      // Telemetry-channel refetch targets (the onPatch fallback for ops too
      // deep to merge in place).
      barrel.onSnapshot(`${statePath}/sketch_state`, (data) => {
        if (key === currentKey) ingestRailState(data);
      });
      barrel.onSnapshot(`${statePath}/plugin_states`, (data) => {
        if (key === currentKey) ingestPluginStates(data);
      });
    }

    // Editor → bridge push for this instance's sketch.
    appController.setBarrelPusher(BARREL_SKETCH_ID, (snapshot) => {
      if (currentKey !== key) return;
      barrel.patch(statePath, [{ op: 'replace', path: '/sketch', value: snapshot }]);
    });

    // Fetch the newly selected instance's full state, and re-flush the trace
    // registrations — they haven't changed, but their preview requests now
    // route to this instance (the pusher below keys them by currentKey).
    barrel.get(statePath);
    traceController.requestFlush();
    console.log(`[barrel] editing instance ${key}`);
  };

  // Trace controller → bridge preview-request relay. One global pusher for
  // ALL instances: thumbnail registrations (id embeds the instance key) go to
  // their own instance's /preview_requests; everything else (edit preview,
  // chain-entry monitors) to the instance wired for editing. Instances whose
  // requests all went away get one explicit `{}` push so the native side
  // stops capturing.
  const lastPushedRequests = new Map<string, string>();
  appController.setBarrelPreviewPusher((tracePoints) => {
    // Sidechannel thumbnails route to each channel's writer instance.
    const writers: Record<string, string> = {};
    for (const [ch, info] of Object.entries(appState.local.engine.sidechannels)) {
      if (info?.writer) writers[ch] = info.writer;
    }
    const groups = groupPreviewRequests(tracePoints, currentKey, writers);

    // Every instance we push requests AT must be observed for the native
    // watched-gate — thumbnailed instances plus sidechannel writers.
    thumbKeys = new Set([
      ...tracePoints.map((tp) => instanceKeyFromThumbTraceId(tp.id))
        .filter((k): k is string => !!k),
      ...[...groups.keys()].filter((k) => k !== currentKey),
    ]);
    reconcileObservations();

    for (const key of [...lastPushedRequests.keys()]) {
      if (!groups.has(key)) groups.set(key, {});
    }
    for (const [key, requests] of groups) {
      const json = JSON.stringify(requests);
      if (lastPushedRequests.get(key) === json) continue;
      lastPushedRequests.set(key, json);
      barrel.patch(`/plugins/${key}/state`,
        [{ op: 'add', path: '/preview_requests', value: requests }]);
    }
    // A cleared instance needs no further pushes — forget it (its `{}` just
    // went out; were it kept, the sweep above would re-add it every flush).
    for (const [key, json] of [...lastPushedRequests]) {
      if (json === '{}') lastPushedRequests.delete(key);
    }
  });

  // The controller drives instance selection (Organize tab + default pick);
  // it calls back here to rewire the transport.
  appController.setBarrelSelectHandler(wireInstance);

  // Maintain the live instance list from /global/plugins.
  barrel.onSnapshot('/global/plugins', (arr) => {
    (window as any).__barrelInstances = arr;
    appController.setBarrelInstances(parseInstances(arr));
  });

  // Sidechannel-bus channel metadata (channel → writer plugin key + size),
  // published by the native runtime only when it changes. Feeds the same
  // observable the playground's worker push does, so the channel-labeling UI
  // is mode-agnostic.
  const ingestSidechannels = (data: any) => {
    if (!data || typeof data !== 'object') return;
    appController.setSidechannels(data);
    // Channel metadata (esp. WRITER identity) steers sidechannel preview
    // routing — re-flush so open thumbnails follow a writer change. Metadata
    // pushes are change-gated upstream, so this is not per-frame traffic.
    traceController.requestFlush();
  };
  barrel.onSnapshot('/global/sidechannels', ingestSidechannels);

  // Binary preview frames — the controller decodes (NBPV v2) and drops any
  // frame that is neither the selected instance's nor an instance thumbnail's.
  barrel.onBinaryFrame = (buf) => {
    void appController.ingestBarrelPreviewFrame(buf);
  };

  // Telemetry publishes go through the doc-diffing set_at, so AFTER the first
  // publish the ops arrive FINE-GRAINED (e.g. .../plugin_states/sf@0/autopilot_x
  // per frame under autopilot) — an exact-path match would only ever see the
  // initial whole-object add. Merge instance-level and field-level ops into
  // the live pluginStates map; anything deeper is refetched wholesale.
  const applyInstanceStatesLeaf = (relPath: string, value: any): boolean => {
    const parts = relPath.slice(1).split('/');   // '/<ik>' or '/<ik>/<field>'
    const ik = parts[0];
    if (!ik) return false;
    if (parts.length === 1) {
      const obj = coerceJsonObject(value);
      if (obj) appController.applyPluginStatesDiff({ changed: { [ik]: obj }, removed: [] });
      return !!obj;
    }
    if (parts.length !== 2) return false;        // nested value — refetch instead
    const cur = (appState.local.engine.pluginStates as Record<string, any>)[ik];
    appController.applyPluginStatesDiff({
      changed: { [ik]: { ...(cur ?? {}), [parts[1]]: value } }, removed: [],
    });
    return true;
  };
  // Rail leaf update: /sketch_state/<railId>. Rails live under the barrel
  // sketch's single entry in engine.sketchState.
  const applyRailLeaf = (relPath: string, value: any): boolean => {
    const parts = relPath.slice(1).split('/');
    if (parts.length !== 1 || !parts[0]) return false;
    const cur = (appState.local.engine.sketchState as Record<string, any>)[BARREL_SKETCH_ID];
    appController.applySketchStateDiff({
      changed: { [BARREL_SKETCH_ID]: { ...(cur ?? {}), [parts[0]]: value } }, removed: [],
    });
    return true;
  };

  barrel.onPatch((ops) => {
    let globalTouched = false;
    const statePath = currentKey ? `/plugins/${currentKey}/state` : null;
    const sketchPath = statePath ? `${statePath}/sketch` : null;
    const sketchStatePath = statePath ? `${statePath}/sketch_state` : null;
    const macroOutputsPath = statePath ? `${statePath}/macro_outputs` : null;
    const pluginStatesPath = statePath ? `${statePath}/plugin_states` : null;
    let sketchTouched = false;
    let railRefetch = false;
    let pluginStatesRefetch = false;
    for (const op of ops) {
      const p = typeof op?.path === 'string' ? op.path : '';
      if (p === '/global/plugins' || p.startsWith('/global/plugins')) {
        globalTouched = true;          // instance added/removed
      } else if (p === '/global/sidechannels') {
        ingestSidechannels(op.value);  // whole-object replace per publish
      } else if (sketchPath && (p === sketchPath || p.startsWith(sketchPath + '/'))) {
        sketchTouched = true;
      } else if (p === sketchStatePath) {
        ingestRailState(op.value);
      } else if (sketchStatePath && p.startsWith(sketchStatePath + '/')) {
        if (!applyRailLeaf(p.slice(sketchStatePath.length), op.value)) railRefetch = true;
      } else if (p === macroOutputsPath) {
        ingestMacroOutputs(op.value);
      } else if (macroOutputsPath && p.startsWith(macroOutputsPath + '/')) {
        if (!applyInstanceStatesLeaf(p.slice(macroOutputsPath.length), op.value))
          pluginStatesRefetch = true;
      } else if (p === pluginStatesPath) {
        ingestPluginStates(op.value);
      } else if (pluginStatesPath && p.startsWith(pluginStatesPath + '/')) {
        if (!applyInstanceStatesLeaf(p.slice(pluginStatesPath.length), op.value))
          pluginStatesRefetch = true;
      }
    }
    if (globalTouched) barrel.get('/global/plugins');  // refresh the list
    if (sketchTouched && sketchPath) barrel.get(sketchPath);
    if (railRefetch && sketchStatePath) barrel.get(sketchStatePath);
    if (pluginStatesRefetch && pluginStatesPath) barrel.get(pluginStatesPath);
  });

  const subscribe = () => {
    barrel.get('/global/plugins');
    barrel.observe('/global/plugins');
    barrel.get('/global/sidechannels');
    barrel.observe('/global/sidechannels');
    // If a selection already exists (reconnect), rewire it.
    const sel = appController.getSelectedBarrelKey();
    if (sel) wireInstance(sel);
  };
  // Surface connection health for the shell's "switch to Playground?" offer.
  barrel.onOpen = () => {
    appController.setBarrelConnectionState('open');
    subscribe();
  };
  barrel.onClose = () => appController.setBarrelConnectionState('closed');
  if (barrel.isOpen) {
    appController.setBarrelConnectionState('open');
    subscribe();
  }

  console.log(`[barrel] connecting ${url} (window.__barrel / __barrelInstances)`);
}

/**
 * Playground-mode background probe: is a shared NanoBarrel server up on the
 * barrel port? One lightweight WebSocket attempt every 10 s (NOT a
 * WsBridgeClient — its infinite exponential backoff and logging are wrong
 * for probing). Stops once detected, or once the user dismisses the offer
 * (the shell records the dismissal in sessionStorage).
 */
function startBarrelProbe(url: string) {
  const PROBE_INTERVAL_MS = 10000;
  const attempt = () => {
    if (appState.local.barrelDetected) return;
    if (sessionStorage.getItem(OFFER_LIVE_DISMISSED_KEY)) return;
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch { setTimeout(attempt, PROBE_INTERVAL_MS); return; }
    let settled = false;
    const settle = (up: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      if (up) appController.setBarrelDetected(true);
      else setTimeout(attempt, PROBE_INTERVAL_MS);
    };
    ws.onopen = () => settle(true);
    ws.onerror = () => settle(false);
    ws.onclose = () => settle(false);
  };
  attempt();
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
