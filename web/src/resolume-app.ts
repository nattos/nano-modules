/**
 * Resolume sketch editor entry point. Mounted at /resolume/.
 *
 * Boots the shared engine, layers in resolume-specific defaults (auto-instantiate
 * a few effects + a debug particles sketch), and mounts the <sketch-app> shell.
 */

import { boot } from './boot';
import { appController } from './state/controller';
import type { Sketch } from './sketch-types';

// Import the root component (self-registering)
import './views/sketch-app';

// Dev-only WASM HMR listener (no-op in production).
import './wasm-hmr-client';

async function main() {
  const { engine } = await boot();

  let debugSketchCreated = false;
  const baseHandler = engine.onEffectsDiscovered;
  engine.onEffectsDiscovered = (effects) => {
    baseHandler?.(effects);
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
