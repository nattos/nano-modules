/**
 * Wire lowering — builds the executor's external-scalar table
 * (`executor_set_external_scalars`) from the sketches' device wires + the
 * MidiManager's current value tables.
 *
 * Pure and allocation-light: only endpoints actually referenced by a `midi:`
 * wire are included, and endpoints with no known value are OMITTED — an
 * absent value is the executor's dormant-wire signal (dest keeps its authored
 * value), which is exactly right for a missing/never-touched device. Keys are
 * emitted sorted so identical states produce identical JSON (callers dedupe
 * pushes by string compare).
 */

import { isMidiInstanceKey, midiInstanceIdFromKey } from './midi-types';
import type { Sketch } from '../sketch-types';

/** deviceInstanceId → the endpoint fields some wire reads. */
export function collectDeviceWireRefs(
  sketches: Record<string, Sketch | undefined>,
): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const sketch of Object.values(sketches)) {
    if (!sketch?.wires) continue;
    for (const wire of sketch.wires) {
      const key = wire.src?.instanceKey;
      if (!key || !isMidiInstanceKey(key) || !wire.src.field) continue;
      const id = midiInstanceIdFromKey(key)!;
      let fields = refs.get(id);
      if (!fields) { fields = new Set(); refs.set(id, fields); }
      fields.add(wire.src.field);
    }
  }
  return refs;
}

/**
 * The external-scalar JSON (`{"midi:<uuid>": {"b0/e05/turn": 0.42}}`).
 * `values` resolves an instance's current merged live+sim table
 * (`MidiManager.getValues`). Returns '{}' when nothing is wired/valued.
 */
export function buildExternalScalars(
  sketches: Record<string, Sketch | undefined>,
  values: (deviceInstanceId: string) => ReadonlyMap<string, number>,
): string {
  const refs = collectDeviceWireRefs(sketches);
  const out: Record<string, Record<string, number>> = {};
  for (const id of [...refs.keys()].sort()) {
    const table = values(id);
    let entry: Record<string, number> | null = null;
    for (const field of [...refs.get(id)!].sort()) {
      const v = table.get(field);
      if (v === undefined) continue;   // unknown → dormant wire
      (entry ??= {})[field] = v;
    }
    if (entry) out[`midi:${id}`] = entry;
  }
  return JSON.stringify(out);
}
