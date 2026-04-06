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
import { HistoryManager } from './history';
import type { DatabaseState, StagingInstance, PluginInfo } from './types';
import type { EngineProxy } from '../engine-proxy';
import type { EngineState, TracePoint } from '../engine-types';
import type { Sketch, ChainEntry } from '../sketch-types';

export class AppController {
  public readonly history: HistoryManager;
  private engine: EngineProxy | null = null;
  private nextSketchId = 0;

  constructor() {
    this.history = new HistoryManager(appState);
  }

  setEngine(engine: EngineProxy) {
    this.engine = engine;
  }

  // ========================================================================
  // Database mutations (undo/redo-able)
  // ========================================================================

  /** Generic mutation bottleneck. All sketch changes go through here. */
  mutate(description: string, recipe: (draft: DatabaseState) => void) {
    this.history.record(description, recipe);
    this.syncSketchesToEngine();
  }

  createSketch(staging: StagingInstance[]): string {
    const sketchId = `sketch_${this.nextSketchId++}`;
    const outInstances = staging.filter(s => s.textureOut);
    const inInstances = staging.filter(s => s.textureIn);

    const columns = outInstances.map(out => {
      const chain: ChainEntry[] = [
        { type: 'texture_input', id: 'primary_in' },
      ];
      if (inInstances.length > 0) {
        chain.push({
          type: 'module',
          module_type: inInstances[0].moduleType,
          instance_key: inInstances[0].pluginKey,
          params: {},
        });
      }
      chain.push({
        type: 'module',
        module_type: out.moduleType,
        instance_key: out.pluginKey,
        params: {},
      });
      chain.push({ type: 'texture_output', id: 'primary_out' });
      return { name: shortName(out.moduleType), chain };
    });

    if (columns.length === 0) {
      columns.push({
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'primary_in' },
          { type: 'texture_output', id: 'primary_out' },
        ],
      });
    }

    const anchor = outInstances[0]?.pluginKey ?? inInstances[0]?.pluginKey ?? null;
    const sketch: Sketch = { anchor, columns };

    this.mutate(`Create sketch ${sketchId}`, draft => {
      draft.sketches[sketchId] = sketch;
    });

    return sketchId;
  }

  addEffectToChain(sketchId: string, colIdx: number, insertIdx: number, moduleType: string) {
    const instanceKey = `virtual_${shortName(moduleType)}@${Date.now()}`;

    const plugin = appState.local.plugins.find(p => p.id === moduleType);
    const defaultParams: Record<string, number> = {};
    if (plugin) {
      for (const p of plugin.params) {
        // Use field name as key (matches schema field paths)
        defaultParams[p.name] = p.defaultValue;
      }
    }

    this.mutate(`Add ${shortName(moduleType)}`, draft => {
      const column = draft.sketches[sketchId]?.columns[colIdx];
      if (!column) return;
      column.chain.splice(insertIdx, 0, {
        type: 'module',
        module_type: moduleType,
        instance_key: instanceKey,
        params: defaultParams,
      });
    });
  }

  removeEffectFromChain(sketchId: string, colIdx: number, chainIdx: number) {
    this.mutate('Remove effect', draft => {
      const column = draft.sketches[sketchId]?.columns[colIdx];
      if (!column) return;
      const entry = column.chain[chainIdx];
      if (entry?.type === 'module') {
        column.chain.splice(chainIdx, 1);
      }
    });
  }

  setEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: number) {
    this.mutate(`Set param ${paramKey}`, draft => {
      const entry = draft.sketches[sketchId]?.columns[colIdx]?.chain[chainIdx];
      if (entry?.type === 'module') {
        entry.params[paramKey] = value;
      }
    });
    // Also send immediate param update to the engine for live preview
    this.engine?.setParam(sketchId, colIdx, chainIdx, parseInt(paramKey), value);
  }

  undo() { this.history.undo(); this.syncSketchesToEngine(); }
  redo() { this.history.redo(); this.syncSketchesToEngine(); }

  // ========================================================================
  // Local state changes (ephemeral, no undo)
  // ========================================================================

  setActiveTab(tab: 'create' | 'organize' | 'edit') {
    runInAction(() => { appState.local.activeTab = tab; });
  }

  /** Sync state from the engine worker. Updates plugins and adopts new remote sketches. */
  syncFromRemoteState(engineState: EngineState) {
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

  selectSketch(id: string | null) {
    runInAction(() => { appState.local.selectedSketchId = id; });
  }

  editSketch(id: string | null) {
    console.log('[controller] editSketch:', id);
    runInAction(() => { appState.local.editingSketchId = id; });
    // Set trace point for the sketch being edited
    if (id) {
      console.log('[controller] setTracePoints for sketch_output:', id);
      this.setTracePoints([{ id: 'edit_preview', target: { type: 'sketch_output', sketchId: id } }]);
    } else {
      this.setTracePoints([]);
    }
  }

  setEngineFps(fps: number) {
    runInAction(() => { appState.local.engine.fps = fps; });
  }

  setEngineError(error: string | null) {
    runInAction(() => { appState.local.engine.error = error; });
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

  // ========================================================================
  // Engine sync
  // ========================================================================

  loadModule(moduleType: string) {
    this.engine?.loadModule(moduleType);
  }

  setTracePoints(tracePoints: TracePoint[]) {
    this.engine?.setTracePoints(tracePoints);
  }

  private syncSketchesToEngine() {
    if (!this.engine) return;
    for (const [id, sketch] of Object.entries(appState.database.sketches)) {
      this.engine.updateSketch(id, toJS(sketch));
    }
  }
}

function shortName(moduleId: string): string {
  return moduleId.split('.').pop() ?? moduleId;
}

export const appController = new AppController();
