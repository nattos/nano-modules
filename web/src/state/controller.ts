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
import { traceController } from './trace-controller';
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
    // Wire the trace controller to push trace points through the engine
    traceController.onFlush = (tracePoints) => this.setTracePoints(tracePoints);
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

    const instances: Record<string, import('../sketch-types').InstanceState> = {};

    const columns = outInstances.map(out => {
      const chain: ChainEntry[] = [
        { type: 'texture_input', id: 'primary_in' },
      ];
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

  setEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: number) {
    // Find the instance key for this chain entry
    const sketch = appState.database.sketches[sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    if (!entry || entry.type !== 'module') return;

    this.mutate(`Set param ${paramKey}`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      // Write to the instance state (canonical source)
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) {
        inst.state[paramKey] = value;
      }
    });
    // Also send immediate param update to the engine for live preview
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
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

  // --- Rail CRUD ---

  private nextRailId = 0;

  addRail(sketchId: string, scope: 'sketch' | number, name: string, dataType: 'float' | 'texture'): string {
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

  selectSketch(id: string | null) {
    runInAction(() => { appState.local.selectedSketchId = id; });
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
