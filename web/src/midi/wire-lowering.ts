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
import { aliasEdgeKey, type AliasEdge } from './alias-groups';
import type { Sketch, Wire } from '../sketch-types';

/** True for a wire whose BOTH endpoints are device controls — a control
 *  ALIAS, not a modulation wire. It synthesizes no rail and no read tap; the
 *  host value tables fold it instead (see alias-groups.ts). */
export function isAliasWire(wire: Wire): boolean {
  return isMidiInstanceKey(wire.src?.instanceKey ?? '')
      && isMidiInstanceKey(wire.dest?.instanceKey ?? '');
}

/**
 * Every control alias in the document, deduped by unordered endpoint pair.
 * Self-aliases (a control wired to itself) are dropped — they are no-ops that
 * would otherwise widen a group for nothing.
 */
export function collectAliasEdges(
  sketches: Record<string, Sketch | undefined>,
): AliasEdge[] {
  const out: AliasEdge[] = [];
  const seen = new Set<string>();
  for (const sketch of Object.values(sketches)) {
    if (!sketch?.wires) continue;
    for (const wire of sketch.wires) {
      if (!isAliasWire(wire) || !wire.src.field || !wire.dest.field) continue;
      const a = { deviceId: midiInstanceIdFromKey(wire.src.instanceKey)!, field: wire.src.field };
      const b = { deviceId: midiInstanceIdFromKey(wire.dest.instanceKey)!, field: wire.dest.field };
      if (a.deviceId === b.deviceId && a.field === b.field) continue;
      const key = aliasEdgeKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b });
    }
  }
  return out;
}

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
      // An alias wire references no sketch field — its endpoints reach the
      // executor only through whatever OTHER wires read the aliased controls.
      if (isAliasWire(wire)) continue;
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
 *
 * `resolveId` maps a wire-referenced uuid to the CANONICAL instance that
 * answers for it (`knownAs` aliases): the output entry keeps the WIRE's uuid
 * (that's the rail key the executor looks up) while the values come from the
 * aliased device. Omitted → identity.
 */
export function buildExternalScalars(
  sketches: Record<string, Sketch | undefined>,
  values: (deviceInstanceId: string) => ReadonlyMap<string, number>,
  resolveId?: (referencedId: string) => string,
): string {
  const refs = collectDeviceWireRefs(sketches);
  const out: Record<string, Record<string, number>> = {};
  for (const id of [...refs.keys()].sort()) {
    const table = values(resolveId ? resolveId(id) : id);
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
