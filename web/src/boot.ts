/**
 * Shared engine + state bootstrap, used by both entry points
 * (`resolume-app.ts` and `effect-ide-app.ts`).
 *
 * Steps:
 *   1. Create the engine proxy and wire its callbacks to the controller.
 *   2. Restore user settings + persisted projects from IndexedDB.
 *   3. Subscribe debounced autoruns that write changes back to IndexedDB.
 *   4. Return the proxy so callers can layer extra `onEffectsDiscovered`
 *      handlers and call `loadModule(...)` to begin effect discovery.
 */

import { toJS } from 'mobx';
import { appState } from './state/app-state';
import { appController } from './state/controller';
import { EngineProxy } from './engine-proxy';
import { loadUserSettings, subscribeUserSettingsAutosave } from './state/user-settings';
import { loadAllProjects, subscribeProjectsAutosave } from './state/project-store';

export interface BootResult {
  engine: EngineProxy;
}

export async function boot(width = 320, height = 180): Promise<BootResult> {
  const engine = new EngineProxy(width, height);
  appController.setEngine(engine);

  (window as any).debugDumpState = () => toJS(appState);
  (window as any).debugPrintState = () => {
    console.log(JSON.stringify(toJS(appState), undefined, 2));
  };
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
  engine.onEffectsDiscovered = (effects) => appController.setAvailableEffects(effects);

  // Restore from IndexedDB before mounting UI so the first paint is correct.
  // Errors are non-fatal; we fall back to defaults.
  try {
    const settings = await loadUserSettings();
    appController.loadInitialUserSettings(settings);
    // Push the persisted paused state to the engine so the worker matches the UI.
    if (settings.paused) engine.setPaused(true);
  } catch (err) {
    console.warn('[boot] failed to load user settings', err);
  }
  try {
    const projects = await loadAllProjects();
    if (Object.keys(projects).length > 0) {
      appController.loadInitialSketches(projects);
    }
  } catch (err) {
    console.warn('[boot] failed to load projects', err);
  }

  // Auto-save subsequent changes.
  subscribeUserSettingsAutosave();
  subscribeProjectsAutosave();

  return { engine };
}
