/**
 * Device-wires model — pure collection/grouping of every `midi:` wire a
 * device (or a subset of its controls) drives, across ALL instances of the
 * composition. Feeds the Devices tab's wires panel (device-wires-panel.ts).
 * Dependency-free (no appState/DOM) so it unit-tests over plain sketch docs.
 */

import type { ModuleEntry, Sketch, Wire } from '../../sketch-types';
import { sketchChain } from '../../sketch-types';
import {
  midiInstanceIdFromKey, midiInstanceKey, parseControlId, type ControlGesture,
} from '../../midi/midi-types';

/** What every row carries: the wire plus THIS device's end of it. */
interface DeviceWireRowBase {
  wire: Wire;
  /** Physical control id ('b0/e05') — the gesture-less endpoint prefix. */
  controlId: string;
  gesture: ControlGesture;
}

/** A device→field modulation wire, resolved against its sketch's chain. */
export interface DeviceModWireRow extends DeviceWireRowBase {
  kind: 'mod';
  /** Chain position of the dest module (single-column sketches: colIdx 0). */
  chainIdx: number;
  dest: ModuleEntry;
}

/** A device→device control ALIAS. Undirected, so `peer` is simply whichever
 *  end isn't this device — which may be this same device (two of its own
 *  controls aliased together). */
export interface DeviceAliasWireRow extends DeviceWireRowBase {
  kind: 'alias';
  peer: { deviceId: string; controlId: string; gesture: ControlGesture };
}

export type DeviceWireRow = DeviceModWireRow | DeviceAliasWireRow;

/** All of one instance's rows; groups are ordered selected-instance-first. */
export interface DeviceWireGroup {
  sketchId: string;
  rows: DeviceWireRow[];
}

/**
 * Collect every wire that touches `deviceId` (optionally restricted to the
 * physical controls in `controlIds`) across `sketchIds`, grouped per sketch:
 * the modulation wires it SOURCES, plus the control aliases it sits on at
 * either end (an alias has no writer — see alias-groups.ts).
 *
 * `sketchIds` is the composition scan set — instance keys are sketch ids in
 * every mode (pg:* in Playground, barrel UUIDs in Live). Duplicates are
 * ignored; ids with no sketch or no matching wires produce no group. Groups
 * keep `sketchIds` order (callers put the currently-edited instance first);
 * rows keep the sketch's wire order.
 */
export function collectDeviceWires(
  sketches: Record<string, Sketch | undefined>,
  sketchIds: Iterable<string>,
  deviceId: string,
  controlIds: string[] | null,
): DeviceWireGroup[] {
  const srcKey = midiInstanceKey(deviceId);
  const groups: DeviceWireGroup[] = [];
  const seen = new Set<string>();
  for (const sketchId of sketchIds) {
    if (seen.has(sketchId)) continue;
    seen.add(sketchId);
    const sketch = sketches[sketchId];
    if (!sketch?.wires?.length) continue;
    const chain = sketchChain(sketch);
    const rows: DeviceWireRow[] = [];
    for (const wire of sketch.wires) {
      const destDeviceId = midiInstanceIdFromKey(wire.dest.instanceKey);
      if (destDeviceId !== null) {
        // Control alias — match on EITHER end, and emit one row per end when
        // both are ours (a device aliased to itself across two controls).
        for (const [mine, theirs] of [[wire.src, wire.dest], [wire.dest, wire.src]] as const) {
          if (midiInstanceIdFromKey(mine.instanceKey) !== deviceId) continue;
          const parsed = parseControlId(mine.field);
          const peer = parseControlId(theirs.field);
          if (!parsed || !peer) continue;
          if (controlIds && !controlIds.includes(parsed.controlId)) continue;
          rows.push({
            kind: 'alias',
            wire,
            controlId: parsed.controlId,
            gesture: parsed.gesture,
            peer: {
              deviceId: midiInstanceIdFromKey(theirs.instanceKey) ?? '',
              controlId: peer.controlId,
              gesture: peer.gesture,
            },
          });
        }
        continue;
      }
      if (wire.src.instanceKey !== srcKey) continue;
      const parsed = parseControlId(wire.src.field);
      if (!parsed) continue;
      if (controlIds && !controlIds.includes(parsed.controlId)) continue;
      const chainIdx = chain.findIndex(
        e => e.type === 'module' && e.instance_key === wire.dest.instanceKey);
      if (chainIdx < 0) continue;   // dangling dest — nothing to configure/locate
      rows.push({
        kind: 'mod',
        wire,
        controlId: parsed.controlId,
        gesture: parsed.gesture,
        chainIdx,
        dest: chain[chainIdx] as ModuleEntry,
      });
    }
    if (rows.length > 0) groups.push({ sketchId, rows });
  }
  return groups;
}

/** One MISSING device reconstructed from the wires that reference it. */
export interface GhostDevice {
  /** The uuid the wires reference — no library device answers to it. */
  deviceId: string;
  wireCount: number;
  sketchCount: number;
  perSketch: { sketchId: string; wireIds: string[] }[];
  /** Distinct physical controls used, with the gesture set seen per control. */
  controls: { controlId: string; gestures: ControlGesture[] }[];
}

/**
 * Group every wire referencing an UNKNOWN `midi:<uuid>` into per-device
 * "ghosts" — one per missing uuid, with control/wire/sketch tallies. The
 * Devices tab renders these as placeholder cards whose adopt/alias actions
 * revive the mappings WITHOUT rewriting any sketch wires (the uuid either
 * becomes a real instance id, or a `knownAs` alias of one).
 * `knownDeviceIds` should be `libraryKnownIds(library)` — ids ∪ aliases,
 * deleted included (a wire to a deleted device is restorable, not a ghost).
 */
export function collectGhostDevices(
  sketches: Record<string, Sketch | undefined>,
  sketchIds: Iterable<string>,
  knownDeviceIds: ReadonlySet<string>,
): GhostDevice[] {
  const byDevice = new Map<string, {
    perSketch: Map<string, string[]>;
    gestures: Map<string, Set<ControlGesture>>;
    wireCount: number;
  }>();
  const seen = new Set<string>();
  for (const sketchId of sketchIds) {
    if (seen.has(sketchId)) continue;
    seen.add(sketchId);
    const sketch = sketches[sketchId];
    if (!sketch?.wires?.length) continue;
    for (const wire of sketch.wires) {
      // BOTH ends can name a device: a control alias's peer is just as much a
      // missing device as an unknown wire source, and adopting it revives the
      // alias the same way.
      for (const end of [wire.src, wire.dest]) {
        const devId = midiInstanceIdFromKey(end.instanceKey);
        if (!devId || knownDeviceIds.has(devId)) continue;
        let g = byDevice.get(devId);
        if (!g) {
          g = { perSketch: new Map(), gestures: new Map(), wireCount: 0 };
          byDevice.set(devId, g);
        }
        g.wireCount++;
        const ids = g.perSketch.get(sketchId) ?? [];
        ids.push(wire.id);
        g.perSketch.set(sketchId, ids);
        const parsed = parseControlId(end.field);
        if (parsed) {
          const gs = g.gestures.get(parsed.controlId) ?? new Set<ControlGesture>();
          gs.add(parsed.gesture);
          g.gestures.set(parsed.controlId, gs);
        }
      }
    }
  }
  return [...byDevice.entries()].map(([deviceId, g]) => ({
    deviceId,
    wireCount: g.wireCount,
    sketchCount: g.perSketch.size,
    perSketch: [...g.perSketch.entries()].map(([sketchId, wireIds]) => ({ sketchId, wireIds })),
    controls: [...g.gestures.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([controlId, gestures]) => ({ controlId, gestures: [...gestures] })),
  }));
}
