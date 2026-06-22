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

import { observable, runInAction } from 'mobx';
import type {
  ColumnAdapter, ColumnCapabilities, ColumnDataSource, ColumnController,
  ColumnTaps, EditHandle, PluginInfo, FieldModulation,
} from '../../../widgets/column-adapter';
import type { Sketch } from '../../../sketch-types';
import type { ParamValue } from '../../../engine-types';
import type { Selectable, EffectClipboard, AvailableEffect } from '../../../state/types';
import type { FieldBinding } from '../../../widgets/field-editor';
import type { Device } from '../model/composition';
import { store } from '../state/store';
import { EFFECT_CATALOG, catalogEffect } from '../engine/effect-catalog';
import { clipInstanceKey } from '../engine/clip-sketch';

const CAPS: ColumnCapabilities = {
  tracing: false,
  wiring: false,
  smoothing: false,
  typeEditing: true,
  clipboard: false,
};

const AVAILABLE: AvailableEffect[] = EFFECT_CATALOG.map((c) => ({
  id: c.type,
  name: c.name,
  description: '',
  category: c.type.split('.')[0],
  keywords: [],
}));

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
  /**
   * The engine instance key this device renders under, for reading live engine
   * telemetry (modulationData). Only clip targets render through the engine;
   * track targets omit it (no live modulation).
   */
  engineKeyFor?(deviceId: string): string | undefined;
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
  _ck: string;
}

export class ArrColumnAdapter implements ColumnAdapter {
  /** Local card/field selection (observable so column-group re-renders). */
  private sel = observable({ path: null as string | null, fieldKey: null as string | null });
  private pluginCache = new Map<string, PluginInfo>();

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
  data: ColumnDataSource = {
    get caps() { return CAPS; },
    get tappingMode() { return false; },
    get availableEffects() { return AVAILABLE; },
    getSketch: (_sketchId: string): Sketch | undefined => {
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
      };
    },
    getPlugin: (moduleType: string): PluginInfo | undefined => {
      // Prefer the engine's REAL schema (complete editors: color/bool/enum/vec,
      // exact ranges). Reading store.enginePlugins here ties column-group's render
      // to it, so editors upgrade automatically once the bundle warms up. The
      // real schema carries no display names, so overlay the catalog's curated
      // labels where present. Falls back to the float-only synthesis until the
      // schema lands.
      const real = store.enginePlugin(moduleType);
      if (real) {
        const mergedKey = `real:${moduleType}`;
        const cachedReal = this.pluginCache.get(mergedKey);
        if (cachedReal) return cachedReal;
        const cat = catalogEffect(moduleType);
        const schema: Record<string, any> = {};
        for (const [k, def] of Object.entries((real.schema ?? {}) as Record<string, any>)) {
          const label = cat?.fields.find((f) => f.key === k)?.label;
          schema[k] = label && def && def.name == null ? { ...def, name: label } : def;
        }
        const merged: PluginInfo = { ...(real as unknown as PluginInfo), schema };
        this.pluginCache.set(mergedKey, merged);
        return merged;
      }
      const cached = this.pluginCache.get(moduleType);
      if (cached) return cached;
      const cat = catalogEffect(moduleType);
      if (!cat) return undefined;
      // schema drives the slider label (def.name); params drive the editor.
      const schema: Record<string, any> = {};
      cat.fields.forEach((f, i) => {
        schema[f.key] = {
          name: f.label, type: 'float', io: 1,
          min: f.min, max: f.max, default: f.default, order: i,
        };
      });
      const plugin: PluginInfo = {
        key: moduleType, id: moduleType, version: '0.0.0', io: [],
        params: cat.fields.map((f, i) => ({
          index: i, name: f.key, type: 10, defaultValue: f.default, min: f.min, max: f.max,
        })),
        schema,
      };
      this.pluginCache.set(moduleType, plugin);
      return plugin;
    },
    pluginState: (_instanceKey: string): Record<string, any> | undefined => undefined,
    // instanceKey is the device id (from getSketch); translate to the engine
    // key the live telemetry is published under, then read the store.
    modulation: (instanceKey: string): Record<string, FieldModulation> | undefined => {
      const ek = this.target.engineKeyFor?.(instanceKey);
      return ek ? store.modulationData[ek] : undefined;
    },
  };

  // ── controller ──
  controller: ColumnController = {
    select: (path) => runInAction(() => { this.sel.path = path; }),
    isSelected: (path) => this.sel.path === path,
    selectField: (key) => runInAction(() => { this.sel.fieldKey = key; }),
    selectedFieldKey: () => this.sel.fieldKey,
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
      const ck = `insert:${this.target.id}:${insertIdx}:${type}`;
      const id = this.target.insertAt(insertIdx, type, ck);
      const handle: ArrEditHandle = {
        _ck: ck,
        accept: () => {},
        cancel: () => { if (id) this.target.remove(id, ck); },
      };
      return { edit: handle, instanceKey: id ?? '' };
    },
    updateInsertEffect: (edit, _s, _c, _idx, instanceKey, type) => {
      this.target.setType(instanceKey, type, (edit as ArrEditHandle)._ck);
    },
    cancelInsertEffect: (edit) => edit.cancel(),

    // clipboard / smoothing / wiring are capability-gated off → never invoked.
    snapshotEffect: (): EffectClipboard | null => null,
    insertEffectFromClipboard: () => {},
    setFieldSmoothing: () => {},
    beginSetFieldSmoothing: (): EditHandle => ({ accept: () => {}, cancel: () => {} }),
    updateSetFieldSmoothing: () => {},
    connectWire: () => {},
    removeWire: () => {},
    updateWire: () => {},
    beginUpdateWire: (): EditHandle => ({ accept: () => {}, cancel: () => {} }),
    updateUpdateWire: () => {},
  };

  // ── taps (no-op: wiring off) ──
  taps: ColumnTaps = {
    get state() { return null; },
    beginFromFieldDrag: () => {},
    beginFromFieldClick: () => {},
    completeOnField: () => {},
    consumeClickSuppression: () => false,
  };
}
