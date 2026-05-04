/**
 * Shared engine + state bootstrap, used by both entry points
 * (`resolume-app.ts` and `effect-ide-app.ts`).
 *
 * Steps:
 *   1. Create the engine proxy and wire its callbacks to the controller.
 *   2. Restore user settings + persisted projects from IndexedDB.
 *   3. Enable persistence so subsequent mutations save to IndexedDB.
 *   4. Return the proxy so callers can layer extra `onEffectsDiscovered`
 *      handlers and call `loadModule(...)` to begin effect discovery.
 *
 * Persistence is driven explicitly from controller methods (no MobX
 * reactions). See `state/controller.ts` for the debounced save scheduling.
 */

import { toJS } from 'mobx';
import { appState } from './state/app-state';
import { appController } from './state/controller';
import { EngineProxy } from './engine-proxy';
import { loadUserSettings } from './state/user-settings';
import { loadAllProjects } from './state/project-store';
import { idbGetAll, idbGet, STORE_PROJECTS, STORE_SETTINGS, STORE_SKETCH_INPUTS } from './state/idb-store';

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
  // What's actually persisted in IndexedDB right now? Useful when
  // diagnosing "I edited my project but it didn't save".
  (window as any).debugDumpIdb = async () => {
    const projects = await idbGetAll(STORE_PROJECTS);
    const settings = await idbGet(STORE_SETTINGS, 'settings');
    const inputs = await idbGetAll(STORE_SKETCH_INPUTS);
    const dump = { projects, settings, inputs };
    console.log('[debugDumpIdb]', dump);
    return dump;
  };
  // Nuclear option — wipe IndexedDB to start over. Reload the page after.
  (window as any).debugClearIdb = async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('nano-modules');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('[debugClearIdb] blocked — close other tabs?');
    });
    console.log('[debugClearIdb] done — reload to start fresh');
  };

  engine.onStateUpdate = (state) => appController.syncFromRemoteState(state);
  engine.onFps = (fps) => appController.setEngineFps(fps);
  engine.onTracedFrames = (frames) => appController.setTracedFrames(frames);
  engine.onSketchState = (state) => appController.setSketchState(state);
  engine.onPluginStates = (states) => appController.setPluginStates(states);
  engine.onDebugStats = (stats) => appController.setDebugStats(stats);
  engine.onDebugConsoleLog = (entries) => appController.appendDebugConsoleLog(entries);
  engine.onError = (msg) => appController.setEngineError(msg);
  engine.onEffectsDiscovered = (effects) => appController.setAvailableEffects(effects);

  // Restore from IndexedDB before mounting UI so the first paint is correct.
  // Errors are non-fatal; we fall back to defaults. Persistence stays
  // disabled during this phase so loaded values aren't immediately echoed
  // back to disk.
  try {
    const settings = await loadUserSettings();
    appController.loadInitialUserSettings(settings);
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

  // Subsequent mutations from this point on persist explicitly.
  appController.enablePersistence();

  return { engine };
}
