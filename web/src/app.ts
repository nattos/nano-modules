/**
 * Sketch Editor — entry point.
 *
 * Sets up the engine worker, wires state updates, and mounts <sketch-app>.
 */

import { appController } from './state/controller';
import { EngineProxy } from './engine-proxy';
import { canvasReady } from './views/sketch-app';

async function main() {
  // Wait for <sketch-app> to render and provide its canvas
  const canvas = await canvasReady;

  const engine = new EngineProxy(canvas);
  appController.setEngine(engine);

  engine.onStateUpdate = (state) => appController.syncFromRemoteState(state);
  engine.onFps = (fps) => appController.setEngineFps(fps);
  engine.onError = (msg) => appController.setEngineError(msg);

  // Load default modules
  appController.loadModule('com.nattos.spinningtris');
  appController.loadModule('com.nattos.nanolooper');
  appController.loadModule('com.nattos.gpu_test');
  appController.loadModule('com.nattos.brightness_contrast');
  appController.loadModule('com.nattos.paramlinker');
}

main();
