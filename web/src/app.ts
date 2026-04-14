/**
 * Sketch Editor — entry point.
 *
 * Sets up the engine worker, wires state updates, and mounts <sketch-app>.
 */

import { toJS } from 'mobx';
import { appState } from './state/app-state';
import { appController } from './state/controller';
import { EngineProxy } from './engine-proxy';
import type { Sketch } from './sketch-types';

// Import the root component (self-registering)
import './views/sketch-app';

// Debug: expose state for inspection
(window as any).debugDumpState = () => {
  return toJS(appState);
};
(window as any).debugPrintState = () => {
  console.log(JSON.stringify(toJS(appState), undefined, 2));
};

async function main() {
  const engine = new EngineProxy(320, 180);
  appController.setEngine(engine);

  // Debug: dump engine worker's internal state (bridge core, sketches, instances)
  (window as any).debugDumpEngineState = async () => {
    const data = await engine.debugDump();
    console.log(JSON.stringify(data, undefined, 2));
    return data;
  };

  engine.onStateUpdate = (state) => appController.syncFromRemoteState(state);
  engine.onFps = (fps) => appController.setEngineFps(fps);
  engine.onTracedFrames = (frames) => appController.setTracedFrames(frames);
  engine.onSketchState = (state) => appController.setSketchState(state);
  engine.onPluginStates = (states) => appController.setPluginStates(states);
  engine.onError = (msg) => appController.setEngineError(msg);

  // When effects are discovered, store them and instantiate defaults
  let debugSketchCreated = false;
  engine.onEffectsDiscovered = (effects) => {
    appController.setAvailableEffects(effects);
    appController.instantiateEffect('generator.spinningtris');
    appController.instantiateEffect('generator.solid_color');
    appController.instantiateEffect('debug.gpu_test');

    if (!debugSketchCreated) {
      debugSketchCreated = true;
      createDebugParticleSketch();
    }
  };

  // Load the combined module (discovers all available effects)
  appController.loadModule('com.nattos.nano_effects');
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
