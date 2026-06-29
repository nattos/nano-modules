/**
 * ArrColumnAdapter — the arrangement's ColumnAdapter, backing the real
 * <column-group> effect card with the arrangement store + effect catalog (it
 * retires the bespoke <arr-chain> + FakeBinding).
 *
 * It's target-agnostic: a `DeviceTarget` (see `clipTarget`/`trackTarget`) binds
 * it to either a clip's or a track's device list and the matching store
 * mutators, so both the clip and track inspectors mount the same card. The
 * adapter projects the device list into a Structor `Sketch` (each device's
 * `state` aliased so reads/writes stay live), synthesizes `PluginInfo` from the
 * catalog so the generic inspector renders real param sliders, and routes
 * mutations through the target. Capabilities the arrangement doesn't plumb yet
 * (tracing/wiring/smoothing/clipboard) are off; param editing + add/retype are on.
 */

import type {
  ColumnAdapter, ColumnCapabilities, ColumnDataSource, ColumnController,
  ColumnTaps, EditHandle, PluginInfo, FieldModulation,
} from '../../../widgets/column-adapter';
import type { Sketch, Wire } from '../../../sketch-types';
import type { ParamValue } from '../../../engine-types';
import type { Selectable, EffectClipboard, AvailableEffect } from '../../../state/types';
import type { FieldBinding } from '../../../widgets/field-editor';
import type { Clip, Device } from '../model/composition';
import { store } from '../state/store';
import { buildMultiEditModel, clipInsertIndex, aggregateField, multiSketchId, type MultiEditModel } from '../state/multi-edit';
import { engineBridge } from '../engine/engine-bridge';
import { WireConnect } from '../../../widgets/taps-connect';
import { effectCatalog, catalogEffect, VIDEO_SOURCE_TYPE } from '../engine/effect-catalog';
import { clipInstanceKey } from '../engine/clip-sketch';

/**
 * Return `plugin` with the conditional-visibility overlay applied. When the live
 * schema already carries `hidden` flags (the effect's instance executed + fired
 * on_state_ready), trust it as-is. Otherwise — a not-yet-executed or off-playhead
 * instance whose schema momentarily lost its flags — overlay the last-known
 * hidden set the store remembered (`store.hiddenFieldMemory`, refreshed reactively
 * in setEnginePlugins). Reading it here ties the render to it, so the inspector
 * re-renders when a republish refreshes the memory (no stale-until-reselect).
 * Cheap — only clones the schema on the overlay path.
 */
function applyHiddenMemory(moduleType: string, plugin: PluginInfo): PluginInfo {
  const schema = (plugin.schema ?? {}) as Record<string, any>;
  const cached = store.hiddenFieldMemory[moduleType]; // tracked read (reactive)
  const liveHidden = Object.keys(schema).some((k) => schema[k]?.hidden);
  if (liveHidden || !cached || cached.length === 0) return plugin;
  const overlaid: Record<string, any> = {};
  for (const [k, d] of Object.entries(schema)) overlaid[k] = cached.includes(k) ? { ...d, hidden: true } : d;
  return { ...plugin, schema: overlaid } as PluginInfo;
}

const CAPS: ColumnCapabilities = {
  // Tracing on → output trace cards render, exposing output fields as connectable
  // wire endpoints. The cards are display-only for now (the arrangement
  // compositor emits no per-device trace data — see MOCKUP_NOTES).
  tracing: true,
  wiring: false,
  smoothing: false,
  typeEditing: true,
  clipboard: false,
  reorder: true,
  fieldClickSelect: true, // click a field → per-owner automation-field selection
  inlineWirePanel: true,  // STABLE: pip click opens the floating wire-mod panel (any mode)
};

// The add-effect palette, derived LIVE from discovered effects (reactive: reading
// effectCatalog() in a render ties it to store.enginePlugins, so it fills in as
// bundles warm). The host-fed video source is excluded — it's added automatically
// for media clips, not picked from the palette.
function availableEffects(): AvailableEffect[] {
  return effectCatalog()
    .filter((c) => c.type !== VIDEO_SOURCE_TYPE)
    .map((c) => ({
      id: c.type,
      name: c.name,
      description: '',
      category: c.type.split('.')[0],
      keywords: [],
    }));
}

/** Binds the adapter to a clip's or track's device list + store mutators. */
export interface DeviceTarget {
  /** Stable key — used as the column sketchId and the adapter-cache key. */
  readonly id: string;
  getDevices(): Device[] | undefined;
  setField(deviceId: string, key: string, value: unknown): void;
  setType(deviceId: string, type: string, ck?: string): void;
  replace(deviceId: string, snap: Partial<Device>, ck?: string): void;
  insertAt(index: number, type: string, ck?: string): string | null;
  remove(deviceId: string, ck?: string): void;
  /** Move the device at chain index `from` to insertion index `to`. */
  move(from: number, to: number): void;
  /**
   * The engine instance key this device renders under, for reading live engine
   * telemetry (modulationData). Only clip targets render through the engine;
   * track targets omit it (no live modulation).
   */
  engineKeyFor?(deviceId: string): string | undefined;

  /** Multi-edit only: whether the edited clips disagree on a field (→ "many"). */
  isFieldMixed?(deviceId: string, field: string): boolean;
  /** Multi-edit only: distinct values used across the clips (enum highlight). */
  fieldInUseValues?(deviceId: string, field: string): unknown[];
  /** Multi-edit only: ragged (non-common) device runs by gap, for the collapsed
   *  "other effects" placeholder rows. `gapIndex` ∈ `[0, commonCount]`. */
  raggedSegments?(): { gapIndex: number; count: number }[];
  /** Multi-edit only: the wires COMMON to every clip (clip[0]'s rep wires), so
   *  the panel shows + edits them (edits fan out via the store's multi/ branch). */
  commonWires?(): Wire[];
  /** Multi-edit only: count of intra-sketch wires present on only SOME clips. */
  raggedWireCount?(): number;
  /** Multi-edit only: count of return-track rail taps present on only SOME clips. */
  raggedRailCount?(): number;
  /** Optional capability overrides merged over the defaults (e.g. multi disables
   *  reorder/wiring/tracing in early phases). */
  capsOverride?: Partial<ColumnCapabilities>;
}

export function clipTarget(trackId: string, clipId: string): DeviceTarget {
  return {
    id: `clip/${trackId}/${clipId}`,
    getDevices: () => store.trackById(trackId)?.clips.find((c) => c.id === clipId)?.sketch.devices,
    setField: (d, k, v) => store.setClipDeviceField(trackId, clipId, d, k, v),
    setType: (d, t, ck) => store.setClipDeviceType(trackId, clipId, d, t, ck),
    replace: (d, s, ck) => store.replaceClipDevice(trackId, clipId, d, s, ck),
    insertAt: (i, t, ck) => store.insertClipDeviceAt(trackId, clipId, i, t, ck),
    remove: (d, ck) => store.removeClipDevice(trackId, clipId, d, ck),
    move: (from, to) => store.moveClipDevice(trackId, clipId, from, to),
    engineKeyFor: (d) => clipInstanceKey(clipId, d),
  };
}

export function trackTarget(trackId: string): DeviceTarget {
  return {
    id: `track/${trackId}`,
    getDevices: () => store.trackById(trackId)?.sketch.devices,
    setField: (d, k, v) => store.setTrackDeviceField(trackId, d, k, v),
    setType: (d, t, ck) => store.setTrackDeviceType(trackId, d, t, ck),
    replace: (d, s, ck) => store.replaceTrackDevice(trackId, d, s, ck),
    insertAt: (i, t, ck) => store.insertTrackDeviceAt(trackId, i, t, ck),
    remove: (d, ck) => store.removeTrackDevice(trackId, d, ck),
    move: (from, to) => store.moveTrackDevice(trackId, from, to),
  };
}

/**
 * A `DeviceTarget` that edits SEVERAL selected clips at once. Its `getDevices()`
 * returns the synthesized list of devices COMMON to every clip (rep ids +
 * clip[0]'s state), so `ArrColumnAdapter` + `<column-group>` render it unchanged;
 * every mutation fans out through the matching device in each clip (one undo via
 * the `store.*Clips*` actions). Field reads report a `mixed` flag when the clips
 * disagree. The reconciliation model is rebuilt lazily per call so MobX
 * re-renders when any clip's chain changes. (Phase 1: reorder/wiring/tracing off.)
 */
export function multiClipTarget(refs: { trackId: string; clipId: string }[]): DeviceTarget {
  const trackByClip = new Map(refs.map((r) => [r.clipId, r.trackId]));
  // Stable id keyed by the (order-independent) clip set → the adapter + the
  // mounted column-group instance are reused when the same set is re-selected.
  const id = multiSketchId(refs);

  const clips = (): Clip[] =>
    refs
      .map((r) => store.trackById(r.trackId)?.clips.find((c) => c.id === r.clipId))
      .filter((c): c is Clip => !!c);
  const model = (): MultiEditModel => buildMultiEditModel(clips());
  const resolveDefault = (moduleType: string, field: string): unknown =>
    catalogEffect(moduleType)?.fields.find((f) => f.key === field)?.default;

  // Bridge between an insert and the retype that immediately follows it: the new
  // devices aren't in the reconciliation yet, so map the rep id (clip[0]'s new
  // device) → each clip's new device id until the next rebuild catches up.
  const pendingInserts = new Map<string, Map<string, string>>();
  const targetsFor = (repId: string): { trackId: string; clipId: string; deviceId: string }[] => {
    const common = model().devices.common.find((c) => c.repId === repId);
    if (common) {
      return [...common.idByClip].map(([clipId, deviceId]) => ({ trackId: trackByClip.get(clipId)!, clipId, deviceId }));
    }
    const pend = pendingInserts.get(repId);
    if (pend) return [...pend].map(([clipId, deviceId]) => ({ trackId: trackByClip.get(clipId)!, clipId, deviceId }));
    return [];
  };

  return {
    id,
    getDevices: () => {
      const c0 = clips()[0];
      if (!c0) return [];
      // Representative device = clip[0]'s matched device (real Device → real state
      // drives the card; mixed-ness is resolved separately via isFieldMixed).
      return model().devices.common
        .map((cd) => c0.sketch.devices.find((d) => d.id === cd.repId))
        .filter((d): d is Device => !!d);
    },
    setField: (repId, key, value) => store.setClipsDeviceField(targetsFor(repId), key, value),
    setType: (repId, type, ck) => store.setClipsDeviceType(targetsFor(repId), type, ck),
    replace: (repId, snap, ck) => store.replaceClipsDevice(targetsFor(repId), snap, ck),
    insertAt: (index, type) => {
      const m = model();
      const cs = clips();
      const targets = cs.map((c) => ({
        trackId: trackByClip.get(c.id)!, clipId: c.id, index: clipInsertIndex(c, m.devices, index),
      }));
      const newIds = store.insertClipsDeviceAt(targets, type); // Map<clipId, newId>
      const repId = newIds.get(cs[0]?.id ?? '') ?? null;
      if (repId) pendingInserts.set(repId, newIds);
      return repId;
    },
    remove: (repId, ck) => {
      store.removeClipsDevice(targetsFor(repId), ck);
      pendingInserts.delete(repId);
    },
    move: (from, to) => {
      const m = model();
      const targets: { trackId: string; clipId: string; from: number; to: number }[] = [];
      for (const c of clips()) {
        const fromId = m.devices.common[from]?.idByClip.get(c.id);
        if (fromId === undefined) continue;
        const fromIdx = c.sketch.devices.findIndex((d) => d.id === fromId);
        if (fromIdx < 0) continue;
        targets.push({ trackId: trackByClip.get(c.id)!, clipId: c.id, from: fromIdx, to: clipInsertIndex(c, m.devices, to) });
      }
      store.moveClipsDevice(targets);
    },
    isFieldMixed: (repId, field) => {
      const m = model();
      const common = m.devices.common.find((c) => c.repId === repId);
      return common ? aggregateField(m.clips, common, field, resolveDefault).mixed : false;
    },
    fieldInUseValues: (repId, field) => {
      const m = model();
      const common = m.devices.common.find((c) => c.repId === repId);
      return common ? aggregateField(m.clips, common, field, resolveDefault).inUse : [];
    },
    raggedSegments: () =>
      model().devices.ragged.map((s) => ({ gapIndex: s.gapIndex, count: s.count })),
    commonWires: () => {
      const m = model();
      const c0 = m.clips[0];
      if (!c0) return [];
      // Rep wires = clip[0]'s actual wire objects (so combine/curve/scale/etc.
      // flow through). Their endpoint instance keys are clip[0]'s device ids,
      // which match the synthesized chain — so pips + the wire-mod panel work.
      const byId = new Map((c0.sketch.wires ?? []).map((w) => [w.id, w]));
      return m.wires.common.map((cw) => byId.get(cw.repId)).filter((w): w is Wire => !!w);
    },
    raggedWireCount: () => model().wires.raggedCount,
    raggedRailCount: () => model().rails.raggedCount,
    // Reorder of common devices fans out (each clip moves its matched device).
    // Wiring overlay + output-trace cards stay off — no single live engine
    // instance for a multi-selection (lifted/addressed in later phases).
    capsOverride: { wiring: false, inlineWireArcs: false, tracing: false },
    // engineKeyFor omitted on purpose (no aggregated live telemetry).
  };
}

/**
 * A standalone `FieldBinding` for one clip device field — used by surfaces that
 * aren't a `<column-group>` (e.g. the inspector dashboard's knobs + sparks).
 * Reads/writes the clip's device state through the store (param writes already
 * coalesce per `param:<dev>:<field>`, so a knob drag is one undo) and reads live
 * modulation from the telemetry channel keyed by the engine instance key.
 */
export function buildClipFieldBinding(trackId: string, clipId: string, deviceId: string): FieldBinding {
  const device = (): Device | undefined =>
    store.trackById(trackId)?.clips.find((c) => c.id === clipId)?.sketch.devices.find((d) => d.id === deviceId);
  const ek = clipInstanceKey(clipId, deviceId);
  const fallback = (field: string): number => {
    const cat = catalogEffect(device()?.moduleType ?? '');
    return cat?.fields.find((f) => f.key === field)?.default ?? 0;
  };
  return {
    instanceKey: deviceId,
    getValue: (field) => {
      const v = device()?.state?.[field];
      return typeof v === 'number' ? v : fallback(field);
    },
    getModulation: (field) => store.modulationData[ek]?.[field] ?? null,
    setValue: (field, value) => store.setClipDeviceField(trackId, clipId, deviceId, field, value),
    beginContinuousEdit: (field, value) => {
      const orig = device()?.state?.[field];
      store.setClipDeviceField(trackId, clipId, deviceId, field, value);
      return {
        update: (v: unknown) => store.setClipDeviceField(trackId, clipId, deviceId, field, v),
        accept: () => {},
        cancel: () => store.setClipDeviceField(trackId, clipId, deviceId, field, orig),
      };
    },
  };
}

/** A store-backed edit handle that carries its coalesce session key. */
interface ArrEditHandle extends EditHandle {
  _ck?: string;
}

export class ArrColumnAdapter implements ColumnAdapter {
  // Keyed by the REAL PluginInfo object identity (NOT by module-type string): the
  // worker republishes a fresh PluginInfo whenever the schema changes — including
  // when an effect hides/shows fields via setFieldHidden (e.g. warp.crop's inset
  // params). A string key would pin the first merge forever and the label-merged
  // copy would never pick up the new `hidden` flags. A WeakMap on the source ref
  // rebuilds exactly when (and only when) the engine ships a new schema.
  private pluginCache = new WeakMap<PluginInfo, PluginInfo>();

  constructor(private target: DeviceTarget) {}

  get id() { return this.target.id; }

  // ── helpers ──
  private deviceIdAt(chainIdx: number): string | undefined {
    return this.target.getDevices()?.[chainIdx]?.id;
  }
  private device(id: string): Device | undefined {
    return this.target.getDevices()?.find((d) => d.id === id);
  }

  // ── data source ──
  /** Per-adapter wire-connect gesture machine, backed by the arrangement store. */
  private readonly wire = new WireConnect({
    getSketch: (id) => this.data.getSketch(id),
    getPlugin: (mt) => this.data.getPlugin(mt),
    connectWire: (a, b) => store.connectSketchWire(a, b),
  });

  // `self` capture: the `get caps()` getter rebinds `this` to the data object, so
  // it can't read `this.target`. An IIFE binds the adapter as `self`; the arrow
  // members below still see the adapter via lexical `this` unchanged.
  data: ColumnDataSource = ((self: ArrColumnAdapter): ColumnDataSource => ({
    // Wiring follows the global wires-mode toggle: on → tap overlay + pips +
    // click-to-connect; the gutter reappears to host the pips. A target may
    // override caps (multi-edit disables reorder/wiring/tracing in early phases).
    get caps(): ColumnCapabilities {
      return { ...CAPS, wiring: store.wiresMode, inlineWireArcs: store.wiresMode, ...(self.target.capsOverride ?? {}) };
    },
    get tappingMode() { return store.wiresMode; },
    get availableEffects() { return availableEffects(); },
    getSketch: (sketchId: string): Sketch | undefined => {
      const devices = this.target.getDevices();
      if (!devices) return undefined;
      // Rebuilt every call so it reads the CURRENT device.state (the store
      // replaces the state object on each edit) — and so reading it in
      // column-group's render establishes the MobX dependency that re-renders
      // the card when a param changes.
      return {
        anchor: null,
        chain: devices.map((d) => ({
          type: 'module' as const, module_type: d.moduleType, instance_key: d.id,
        })),
        instances: Object.fromEntries(
          devices.map((d) => [d.id, { module_type: d.moduleType, state: (d.state ?? {}) as Record<string, unknown> }]),
        ),
        // Read through the store so the overlay re-renders when wires change.
        // Multi-edit synthesizes the COMMON wires (rep ids); single-clip/track
        // targets fall back to the real per-sketch wire list.
        wires: this.target.commonWires?.() ?? store.sketchWires(sketchId),
      };
    },
    getPlugin: (moduleType: string): PluginInfo | undefined => {
      // The engine's REAL schema (complete editors: color/bool/enum/vec, exact
      // ranges). Reading store.enginePlugins here ties column-group's render to it,
      // so editors appear once the bundle warms up. The real schema carries no
      // display names, so overlay the registry's humanized labels onto the float
      // fields. Returns undefined until the schema lands (no synthesis fallback —
      // every effect is a discovered plugin).
      const real = store.enginePlugin(moduleType);
      if (!real) return undefined;
      let base = this.pluginCache.get(real);
      if (!base) {
        const cat = catalogEffect(moduleType);
        const schema: Record<string, any> = {};
        for (const [k, def] of Object.entries((real.schema ?? {}) as Record<string, any>)) {
          const label = cat?.fields.find((f) => f.key === k)?.label;
          schema[k] = label && def && def.name == null ? { ...def, name: label } : def;
        }
        base = { ...(real as unknown as PluginInfo), schema };
        this.pluginCache.set(real, base);
      }
      // Overlay the last-known hidden set (computed per-call, NOT cached on the
      // `real` ref, since the memory updates independently of the engine schema).
      return applyHiddenMemory(moduleType, base);
    },
    // instanceKey is the device id; translate to the engine key the live output
    // state is published under, then read the store (so output traces animate).
    pluginState: (instanceKey: string): Record<string, any> | undefined => {
      const ek = this.target.engineKeyFor?.(instanceKey);
      return ek ? store.pluginStates[ek] : undefined;
    },
    // instanceKey is the device id (from getSketch); translate to the engine
    // key the live telemetry is published under, then read the store.
    modulation: (instanceKey: string): Record<string, FieldModulation> | undefined => {
      const ek = this.target.engineKeyFor?.(instanceKey);
      return ek ? store.modulationData[ek] : undefined;
    },
    // Multi-edit: delegate the "many"/in-use signal to the target (undefined on
    // single-clip + track targets → the binding treats it as not-mixed).
    fieldMixed: (instanceKey: string, fieldPath: string): boolean =>
      this.target.isFieldMixed?.(instanceKey, fieldPath) ?? false,
    fieldInUse: (instanceKey: string, fieldPath: string): unknown[] =>
      this.target.fieldInUseValues?.(instanceKey, fieldPath) ?? [],
  }))(this);

  // ── controller ──
  controller: ColumnController = {
    // Card/field selection is unified on the store (shared by every adapter), so
    // highlight, Delete, and click-away all agree across the app.
    select: (path) => store.setChainFocus(path),
    isSelected: (path) => store.chainFocusPath === path,
    // Field selection is PER-OWNER in the arrangement (each clip/track remembers
    // its own automation field), not the global chainFieldKey. Drives the
    // clip-view automation tab + the track automation overlay.
    selectField: (key) => {
      if (key == null) { store.clearAutoField(this.target.id); return; }
      // key = `${target.id}/${colIdx}/${chainIdx}/${field}`
      const rest = key.startsWith(this.target.id + '/') ? key.slice(this.target.id.length + 1) : key;
      const parts = rest.split('/'); // [colIdx, chainIdx, ...field]
      const chainIdx = Number(parts[1]);
      const field = parts.slice(2).join('/');
      const deviceId = this.deviceIdAt(chainIdx);
      if (deviceId && field) store.selectAutoField(this.target.id, deviceId, field);
    },
    selectedFieldKey: () => {
      const sel = store.autoField(this.target.id);
      if (!sel) return null;
      const idx = this.target.getDevices()?.findIndex((d) => d.id === sel.deviceId) ?? -1;
      return idx < 0 ? null : `${this.target.id}/0/${idx}/${sel.field}`;
    },
    defineSelectable: (_s: Selectable) => { /* arrangement routes its own inspector */ },

    setEffectParam: (_s, _c, ch, key, v: ParamValue) => {
      const id = this.deviceIdAt(ch);
      if (id) this.target.setField(id, key, v);
    },
    beginSetEffectParam: (_s, _c, ch, key, v: ParamValue): EditHandle => {
      const id = this.deviceIdAt(ch);
      const orig = id ? this.device(id)?.state?.[key] : undefined;
      if (id) this.target.setField(id, key, v);
      return {
        accept: () => {},
        cancel: () => { if (id) this.target.setField(id, key, orig); },
      };
    },
    updateSetEffectParam: (_e, _s, _c, ch, key, v: ParamValue) => {
      const id = this.deviceIdAt(ch);
      if (id) this.target.setField(id, key, v);
    },
    beginSetEffectParams: (_s, _c, ch, values): EditHandle => {
      const id = this.deviceIdAt(ch);
      const orig: Record<string, unknown> = {};
      if (id) { const d = this.device(id); for (const k in values) orig[k] = d?.state?.[k]; }
      if (id) for (const k in values) this.target.setField(id, k, values[k]);
      return {
        accept: () => {},
        cancel: () => { if (id) for (const k in orig) this.target.setField(id, k, orig[k]); },
      };
    },
    updateSetEffectParams: (_e, _s, _c, ch, values) => {
      const id = this.deviceIdAt(ch);
      if (id) for (const k in values) this.target.setField(id, k, values[k]);
    },

    toggleEffectCollapsed: (_s, instanceKey) => {
      const dev = this.device(instanceKey);
      if (!dev) return;
      const ui = (dev.state?.['__ui_only__'] && typeof dev.state['__ui_only__'] === 'object')
        ? dev.state['__ui_only__'] as Record<string, unknown> : {};
      this.target.replace(instanceKey, {
        state: { ...(dev.state ?? {}), ['__ui_only__']: { ...ui, collapsed: !ui.collapsed } },
      });
    },
    removeEffectFromChain: (_s, _c, ch) => {
      const id = this.deviceIdAt(ch);
      if (id) this.target.remove(id);
    },
    changeEffectType: (_s, _c, ch, type) => {
      const id = this.deviceIdAt(ch);
      if (id) this.target.setType(id, type);
    },
    beginChangeEffectType: (_s, _c, ch, type): EditHandle => {
      const id = this.deviceIdAt(ch);
      const dev = id ? this.device(id) : undefined;
      const orig: Partial<Device> | undefined = dev
        ? JSON.parse(JSON.stringify({ moduleType: dev.moduleType, name: dev.name, capabilities: dev.capabilities, state: dev.state }))
        : undefined;
      const ck = `retype:${id}`;
      if (id) this.target.setType(id, type, ck);
      const handle: ArrEditHandle = {
        _ck: ck,
        accept: () => {},
        cancel: () => { if (id && orig) this.target.replace(id, orig, ck); },
      };
      return handle;
    },
    updateChangeEffectType: (edit, _s, _c, ch, type) => {
      const id = this.deviceIdAt(ch);
      if (id) this.target.setType(id, type, (edit as ArrEditHandle)._ck);
    },
    cancelChangeEffectType: (edit) => edit.cancel(),
    beginInsertEffect: (_s, _c, insertIdx, type) => {
      // Insert as its OWN committed undo point (no coalesce key). Crucially, the
      // insert must NOT share a coalesce key with the subsequent retype: history
      // coalescing reverts the doc to the entry's base and replays only the
      // latest recipe, so an insert+retype under one key would revert the insert
      // away and then setType against a base missing the device — corrupting the
      // chain (the "edits other effects" blast radius). Keeping them separate,
      // and retyping under a per-device key (below), reverts to a base that still
      // contains the device, so only that device changes.
      const id = this.target.insertAt(insertIdx, type);
      const handle: ArrEditHandle = {
        _ck: id ? `retype:${id}` : undefined,
        accept: () => {},
        cancel: () => { if (id) this.target.remove(id); },
      };
      return { edit: handle, instanceKey: id ?? '' };
    },
    updateInsertEffect: (edit, _s, _c, _idx, instanceKey, type) => {
      // Retype the freshly-inserted device under a per-device key, NOT the
      // insert's key — see beginInsertEffect.
      this.target.setType(instanceKey, type, (edit as ArrEditHandle)._ck ?? `retype:${instanceKey}`);
    },
    cancelInsertEffect: (edit) => edit.cancel(),
    moveEffect: (_s, _c, from, to) => this.target.move(from, to),

    // clipboard / smoothing are capability-gated off → never invoked.
    snapshotEffect: (): EffectClipboard | null => null,
    insertEffectFromClipboard: () => {},
    setFieldSmoothing: () => {},
    beginSetFieldSmoothing: (): EditHandle => ({ accept: () => {}, cancel: () => {} }),
    updateSetFieldSmoothing: () => {},

    // wiring → store (intra-sketch modulation; rail endpoints punted for now).
    connectWire: (a, b) => store.connectSketchWire(a, b),
    removeWire: (sketchId, wireId) => store.removeSketchWire(sketchId, wireId),
    updateWire: (sketchId, wireId, patch) => store.updateSketchWire(sketchId, wireId, patch as Record<string, unknown>),
    beginUpdateWire: (sketchId, wireId, patch): EditHandle => {
      const ck = `wire:${wireId}`;
      store.updateSketchWire(sketchId, wireId, patch as Record<string, unknown>, ck);
      return { _ck: ck, accept: () => {}, cancel: () => {} } as ArrEditHandle;
    },
    updateUpdateWire: (edit, sketchId, wireId, patch) =>
      store.updateSketchWire(sketchId, wireId, patch as Record<string, unknown>, (edit as ArrEditHandle)._ck),
  };

  // ── taps: the shared wire-connect gesture, backed by this adapter ──
  get taps(): ColumnTaps { return this.wire; }

  // ── trace seam: output texture monitors capture per-device tex_out from the
  //    live composite engine (remapped clip-local → composite by the bridge). ──
  get traceSource() { return engineBridge.traceSource; }
}
