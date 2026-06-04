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
import { initFontProvider, requestFont } from './font-access';
import { loadUserSettings } from './state/user-settings';
import { loadAllProjects } from './state/project-store';
import { idbGetAll, idbGet, STORE_PROJECTS, STORE_SETTINGS, STORE_SKETCH_INPUTS } from './state/idb-store';

export interface BootOptions {
  width?: number;
  height?: number;
  /**
   * When true, skip loading projects from IndexedDB and skip enabling
   * IndexedDB persistence. The caller is responsible for supplying the
   * sketch from another source (eg the remote NanoBarrel bridge in
   * `resolume-app.ts`). Without this, stale local projects would be
   * fed into the engine sync the moment effects are discovered — and
   * mutations to the barrel-mirrored sketch would silently get
   * persisted on top of unrelated local state.
   */
  barrelMode?: boolean;
}

export interface BootResult {
  engine: EngineProxy;
}

export async function boot(opts: BootOptions = {}): Promise<BootResult> {
  const width = opts.width ?? 320;
  const height = opts.height ?? 180;
  const barrelMode = !!opts.barrelMode;
  const engine = new EngineProxy(width, height, barrelMode);
  appController.setEngine(engine);

  // Bridge OS font resolution: the worker's text engine asks (fontRequest) for a
  // family it lacks; the main thread resolves the bytes via Local Font Access
  // (gesture-primed, Chromium/Electron) and ships them back (registerFont).
  initFontProvider((key, family, bytes) => engine.registerFont(key, bytes, family));
  engine.onFontRequest = (req) => requestFont(req);

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

  engine.onError = (msg) => appController.setEngineError(msg);
  // In barrel mode the worker never simulates, so the remote-state /
  // FPS / traced-frames / sketchState / pluginStates streams are all
  // permanently empty. Skip the wiring so empty payloads can't clobber
  // the controller's bridge-supplied plugin list or stomp the trace UI
  // with cleared frames. `effectsDiscovered` is barrel-supplied too —
  // resolume-app derives it from the bridge's plugin_schemas blob.
  if (!barrelMode) {
    engine.onStateUpdate = (state) => appController.syncFromRemoteState(state);
    engine.onFps = (fps) => appController.setEngineFps(fps);
    engine.onTracedFrames = (frames) => appController.setTracedFrames(frames);
    engine.onSketchStateDiff = (diff) => appController.applySketchStateDiff(diff);
    engine.onPluginStatesDiff = (diff) => appController.applyPluginStatesDiff(diff);
    engine.onDebugStats = (stats) => appController.setDebugStats(stats);
    engine.onDebugConsoleLog = (entries) => appController.appendDebugConsoleLog(entries);
    engine.onEffectsDiscovered = (effects) => appController.setAvailableEffects(effects);
  }

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
  if (!barrelMode) {
    try {
      const projects = await loadAllProjects();
      if (Object.keys(projects).length > 0) {
        appController.loadInitialSketches(projects);
      }
    } catch (err) {
      console.warn('[boot] failed to load projects', err);
    }
  }

  // Subsequent mutations from this point on persist explicitly.
  // Barrel-mode editors don't persist — the remote bridge holds the truth.
  if (!barrelMode) appController.enablePersistence();

  return { engine };
}
