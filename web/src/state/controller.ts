/**
 * App controller — single entry point for all state mutations.
 *
 * Separates:
 * - Database mutations (through historyManager.record → undo/redo-able)
 * - Local state changes (direct MobX runInAction → ephemeral)
 * - Engine commands (forwarded to worker via EngineProxy)
 */

import { runInAction, toJS } from 'mobx';
import { appState } from './app-state';
import { HistoryManager, LongEdit } from './history';
import { traceController } from './trace-controller';
import type { DatabaseState, StagingInstance, PluginInfo, AvailableEffect, Selectable, UserSettings } from './types';
import type { EngineProxy } from '../engine-proxy';
import type { EngineState, EffectInfo, TracePoint, ParamValue } from '../engine-types';
import type { Sketch, ChainEntry } from '../sketch-types';
import { normalizeSketchChains } from '../sketch-types';
import { isRailCompatible } from '../schema-compat';
import {
  isDefaultProjectId,
  isUserProjectId,
  isPersistableProjectId,
  effectIdFromDefaultProjectId,
  defaultProjectIdForEffect,
  synthesizeDefaultProject,
} from './default-projects';
import { saveUserSettings } from './user-settings';
import { saveProject, deleteProject as idbDeleteProject } from './project-store';
import { SketchInputManager } from './sketch-input-manager';

/** Identifies one end of a drag-to-connect operation. */
export interface FieldConnectInfo {
  sketchId: string;
  colIdx: number;
  chainIdx: number;
  fieldPath: string;
  isOutput: boolean;
  /** Viewport Y used to decide writer vs reader when both fields are same direction. */
  viewportY: number;
  /** Schema definition for this field (null if legacy / no schema). Used to pick rail type. */
  schemaDef: any | null;
}

/** True for schema fields that need struct-rail transport (not scalar/texture). */
function isStructuredSchemaTypeDef(def: any): boolean {
  if (!def || typeof def !== 'object') return false;
  const t = def.type;
  return t === 'object' || t === 'array' || t === 'float2' || t === 'float3' || t === 'float4';
}

/** Derive a rail data type from a schema field definition. */
function railDataTypeFromSchema(def: any | null): import('../sketch-types').RailDataType {
  if (!def || typeof def !== 'object') return 'float';
  if (def.type === 'texture') return 'texture';
  if (isStructuredSchemaTypeDef(def)) {
    // Deep-clone the schema: `def` frequently points into the MobX-proxied
    // plugins list, and proxies can't cross `postMessage` to the worker.
    // Storing a plain clone in the rail keeps the sketch structured-clonable.
    return { kind: 'struct', schema: JSON.parse(JSON.stringify(def)) };
  }
  return 'float';
}

export class AppController {
  public readonly history: HistoryManager;
  private engine: EngineProxy | null = null;
  private nextSketchId = 0;

  /**
   * Set of sketch IDs the engine currently knows about. Used to detect
   * deletions on each sync — anything previously synced but no longer
   * present (or excluded by `engineSketchFilter`) gets a `deleteSketch`
   * command so the engine can drop its cached state.
   */
  private engineSyncedSketchIds = new Set<string>();

  /**
   * Optional filter limiting which sketches get pushed to the engine.
   * The IDE entry sets this to "only the currently selected project" so
   * other user/template sketches sit dormant in `appState.database` for
   * the explorer UI but never run on the GPU. When `null`, all sketches
   * sync (resolume's behavior).
   */
  private engineSketchFilter: ((sketchId: string) => boolean) | null = null;

  // -- Persistence scheduling (no MobX reactions; fired explicitly by
  //    every method that mutates the relevant slice) --

  private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private projectsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Last serialized form of each `user:` project that has been written to
   * IndexedDB. Used to avoid redundant writes and to detect deletions.
   */
  private projectsLastSavedJson = new Map<string, string>();
  /** Disabled during boot so loading from IDB doesn't immediately re-save. */
  private persistenceEnabled = false;

  /**
   * Owns the off-screen video element / image lifecycle that drives the
   * active sketch's `texture_input`. Survives UI re-mounts (tab switches),
   * persists drops to IndexedDB, and restores them when a project is
   * reselected.
   */
  private inputManager = new SketchInputManager(
    (sketchId, bitmap) => this.engine?.setSketchInput(sketchId, bitmap),
  );

  /**
   * Plain (non-observable) registry of all mounted selectables.
   * Lives outside MobX so mutations during render don't trigger reactions.
   */
  private readonly selectableRegistry = new Map<string, Selectable>();

  constructor() {
    this.history = new HistoryManager(appState);
    // In-draft hook: any time the database is mutated (direct or via a
    // long edit preview/accept) and the active sketch is still flagged
    // as a template, promote it. Lives in the same Immer transaction as
    // the user's edit so the promotion is atomic with the change.
    this.history.inDraftHook = (draft) => {
      const sel = appState.local.userSettings.selectedProjectId;
      if (sel && draft.sketches[sel]?.isTemplate) {
        draft.sketches[sel].isTemplate = false;
      }
    };
    // Post-record hook: every committed mutation (including long-edit
    // accepts and undo/redo) syncs to the engine and schedules a save.
    // Without this, slider drags (which use long edits) never fire the
    // IndexedDB save.
    this.history.postRecordHook = () => {
      this.syncSketchesToEngine();
      this.requestProjectsSave();
    };
    // Wire the trace controller to push trace points through the engine
    traceController.onFlush = (tracePoints) => this.setTracePoints(tracePoints);
  }

  setEngine(engine: EngineProxy) {
    this.engine = engine;
  }

  // ========================================================================
  // Database mutations (undo/redo-able)
  // ========================================================================

  /**
   * Generic mutation bottleneck. All sketch changes go through here. The
   * in-draft / post-record hooks installed in the constructor handle
   * isTemplate promotion, engine sync, and save scheduling — `mutate` is
   * just sugar over `history.record` now.
   */
  mutate(description: string, recipe: (draft: DatabaseState) => void) {
    this.history.record(description, recipe);
  }

  createSketch(staging: StagingInstance[]): string {
    const sketchId = `sketch_${this.nextSketchId++}`;
    const outInstances = staging.filter(s => s.textureOut);
    const inInstances = staging.filter(s => s.textureIn);

    const instances: Record<string, import('../sketch-types').InstanceState> = {};

    const columns = outInstances.map(out => {
      // Texture I/O are implicit (always wrapped around the chain by
      // the executor + the column-group widget); only the modules in
      // between go into `chain`.
      const chain: ChainEntry[] = [];
      if (inInstances.length > 0) {
        const inKey = inInstances[0].pluginKey;
        chain.push({
          type: 'module',
          module_type: inInstances[0].moduleType,
          instance_key: inKey,
        });
        instances[inKey] = { module_type: inInstances[0].moduleType, state: {} };
      }
      chain.push({
        type: 'module',
        module_type: out.moduleType,
        instance_key: out.pluginKey,
      });
      instances[out.pluginKey] = { module_type: out.moduleType, state: {} };
      return { name: shortName(out.moduleType), chain };
    });

    if (columns.length === 0) {
      columns.push({ name: 'main', chain: [] });
    }

    const anchor = outInstances[0]?.pluginKey ?? inInstances[0]?.pluginKey ?? null;
    const sketch: Sketch = { anchor, columns, instances };

    this.mutate(`Create sketch ${sketchId}`, draft => {
      draft.sketches[sketchId] = sketch;
    });

    return sketchId;
  }

  addEffectToChain(sketchId: string, colIdx: number, insertIdx: number, moduleType: string) {
    const instanceKey = `virtual_${shortName(moduleType)}@${Date.now()}`;

    const plugin = appState.local.plugins.find(p => p.id === moduleType);
    const defaultState: Record<string, any> = {};
    if (plugin) {
      for (const p of plugin.params) {
        defaultState[p.name] = p.defaultValue;
      }
    }

    this.mutate(`Add ${shortName(moduleType)}`, draft => {
      const sketch = draft.sketches[sketchId];
      if (!sketch) return;
      const column = sketch.columns[colIdx];
      if (!column) return;
      column.chain.splice(insertIdx, 0, {
        type: 'module',
        module_type: moduleType,
        instance_key: instanceKey,
      });
      // Create instance state in the sketch
      sketch.instances = sketch.instances ?? {};
      sketch.instances[instanceKey] = { module_type: moduleType, state: defaultState };
    });
  }

  /** Change the module type of an existing effect in a chain. */
  changeEffectType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    this.mutate(`Change to ${shortName(newModuleType)}`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const entry = sk.columns[colIdx]?.chain[chainIdx];
      if (!entry || entry.type !== 'module') return;
      entry.module_type = newModuleType;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) { inst.module_type = newModuleType; inst.state = {}; }
    });
    // Tell the engine worker to swap the instance directly
    this.engine?.changeInstanceType(sketchId, colIdx, chainIdx, newModuleType);
  }

  /** Recipe for changing an effect type (shared by long edit methods). */
  private changeTypeRecipe(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const entry = sk.columns[colIdx]?.chain[chainIdx];
      if (!entry || entry.type !== 'module') return;
      entry.module_type = newModuleType;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) { inst.module_type = newModuleType; inst.state = {}; }
    };
  }

  /**
   * Begin a continuous (long) edit for changing effect type.
   * Updates are previewed live without creating undo points.
   */
  beginChangeEffectType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string): LongEdit {
    const edit = this.history.beginLongEdit(
      `Change to ${shortName(newModuleType)}`,
      this.changeTypeRecipe(sketchId, colIdx, chainIdx, newModuleType),
    );
    this.engine?.changeInstanceType(sketchId, colIdx, chainIdx, newModuleType);
    return edit;
  }

  /** Update a continuous effect type change (preview only, no undo point). */
  updateChangeEffectType(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    edit.update(this.changeTypeRecipe(sketchId, colIdx, chainIdx, newModuleType));
    this.engine?.changeInstanceType(sketchId, colIdx, chainIdx, newModuleType);
  }

  removeEffectFromChain(sketchId: string, colIdx: number, chainIdx: number) {
    this.mutate('Remove effect', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const column = sk.columns[colIdx];
      if (!column) return;
      const entry = column.chain[chainIdx];
      if (entry?.type === 'module') {
        column.chain.splice(chainIdx, 1);
        // Clean up instance state
        if (sk.instances) {
          delete sk.instances[entry.instance_key];
        }
      }
    });
  }

  setEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue) {
    // Find the instance key for this chain entry
    const sketch = appState.database.sketches[sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    if (!entry || entry.type !== 'module') return;

    this.mutate(`Set param ${paramKey}`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) {
        inst.state[paramKey] = value;
      }
    });
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
  }

  /** Recipe for setting a param value (shared by continuous edit methods). */
  private setParamRecipe(sketchId: string, instanceKey: string, paramKey: string, value: ParamValue) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[instanceKey];
      if (inst) { inst.state[paramKey] = value; }
    };
  }

  /** Begin a continuous param edit (slider drag). No undo points during drag. */
  beginSetEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue): LongEdit {
    const sketch = appState.database.sketches[sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    const edit = this.history.beginLongEdit(
      `Set ${paramKey}`,
      this.setParamRecipe(sketchId, instanceKey, paramKey, value),
    );
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
    return edit;
  }

  /** Update a continuous param edit (slider drag in progress). */
  updateSetEffectParam(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue) {
    const sketch = appState.database.sketches[sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    edit.update(this.setParamRecipe(sketchId, instanceKey, paramKey, value));
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
  }

  undo() { this.history.undo(); }
  redo() { this.history.redo(); }

  // ========================================================================
  // Local state changes (ephemeral, no undo)
  // ========================================================================

  setActiveTab(tab: 'create' | 'organize' | 'edit') {
    runInAction(() => { appState.local.activeTab = tab; });
  }

  /**
   * Update one user-setting field. Goes through `runInAction` only — never
   * recorded in undo history (splitter drags etc. must not pollute the stack).
   *
   * Schedules a debounced save to IndexedDB. This is the single chokepoint
   * for user-settings mutations; other controller methods that touch
   * settings should call it rather than mutate `userSettings` directly.
   */
  setUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    runInAction(() => { appState.local.userSettings[key] = value; });
    this.requestUserSettingsSave();
    // Tab-driven engine sync: only the Debug Info tab needs the
    // worker to broadcast stats/console-logs. Toggle explicitly here
    // (per the project rule that engine sync flows from the action,
    // not a MobX reaction).
    if (key === 'ideLeftTab') {
      this.engine?.setDebugMode(value === 'debug_info');
      // Reset the UI buffer when leaving the tab so a re-open starts
      // clean instead of showing stale entries from earlier in the
      // session.
      if (value !== 'debug_info') this.clearDebugConsoleLog();
    }
  }

  /**
   * Boot-time replacement of user settings (e.g. after IndexedDB load).
   * Bypasses history — these are not undo/redo-able.
   */
  loadInitialUserSettings(settings: UserSettings) {
    runInAction(() => { appState.local.userSettings = settings; });
    // No save here — this IS the load. Persistence stays disabled until
    // boot finishes calling `enablePersistence()`.
  }

  /**
   * Boot-time merge of sketches loaded from IndexedDB into the database.
   * Bypasses history — loading is not an undo-able action. Seeds the
   * "last saved" snapshot so the next mutation doesn't redundantly save
   * the loaded state, then runs a one-shot migration to convert any
   * legacy `user:<uuid>` entries (from the prior data model) into the new
   * `default:<effectId>` form.
   */
  loadInitialSketches(sketches: Record<string, Sketch>) {
    runInAction(() => {
      for (const [id, sk] of Object.entries(sketches)) {
        // Strip any legacy explicit texture_input / texture_output
        // chain entries — they're implicit in the current model and
        // would crash downstream iteration if left in.
        const normalized = normalizeSketchChains(sk);
        appState.database.sketches[id] = normalized;
        if (isPersistableProjectId(id) && !normalized.isTemplate) {
          this.projectsLastSavedJson.set(id, JSON.stringify(normalized));
        }
      }
    });
    this.migrateLegacyUserProjects();
    this.syncSketchesToEngine();
  }

  /**
   * Called by `boot()` once initial-load is complete. After this, mutations
   * actually fire IndexedDB saves; before, they're suppressed so loading
   * doesn't echo straight back to disk.
   *
   * We always schedule both saves: the migration in `loadInitialSketches`
   * may have changed in-memory state (renamed user: → default:, dropped
   * stale templates) that needs to be flushed.
   */
  enablePersistence() {
    this.persistenceEnabled = true;
    this.requestUserSettingsSave();
    this.requestProjectsSave();
    void this.inputManager.setActiveSketch(appState.local.userSettings.selectedProjectId);
  }

  /**
   * One-shot migration from the previous "materialized template" model:
   *   - `user:<uuid>` with `isTemplate: true` → drop (legacy stub).
   *   - `user:<uuid>` (edited) → rename to `default:<effectId>` derived
   *     from its first module entry, so re-clicking the default brings
   *     back the user's edits exactly like a brand-new save would.
   *
   * If the new id is already in use, the legacy entry is left in place;
   * the user can clean it up via the User Projects list.
   */
  private migrateLegacyUserProjects() {
    runInAction(() => {
      const userIds = Object.keys(appState.database.sketches)
        .filter(id => isUserProjectId(id));
      for (const id of userIds) {
        const sk = appState.database.sketches[id];
        if (!sk) continue;
        if (sk.isTemplate) {
          delete appState.database.sketches[id];
          if (appState.local.userSettings.selectedProjectId === id) {
            appState.local.userSettings.selectedProjectId = null;
          }
          continue;
        }
        const moduleEntry = sk.columns?.[0]?.chain?.find(e => e.type === 'module');
        if (moduleEntry?.type !== 'module') continue;
        const newId = defaultProjectIdForEffect(moduleEntry.module_type);
        if (appState.database.sketches[newId]) continue;
        appState.database.sketches[newId] = sk;
        delete appState.database.sketches[id];
        if (appState.local.userSettings.selectedProjectId === id) {
          appState.local.userSettings.selectedProjectId = newId;
        }
      }
    });
  }

  // ---- Debounced save scheduling (called explicitly, not via reactions) ----

  private requestUserSettingsSave(debounceMs = 300) {
    if (!this.persistenceEnabled) return;
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null;
      saveUserSettings(toJS(appState.local.userSettings)).catch(err => {
        console.warn('[user-settings] save failed', err);
      });
    }, debounceMs);
  }

  private requestProjectsSave(debounceMs = 300) {
    if (!this.persistenceEnabled) return;
    if (this.projectsSaveTimer) clearTimeout(this.projectsSaveTimer);
    this.projectsSaveTimer = setTimeout(() => {
      this.projectsSaveTimer = null;
      this.flushProjectsSave().catch(err => {
        console.warn('[project-store] flush failed', err);
      });
    }, debounceMs);
  }

  private async flushProjectsSave() {
    const sketches = appState.database.sketches;
    // Save anything keyed `default:` or `user:`, except still-pristine
    // (`isTemplate: true`) sketches — those are virtual entries from a
    // browse-only click. The first edit clears `isTemplate` (see
    // `mutate`), at which point the project becomes persistable.
    const liveIds = new Set<string>();
    for (const id of Object.keys(sketches)) {
      if (!isPersistableProjectId(id)) continue;
      if (sketches[id]?.isTemplate) continue;
      liveIds.add(id);
    }
    for (const id of liveIds) {
      const json = JSON.stringify(toJS(sketches[id]));
      if (this.projectsLastSavedJson.get(id) === json) continue;
      try {
        await saveProject(id, sketches[id]);
        this.projectsLastSavedJson.set(id, json);
      } catch (err) {
        console.warn('[project-store] save failed', id, err);
      }
    }
    for (const id of Array.from(this.projectsLastSavedJson.keys())) {
      if (!liveIds.has(id)) {
        try {
          await idbDeleteProject(id);
          this.projectsLastSavedJson.delete(id);
        } catch (err) {
          console.warn('[project-store] delete failed', id, err);
        }
      }
    }
  }

  /** Store discovered effects from a loaded WASM module. */
  setAvailableEffects(effects: EffectInfo[]) {
    runInAction(() => {
      const existing = appState.local.availableEffects;
      for (const e of effects) {
        if (!existing.some(x => x.id === e.id)) {
          existing.push({ id: e.id, name: e.name, description: e.description, category: e.category, keywords: e.keywords });
        }
      }
    });
    // If a default project was selected before its effect was discovered
    // (typical at boot — settings load completes before WASM does), retry
    // materialization now that the effect list has grown. selectProject
    // also re-runs `syncSketchesToEngine`, flushing any sketches that
    // were waiting for effects to land.
    const sel = appState.local.userSettings.selectedProjectId;
    if (sel && isDefaultProjectId(sel)) {
      this.selectProject(sel);
      return;
    }
    // Otherwise (selection is a `user:` id, or null), still flush — the
    // sketches loaded from IndexedDB at boot have been waiting for the
    // first effects to arrive before we'd push them to the engine.
    this.syncSketchesToEngine();
  }

  /**
   * Select a project for the IDE.
   *
   * Default projects use stable `default:<effectId>` ids. If the entry
   * doesn't exist in `database.sketches` yet (first time this default is
   * being opened in this session), it's synthesized fresh and inserted
   * with `isTemplate: true`. The first real edit clears `isTemplate` (see
   * `mutate`) which makes the autosave start persisting it. Re-selecting
   * the same default later — including across reloads — picks up exactly
   * the user's saved edits because the id is stable.
   */
  selectProject(id: string | null) {
    if (!id) {
      this.setUserSetting('selectedProjectId', null);
      this.syncSketchesToEngine();
      void this.inputManager.setActiveSketch(null);
      return;
    }
    if (isDefaultProjectId(id) && !appState.database.sketches[id]) {
      const effectId = effectIdFromDefaultProjectId(id);
      const sketch = synthesizeDefaultProject(effectId, appState.local.availableEffects);
      if (!sketch) {
        // Effects haven't been discovered yet — store the selection so
        // `setAvailableEffects` can retry once the bundle loads.
        this.setUserSetting('selectedProjectId', id);
        return;
      }
      runInAction(() => {
        appState.database.sketches[id] = { ...sketch, isTemplate: true };
      });
    }
    this.setUserSetting('selectedProjectId', id);
    this.syncSketchesToEngine();
    // Save is a no-op for still-pristine sketches; first edit promotes
    // them and triggers a real save.
    this.requestProjectsSave();
    void this.inputManager.setActiveSketch(id);
  }

  /**
   * Delete a saved project (default or user). Goes through history so
   * undo restores the sketch; the autosave picks up the deletion on the
   * next debounce. Templates aren't typically deleted this way (they're
   * not user-visible) but the function tolerates them.
   */
  deleteProject(id: string) {
    if (!isPersistableProjectId(id)) return;
    this.mutate(`Delete project`, draft => {
      delete draft.sketches[id];
    });
    void this.inputManager.clear(id);
    if (appState.local.userSettings.selectedProjectId === id) {
      this.setUserSetting('selectedProjectId', null);
      this.syncSketchesToEngine();
      void this.inputManager.setActiveSketch(null);
    }
  }

  /** Sync state from the engine worker. Updates plugins and adopts new remote sketches. */
  syncFromRemoteState(engineState: EngineState) {
    // Snapshot the previous plugin set so we can detect "we just learned
    // a schema we didn't have before" and re-sync any sketch that was
    // pushed to the engine without that knowledge.
    //
    // Why this matters: setAvailableEffects fires from the worker's
    // `effectsDiscovered` post (synchronous on bundle-load completion),
    // and that's when sketches first get pushed to the engine. But
    // PLUGIN SCHEMAS (which are what augmentSketchWithImplicitConnections
    // needs to wire up implicit struct-rail connections) arrive a frame
    // later via this `state` broadcast. Without a re-sync here, the
    // engine ends up holding an un-augmented sketch — every motion-vector
    // consumer like video.motion_blur sits in pass-through fallback
    // until something else triggers a sync (param release does, because
    // its postRecordHook calls syncSketchesToEngine). Symptom on a fresh
    // page reload: nothing renders until you release a slider.
    const oldPluginIds = new Set(appState.local.plugins.map(p => p.id));
    const newPluginIds = new Set(engineState.plugins.map(p => p.id));
    let pluginsChanged = oldPluginIds.size !== newPluginIds.size;
    if (!pluginsChanged) {
      for (const id of newPluginIds) {
        if (!oldPluginIds.has(id)) { pluginsChanged = true; break; }
      }
    }

    runInAction(() => { appState.local.plugins = engineState.plugins; });

    for (const [id, sketch] of Object.entries(engineState.sketches)) {
      if (!(id in appState.database.sketches)) {
        this.mutate(`Remote sketch ${id}`, draft => {
          draft.sketches[id] = sketch;
        });
      } else {
        const local = JSON.stringify(appState.database.sketches[id]);
        const remote = JSON.stringify(sketch);
        if (local !== remote) {
          console.warn(`[conflict] Sketch ${id} differs between local and remote. Local wins for now.`);
        }
      }
    }

    if (pluginsChanged) {
      // Re-push sketches now that we have schemas to drive implicit
      // connection wiring. Idempotent on the engine side — it just
      // overwrites its sketches map — but the augmented form will
      // differ from whatever was pushed before plugins arrived.
      this.syncSketchesToEngine();
    }
  }

  addToStaging(plugin: PluginInfo) {
    runInAction(() => {
      if (appState.local.staging.some(s => s.pluginKey === plugin.key)) return;
      appState.local.staging.push({
        pluginKey: plugin.key,
        moduleType: plugin.id,
        name: shortName(plugin.id),
        textureIn: false,
        textureOut: true,
      });
    });
  }

  removeFromStaging(idx: number) {
    runInAction(() => { appState.local.staging.splice(idx, 1); });
  }

  toggleStagingIn(idx: number) {
    runInAction(() => {
      appState.local.staging[idx].textureIn = !appState.local.staging[idx].textureIn;
    });
  }

  toggleStagingOut(idx: number) {
    runInAction(() => {
      appState.local.staging[idx].textureOut = !appState.local.staging[idx].textureOut;
    });
  }

  clearStaging() {
    runInAction(() => { appState.local.staging = []; });
  }

  // --- Tapping mode & field selection ---

  setTappingMode(on: boolean) {
    runInAction(() => {
      appState.local.tappingMode = on;
      if (!on) appState.local.selectedFieldPath = null;
    });
  }

  selectField(path: string | null) {
    runInAction(() => { appState.local.selectedFieldPath = path; });
  }

  // --- Selection / Inspector ---

  /**
   * Register a selectable element. If this path was queued for selection
   * (user clicked before the component rendered), the selection activates.
   * Call this from component render/updated methods.
   */
  defineSelectable(selectable: Selectable) {
    // Plain Map — not observable, safe to mutate during render.
    this.selectableRegistry.set(selectable.path, selectable);

    // Promote queued selection (fires once, not every render).
    if (appState.local.queuedSelectionPath === selectable.path) {
      runInAction(() => {
        appState.local.selection = selectable;
        appState.local.queuedSelectionPath = null;
      });
    }
  }

  /** Unregister a selectable (component disconnected). */
  undefineSelectable(path: string) {
    this.selectableRegistry.delete(path);
  }

  /** Select a path. If the selectable is registered, activates immediately. Otherwise queues. */
  select(path: string | null) {
    runInAction(() => {
      if (path === null) {
        appState.local.selection = null;
        appState.local.queuedSelectionPath = null;
        return;
      }
      const selectable = this.selectableRegistry.get(path);
      if (selectable) {
        appState.local.selection = selectable;
        appState.local.queuedSelectionPath = null;
      } else {
        appState.local.queuedSelectionPath = path;
        appState.local.selection = null;
      }
    });
  }

  /** Look up a selectable by path (for reading fresh renderInspectorContent). */
  getSelectable(path: string): Selectable | undefined {
    return this.selectableRegistry.get(path);
  }

  /** Check if a path is currently selected. */
  isSelected(path: string): boolean {
    return appState.local.selection?.path === path;
  }

  // --- Rail CRUD ---

  private nextRailId = 0;

  addRail(sketchId: string, scope: 'sketch' | number, name: string, dataType: import('../sketch-types').RailDataType): string {
    const railId = `rail_${this.nextRailId++}`;
    this.mutate(`Add rail ${name}`, draft => {
      const sketch = draft.sketches[sketchId];
      if (!sketch) return;
      const rail = { id: railId, name, dataType };
      if (scope === 'sketch') {
        sketch.rails = sketch.rails ?? [];
        sketch.rails.push(rail);
      } else {
        const col = sketch.columns[scope];
        if (!col) return;
        col.rails = col.rails ?? [];
        col.rails.push(rail);
      }
    });
    return railId;
  }

  removeRail(sketchId: string, scope: 'sketch' | number, railId: string) {
    this.mutate(`Remove rail`, draft => {
      const sketch = draft.sketches[sketchId];
      if (!sketch) return;
      // Remove the rail definition
      if (scope === 'sketch') {
        sketch.rails = (sketch.rails ?? []).filter(r => r.id !== railId);
      } else {
        const col = sketch.columns[scope];
        if (col) col.rails = (col.rails ?? []).filter(r => r.id !== railId);
      }
      // Remove all taps referencing this rail from all modules
      for (const col of sketch.columns) {
        for (const entry of col.chain) {
          if (entry.type === 'module' && entry.taps) {
            entry.taps = entry.taps.filter(t => t.railId !== railId);
          }
        }
      }
    });
  }

  // --- Tap CRUD ---

  addTap(sketchId: string, colIdx: number, chainIdx: number, railId: string, fieldPath: string, direction: 'read' | 'write') {
    this.mutate(`Add tap`, draft => {
      const entry = draft.sketches[sketchId]?.columns[colIdx]?.chain[chainIdx];
      if (entry?.type === 'module') {
        entry.taps = entry.taps ?? [];
        entry.taps.push({ railId, fieldPath, direction });
      }
    });
  }

  removeTap(sketchId: string, colIdx: number, chainIdx: number, tapIndex: number) {
    this.mutate(`Remove tap`, draft => {
      const entry = draft.sketches[sketchId]?.columns[colIdx]?.chain[chainIdx];
      if (entry?.type === 'module' && entry.taps) {
        entry.taps.splice(tapIndex, 1);
      }
    });
  }

  setTapDirection(sketchId: string, colIdx: number, chainIdx: number, tapIndex: number, direction: 'read' | 'write') {
    this.mutate(`Set tap direction`, draft => {
      const entry = draft.sketches[sketchId]?.columns[colIdx]?.chain[chainIdx];
      if (entry?.type === 'module' && entry.taps?.[tapIndex]) {
        entry.taps[tapIndex].direction = direction;
      }
    });
  }

  // --- Auto-tap helpers ---

  /**
   * Auto-create a read tap for an input field.
   * Finds the last rail with matching data type and connects to it.
   */
  autoCreateTapForInput(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string, dataType: 'float' | 'texture') {
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;

    const allRails = this.collectRails(sketch, colIdx);
    // Find the last rail with matching data type (reverse search)
    let matchingRail: import('../sketch-types').Rail | undefined;
    for (let i = allRails.length - 1; i >= 0; i--) {
      if (allRails[i].dataType === dataType) { matchingRail = allRails[i]; break; }
    }
    // If no matching rail, create one first
    if (!matchingRail) {
      const existingCount = (sketch.columns[colIdx]?.rails?.length ?? 0) + (sketch.rails?.length ?? 0);
      const name = `Rail ${existingCount + 1}`;
      const railId = this.addRail(sketchId, colIdx, name, dataType);
      this.addTap(sketchId, colIdx, chainIdx, railId, fieldPath, 'read');
      return;
    }

    // Check if tap already exists
    const entry = sketch.columns[colIdx]?.chain[chainIdx];
    if (entry?.type === 'module') {
      const existingRailId = matchingRail.id;
      const existing = (entry.taps ?? []).find(t => t.fieldPath === fieldPath && t.railId === existingRailId);
      if (!existing) {
        this.addTap(sketchId, colIdx, chainIdx, existingRailId, fieldPath, 'read');
      }
    }
  }

  /**
   * Auto-create a write tap for an output field.
   * Creates a new rail and connects the output to it.
   */
  autoCreateTapForOutput(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string, dataType: 'float' | 'texture') {
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;

    // Check if tap already exists for this field
    const entry = sketch.columns[colIdx]?.chain[chainIdx];
    if (entry?.type === 'module') {
      const existing = (entry.taps ?? []).find(t => t.fieldPath === fieldPath && t.direction === 'write');
      if (existing) return; // Already has a write tap
    }

    const existingCount = (sketch.columns[colIdx]?.rails?.length ?? 0) + (sketch.rails?.length ?? 0);
    const name = `Rail ${existingCount + 1}`;
    const railId = this.addRail(sketchId, colIdx, name, dataType);
    this.addTap(sketchId, colIdx, chainIdx, railId, fieldPath, 'write');
  }

  private collectRails(sketch: Sketch, colIdx: number): import('../sketch-types').Rail[] {
    const rails: import('../sketch-types').Rail[] = [];
    if (sketch.rails) rails.push(...sketch.rails);
    const col = sketch.columns[colIdx];
    if (col?.rails) rails.push(...col.rails);
    return rails;
  }

  // --- Drag-to-connect ---

  /**
   * Connect two fields by creating/reusing a rail and wiring taps. Rules:
   *   - If exactly one field is an output, it's the writer and the other is the reader.
   *   - If both are the same direction, the upper (smaller Y) is the writer.
   *   - Writer ensures it has a write tap (reuses existing rail if any, else creates one).
   *   - Reader's read tap on this fieldPath is OVERWRITTEN to point at the writer's rail.
   * Cross-sketch or self connections are ignored.
   */
  connectFields(a: FieldConnectInfo, b: FieldConnectInfo) {
    if (a.sketchId !== b.sketchId) return;
    if (a.colIdx === b.colIdx && a.chainIdx === b.chainIdx && a.fieldPath === b.fieldPath) return;

    let writer: FieldConnectInfo;
    let reader: FieldConnectInfo;
    if (a.isOutput !== b.isOutput) {
      writer = a.isOutput ? a : b;
      reader = a.isOutput ? b : a;
    } else {
      writer = a.viewportY <= b.viewportY ? a : b;
      reader = a.viewportY <= b.viewportY ? b : a;
    }

    const sketchId = writer.sketchId;
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;

    const writerEntry = sketch.columns[writer.colIdx]?.chain[writer.chainIdx];
    const readerEntry = sketch.columns[reader.colIdx]?.chain[reader.chainIdx];
    if (writerEntry?.type !== 'module' || readerEntry?.type !== 'module') return;

    const existingWriteRail = (writerEntry.taps ?? []).find(
      t => t.fieldPath === writer.fieldPath && t.direction === 'write'
    )?.railId;

    // Plan a new rail id/type if we'll need one.
    let newRailInfo: { id: string; name: string; dataType: import('../sketch-types').RailDataType; scope: 'sketch' | number } | null = null;
    if (!existingWriteRail) {
      const id = `rail_${this.nextRailId++}`;
      const name = `Rail ${(sketch.columns[writer.colIdx]?.rails?.length ?? 0) + (sketch.rails?.length ?? 0) + 1}`;
      const dataType = railDataTypeFromSchema(writer.schemaDef);
      // If writer & reader are in different columns, put the rail at
      // sketch scope so both columns can see it; otherwise column-local.
      const scope: 'sketch' | number = (writer.colIdx !== reader.colIdx) ? 'sketch' : writer.colIdx;
      newRailInfo = { id, name, dataType, scope };
    }

    const railId = existingWriteRail ?? newRailInfo!.id;

    this.mutate('Connect fields', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;

      if (newRailInfo) {
        const rail = { id: newRailInfo.id, name: newRailInfo.name, dataType: newRailInfo.dataType };
        if (newRailInfo.scope === 'sketch') {
          sk.rails = sk.rails ?? [];
          sk.rails.push(rail);
        } else {
          const col = sk.columns[newRailInfo.scope];
          if (col) {
            col.rails = col.rails ?? [];
            col.rails.push(rail);
          }
        }
      }

      // Writer: ensure a write tap for this field/rail.
      const w = sk.columns[writer.colIdx]?.chain[writer.chainIdx];
      if (w?.type === 'module') {
        w.taps = w.taps ?? [];
        const has = w.taps.some(t =>
          t.fieldPath === writer.fieldPath && t.direction === 'write' && t.railId === railId);
        if (!has) {
          w.taps.push({ railId, fieldPath: writer.fieldPath, direction: 'write' });
        }
      }

      // Reader: overwrite any existing read tap for this fieldPath.
      const r = sk.columns[reader.colIdx]?.chain[reader.chainIdx];
      if (r?.type === 'module') {
        r.taps = r.taps ?? [];
        r.taps = r.taps.filter(t => !(t.fieldPath === reader.fieldPath && t.direction === 'read'));
        r.taps.push({ railId, fieldPath: reader.fieldPath, direction: 'read' });
      }
    });
  }

  // --- Schema-aware auto-tap helpers ---

  /**
   * Create a write tap for an output field. Picks the rail data type from
   * the schema def when available (struct/gpu/vec → struct rail carrying
   * the output's schema; texture → texture rail; otherwise float).
   */
  autoCreateTapForOutputField(
    sketchId: string,
    colIdx: number,
    chainIdx: number,
    fieldPath: string,
    schemaDef: any | null,
  ) {
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;
    const entry = sketch.columns[colIdx]?.chain[chainIdx];
    if (entry?.type !== 'module') return;
    if ((entry.taps ?? []).some(t => t.fieldPath === fieldPath && t.direction === 'write')) {
      return; // already has a write tap
    }
    const dataType = railDataTypeFromSchema(schemaDef);
    const existingCount = (sketch.columns[colIdx]?.rails?.length ?? 0) + (sketch.rails?.length ?? 0);
    const name = `Rail ${existingCount + 1}`;
    const railId = this.addRail(sketchId, colIdx, name, dataType);
    this.addTap(sketchId, colIdx, chainIdx, railId, fieldPath, 'write');
  }

  /**
   * Create a read tap for an input field. Picks rail type from the schema.
   * Falls back to the legacy matching-rail behaviour for scalar/texture.
   */
  autoCreateTapForInputField(
    sketchId: string,
    colIdx: number,
    chainIdx: number,
    fieldPath: string,
    schemaDef: any | null,
  ) {
    const dataType = railDataTypeFromSchema(schemaDef);
    if (dataType === 'float' || dataType === 'texture') {
      this.autoCreateTapForInput(sketchId, colIdx, chainIdx, fieldPath, dataType);
      return;
    }
    // Structured input: try to find an existing struct rail whose schema is
    // compatible with this input; otherwise create a fresh rail of matching
    // type and wire a read tap (no producer yet — user or auto-connect will
    // fill that in later).
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;
    const entry = sketch.columns[colIdx]?.chain[chainIdx];
    if (entry?.type !== 'module') return;
    if ((entry.taps ?? []).some(t => t.fieldPath === fieldPath && t.direction === 'read')) return;

    const allRails = this.collectRails(sketch, colIdx);
    const match = allRails.find(r => typeof r.dataType !== 'string'
      && isRailCompatible((r.dataType as any).schema, schemaDef));
    if (match) {
      this.addTap(sketchId, colIdx, chainIdx, match.id, fieldPath, 'read');
      return;
    }
    const existingCount = (sketch.columns[colIdx]?.rails?.length ?? 0) + (sketch.rails?.length ?? 0);
    const name = `Rail ${existingCount + 1}`;
    const railId = this.addRail(sketchId, colIdx, name, dataType);
    this.addTap(sketchId, colIdx, chainIdx, railId, fieldPath, 'read');
  }

  selectSketch(id: string | null) {
    runInAction(() => { appState.local.selectedSketchId = id; });
  }

  setBarrelMode(on: boolean) {
    runInAction(() => {
      appState.local.barrelMode = on;
      if (on) appState.local.activeTab = 'edit';
    });
  }

  /**
   * Direct write into the sketches database without going through
   * `mutate()`. Used by the barrel sync to mirror remote state — no
   * undo entry, no IndexedDB persistence (the remote bridge owns it).
   * `sketch` is intentionally loose-typed (any) because the remote
   * blob may not yet conform to the Sketch shape during early bring-up.
   */
  setBarrelSketch(id: string, sketch: any) {
    runInAction(() => {
      appState.database.sketches[id] = sketch;
    });
  }

  editSketch(id: string | null) {
    runInAction(() => { appState.local.editingSketchId = id; });
    // Register/unregister the edit preview trace point via the trace controller
    if (id) {
      traceController.register({
        id: 'edit_preview',
        target: { type: 'sketch_output', sketchId: id },
        resolution: 'high',
      });
    } else {
      traceController.unregister('edit_preview');
    }
  }

  setEngineFps(fps: number) {
    runInAction(() => { appState.local.engine.fps = fps; });
  }

  setEngineError(error: string | null) {
    runInAction(() => { appState.local.engine.error = error; });
  }

  setSketchState(sketchState: Record<string, any>) {
    runInAction(() => {
      appState.local.engine.sketchState = sketchState;
    });
  }

  setPluginStates(pluginStates: Record<string, any>) {
    runInAction(() => {
      appState.local.engine.pluginStates = pluginStates;
    });
  }

  setTracedFrames(frames: Record<string, ImageBitmap>) {
    runInAction(() => {
      // Close old bitmaps
      for (const old of Object.values(appState.local.engine.tracedFrames)) {
        old?.close();
      }
      appState.local.engine.tracedFrames = frames;
      appState.local.engine.frameGeneration++;
    });
  }

  setDebugStats(stats: import('../engine-types').DebugStats) {
    runInAction(() => { appState.local.engine.debugStats = stats; });
  }

  /**
   * Append a frame's worth of console-log entries from the worker
   * and trim to the UI-side cap. Capped here independently of the
   * worker buffer so an off-tab session that re-enables debug mode
   * doesn't get a wall of stale entries.
   */
  appendDebugConsoleLog(entries: import('../engine-types').DebugConsoleEntry[]) {
    if (entries.length === 0) return;
    runInAction(() => {
      const buf = appState.local.engine.debugConsoleLog;
      const merged = buf.concat(entries);
      const CAP = 500;
      appState.local.engine.debugConsoleLog =
        merged.length > CAP ? merged.slice(merged.length - CAP) : merged;
    });
  }

  clearDebugConsoleLog() {
    runInAction(() => { appState.local.engine.debugConsoleLog = []; });
  }

  // ========================================================================
  // Engine sync
  // ========================================================================

  /**
   * Load a WASM module and discover its available effects.
   * Does NOT create any instances — call instantiateEffect() for that.
   */
  loadModule(moduleType: string) {
    this.engine?.loadModule(moduleType);
  }

  /**
   * Instantiate a specific effect into the unassigned bucket sketch.
   * The effect's WASM module must already be loaded via loadModule().
   */
  instantiateEffect(effectId: string) {
    this.engine?.instantiateEffect(effectId);
  }

  setTracePoints(tracePoints: TracePoint[]) {
    this.engine?.setTracePoints(tracePoints);
  }

  /** Pause/resume the engine. Stored in user settings so it persists. */
  setPaused(paused: boolean) {
    this.setUserSetting('paused', paused);
    this.engine?.setPaused(paused);
  }

  /** Reset elapsed time and force a redraw. */
  restartEngine() {
    this.engine?.restart();
  }

  /** Inject a frame source for a sketch's `texture_input`. Pass null to clear. */
  setSketchInput(sketchId: string, bitmap: ImageBitmap | null) {
    this.engine?.setSketchInput(sketchId, bitmap);
  }

  /**
   * Texture-drop-zone calls this on a fresh drop. Persists the file to
   * IndexedDB and starts the appropriate frame source for the active
   * sketch (one-shot for images, continuous pump for videos).
   */
  handleSketchInputDrop(sketchId: string, file: File): Promise<void> {
    return this.inputManager.handleDrop(sketchId, file);
  }

  /**
   * Trigger a WASM module reload (from the dev-time HMR plugin). The worker
   * waits for the in-flight frame to complete, then re-fetches and
   * re-instantiates affected effects.
   */
  reloadWasm(wasmUrl: string) {
    this.engine?.reloadWasm(wasmUrl);
  }

  private syncSketchesToEngine() {
    if (!this.engine) return;
    // Don't push sketches until at least one effect bundle has registered.
    // Boot ordering: settings + projects load before `loadModule` even
    // starts; pushing a sketch with `module_type: "generator.solid_color"`
    // before the WASM module is loaded would cause the engine to error
    // every frame trying to render it. Once `setAvailableEffects` fires,
    // it calls back into here to flush any waiting sketches.
    if (appState.local.availableEffects.length === 0) return;

    const plugins = appState.local.plugins;
    const nowSynced = new Set<string>();
    for (const [id, sketch] of Object.entries(appState.database.sketches)) {
      if (this.engineSketchFilter && !this.engineSketchFilter(id)) continue;
      nowSynced.add(id);
      const augmented = augmentSketchWithImplicitConnections(toJS(sketch), plugins);
      this.engine.updateSketch(id, augmented);
    }
    // Anything previously synced but no longer eligible (deleted or filtered
    // out) — tell the engine to drop it so it stops trying to render.
    for (const id of this.engineSyncedSketchIds) {
      if (!nowSynced.has(id)) {
        this.engine.deleteSketch(id);
      }
    }
    this.engineSyncedSketchIds = nowSynced;
  }

  /**
   * Install (or clear) the engine sketch filter. Calling this triggers an
   * immediate re-sync so newly-eligible sketches get pushed and
   * newly-ineligible ones get deleted.
   *
   * The IDE entry uses this to keep the engine focused on the active project.
   */
  setEngineSketchFilter(filter: ((sketchId: string) => boolean) | null) {
    this.engineSketchFilter = filter;
    this.syncSketchesToEngine();
  }
}

/**
 * Produce a copy of `sketch` with implicit struct/gpu/vec auto-connections
 * added, without touching the caller's sketch. Scans each column for
 * structured inputs lacking a read tap and, for each, finds an earlier
 * module with a compatible structured output. If such a producer exists,
 * a synthesized rail (deterministic ID so repeated syncs stay stable) +
 * write tap + read tap are inserted into the returned sketch. The input
 * sketch is left unmodified, and these synthetic entries never land in
 * the user's schema or the UI.
 */
export function augmentSketchWithImplicitConnections(
  sketch: Sketch,
  plugins: PluginInfo[],
): Sketch {
  // Deep clone so we can mutate freely without touching MobX-proxy state.
  const clone: Sketch = JSON.parse(JSON.stringify(sketch));

  for (let colIdx = 0; colIdx < clone.columns.length; colIdx++) {
    augmentColumn(clone, colIdx, plugins);
  }
  return clone;
}

function augmentColumn(sketch: Sketch, colIdx: number, plugins: PluginInfo[]) {
  const column = sketch.columns[colIdx];
  if (!column) return;

  // Deterministic implicit rail ID, so repeated syncs for the same
  // producer emit the same rail. The key uniquely identifies "this
  // producer's output feeds a compatible struct rail in this column".
  const implicitRailId = (producerChainIdx: number, producerFieldPath: string) =>
    `__implicit__/${colIdx}/${producerChainIdx}/${producerFieldPath}`;

  const allRails = [
    ...(column.rails ?? []),
    ...(sketch.rails ?? []),
  ];

  // Existing explicit write taps in this column — consumers can reuse
  // whatever rail a producer is already writing to.
  const writeTapByProducer = new Map<string, { railId: string; dataType: import('../sketch-types').RailDataType }>();
  for (let i = 0; i < column.chain.length; i++) {
    const e = column.chain[i];
    if (e.type !== 'module') continue;
    for (const t of e.taps ?? []) {
      if (t.direction !== 'write') continue;
      const rail = allRails.find(r => r.id === t.railId);
      if (!rail) continue;
      writeTapByProducer.set(`${i}/${t.fieldPath}`, { railId: rail.id, dataType: rail.dataType });
    }
  }

  for (let i = 0; i < column.chain.length; i++) {
    const entry = column.chain[i];
    if (entry.type !== 'module') continue;
    const plugin = plugins.find(p => p.id === entry.module_type);
    const schema = plugin?.schema;
    if (!schema) continue;

    for (const [fieldName, def] of Object.entries(schema)) {
      const d: any = def;
      const io = d?.io ?? 0;
      if (!(io & 1)) continue;
      if (!isStructuredSchemaTypeDef(d)) continue;

      // User explicitly wired this input already? Leave it alone.
      const hasRead = (entry.taps ?? []).some(
        t => t.fieldPath === fieldName && t.direction === 'read');
      if (hasRead) continue;

      // Find the nearest earlier module with a compatible structured output.
      let producerChainIdx = -1;
      let producerFieldPath = '';
      let producerSchema: any = null;
      outer: for (let j = i - 1; j >= 0; j--) {
        const pe = column.chain[j];
        if (pe.type !== 'module') continue;
        const pplug = plugins.find(p => p.id === pe.module_type);
        const pschema = pplug?.schema ?? {};
        for (const [pname, pdef] of Object.entries(pschema)) {
          const pd: any = pdef;
          if (!((pd?.io ?? 0) & 2)) continue;
          if (!isStructuredSchemaTypeDef(pd)) continue;
          if (!isRailCompatible(pd, d)) continue;
          producerChainIdx = j;
          producerFieldPath = pname;
          producerSchema = pd;
          break outer;
        }
      }
      if (producerChainIdx < 0) continue;

      // Prefer an existing explicit write tap (user-authored) on the
      // producer — reuse its rail so behaviour stays consistent with
      // manual routing. Otherwise synthesize a deterministic implicit
      // rail and write tap pair.
      const producerKey = `${producerChainIdx}/${producerFieldPath}`;
      let produced = writeTapByProducer.get(producerKey);
      if (!produced) {
        const railId = implicitRailId(producerChainIdx, producerFieldPath);
        // Deep-clone the schema: producerSchema points into the MobX-proxied
        // plugins list, and structured-clone (postMessage) chokes on proxies.
        const dataType: import('../sketch-types').RailDataType = {
          kind: 'struct',
          schema: JSON.parse(JSON.stringify(producerSchema)),
        };
        column.rails = column.rails ?? [];
        column.rails.push({ id: railId, name: railId, dataType });
        const producerEntry = column.chain[producerChainIdx];
        if (producerEntry.type === 'module') {
          producerEntry.taps = producerEntry.taps ?? [];
          producerEntry.taps.push({ railId, fieldPath: producerFieldPath, direction: 'write' });
        }
        produced = { railId, dataType };
        writeTapByProducer.set(producerKey, produced);
      }

      // Sanity: if the producer's existing rail isn't structurally
      // compatible anymore (e.g. user reused it for something else),
      // skip this consumer rather than create a broken tap.
      if (typeof produced.dataType === 'string') continue;
      if (!isRailCompatible((produced.dataType as any).schema, d)) continue;

      entry.taps = entry.taps ?? [];
      entry.taps.push({ railId: produced.railId, fieldPath: fieldName, direction: 'read' });
    }
  }
}

function shortName(moduleId: string): string {
  return moduleId.split('.').pop() ?? moduleId;
}

export const appController = new AppController();
