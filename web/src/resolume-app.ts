/**
 * Resolume sketch editor entry point. Mounted at /resolume/.
 *
 * Boots the shared engine, layers in resolume-specific defaults (auto-instantiate
 * a few effects + a debug particles sketch), and mounts the <sketch-app> shell.
 */

import { boot } from './boot';
import { appController } from './state/controller';
import type { Sketch } from './sketch-types';
import { WsBridgeClient } from './ws-bridge-client';

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

  const { engine } = await boot({ barrelMode });
  appController.setBarrelMode(barrelMode);

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

  // Resolume is the developer-facing sketch editor — load all three bundles
  // so every effect is reachable.
  appController.loadModule('com.nattos.core');
  appController.loadModule('com.nattos.nano');
  appController.loadModule('com.nattos.testonly');
  appController.loadModule('com.nano.lights');

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

  barrel.onSnapshot('/', (data) => {
    (window as any).__barrelState = data;
    const plugins = data?.plugins ?? {};
    const keys = Object.keys(plugins);
    if (keys.length === 0) {
      console.warn('[barrel] root snapshot had no plugins');
      return;
    }
    barrelPluginKey = keys[0];
    const sketch = plugins[barrelPluginKey!]?.state?.sketch ?? {};
    applySketchFromSnapshot(sketch);
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
  });

  barrel.onPatch((ops) => {
    if (!barrelPluginKey) return;
    const sketchPath = `/plugins/${barrelPluginKey}/state/sketch`;
    const sketchTouched = ops.some(
      (op: any) => typeof op?.path === 'string' &&
                   (op.path === sketchPath || op.path.startsWith(sketchPath + '/')));
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
 * would crash the edit tab's `sketch.columns.length` reads. We bridge
 * the gap by filling in defaults for any missing fields; the editor
 * then renders an empty sketch instead of throwing.
 */
function coerceSketch(remote: any): Sketch {
  const r = (remote && typeof remote === 'object' && !Array.isArray(remote))
              ? remote
              : {};
  return {
    anchor: typeof r.anchor === 'string' ? r.anchor : null,
    columns: Array.isArray(r.columns) ? r.columns : [],
    rails: Array.isArray(r.rails) ? r.rails : undefined,
    instances: (r.instances && typeof r.instances === 'object' && !Array.isArray(r.instances))
                  ? r.instances
                  : undefined,
  };
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
    columns: [{
      name: 'Particles',
      rails: [{
        id: 'particles_rail',
        name: 'Particle Data',
        dataType: { kind: 'struct', schema: PARTICLES_SCHEMA },
      }],
      chain: [
        { type: 'texture_input', id: 'primary_in' },
        {
          type: 'module',
          module_type: 'data.particles_emitter',
          instance_key: emitterKey,
          taps: [
            { railId: 'particles_rail', fieldPath: 'particles_out', direction: 'write' },
          ],
        },
        {
          type: 'module',
          module_type: 'video.particles_renderer',
          instance_key: rendererKey,
          taps: [
            { railId: 'particles_rail', fieldPath: 'particles_in', direction: 'read' },
          ],
        },
        { type: 'texture_output', id: 'primary_out' },
      ],
    }],
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
