/**
 * Per-instance field visibility — which of an effect's schema fields the editor
 * should render for ONE particular card.
 *
 * An effect's schema is published once per module TYPE (`module_init` takes no
 * `self`), so an effect whose field set depends on its mode declares the UNION
 * of every field it can ever expose and hides the inactive ones — the house
 * pattern in EFFECTS_STYLE_GUIDE.md. The hidden set, unlike the schema, is
 * genuinely per instance: two `source.brutal_fold` cards in different modes, or
 * two `mod.shaper.add` cards with different input counts, must resolve
 * independently.
 *
 * There are two sources for that set, in priority order:
 *
 *  1. A SYNCHRONOUS rule registered here, derived purely from the instance's own
 *     persisted state. No worker round trip, no live instance, no `await` — so
 *     the card paints the right field set on its FIRST render and the layout
 *     never shifts underneath the user. This is the path the math nodes'
 *     `input_count` takes; it is only available to effects whose visibility the
 *     UI can compute on its own.
 *  2. The engine's live per-instance set, forwarded from each `WasmHost`'s own
 *     `hiddenFields` (what the effect passed to `state::setFieldHidden`). This
 *     covers every wasm-declared conditional field, but only once that instance
 *     has actually executed.
 *
 * When neither answers, the caller falls back to whatever `hidden` flags the
 * broadcast schema already carries — a type-level, first-host-wins approximation
 * that is right whenever every instance of a type is in the same mode, and is
 * exactly what the editor used for everything before this module existed.
 */

import type { PluginInfo } from '../widgets/column-adapter';

/** Derives the hidden-field set for one instance from its own state. Pure. */
export type VisibilityRule = (state: Record<string, any>) => string[];

const rules = new Map<string, VisibilityRule>();

/**
 * Register a synchronous visibility rule for a module type. Rules must be PURE
 * functions of the passed state — they run inside render, on every card, every
 * frame.
 */
export function registerVisibilityRule(moduleType: string, rule: VisibilityRule): void {
  rules.set(moduleType, rule);
}

/** True when a module type has a synchronous rule (i.e. needs no engine round trip). */
export function hasVisibilityRule(moduleType: string): boolean {
  return rules.has(moduleType);
}

/**
 * The hidden-field set for one instance, or null to leave the schema as-is.
 * Synchronous rule first, then the engine's live per-instance set.
 */
export function hiddenFieldsFor(
  moduleType: string,
  state: Record<string, any> | undefined,
  liveHidden?: readonly string[] | null,
): string[] | null {
  const rule = rules.get(moduleType);
  if (rule) return rule(state ?? {});
  // PRESENCE is the signal, not length: an empty array is a live instance
  // saying "I hide nothing", which must still override the type-level flags on
  // the broadcast schema. Only `undefined`/`null` — no live instance — declines.
  return liveHidden ? [...liveHidden] : null;
}

// Memo: `applyHidden` runs inside render and allocates a fresh plugin + schema,
// so an uncached version would hand Lit/MobX a new object identity every frame
// and defeat every downstream dirty check. Keyed by the source plugin object
// (which the worker replaces wholesale on each broadcast, so entries retire with
// it) and then by the hidden set.
const overlayCache = new WeakMap<PluginInfo, Map<string, PluginInfo>>();

/**
 * `plugin` with a per-instance hidden overlay applied.
 *
 * A non-null `hidden` is AUTHORITATIVE: fields in it end up `hidden:true` and
 * fields out of it end up not hidden, which is what lets a per-instance answer
 * CLEAR a stale type-level flag the broadcast schema carries. Passing null
 * leaves those flags exactly as they arrived.
 *
 * Only a field whose flag has to flip is rewritten, so a field that was never
 * hidden keeps its original def (no explicit `hidden:false` is added) and the
 * whole plugin keeps its identity when nothing changed.
 */
export function applyHidden(plugin: PluginInfo, hidden: readonly string[] | null): PluginInfo {
  if (!hidden) return plugin;

  const cacheKey = [...hidden].sort().join(' ');
  let byKey = overlayCache.get(plugin);
  if (!byKey) { byKey = new Map(); overlayCache.set(plugin, byKey); }
  const hit = byKey.get(cacheKey);
  if (hit) return hit;

  const schema = (plugin.schema ?? {}) as Record<string, any>;
  const set = new Set(hidden);
  let changed = false;
  const overlaid: Record<string, any> = {};
  for (const [k, d] of Object.entries(schema)) {
    const wantHidden = set.has(k);
    if (!!(d as any)?.hidden === wantHidden) {
      overlaid[k] = d;
    } else {
      overlaid[k] = { ...(d as any), hidden: wantHidden };
      changed = true;
    }
  }
  // Nothing to overlay — hand back the original so identity is preserved for
  // the overwhelmingly common "no conditional fields" case.
  const result = changed ? ({ ...plugin, schema: overlaid } as PluginInfo) : plugin;
  byKey.set(cacheKey, result);
  return result;
}
