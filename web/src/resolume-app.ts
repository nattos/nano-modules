/**
 * Resolume sketch editor entry point. Mounted at /resolume/.
 *
 * Boots the shared engine, layers in resolume-specific defaults (auto-instantiate
 * a few effects + a debug particles sketch), and mounts the <sketch-app> shell.
 */

import { boot } from './boot';
import { appController } from './state/controller';
import { appState } from './state/app-state';
import type { Sketch } from './sketch-types';
import { WsBridgeClient } from './ws-bridge-client';
import { normalizeSketchChains } from './sketch-types';

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
  // Decide barrel mode up front, BEFORE booting — boot needs the flag
  // so it can skip the IndexedDB project load (otherwise stale local
  // sketches would feed into syncSketchesToEngine the moment effects
  // are discovered, and any of them with malformed shape would crash
  // augmentSketchWithImplicitConnections).
  const params = new URLSearchParams(location.search);
  const barrelUrl = params.get('barrel');
  const barrelMode = !!barrelUrl;

  // Local mode simulates the sketch in-worker — render at full 1920×1080 (the
  // boot default is a tiny 320×180). Barrel mode never simulates (the plugin
  // renders), so the size is irrelevant there.
  const { engine } = await boot({ width: 1920, height: 1080, barrelMode });
  appController.setBarrelMode(barrelMode);

  // Local simulator: run ONLY the sketch open in the edit tab — not every
  // sketch in the database (loaded effect-IDE projects, the debug demo, etc.).
  // The filter reads `editingSketchId` fresh on each sync; `editSketch` re-syncs.
  if (!barrelMode) {
    appController.setEngineSketchFilter((id) => id === appState.local.editingSketchId);
  }

  let debugSketchCreated = false;
  const baseHandler = engine.onEffectsDiscovered;
  engine.onEffectsDiscovered = (effects) => {
    baseHandler?.(effects);
    if (barrelMode) return;
    appController.instantiateEffect('generator.spinningtris');
    appController.instantiateEffect('generator.solid_color');
    appController.instantiateEffect('debug.gpu_test');

    if (!debugSketchCreated) {
      debugSketchCreated = true;
      createDebugParticleSketch();
    }
  };

  // Local-mode IDE: load every effect bundle so all effects are reachable.
  // Barrel mode skips this — the worker never instantiates anything; the
  // plugin list comes from the barrel's WS state subtree (see connectBarrel).
  if (!barrelMode) {
    appController.loadModule('com.nattos.core');
    appController.loadModule('com.nattos.nano');
    appController.loadModule('com.nattos.testonly');
    appController.loadModule('com.nano.lights');
    appController.loadModule('com.nattos.text');      // gen.text
    appController.loadModule('com.nattos.richtext');  // gen.richtext (Blitz HTML/CSS)
  }

  if (barrelMode) connectBarrel(barrelUrl!);
}

/**
 * Connect to a running NanoBarrel FFGL plugin via its per-instance WS
 * server. On the initial snapshot we discover the plugin key, mirror
 * the remote sketch into `appState.database.sketches[BARREL_SKETCH_ID]`,
 * and auto-select it for editing. On subsequent patches that touch the
 * sketch subtree we re-fetch the sketch and replace the local mirror.
 *
 * The client is also exposed on `window.__barrel` / `window.__barrelState`
 * for ad-hoc devtools-console patching while we bring up the UI:
 *
 *   window.__barrel.patch('/plugins/com.nattos.nanobarrel@0/state',
 *                         [{op:'replace', path:'/sketch', value:{...}}])
 *
 * Editor-side mutations don't push back yet — that's the next slice.
 */
function connectBarrel(url: string) {
  const barrel = new WsBridgeClient(url);
  (window as any).__barrel = barrel;

  let barrelPluginKey: string | null = null;
  let sketchSubscribed = false;

  const applySketchFromSnapshot = (sketch: any) => {
    appController.setBarrelSketch(BARREL_SKETCH_ID, coerceSketch(sketch));
    appController.editSketch(BARREL_SKETCH_ID);
  };

  /**
   * Adopt the barrel's published effect schemas. Each entry is one
   * registered effect on the native side (module_type → PluginInfo-ish
   * shape). The controller derives `params` / `io` from the raw schema
   * fields so its inspector + augmenter behave the same as in local
   * mode — except no WasmHost ever runs on the web.
   */
  const applyPluginSchemasFromSnapshot = (schemasObj: any) => {
    if (!schemasObj || typeof schemasObj !== 'object') return;
    const remotePlugins = Object.values(schemasObj)
      .filter((v: any) => v && typeof v === 'object' && typeof v.id === 'string') as any[];
    appController.setBarrelPlugins(remotePlugins);
  };

  // Per-frame float-rail telemetry the barrel publishes (native mirror of the
  // local executor's /sketch_state). Stored as a JSON string so it rides as one
  // patch op; we parse it and feed engine.sketchState so the rail spark charts
  // show live values in barrel mode (where the web never simulates).
  const ingestRailState = (jsonStr: any) => {
    if (typeof jsonStr !== 'string') return;
    let railState: any;
    try { railState = JSON.parse(jsonStr); } catch { return; }
    if (!railState || typeof railState !== 'object') return;
    appController.applySketchStateDiff({
      changed: { [BARREL_SKETCH_ID]: railState }, removed: [],
    });
  };

  // Per-instance output values the barrel publishes for io.barrel_macros (the
  // live macro knobs). Injected into a local sketch copy natively, so otherwise
  // invisible to the web. Feeds engine.pluginStates so the effect's output trace
  // cards (which read pluginStates[instanceKey][field]) show live values.
  const ingestMacroOutputs = (jsonStr: any) => {
    if (typeof jsonStr !== 'string') return;
    let states: any;
    try { states = JSON.parse(jsonStr); } catch { return; }
    if (!states || typeof states !== 'object') return;
    appController.applyPluginStatesDiff({ changed: states, removed: [] });
  };

  barrel.onSnapshot('/', (data) => {
    (window as any).__barrelState = data;
    const plugins = data?.plugins ?? {};
    const keys = Object.keys(plugins);
    if (keys.length === 0) {
      console.warn('[barrel] root snapshot had no plugins');
      return;
    }
    barrelPluginKey = keys[0];
    const pluginState = plugins[barrelPluginKey!]?.state ?? {};
    const sketch = pluginState.sketch ?? {};
    // Plugin schemas must land before applying the sketch — the
    // inspector + augmenter rely on them, and the sketch apply path
    // calls `backfillEmptyInstanceStates` which needs the schemas to
    // fill in defaults for instances the user dropped before any
    // schema was known.
    applyPluginSchemasFromSnapshot(pluginState.plugin_schemas);
    applySketchFromSnapshot(sketch);
    ingestRailState(pluginState.sketch_state);     // seed rail telemetry if present
    ingestMacroOutputs(pluginState.macro_outputs); // seed macro output cards if present
    console.log(`[barrel] mirrored sketch from /plugins/${barrelPluginKey}/state/sketch`);

    // Now that we know the plugin key, register a snapshot handler for
    // the sketch path so subsequent re-fetches land in the same spot.
    if (!sketchSubscribed) {
      sketchSubscribed = true;
      const sketchPath = `/plugins/${barrelPluginKey}/state/sketch`;
      barrel.onSnapshot(sketchPath, (latest) => {
        applySketchFromSnapshot(latest);
      });
    }

    // Wire the editor → barrel push direction. Every committed mutation
    // of the mirrored sketch fires this pusher with the post-mutation
    // sketch object, which we wrap in a replace-/sketch JSON patch
    // targeting the barrel plugin's state subtree.
    appController.setBarrelPusher(BARREL_SKETCH_ID, (snapshot) => {
      if (!barrelPluginKey) return;
      barrel.patch(`/plugins/${barrelPluginKey}/state`, [
        { op: 'replace', path: '/sketch', value: snapshot },
      ]);
    });

    // Wire the trace controller → bridge preview-request relay. Every
    // texture-monitor mount or unmount triggers a flush; we translate
    // the consolidated tracepoint set into a JSON map at
    // /preview_requests so the barrel knows which textures to capture
    // and ship back. Only the `width`/`height` from `tp.size` ride
    // through — the barrel ignores resolution metadata and just
    // honours the requested dimensions.
    let lastPushedRequestsJson: string | null = null;
    appController.setBarrelPreviewPusher((tracePoints) => {
      if (!barrelPluginKey) return;
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
        // trace-controller only sets `tp.size` for 'low' registrations;
        // 'high' leaves it undefined, meaning "capture at the source
        // texture's native resolution". Send `0/0` to the barrel as a
        // sentinel for that case — the barrel substitutes the live
        // source dimensions in publishPreviewFrames.
        requests[tp.id] = {
          target: serialized,
          width:  tp.size?.width  ?? 0,
          height: tp.size?.height ?? 0,
        };
      }
      const json = JSON.stringify(requests);
      if (json === lastPushedRequestsJson) return;
      lastPushedRequestsJson = json;
      // `add` on an existing path replaces (RFC 6902 §4.1); on a missing
      // path it creates. `replace` would fail silently if the barrel
      // hadn't pre-populated `/preview_requests` in its initial state,
      // so `add` keeps us robust against both old + new barrel binaries.
      barrel.patch(`/plugins/${barrelPluginKey}/state`, [
        { op: 'add', path: '/preview_requests', value: requests },
      ]);
    });
  });

  // Binary frames from the bridge carry preview snapshots. The decoder
  // lives on the controller because it owns appState; resolume-app is
  // just the transport wire.
  barrel.onBinaryFrame = (buf) => {
    void appController.ingestBarrelPreviewFrame(buf);
  };

  barrel.onPatch((ops) => {
    if (!barrelPluginKey) return;
    const sketchPath = `/plugins/${barrelPluginKey}/state/sketch`;
    const sketchStatePath = `/plugins/${barrelPluginKey}/state/sketch_state`;
    const macroOutputsPath = `/plugins/${barrelPluginKey}/state/macro_outputs`;
    let sketchTouched = false;
    for (const op of ops) {
      const p = typeof op?.path === 'string' ? op.path : '';
      if (p === sketchPath || p.startsWith(sketchPath + '/')) {
        sketchTouched = true;
      } else if (p === sketchStatePath) {
        // Live rail telemetry: apply the value directly (no re-fetch needed —
        // it's a single string op carrying the whole snapshot).
        ingestRailState(op.value);
      } else if (p === macroOutputsPath) {
        ingestMacroOutputs(op.value);
      }
    }
    if (sketchTouched) barrel.get(sketchPath);
  });

  const subscribe = () => {
    barrel.get('/');
    barrel.observe('/');
  };
  if (barrel.isOpen) subscribe();
  else barrel.onOpen = subscribe;

  console.log(`[barrel] connecting ${url} (window.__barrel / __barrelState)`);
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
    columns: Array.isArray(r.columns) ? r.columns : [],
    wires: Array.isArray(r.wires) ? r.wires : undefined,
    instances: (r.instances && typeof r.instances === 'object' && !Array.isArray(r.instances))
                  ? r.instances
                  : undefined,
  };
  // Strip any legacy explicit I/O chain entries — texture input/output
  // are implicit in the current model — and flatten to the single `chain`.
  return normalizeSketchChains(draft);
}

/**
 * Build a debug sketch wiring particles_emitter → particles_renderer
 * via a struct rail carrying GPU-resident positions/velocities.
 * Exists to exercise the structured-port + GPU-array data path end-to-end.
 */
function createDebugParticleSketch() {
  const PARTICLES_SCHEMA = {
    type: 'object',
    fields: {
      count: { type: 'int' },
      positions:  { type: 'array', gpu: true, elementType: { type: 'float' } },
      velocities: { type: 'array', gpu: true, elementType: { type: 'float' } },
    },
  };

  const emitterKey = 'debug_particles_emit@0';
  const rendererKey = 'debug_particles_render@0';

  const sketch: Sketch = {
    anchor: null,
    chain: [
      {
        type: 'module',
        module_type: 'data.particles_emitter',
        instance_key: emitterKey,
      },
      {
        type: 'module',
        module_type: 'video.particles_renderer',
        instance_key: rendererKey,
      },
    ],
    wires: [
      {
        id: 'particles_wire',
        src: { instanceKey: emitterKey, field: 'particles_out' },
        dest: { instanceKey: rendererKey, field: 'particles_in' },
      },
    ],
    instances: {
      [emitterKey]: {
        module_type: 'data.particles_emitter',
        state: { spawn_speed: 0.6, gravity: [0.0, -0.4] },
      },
      [rendererKey]: {
        module_type: 'video.particles_renderer',
        state: { particle_size: 0.03, tint: [1.0, 0.7, 0.2, 1.0] },
      },
    },
  };

  appController.mutate('Create debug particles sketch', draft => {
    draft.sketches['debug_particles'] = sketch;
  });
}

main();
