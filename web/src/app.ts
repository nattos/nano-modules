/**
 * Sketch Editor — entry point.
 *
 * Sets up the engine worker, wires state updates, and mounts <sketch-app>.
 */

import { toJS } from 'mobx';
import { appState } from './state/app-state';
import { appController } from './state/controller';
import { EngineProxy } from './engine-proxy';

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

  // Load default generators
  appController.loadModule('com.nattos.spinningtris');
  appController.loadModule('com.nattos.gpu_test');
  appController.loadModule('com.nattos.nanolooper');
  appController.loadModule('com.nattos.brightness_contrast');
  appController.loadModule('com.nattos.env_lfo');
}

main();
