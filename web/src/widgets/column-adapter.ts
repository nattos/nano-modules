/**
 * ColumnAdapter — the injection seam that decouples <column-group> from the
 * effect-IDE globals (`appState` / `appController` / the `tapsConnect` singleton).
 *
 * column-group renders the real effect card (chain, wires, taps, gutter pips,
 * trace cards, smart-input retyping). Instead of reaching into IDE state
 * directly, it reads/writes through this adapter, so a second surface (the
 * arrangement editor) can mount the SAME card against its own data by supplying
 * its own adapter. The IDE supplies `ideColumnAdapter` (a pure forwarder, all
 * caps on → identical behavior); the arrangement supplies one backed by its
 * store + effect catalog, with the features it can't do yet turned off via
 * `caps`.
 *
 * The adapter has three facets — `data` (reactive reads + plugin/engine lookups),
 * `controller` (mutations), `taps` (drag-to-connect) — plus `caps` (render-time
 * capability gates).
 */

import type { PluginInfo, AvailableEffect, Selectable, EffectClipboard } from '../state/types';
import type { Sketch, Wire, ParamSmoothing, FieldConnectInfo } from '../sketch-types';
import type { ParamValue } from '../engine-types';
import type { TraceSource } from '../state/trace-controller';

export type { PluginInfo, FieldConnectInfo };

/**
 * A continuous-edit handle. The IDE returns a real `LongEdit` (which satisfies
 * this structurally); the controller's `update*` methods take the same handle
 * back. Kept minimal so non-IDE adapters can return a plain object.
 */
export interface EditHandle {
  accept(): void;
  cancel(): void;
}

/** Per-field modulation telemetry, as published by the engine. */
export interface FieldModulation {
  value: number;
  min: number;
  max: number;
  neutral: number;
}

/**
 * Render-time capability gates. All-true reproduces the effect IDE exactly; a
 * surface that lacks the backing plumbing turns the relevant feature off so the
 * corresponding card UI is not rendered (and its handlers never run).
 */
export interface ColumnCapabilities {
  /** Texture monitors, output-trace rows, texture in/out markers. */
  tracing: boolean;
  /** Tap overlays, gutter wire pips, drag-to-connect, wire-mod inspector. */
  wiring: boolean;
  /** Per-field smoothing option block in the field inspector. */
  smoothing: boolean;
  /** Double-click-header retype + tab-insert via smart-input. */
  typeEditing: boolean;
  /** Copy/paste of effect cards (selectable copy/paste). */
  clipboard: boolean;
  /** Self-contained drag-to-reorder cards + drag-from-chip insertion. When
   *  false the host drives reordering itself via callbacks (the IDE). */
  reorder?: boolean;
  /** Draw committed wires as arcs INSIDE the column (the reusable single-column
   *  editor). The IDE leaves this off — it has its own <taps-overlay>. */
  inlineWireArcs?: boolean;
  /** This surface shows wire/field options as an in-column floating panel (not the
   *  IDE's <taps-overlay> field card). STABLE — independent of wires mode — so a pip
   *  click opens the options popup even when wires mode is off. */
  inlineWirePanel?: boolean;
  /** Clicking anywhere on a field row selects it (via controller.selectField) —
   *  the arrangement uses this for per-owner automation-field selection. The IDE
   *  leaves it off (it selects fields through the tap overlay / gutter pips). */
  fieldClickSelect?: boolean;
}

/** Reactive reads + plugin/engine lookups. */
export interface ColumnDataSource {
  readonly caps: ColumnCapabilities;
  readonly tappingMode: boolean;
  readonly availableEffects: AvailableEffect[];

  /** The sketch document for `sketchId` (reactive). */
  getSketch(sketchId: string): Sketch | undefined;
  /** The plugin descriptor (schema/params/io) for a module type. */
  getPlugin(moduleType: string): PluginInfo | undefined;

  /** Engine-published live values for an instance (outputs/broadcasts), if any. */
  pluginState(instanceKey: string): Record<string, any> | undefined;
  /** Per-field modulation telemetry for an instance, if any. */
  modulation(instanceKey: string): Record<string, FieldModulation> | undefined;

  /** Multi-edit only: true when the edited targets (e.g. several selected clips)
   *  disagree on this field, so widgets render a "many" placeholder. Absent on
   *  single-target adapters → treated as not-mixed. */
  fieldMixed?(instanceKey: string, fieldPath: string): boolean;
  /** Multi-edit only: distinct values in use across the targets (enum multi-
   *  highlight). Absent on single-target adapters. */
  fieldInUse?(instanceKey: string, fieldPath: string): unknown[];
}

/** Mutations. Signatures mirror AppController so the IDE adapter forwards 1:1. */
export interface ColumnController {
  // selection
  select(path: string | null): void;
  isSelected(path: string): boolean;
  selectField(key: string | null): void;
  selectedFieldKey(): string | null;
  defineSelectable(selectable: Selectable): void;

  // params / device controls
  setEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue): void;
  beginSetEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue): EditHandle;
  updateSetEffectParam(edit: EditHandle, sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue): void;
  beginSetEffectParams(sketchId: string, colIdx: number, chainIdx: number, values: Record<string, ParamValue>): EditHandle;
  updateSetEffectParams(edit: EditHandle, sketchId: string, colIdx: number, chainIdx: number, values: Record<string, ParamValue>): void;

  // chain edit
  toggleEffectCollapsed(sketchId: string, instanceKey: string): void;
  removeEffectFromChain(sketchId: string, colIdx: number, chainIdx: number): void;
  changeEffectType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string): void;
  beginChangeEffectType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string): EditHandle;
  updateChangeEffectType(edit: EditHandle, sketchId: string, colIdx: number, chainIdx: number, newModuleType: string): void;
  cancelChangeEffectType(edit: EditHandle): void;
  beginInsertEffect(sketchId: string, colIdx: number, insertIdx: number, moduleType: string): { edit: EditHandle; instanceKey: string };
  updateInsertEffect(edit: EditHandle, sketchId: string, colIdx: number, insertIdx: number, instanceKey: string, newModuleType: string): void;
  cancelInsertEffect(edit: EditHandle): void;
  /** Move the effect at `from` so it lands at insertion index `to` (caps.reorder). */
  moveEffect?(sketchId: string, colIdx: number, from: number, to: number): void;

  // clipboard (caps.clipboard)
  snapshotEffect(sketchId: string, instanceKey: string): EffectClipboard | null;
  insertEffectFromClipboard(sketchId: string, colIdx: number, insertIdx: number, payload: EffectClipboard): void;

  // smoothing (caps.smoothing)
  setFieldSmoothing(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string, patch: Partial<ParamSmoothing>): void;
  beginSetFieldSmoothing(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string, patch: Partial<ParamSmoothing>): EditHandle;
  updateSetFieldSmoothing(edit: EditHandle, sketchId: string, colIdx: number, chainIdx: number, fieldPath: string, patch: Partial<ParamSmoothing>): void;

  // wires (caps.wiring)
  connectWire(a: FieldConnectInfo, b: FieldConnectInfo): void;
  removeWire(sketchId: string, wireId: string): void;
  updateWire(sketchId: string, wireId: string, patch: Partial<Wire>): void;
  beginUpdateWire(sketchId: string, wireId: string, patch: Partial<Wire>): EditHandle;
  updateUpdateWire(edit: EditHandle, sketchId: string, wireId: string, patch: Partial<Wire>): void;
}

/** Drag-to-connect controller (the IDE's `tapsConnect` singleton). */
export interface ColumnTaps {
  readonly state: unknown | null;
  beginFromFieldDrag(e: PointerEvent, sourceEl: HTMLElement, sketchId: string, key: string, info: FieldConnectInfo): void;
  beginFromFieldClick(sketchId: string, key: string, info: FieldConnectInfo): void;
  completeOnField(key: string): void;
  consumeClickSuppression(): boolean;
}

export interface ColumnAdapter {
  data: ColumnDataSource;
  controller: ColumnController;
  taps: ColumnTaps;
  /** Trace seam for output texture monitors. Omit to use the IDE default
   *  (global controller + appState). */
  traceSource?: TraceSource;
}
