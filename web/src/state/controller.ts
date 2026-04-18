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
import type { DatabaseState, StagingInstance, PluginInfo, AvailableEffect, Selectable } from './types';
import type { EngineProxy } from '../engine-proxy';
import type { EngineState, EffectInfo, TracePoint } from '../engine-types';
import type { Sketch, ChainEntry } from '../sketch-types';
import { isRailCompatible } from '../schema-compat';

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
  if (isStructuredSchemaTypeDef(def)) return { kind: 'struct', schema: def };
  return 'float';
}

export class AppController {
  public readonly history: HistoryManager;
  private engine: EngineProxy | null = null;
  private nextSketchId = 0;

  /**
   * Plain (non-observable) registry of all mounted selectables.
   * Lives outside MobX so mutations during render don't trigger reactions.
   */
  private readonly selectableRegistry = new Map<string, Selectable>();

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
    this.ensureAutoStructTapsInColumn(sketchId, colIdx);
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
    this.ensureAutoStructTapsInColumn(sketchId, colIdx);
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

  setEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: number) {
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
  private setParamRecipe(sketchId: string, instanceKey: string, paramKey: string, value: number) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[instanceKey];
      if (inst) { inst.state[paramKey] = value; }
    };
  }

  /** Begin a continuous param edit (slider drag). No undo points during drag. */
  beginSetEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: number): LongEdit {
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
  updateSetEffectParam(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: number) {
    const sketch = appState.database.sketches[sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    edit.update(this.setParamRecipe(sketchId, instanceKey, paramKey, value));
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

  /**
   * Scan a column and auto-connect struct / gpu / vector inputs to matching
   * outputs of prior effects. Never overwrites an existing read tap. Does
   * nothing for scalar or texture inputs — those already have their own
   * manual-tap flows.
   *
   * Executes as ONE undo transaction so that a single user action (add
   * effect, change type, drag-drop) produces at most one auto-connect entry
   * in the undo stack.
   */
  ensureAutoStructTapsInColumn(sketchId: string, colIdx: number) {
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;
    const column = sketch.columns[colIdx];
    if (!column) return;

    // Plan all changes up-front from the current snapshot — we apply the
    // collected operations atomically inside one mutate() call so the
    // auto-connect shows up as a single undo step.
    type Op =
      | { kind: 'addRail'; railId: string; name: string; dataType: import('../sketch-types').RailDataType }
      | { kind: 'addTap'; chainIdx: number; railId: string; fieldPath: string; direction: 'read' | 'write' };
    const ops: Op[] = [];

    // Track rails that will exist after our planned ops.
    const newRails: Array<{ id: string; dataType: import('../sketch-types').RailDataType }> = [];
    const allRails = this.collectRails(sketch, colIdx);

    // Also track which producers (chainIdx, fieldPath) will have a write tap
    // after our ops, so downstream consumers can share.
    interface ProducedRail { railId: string; dataType: import('../sketch-types').RailDataType; }
    const writeTapAfter = new Map<string, ProducedRail>(); // key: `${chainIdx}/${fieldPath}`
    for (let i = 0; i < column.chain.length; i++) {
      const e = column.chain[i];
      if (e.type !== 'module') continue;
      for (const t of e.taps ?? []) {
        if (t.direction !== 'write') continue;
        const rail = allRails.find(r => r.id === t.railId);
        if (!rail) continue;
        writeTapAfter.set(`${i}/${t.fieldPath}`, { railId: rail.id, dataType: rail.dataType });
      }
    }

    const getRailDataType = (railId: string): import('../sketch-types').RailDataType | null => {
      const existing = allRails.find(r => r.id === railId);
      if (existing) return existing.dataType;
      const planned = newRails.find(r => r.id === railId);
      return planned?.dataType ?? null;
    };

    let nextRailId = this.nextRailId;
    const provisionRailId = () => `rail_${nextRailId++}`;

    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];
      if (entry.type !== 'module') continue;
      const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
      const schema = plugin?.schema;
      if (!schema) continue;

      for (const [fieldName, def] of Object.entries(schema)) {
        const d: any = def;
        const io = d?.io ?? 0;
        if (!(io & 1)) continue;               // inputs only
        if (!isStructuredSchemaTypeDef(d)) continue;  // struct/array/vec only

        // Skip if the consumer already has a read tap for this field.
        const hasRead = (entry.taps ?? []).some(
          t => t.fieldPath === fieldName && t.direction === 'read');
        if (hasRead) continue;

        // Find an earlier module in the column with a compatible output.
        let producerChainIdx = -1;
        let producerFieldPath = '';
        let producerSchema: any = null;
        outer: for (let j = 0; j < i; j++) {
          const pe = column.chain[j];
          if (pe.type !== 'module') continue;
          const pplug = appState.local.plugins.find(p => p.id === pe.module_type);
          const pschema = pplug?.schema ?? {};
          for (const [pname, pdef] of Object.entries(pschema)) {
            const pd: any = pdef;
            if (!((pd?.io ?? 0) & 2)) continue;    // outputs only
            if (!isStructuredSchemaTypeDef(pd)) continue;
            if (!isRailCompatible(pd, d)) continue;
            producerChainIdx = j;
            producerFieldPath = pname;
            producerSchema = pd;
            break outer;
          }
        }
        if (producerChainIdx < 0) continue;

        // Find or plan a write tap on the producer.
        const producerKey = `${producerChainIdx}/${producerFieldPath}`;
        let produced = writeTapAfter.get(producerKey);
        if (!produced) {
          const railId = provisionRailId();
          const dataType: import('../sketch-types').RailDataType = {
            kind: 'struct',
            schema: producerSchema,
          };
          ops.push({ kind: 'addRail', railId, name: `Rail ${allRails.length + newRails.length + 1}`, dataType });
          newRails.push({ id: railId, dataType });
          ops.push({ kind: 'addTap', chainIdx: producerChainIdx, railId, fieldPath: producerFieldPath, direction: 'write' });
          produced = { railId, dataType };
          writeTapAfter.set(producerKey, produced);
        }

        // Verify the producer rail is still compatible with the consumer
        // schema (it always will be for freshly-created rails; may not be
        // for pre-existing ones if the producer schema drifted).
        const producedDataType = getRailDataType(produced.railId) ?? produced.dataType;
        if (typeof producedDataType === 'string') continue;
        if (!isRailCompatible((producedDataType as any).schema, d)) continue;

        ops.push({ kind: 'addTap', chainIdx: i, railId: produced.railId, fieldPath: fieldName, direction: 'read' });
      }
    }

    if (ops.length === 0) return;

    this.mutate('Auto-connect struct inputs', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const col = sk.columns[colIdx];
      if (!col) return;
      for (const op of ops) {
        if (op.kind === 'addRail') {
          col.rails = col.rails ?? [];
          col.rails.push({ id: op.railId, name: op.name, dataType: op.dataType });
        } else {
          const e = col.chain[op.chainIdx];
          if (e?.type === 'module') {
            e.taps = e.taps ?? [];
            e.taps.push({ railId: op.railId, fieldPath: op.fieldPath, direction: op.direction });
          }
        }
      }
    });
    this.nextRailId = nextRailId;
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
