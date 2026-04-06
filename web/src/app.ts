/**
 * Sketch Editor — entry point.
 *
 * Sets up the engine worker, wires state updates, and mounts <sketch-app>.
 */

import { appController } from './state/controller';
import { EngineProxy } from './engine-proxy';

// Import the root component (self-registering)
import './views/sketch-app';

async function main() {
  const engine = new EngineProxy(320, 180);
  appController.setEngine(engine);

  engine.onStateUpdate = (state) => appController.syncFromRemoteState(state);
  engine.onFps = (fps) => appController.setEngineFps(fps);
  engine.onFrame = (bitmap) => appController.setEngineFrame(bitmap);
  engine.onError = (msg) => appController.setEngineError(msg);

  // Load default generators
  appController.loadModule('com.nattos.spinningtris');
  appController.loadModule('com.nattos.gpu_test');
  appController.loadModule('com.nattos.nanolooper');
  appController.loadModule('com.nattos.brightness_contrast');
}

main();
