/**
 * Effect registry — the set of REAL effects a clip's device chain can host,
 * DERIVED at runtime from the engine's discovered plugin schemas
 * (`store.enginePlugins`, keyed by effect id), not a hand-kept table.
 *
 * This is the single source of truth for:
 *   - building a real Structor `Sketch` from a clip (`clip-sketch.ts`),
 *   - seeding a device's default param state (`store.makeDevice`),
 *   - rendering the inspector's real param sliders,
 *   - the add-device palette (`availableEffects` in the column adapter).
 *
 * `role`: comes straight from the effect's declared CAPABILITIES — an effect
 * tagged `generator` (it synthesizes image output; can start a chain, possibly
 * compositing over an optional input) becomes the FIRST chain entry; everything
 * else is an `effect`, chained top-to-bottom (each reads the previous entry's
 * output implicitly, no wires). A clip with effect devices but no generator gets
 * an implicit solid stand-in as the first entry so the effects have a real input.
 *
 * `fields` / `outputs` are the effect's scalar FLOAT params, read from the
 * discovered schema: an input field (io&1) is an editable slider; an output field
 * (io&2) is a connectable wire source (e.g. a modulation source's value). The
 * field min/max IS the modulation-range contract. Non-float fields (vec / color /
 * bool / enum / texture) are intentionally omitted from this model, exactly as the
 * old hand-kept catalog did. Labels humanize the field key (the schema carries no
 * display name); effect display names humanize the id's last segment.
 *
 * Because effects are discovered after the engine boots and warms the bundles, the
 * registry getters (`effectCatalog`/`generators`/`effects`) are reactive functions,
 * NOT static arrays — they read `store.enginePlugins` live, so MobX-observed UI
 * fills in as discovery lands. Tests seed `store.setEnginePlugins([...])` to make
 * the registry resolve offline (see `engine/test-plugins.ts`).
 */

import type { PluginInfo } from '../../../engine-types';
import { store } from '../state/store';

export interface EffectField {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
}

export interface CatalogEffect {
  type: string;
  name: string;
  role: 'generator' | 'effect';
  fields: EffectField[];
  /** Declared scalar OUTPUTS (io&2) — e.g. a modulation source's value. Used to
   *  synthesize output schema entries so wires can connect from them. */
  outputs?: EffectField[];
}

/** The host-fed video source module type (added automatically for media clips). */
export const VIDEO_SOURCE_TYPE = 'source.video.file';

/**
 * Solid stand-in used as the first chain entry when a chain has no generator —
 * a real core source (renders solid, default black) so testonly is never loaded.
 */
export const IMPLICIT_ANCHOR = { type: 'source.solid_color' };

// ── Schema → catalog derivation ──────────────────────────────────────────────

// Acronyms that should stay uppercased when humanizing keys/ids into labels.
const ACRONYMS = new Set(['hsl', 'hsv', 'lfo', 'adsr', 'rgb', 'rgba', 'hdr', 'fft', 'kh', 'xy']);

function titleWord(w: string): string {
  return ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1);
}

/** "block_dehance" / "in min" → "Block Dehance" / "In Min". */
function humanize(s: string): string {
  return s.split(/[_\s]+/).filter(Boolean).map(titleWord).join(' ');
}

/** Display name for an effect id — humanize its last dot-segment ("color.hsl" → "HSL"). */
function effectName(id: string): string {
  return humanize(id.split('.').pop() ?? id);
}

/** Scalar FLOAT fields from a plugin's schema, in declared order, filtered by io
 *  direction (input: io&1; output: io&2). Mirrors the old catalog's float-only
 *  scope — non-float fields (texture/color/bool/enum/int) are skipped. */
function fieldsFrom(p: PluginInfo, want: 'input' | 'output'): EffectField[] {
  const schema = p.schema ?? {};
  const bit = want === 'output' ? 2 : 1;
  return Object.entries(schema)
    .filter(([, def]: [string, any]) => def?.type === 'float' && ((def.io ?? 0) & bit))
    .sort((a, b) => ((a[1] as any).order ?? 0) - ((b[1] as any).order ?? 0))
    .map(([key, def]: [string, any]) => ({
      key,
      label: humanize(key),
      min: typeof def.min === 'number' ? def.min : 0,
      max: typeof def.max === 'number' ? def.max : 1,
      default: typeof def.default === 'number' ? def.default : 0,
    }));
}

function pluginToCatalog(p: PluginInfo): CatalogEffect {
  const role = (p.capabilities ?? []).includes('generator') ? 'generator' : 'effect';
  const outputs = fieldsFrom(p, 'output');
  return {
    type: p.id,
    name: effectName(p.id),
    role,
    fields: fieldsFrom(p, 'input'),
    ...(outputs.length ? { outputs } : {}),
  };
}

// ── Public API (reads the live discovered plugins) ───────────────────────────

export function catalogEffect(type: string): CatalogEffect | undefined {
  const p = store.enginePlugin(type);
  return p ? pluginToCatalog(p) : undefined;
}

export function isCatalogEffect(type: string): boolean {
  return !!store.enginePlugin(type);
}

/** Default field state for an effect (float input field key → default value). */
export function defaultStateFor(type: string): Record<string, number> {
  const p = store.enginePlugin(type);
  const state: Record<string, number> = {};
  if (p) for (const f of fieldsFrom(p, 'input')) state[f.key] = f.default;
  return state;
}

/** All discovered effects as catalog descriptors (stable id order). */
export function effectCatalog(): CatalogEffect[] {
  return Object.values(store.enginePlugins)
    .map(pluginToCatalog)
    .sort((a, b) => a.type.localeCompare(b.type));
}

export function generators(): CatalogEffect[] {
  return effectCatalog().filter((e) => e.role === 'generator');
}

export function effects(): CatalogEffect[] {
  return effectCatalog().filter((e) => e.role === 'effect');
}
