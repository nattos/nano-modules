/**
 * multi-edit — the PURE reconciliation core for editing several selected clips
 * at once. Given a list of clips (clips[0] is the template), it computes which
 * effects / wires / rail taps are "common" across all of them (editable
 * together) and which are "ragged" (present in only some, or hanging off ragged
 * effects — surfaced as a single collapsed placeholder the user can delete).
 *
 * Deliberately store-free and DOM-free so it's trivially unit-testable: plain
 * `Clip[]` in, plain data out. The only outside knowledge it needs — a field's
 * default when a clip hasn't authored a value — is INJECTED as `resolveDefault`.
 *
 * Effect matching is BY `moduleType` ONLY (a renamed same-type effect still
 * groups); duplicate types pair positionally via a greedy front-pop.
 */

import type { Clip, Device, RailExport, RailRead } from '../model/composition';
import type { Wire } from '../../../sketch-types';

/** Selected clips in selection order; `clips[0]` is the reconciliation template. */
export type ClipList = readonly Clip[];

// ── Multi-selection sketch id (one place owns the format) ────────────────────

/**
 * The stable column/sketch id for a multi-clip selection: order-INDEPENDENT (the
 * clip set is sorted) so the same selection re-uses the same adapter + mounted
 * column-group. NOTE: this deliberately discards the primary-first order, so it's
 * an identity key only — never reconstruct the reconciliation template order from
 * it (use the live selection's primary-first order instead).
 */
export function multiSketchId(refs: readonly { trackId: string; clipId: string }[]): string {
  return 'multi/' + refs.map((r) => `${r.trackId}/${r.clipId}`).sort().join(',');
}

/** Inverse of {@link multiSketchId} (sorted order — see the caveat there). */
export function parseMultiSketchId(id: string): { trackId: string; clipId: string }[] {
  if (!id.startsWith('multi/')) return [];
  return id
    .slice('multi/'.length)
    .split(',')
    .filter(Boolean)
    .map((chunk) => {
      const [trackId, clipId] = chunk.split('/');
      return { trackId, clipId };
    });
}

// ── Devices ────────────────────────────────────────────────────────────────

/** One effect present (by type, positionally) in EVERY selected clip. */
export interface CommonDevice {
  moduleType: string;
  /** Representative device id — clips[0]'s matched device. */
  repId: string;
  /** clipId → matched device id, one entry per selected clip (incl. clips[0]). */
  idByClip: Map<string, string>;
}

/**
 * A run of ragged (non-common) devices sitting in one gap between common
 * entries. `gapIndex` is in `[0, common.length]`: the segment sits BEFORE
 * `common[gapIndex]` (`=== common.length` ⇒ after the last common entry).
 */
export interface RaggedSegment {
  gapIndex: number;
  /** clipId → the ragged device ids that clip contributes in this gap. */
  idsByClip: Map<string, string[]>;
  /** Total ragged devices across all clips in this gap (placeholder count). */
  count: number;
}

export interface DeviceReconciliation {
  common: CommonDevice[];
  /** Only non-empty gaps, ascending by `gapIndex`. */
  ragged: RaggedSegment[];
}

/**
 * Greedy front-pop reconciliation. For each template device (clips[0],
 * front→back) we look for the first not-yet-consumed device of the same
 * `moduleType` in every other clip. If all clips yield one, it's common and the
 * devices skipped over in each clip fall into the current gap. If any clip
 * lacks it, the template device itself is ragged (and other cursors don't
 * advance, so a later template device can still match them).
 */
export function reconcileDevices(clips: ClipList): DeviceReconciliation {
  const common: CommonDevice[] = [];
  const ragged: RaggedSegment[] = [];

  if (clips.length === 0) return { common, ragged };

  const template = clips[0];
  const others = clips.slice(1);
  const cursors = others.map(() => 0); // first unconsumed index in each other clip

  // Ragged devices collected for the gap we're currently in, keyed by clipId.
  let curGap: Map<string, string[]> = new Map();
  const pushRagged = (clipId: string, deviceId: string) => {
    const arr = curGap.get(clipId);
    if (arr) arr.push(deviceId);
    else curGap.set(clipId, [deviceId]);
  };
  const flushGap = (gapIndex: number) => {
    let count = 0;
    for (const arr of curGap.values()) count += arr.length;
    if (count > 0) ragged.push({ gapIndex, idsByClip: curGap, count });
    curGap = new Map();
  };

  for (const t of template.sketch.devices) {
    // Tentatively locate a same-type match at/after each other clip's cursor.
    const found: number[] = [];
    let allMatch = true;
    for (let j = 0; j < others.length; j++) {
      const devs = others[j].sketch.devices;
      let idx = -1;
      for (let k = cursors[j]; k < devs.length; k++) {
        if (devs[k].moduleType === t.moduleType) { idx = k; break; }
      }
      if (idx < 0) { allMatch = false; break; }
      found.push(idx);
    }

    if (allMatch) {
      // Everything skipped over in each other clip becomes ragged in this gap.
      const idByClip = new Map<string, string>();
      idByClip.set(template.id, t.id);
      for (let j = 0; j < others.length; j++) {
        const devs = others[j].sketch.devices;
        for (let k = cursors[j]; k < found[j]; k++) pushRagged(others[j].id, devs[k].id);
        idByClip.set(others[j].id, devs[found[j]].id);
        cursors[j] = found[j] + 1;
      }
      flushGap(common.length); // gap sits BEFORE the common entry we're about to add
      common.push({ moduleType: t.moduleType, repId: t.id, idByClip });
    } else {
      // The template device is ragged; other cursors stay put.
      pushRagged(template.id, t.id);
    }
  }

  // Tails of every other clip (and any trailing template ragged) → final gap.
  for (let j = 0; j < others.length; j++) {
    const devs = others[j].sketch.devices;
    for (let k = cursors[j]; k < devs.length; k++) pushRagged(others[j].id, devs[k].id);
  }
  flushGap(common.length);

  return { common, ragged };
}

// ── Field aggregation across a common entry's matched devices ────────────────

export interface FieldAggregate {
  /** True when the selected clips don't all share one value for this field. */
  mixed: boolean;
  /** A representative value (clips[0]'s) — a sane default for numeric widgets. */
  value: unknown;
  /** Distinct values in use across all clips (for enum multi-highlight). */
  inUse: unknown[];
}

/** Resolve a field's authored value, falling back to an injected default. */
function fieldValue(
  clip: Clip,
  deviceId: string,
  field: string,
  resolveDefault?: (moduleType: string, field: string) => unknown,
): unknown {
  const dev = clip.sketch.devices.find((d) => d.id === deviceId);
  const v = dev?.state?.[field];
  if (v !== undefined && v !== null) return v;
  return dev && resolveDefault ? resolveDefault(dev.moduleType, field) : v;
}

export function aggregateField(
  clips: ClipList,
  common: CommonDevice,
  field: string,
  resolveDefault?: (moduleType: string, field: string) => unknown,
): FieldAggregate {
  const inUse: unknown[] = [];
  let repValue: unknown = undefined;
  for (const clip of clips) {
    const id = common.idByClip.get(clip.id);
    if (id === undefined) continue;
    const v = fieldValue(clip, id, field, resolveDefault);
    if (clip === clips[0]) repValue = v;
    if (!inUse.some((u) => u === v)) inUse.push(v); // exact `===` over authored values
  }
  return { mixed: inUse.length > 1, value: repValue, inUse };
}

// ── Wires (intra-sketch modulation) ──────────────────────────────────────────

export interface WireKey {
  srcCommon: number; srcField: string;
  destCommon: number; destField: string;
}
export interface CommonWire {
  key: WireKey;
  /** Representative wire id — clips[0]'s. */
  repId: string;
  idByClip: Map<string, string>;
}
export interface WireReconciliation {
  common: CommonWire[];
  /** clipId → ids of wires that are NOT in a common group. */
  raggedIdsByClip: Map<string, string[]>;
  /** Total ragged wires across all clips (the "other wires" badge count). */
  raggedCount: number;
}

/** clipId → (deviceId → its common-entry index), for endpoint classification. */
function commonIndexMaps(clips: ClipList, dev: DeviceReconciliation): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const clip of clips) out.set(clip.id, new Map());
  dev.common.forEach((c, i) => {
    for (const [clipId, deviceId] of c.idByClip) out.get(clipId)?.set(deviceId, i);
  });
  return out;
}

function wireKey(w: Wire, idxOf: Map<string, number>): WireKey | null {
  const s = idxOf.get(w.src.instanceKey);
  const d = idxOf.get(w.dest.instanceKey);
  if (s === undefined || d === undefined) return null; // endpoint on a ragged device
  return { srcCommon: s, srcField: w.src.field, destCommon: d, destField: w.dest.field };
}

function wireKeyStr(k: WireKey): string {
  return `${k.srcCommon}|${k.srcField}|${k.destCommon}|${k.destField}`;
}

export function reconcileWires(clips: ClipList, dev: DeviceReconciliation): WireReconciliation {
  const idxMaps = commonIndexMaps(clips, dev);
  // Per clip: key string → wire id (only wires with both endpoints common).
  const perClip: Map<string, Map<string, { id: string; key: WireKey }>> = new Map();
  const raggedIdsByClip = new Map<string, string[]>();
  let raggedCount = 0;

  for (const clip of clips) {
    const idxOf = idxMaps.get(clip.id)!;
    const keyed = new Map<string, { id: string; key: WireKey }>();
    const raggedIds: string[] = [];
    for (const w of clip.sketch.wires ?? []) {
      const k = wireKey(w, idxOf);
      if (k) keyed.set(wireKeyStr(k), { id: w.id, key: k });
      else raggedIds.push(w.id);
    }
    perClip.set(clip.id, keyed);
    if (raggedIds.length) { raggedIdsByClip.set(clip.id, raggedIds); raggedCount += raggedIds.length; }
  }

  // A key is common iff present in every clip's keyed map. Drive off clips[0].
  const common: CommonWire[] = [];
  const tmpl = perClip.get(clips[0]?.id ?? '');
  if (tmpl) {
    for (const [ks, { id, key }] of tmpl) {
      const idByClip = new Map<string, string>();
      let all = true;
      for (const clip of clips) {
        const hit = perClip.get(clip.id)?.get(ks);
        if (!hit) { all = false; break; }
        idByClip.set(clip.id, hit.id);
      }
      if (all) common.push({ key, repId: id, idByClip });
      else {
        // clips[0]'s wire is ragged after all — move it to the ragged tally.
        const arr = raggedIdsByClip.get(clips[0].id) ?? [];
        arr.push(id);
        raggedIdsByClip.set(clips[0].id, arr);
        raggedCount += 1;
      }
    }
  }

  // Wires on a NON-template clip whose key isn't common are ragged too (e.g. an
  // extra wire between two common devices that clips[0] simply doesn't have). The
  // tmpl-driven loop above can't see these, so sweep them here.
  const commonKeys = new Set(common.map((c) => wireKeyStr(c.key)));
  for (const clip of clips) {
    if (clip.id === clips[0]?.id) continue;
    for (const [ks, { id }] of perClip.get(clip.id) ?? []) {
      if (commonKeys.has(ks)) continue;
      const arr = raggedIdsByClip.get(clip.id) ?? [];
      arr.push(id);
      raggedIdsByClip.set(clip.id, arr);
      raggedCount += 1;
    }
  }

  return { common, raggedIdsByClip, raggedCount };
}

// ── Rail exports / reads (return-track modulations) ──────────────────────────

export interface RailExportKey { railId: string; srcCommon: number; sourceField: string; }
export interface RailReadKey { railId: string; destCommon: number; targetField: string; }
export interface CommonRailTap<K> { key: K; repId: string; idByClip: Map<string, string>; }
export interface RailReconciliation {
  exports: CommonRailTap<RailExportKey>[];
  reads: CommonRailTap<RailReadKey>[];
  raggedExportIdsByClip: Map<string, string[]>;
  raggedReadIdsByClip: Map<string, string[]>;
  raggedCount: number;
}

function reconcileTaps<T extends { id: string }, K>(
  clips: ClipList,
  getTaps: (clip: Clip) => readonly T[],
  keyOf: (t: T, idxOf: Map<string, number>) => K | null,
  keyStr: (k: K) => string,
): { common: CommonRailTap<K>[]; raggedByClip: Map<string, string[]>; raggedCount: number } {
  const idxMaps = commonIndexMaps(clips, reconcileDevicesCacheFor(clips));
  const perClip = new Map<string, Map<string, { id: string; key: K }>>();
  const raggedByClip = new Map<string, string[]>();
  let raggedCount = 0;

  for (const clip of clips) {
    const idxOf = idxMaps.get(clip.id)!;
    const keyed = new Map<string, { id: string; key: K }>();
    const ragged: string[] = [];
    for (const t of getTaps(clip)) {
      const k = keyOf(t, idxOf);
      if (k) keyed.set(keyStr(k), { id: t.id, key: k });
      else ragged.push(t.id);
    }
    perClip.set(clip.id, keyed);
    if (ragged.length) { raggedByClip.set(clip.id, ragged); raggedCount += ragged.length; }
  }

  const common: CommonRailTap<K>[] = [];
  const tmpl = perClip.get(clips[0]?.id ?? '');
  if (tmpl) {
    for (const [ks, { id, key }] of tmpl) {
      const idByClip = new Map<string, string>();
      let all = true;
      for (const clip of clips) {
        const hit = perClip.get(clip.id)?.get(ks);
        if (!hit) { all = false; break; }
        idByClip.set(clip.id, hit.id);
      }
      if (all) common.push({ key, repId: id, idByClip });
      else {
        const arr = raggedByClip.get(clips[0].id) ?? [];
        arr.push(id);
        raggedByClip.set(clips[0].id, arr);
        raggedCount += 1;
      }
    }
  }
  // Non-template taps whose key isn't common are ragged too (same gap the
  // tmpl-driven loop misses — an extra tap on a common device only some clips have).
  const commonKeys = new Set(common.map((c) => keyStr(c.key)));
  for (const clip of clips) {
    if (clip.id === clips[0]?.id) continue;
    for (const [ks, { id }] of perClip.get(clip.id) ?? []) {
      if (commonKeys.has(ks)) continue;
      const arr = raggedByClip.get(clip.id) ?? [];
      arr.push(id);
      raggedByClip.set(clip.id, arr);
      raggedCount += 1;
    }
  }
  return { common, raggedByClip, raggedCount };
}

// Rails need the device reconciliation to classify endpoints. Recomputing it is
// cheap; callers that already have one should use `reconcileRails(clips, dev)`.
let _railsDevHint: DeviceReconciliation | null = null;
function reconcileDevicesCacheFor(clips: ClipList): DeviceReconciliation {
  return _railsDevHint ?? reconcileDevices(clips);
}

export function reconcileRails(clips: ClipList, dev: DeviceReconciliation): RailReconciliation {
  _railsDevHint = dev;
  try {
    const exp = reconcileTaps<RailExport, RailExportKey>(
      clips,
      (c) => c.exports ?? [],
      (t, idxOf) => {
        const s = idxOf.get(t.sourceDeviceId);
        return s === undefined ? null : { railId: t.railId, srcCommon: s, sourceField: t.sourceField };
      },
      (k) => `${k.railId}|${k.srcCommon}|${k.sourceField}`,
    );
    const rd = reconcileTaps<RailRead, RailReadKey>(
      clips,
      (c) => c.reads ?? [],
      (t, idxOf) => {
        const d = idxOf.get(t.targetDeviceId);
        return d === undefined ? null : { railId: t.railId, destCommon: d, targetField: t.targetField };
      },
      (k) => `${k.railId}|${k.destCommon}|${k.targetField}`,
    );
    return {
      exports: exp.common,
      reads: rd.common,
      raggedExportIdsByClip: exp.raggedByClip,
      raggedReadIdsByClip: rd.raggedByClip,
      raggedCount: exp.raggedCount + rd.raggedCount,
    };
  } finally {
    _railsDevHint = null;
  }
}

// ── Insertion anchoring ──────────────────────────────────────────────────────

/**
 * The real `sketch.devices` insertion index in `clip` for a multi-edit insert
 * at common slot `commonIndex` (`0..common.length`). Inserts immediately BEFORE
 * `common[commonIndex]`'s matched device, or at the end when
 * `commonIndex === common.length`.
 */
export function clipInsertIndex(clip: Clip, dev: DeviceReconciliation, commonIndex: number): number {
  if (commonIndex >= dev.common.length) return clip.sketch.devices.length;
  const targetId = dev.common[commonIndex].idByClip.get(clip.id);
  if (targetId === undefined) return clip.sketch.devices.length;
  const idx = clip.sketch.devices.findIndex((d) => d.id === targetId);
  return idx < 0 ? clip.sketch.devices.length : idx;
}

// ── Top-level convenience ─────────────────────────────────────────────────────

export interface MultiEditModel {
  clips: ClipList;
  devices: DeviceReconciliation;
  wires: WireReconciliation;
  rails: RailReconciliation;
}

export function buildMultiEditModel(clips: ClipList): MultiEditModel {
  const devices = reconcileDevices(clips);
  return {
    clips,
    devices,
    wires: reconcileWires(clips, devices),
    rails: reconcileRails(clips, devices),
  };
}
