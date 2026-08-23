/**
 * Picking a module's ports from its schema.
 *
 * Used when a wire is spliced through a newly inserted node (double-click a
 * wire): the new node has to be bound to ports that match the wire's data type,
 * without asking the user which ones.
 *
 * `modChannel` is a LOCK-STEP port of the same-named lambda in
 * native/src/sketch/sketch_executor.cpp's modulation auto-connect. Keep the
 * selection rule identical, or a shaper spliced in by the UI binds to a
 * different field than the one auto-connect would have chosen.
 */

import { RESERVED_FIELD_DEFS } from '../sketch-types';

/** Schema io bits: 1 = input, 2 = output, 4 = primary. */
export const IO_INPUT = 1;
export const IO_OUTPUT = 2;
export const IO_PRIMARY = 4;

type Schema = Record<string, any> | undefined;

/**
 * The data class a wire carries, derived from its PRODUCER field's schema.
 *
 * `'any'` is the UNRESOLVED state of a polymorphic port, not a class a rail can
 * actually be: the executor resolves it to one of the others at lowering time,
 * and {@link resolveWireKind} is the editor's twin of that walk.
 */
export type WireKind = 'float' | 'texture' | 'struct' | 'vec' | 'any' | null;

/**
 * The data class of one endpoint's field. The reserved card controls
 * (`__opacity__` / `__enable__`) aren't in any module's schema but are ordinary
 * float destinations — without the fallback, healing a wire onto a card's
 * opacity would look like a type mismatch.
 *
 * Returns `'any'` for a POLYMORPHIC field, whose real class depends on what is
 * wired to it and so cannot be answered from a schema alone. Callers that need
 * the resolved answer use {@link resolveWireKind}, which walks the graph.
 */
export function wireKindOfField(schema: Schema, field: string): WireKind {
  const d = schema?.[field] ?? RESERVED_FIELD_DEFS[field];
  const t = d?.type;
  if (t === 'float') return 'float';
  if (t === 'texture') return 'texture';
  if (t === 'object' || t === 'array') return 'struct';
  // Vectors and colours. All four widths share one class here; the executor's
  // rail records the component count, and connect-time compatibility is the
  // caller's business (a float3 into a float4 is not a wire).
  if (t === 'float2' || t === 'float3' || t === 'float4') return 'vec';
  if (t === 'any') return 'any';
  return null;
}

/** One endpoint of a wire, as both the document and this module address it. */
export interface WireEndpoint { instanceKey: string; field: string }
/** The subset of a wire this resolver reads. */
export interface WireEdge { src: WireEndpoint; dest: WireEndpoint }

/**
 * The CONCRETE data class behind a producer output, following `any` fields back
 * through the wire graph.
 *
 * LOCK-STEP port of `resolveWireDef` in native/src/sketch/sketch_executor.cpp's
 * wire lowering — the executor decides what rail a wire actually becomes, and if
 * this disagrees the editor shows a connection the engine dropped (or refuses
 * one it would have made). Keep the two rules identical.
 *
 * The tie-break, when a node's `any` inputs are wired to different types: the
 * LOWEST-numbered wired input decides ("case 1 picks the type"), ordered by the
 * schema's `order` key. Deliberately not a type-ordering table — a shared
 * ordering would be a second thing to keep in lock-step across the two
 * languages, which is exactly the shape of bug that has bitten here before.
 *
 * Returns null when unresolvable: nothing wired behind the `any` yet, or a
 * cycle. The executor drops such a wire, so the editor treats it as untyped.
 *
 * @param schemaOf  module schema by INSTANCE key (callers hold the chain).
 * @param wires     every wire in the sketch.
 */
export function resolveWireKind(
  schemaOf: (instanceKey: string) => Schema,
  wires: readonly WireEdge[],
  instanceKey: string,
  field: string,
  depth = 0,
): WireKind {
  if (depth > 16) return null;
  // A device control (`midi:<uuid>`) has no chain entry; those rails are always
  // float, matching the executor's external-rail branch.
  if (instanceKey.startsWith('midi:')) return 'float';
  const schema = schemaOf(instanceKey);
  const kind = wireKindOfField(schema, field);
  if (kind !== 'any') return kind;                    // concrete — done
  // An `any` OUTPUT takes its class from this node's own `any` INPUTS, in
  // declaration order, first RESOLVED one wins.
  const ins = Object.entries(schema ?? {})
    .filter(([, d]) => d && typeof d === 'object'
      && (d as any).type === 'any' && (((d as any).io ?? 0) & IO_INPUT) !== 0)
    .sort(([an, ad], [bn, bd]) => {
      const ao = (ad as any).order ?? 1e6, bo = (bd as any).order ?? 1e6;
      return ao !== bo ? ao - bo : an.localeCompare(bn);
    });
  for (const [name] of ins) {
    for (const w of wires) {
      if (w.dest.instanceKey !== instanceKey || w.dest.field !== name) continue;
      const sub = resolveWireKind(schemaOf, wires, w.src.instanceKey, w.src.field, depth + 1);
      if (sub) return sub;
    }
  }
  return null;                                        // no input wired → unknown
}

/**
 * A module's modulation channel for one io direction: the magnitude-marked
 * float field, preferring the one flagged primary. Empty when the module
 * exposes no channel in that direction.
 */
export function modChannel(schema: Schema, ioBit: number): string {
  if (!schema) return '';
  let primary = '';
  let any = '';
  for (const [name, d] of Object.entries(schema)) {
    if (!d || typeof d !== 'object') continue;
    if ((d as any).type !== 'float') continue;
    const io = (d as any).io ?? 0;
    if (!(io & ioBit)) continue;
    if (!('magnitude' in (d as any))) continue;   // channel marker
    if (!any) any = name;
    if ((io & IO_PRIMARY) && !primary) primary = name;
  }
  return primary || any;
}

/** First field of `type` with the given io bit, in schema `order` then name. */
function firstFieldOfType(schema: Schema, type: string | string[], ioBit: number): string {
  if (!schema) return '';
  const types = Array.isArray(type) ? type : [type];
  const entries = Object.entries(schema)
    .filter(([, d]) => d && typeof d === 'object'
      && types.includes((d as any).type)
      && (((d as any).io ?? 0) & ioBit) !== 0)
    .sort(([an, ad], [bn, bd]) => {
      const ao = (ad as any).order ?? 1000, bo = (bd as any).order ?? 1000;
      return ao !== bo ? ao - bo : an.localeCompare(bn);
    });
  return entries[0]?.[0] ?? '';
}

/**
 * The ports a node should use when a wire of `kind` is spliced THROUGH it.
 * Returns null when the module can't carry that kind in both directions — the
 * caller must then abandon the splice rather than leave a half-connected node.
 */
export function passthroughPorts(schema: Schema, kind: WireKind):
    { input: string; output: string } | null {
  if (!schema || !kind) return null;
  // An UNRESOLVED wire has no class to match ports against, so there is nothing
  // to splice it through. (A wire is only 'any' when nothing concrete is wired
  // behind it — the executor drops those too.)
  if (kind === 'any') return null;
  // A POLYMORPHIC node carries whatever it is handed, so its `any` ports match
  // every concrete kind. Checked first: a node declaring both (say `any` cases
  // plus a float selector) should splice through the port that can actually
  // carry the wire, not the one that merely shares its type.
  const anyIn = firstFieldOfType(schema, 'any', IO_INPUT);
  const anyOut = firstFieldOfType(schema, 'any', IO_OUTPUT);
  if (anyIn && anyOut) return { input: anyIn, output: anyOut };
  let input = '';
  let output = '';
  if (kind === 'float') {
    input = modChannel(schema, IO_INPUT) || firstFieldOfType(schema, 'float', IO_INPUT);
    output = modChannel(schema, IO_OUTPUT) || firstFieldOfType(schema, 'float', IO_OUTPUT);
  } else if (kind === 'texture') {
    // A module carries images only if it declares a texture OUTPUT — that's the
    // same test the executor uses for hasTextureOutput. Given one, an
    // undeclared input falls back to the conventional `tex_in` (the executor
    // binds slot 0 there regardless); without one, refuse rather than bind a
    // texture wire to fields the module doesn't have.
    output = firstFieldOfType(schema, 'texture', IO_OUTPUT);
    if (!output) return null;
    input = firstFieldOfType(schema, 'texture', IO_INPUT) || 'tex_in';
  } else if (kind === 'vec') {
    const VEC = ['float2', 'float3', 'float4'];
    input = firstFieldOfType(schema, VEC, IO_INPUT);
    output = firstFieldOfType(schema, VEC, IO_OUTPUT);
  } else {   // struct
    input = firstFieldOfType(schema, ['object', 'array'], IO_INPUT);
    output = firstFieldOfType(schema, ['object', 'array'], IO_OUTPUT);
  }
  return input && output ? { input, output } : null;
}
