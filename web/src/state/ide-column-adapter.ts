/**
 * ideColumnAdapter — the effect IDE's ColumnAdapter: a pure forwarder to
 * `appState` / `appController` / the `tapsConnect` singleton, with every
 * capability enabled. Injecting this into <column-group> reproduces the
 * card's original behavior exactly; the arrangement supplies a different adapter.
 *
 * See `widgets/column-adapter.ts` for the contract.
 */

import { appState } from './app-state';
import { appController } from './controller';
import { tapsConnect } from '../widgets/taps-connect';
import { applyHidden, hiddenFieldsFor } from './field-visibility';
import type {
  ColumnAdapter,
  ColumnCapabilities,
  ColumnDataSource,
  ColumnController,
  ColumnTaps,
  EditHandle,
  FieldModulation,
} from '../widgets/column-adapter';
import type { LongEdit } from './history';
import type { PluginInfo, AvailableEffect, Selectable, EffectClipboard, EffectsClipboard } from './types';
import type { Sketch, Wire, ParamSmoothing, FieldConnectInfo } from '../sketch-types';
import type { ParamValue } from '../engine-types';

const ALL_CAPS: ColumnCapabilities = {
  tracing: true,
  wiring: true,
  smoothing: true,
  typeEditing: true,
  clipboard: true,
};

/**
 * The authored state of an instance, found by key alone. `getPlugin` receives no
 * sketch id, and an instance key is unique across the document, so this scans —
 * cheap in practice (the editor holds a handful of sketches) and it reads the
 * DOCUMENT rather than live engine state, which is what makes the synchronous
 * visibility rules resolve on the very first render.
 */
function instanceStateFor(instanceKey: string): Record<string, any> | undefined {
  for (const sketch of Object.values(appState.database.sketches)) {
    const inst = sketch?.instances?.[instanceKey];
    if (inst) return inst.state;
  }
  return undefined;
}

const data: ColumnDataSource = {
  get caps() { return ALL_CAPS; },
  get tappingMode() { return appState.local.tappingMode; },
  get helpMode() { return appState.local.helpMode; },
  get availableEffects(): AvailableEffect[] { return appState.local.availableEffects; },
  get barrelMode(): boolean { return appState.local.barrelMode; },
  getSketch(sketchId: string): Sketch | undefined { return appState.database.sketches[sketchId]; },
  getPlugin(moduleType: string, instanceKey?: string): PluginInfo | undefined {
    const base = appState.local.plugins.find((p) => p.id === moduleType);
    if (!base || !instanceKey) return base;
    // Resolve conditional visibility for THIS card, so two same-type effects in
    // one chain (two shapers in different modes, two math nodes with different
    // input counts) don't share one hidden set. `plugins[]` is per module type;
    // only the overlay is per instance. Returns `base` untouched for the
    // overwhelmingly common effect with no conditional fields.
    const hidden = hiddenFieldsFor(
      moduleType,
      instanceStateFor(instanceKey),
      appState.local.engine.hiddenFields?.[instanceKey]);
    return applyHidden(base, hidden);
  },
  pluginState(instanceKey: string): Record<string, any> | undefined {
    return appState.local.engine.pluginStates[instanceKey];
  },
  modulation(instanceKey: string): Record<string, FieldModulation> | undefined {
    return appState.local.engine.modulationData[instanceKey];
  },
  getMidiDeviceName(deviceInstanceId: string): string | undefined {
    return appState.local.midi.library.find((i) => i.id === deviceInstanceId)?.name;
  },
};

// The IDE's edit handles are real LongEdits; update*/cancel* hand the same
// handle back. EditHandle is a structural subset, so cast on the way through.
const controller: ColumnController = {
  select: (path) => appController.select(path),
  isSelected: (path) => appController.isSelected(path),
  selectField: (key) => appController.selectField(key),
  selectedFieldKey: () => appController.selectedFieldKey(),
  defineSelectable: (s: Selectable) => appController.defineSelectable(s),
  toggleSelectEffect: (path) => appController.toggleSelectEffect(path),
  rangeSelectEffect: (path) => appController.rangeSelectEffect(path),
  isMultiSelected: (path) => appController.isMultiSelected(path),
  isEffectInGroup: (path) => appController.isEffectInGroup(path),

  setEffectParam: (s, c, ch, k, v: ParamValue) => appController.setEffectParam(s, c, ch, k, v),
  beginSetEffectParam: (s, c, ch, k, v: ParamValue) => appController.beginSetEffectParam(s, c, ch, k, v),
  updateSetEffectParam: (e: EditHandle, s, c, ch, k, v: ParamValue) =>
    appController.updateSetEffectParam(e as LongEdit, s, c, ch, k, v),
  beginSetEffectParams: (s, c, ch, vals) => appController.beginSetEffectParams(s, c, ch, vals),
  updateSetEffectParams: (e: EditHandle, s, c, ch, vals) =>
    appController.updateSetEffectParams(e as LongEdit, s, c, ch, vals),

  toggleEffectCollapsed: (s, k) => appController.toggleEffectCollapsed(s, k),
  removeEffectFromChain: (s, c, ch) => appController.removeEffectFromChain(s, c, ch),
  changeEffectType: (s, c, ch, t) => appController.changeEffectType(s, c, ch, t),
  beginChangeEffectType: (s, c, ch, t) => appController.beginChangeEffectType(s, c, ch, t),
  updateChangeEffectType: (e: EditHandle, s, c, ch, t) =>
    appController.updateChangeEffectType(e as LongEdit, s, c, ch, t),
  cancelChangeEffectType: (e: EditHandle) => appController.cancelChangeEffectType(e as LongEdit),
  beginInsertEffect: (s, c, idx, t) => appController.beginInsertEffect(s, c, idx, t),
  updateInsertEffect: (e: EditHandle, s, c, idx, key, t) =>
    appController.updateInsertEffect(e as LongEdit, s, c, idx, key, t),
  cancelInsertEffect: (e: EditHandle) => appController.cancelInsertEffect(e as LongEdit),
  beginInsertCanvasEffect: appController.beginInsertCanvasEffect.bind(appController),
  updateInsertCanvasEffect: appController.updateInsertCanvasEffect.bind(appController),
  beginInsertOnWire: appController.beginInsertOnWire.bind(appController),
  updateInsertOnWire: appController.updateInsertOnWire.bind(appController),

  snapshotEffect: (s, k): EffectClipboard | null => appController.snapshotEffect(s, k),
  insertEffectFromClipboard: (s, c, idx, payload: EffectClipboard) =>
    appController.insertEffectFromClipboard(s, c, idx, payload),
  insertEffectsFromClipboard: (s, c, idx, payload: EffectsClipboard) =>
    appController.insertEffectsFromClipboard(s, c, idx, payload),

  setInstanceHelp: (s, instanceKey, slotPath, patch) =>
    appController.setInstanceHelp(s, instanceKey, slotPath, patch),

  setSketchOutputFormat: (s, fmt) => appController.setSketchOutputFormat(s, fmt),

  setFieldSmoothing: (s, c, ch, fp, patch: Partial<ParamSmoothing>) =>
    appController.setFieldSmoothing(s, c, ch, fp, patch),
  beginSetFieldSmoothing: (s, c, ch, fp, patch: Partial<ParamSmoothing>) =>
    appController.beginSetFieldSmoothing(s, c, ch, fp, patch),
  updateSetFieldSmoothing: (e: EditHandle, s, c, ch, fp, patch: Partial<ParamSmoothing>) =>
    appController.updateSetFieldSmoothing(e as LongEdit, s, c, ch, fp, patch),

  connectWire: (a: FieldConnectInfo, b: FieldConnectInfo) => appController.connectWire(a, b),
  removeWire: (s, id) => appController.removeWire(s, id),
  updateWire: (s, id, patch: Partial<Wire>) => appController.updateWire(s, id, patch),
  beginUpdateWire: (s, id, patch: Partial<Wire>) => appController.beginUpdateWire(s, id, patch),
  updateUpdateWire: (e: EditHandle, s, id, patch: Partial<Wire>) =>
    appController.updateUpdateWire(e as LongEdit, s, id, patch),
};

const taps: ColumnTaps = {
  get state() { return tapsConnect.state; },
  beginFromFieldDrag: (e, sourceEl, sketchId, key, info) =>
    tapsConnect.beginFromFieldDrag(e, sourceEl, sketchId, key, info),
  beginFromFieldClick: (sketchId, key, info) =>
    tapsConnect.beginFromFieldClick(sketchId, key, info),
  beginRetarget: (sketchId, key, info, onCommit) =>
    tapsConnect.beginRetarget(sketchId, key, info, onCommit),
  completeOnField: (key, info) => tapsConnect.completeOnField(key, info),
  consumeClickSuppression: () => tapsConnect.consumeClickSuppression(),
};

export const ideColumnAdapter: ColumnAdapter = { data, controller, taps };
