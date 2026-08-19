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

/** Schema io bits: 1 = input, 2 = output, 4 = primary. */
export const IO_INPUT = 1;
export const IO_OUTPUT = 2;
export const IO_PRIMARY = 4;

type Schema = Record<string, any> | undefined;

/** The data class a wire carries, derived from its PRODUCER field's schema. */
export type WireKind = 'float' | 'texture' | 'struct' | null;

export function wireKindOfField(schema: Schema, field: string): WireKind {
  const d = schema?.[field];
  const t = d?.type;
  if (t === 'float') return 'float';
  if (t === 'texture') return 'texture';
  if (t === 'object' || t === 'array') return 'struct';
  return null;
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
  let input = '';
  let output = '';
  if (kind === 'float') {
    input = modChannel(schema, IO_INPUT) || firstFieldOfType(schema, 'float', IO_INPUT);
    output = modChannel(schema, IO_OUTPUT) || firstFieldOfType(schema, 'float', IO_OUTPUT);
  } else if (kind === 'texture') {
    input = firstFieldOfType(schema, 'texture', IO_INPUT) || 'tex_in';
    output = firstFieldOfType(schema, 'texture', IO_OUTPUT) || 'tex_out';
  } else {
    input = firstFieldOfType(schema, ['object', 'array'], IO_INPUT);
    output = firstFieldOfType(schema, ['object', 'array'], IO_OUTPUT);
  }
  return input && output ? { input, output } : null;
}
