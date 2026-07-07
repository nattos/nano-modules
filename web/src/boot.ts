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
   * Which app surface is booting. Default `'ide'` (the effect IDE): load
   * effect-IDE projects from IndexedDB and enable persistence.
   *
   * `'barrel'`: skip the project load AND persistence AND the engine
   * callbacks — the remote NanoBarrel bridge is the source of truth
   * (`resolume-app.ts` supplies the sketch). Stale local projects would
   * otherwise feed the engine sync the moment effects are discovered, and
   * mutations to the barrel-mirrored sketch would silently persist on top
   * of unrelated local state.
   *
   * `'playground'`: the local shared-server playground. Keeps the engine
   * callbacks (the worker simulates), but skips the effect-IDE project
   * load — the playground expressly has its OWN IndexedDB store
   * (`playgroundInstances`) and must not read effect-IDE sketches. The
   * caller loads those instances and calls `enablePersistence()` itself.
   */
  mode?: 'ide' | 'barrel' | 'playground';
}

export interface BootResult {
  engine: EngineProxy;
}

export async function boot(opts: BootOptions = {}): Promise<BootResult> {
  const width = opts.width ?? 320;
  const height = opts.height ?? 180;
  const mode = opts.mode ?? 'ide';
  const barrelMode = mode === 'barrel';
  const engine = new EngineProxy(width, height, barrelMode);
  appController.setEngine(engine);

  // Bridge OS font resolution: the worker's text engine asks (fontRequest) for a
  // family it lacks; the main thread resolves the bytes via Local Font Access
  // (gesture-primed, Chromium/Electron) and ships them back (registerFont). The
  // second callback installs the OS's CJK faces as the fallback chain (replacing
  // the bundled Noto CJK) once Local Font Access is primed.
  initFontProvider(
    (family, weight, italic, bytes) => engine.registerFont(family, weight, italic, bytes),
    (lang, bytes) => engine.registerFallback(lang, bytes),
  );
  engine.onFontRequest = (req) => requestFont(req);

  (window as any).appController = appController;
  (window as any).appState = appState;
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
    engine.onGpuTime = (ms) => appController.setEngineGpuTime(ms);
    engine.onTracedFrames = (frames) => appController.setTracedFrames(frames);
    engine.onSketchStateDiff = (diff) => appController.applySketchStateDiff(diff);
    engine.onPluginStatesDiff = (diff) => appController.applyPluginStatesDiff(diff);
    engine.onModulationDataDiff = (diff) => appController.applyModulationDataDiff(diff);
    engine.onDebugStats = (stats) => appController.setDebugStats(stats);
    engine.onDebugConsoleLog = (entries) => appController.appendDebugConsoleLog(entries);
    engine.onEffectsDiscovered = (effects) => appController.setAvailableEffects(effects);
    engine.onSidechannels = (channels) => appController.setSidechannels(channels);
    engine.onTriggerRails = (rails) => appController.setTriggerRails(rails);
  }

  // Restore from IndexedDB before mounting UI so the first paint is correct.
  // Errors are non-fatal; we fall back to defaults. Persistence stays
  // disabled during this phase so loaded values aren't immediately echoed
  // back to disk.
  try {
    const settings = await loadUserSettings();
    appController.loadInitialUserSettings(settings);
    // Route through the controller so the engine AND the IDE video preview both
    // start paused (the preview pump may begin in enablePersistence() below).
    if (settings.paused) appController.setPaused(true);
  } catch (err) {
    console.warn('[boot] failed to load user settings', err);
  }
  // Record the surface actually booting into `appMode`, regardless of what
  // was last persisted — the URL (which decided `mode`) is the source of
  // truth for the current surface; `appMode` only remembers it for the
  // Settings tab's selector. Never auto-redirects a mismatched bookmark.
  appController.setUserSetting('appMode', mode === 'barrel' ? 'live' : mode === 'playground' ? 'playground' : 'effect-dev');
  // Effect-IDE projects load ONLY in ide mode: barrel gets its sketch from
  // the bridge; the playground has its own store (loaded by resolume-app).
  if (mode === 'ide') {
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
  // Playground persistence is enabled by the caller AFTER it loads its
  // instances (so loaded values aren't echoed straight back to disk).
  if (mode === 'ide') appController.enablePersistence();

  return { engine };
}
