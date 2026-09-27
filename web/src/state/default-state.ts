/**
 * The state a freshly-created effect instance starts from — shared by the
 * editor's inserts (AppController) and the effect store's preview scenarios,
 * which must run an effect exactly as a fresh insert would (a wire folding
 * with `add` seeds from the field's current value, so an unseeded field reads
 * as the field's minimum).
 */

/** What seeding reads — satisfied by both the editor's and the engine's
 *  plugin records. */
export interface PluginDefaults {
  schema?: Record<string, any>;
  params: ReadonlyArray<{ name: string; defaultValue: any }>;
}

/**
 * Initial instance state for a plugin, seeded from its typed schema
 * defaults. The legacy `params` list is numeric-only — it coerces string
 * defaults to 0 and drops vector (float2/3/4, color) fields entirely — so a
 * source.text.plain node would come up with `text: 0` and no color. Reading the raw
 * schema `default` preserves strings (`"Text"`), numbers (`64`), bools, and
 * vectors as arrays (`[1,1,1,1]`), matching what the inspector widgets and
 * the native patch readers (patchString / patchVec4) expect. Falls back to
 * the params list for any field the schema didn't carry (or schema-less
 * plugins).
 */
export function defaultStateForPlugin(plugin: PluginDefaults): Record<string, any> {
  const state: Record<string, any> = {};
  const schema = (plugin.schema ?? {}) as Record<string, any>;
  // PURE OUTPUT fields (io & Output, NOT also an input) are live-published by
  // the running effect, not authored. Seeding them into instance state at the
  // schema default (0) bakes a stale 0 that shadows the engine's published
  // value in the field binding — the output trace would read 0.0 forever. Skip
  // them in BOTH loops. A field that is BOTH input and output (a relay, e.g. a
  // util.dashboard knob_i, io = in|out) IS authored — seed it like any input.
  const outputs = new Set<string>();
  for (const [name, field] of Object.entries(schema)) {
    const io = field?.io ?? 0;
    if ((io & 2) !== 0 && (io & 1) === 0) outputs.add(name);
  }
  for (const [name, field] of Object.entries(schema)) {
    if (field?.type === 'texture') continue;            // wiring, not state
    // Same reason: an `any` port carries a CONNECTION, not a value. It has no
    // declared type and so no meaningful default to seed, and the editor
    // renders it as a port rather than a widget.
    if (field?.type === 'any') continue;
    if (field?.type === 'help') continue;               // UI-only doc (see helpFieldNames)
    if (outputs.has(name)) continue;                    // live output, not state
    if (field?.default !== undefined) state[name] = field.default;
  }
  // The legacy `params` list carries no type/io, so it must re-apply BOTH
  // skips or it silently re-adds what the schema loop just excluded. Missing
  // the help skip here made this function non-idempotent with
  // pruneHelpFieldState: an effect whose schema is only a help field + pure
  // outputs (control.barrel_macros) defaulted to `{intro: 0}` instead of `{}`,
  // so backfillEmptyInstanceStates seeded `intro` and pruneHelpFieldState
  // immediately stripped it — two mutations per snapshot, each restamping
  // lastModified, which defeated the push dedup and drove a push↔refetch loop
  // that wholesale-replaced the sketch ~70x/sec and ate the user's edits.
  const help = helpFieldNames(plugin);
  for (const p of plugin.params) {
    if (outputs.has(p.name)) continue;
    if (help.has(p.name)) continue;
    if (!(p.name in state)) state[p.name] = p.defaultValue;
  }
  return state;
}

/** A plugin's help-slot field names (UI-only docs, never state). */
export function helpFieldNames(plugin: Pick<PluginDefaults, 'schema'>): Set<string> {
  const out = new Set<string>();
  const schema = (plugin.schema ?? {}) as Record<string, any>;
  for (const [name, field] of Object.entries(schema)) {
    if (field?.type === 'help') out.add(name);
  }
  return out;
}
