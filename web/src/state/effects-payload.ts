/**
 * Pure helpers for MULTI-card effect clipboard payloads (`kind: 'effects'`) and
 * the effect-card selection paths group operations parse. No appState /
 * controller imports — everything takes plain data, so the capture → remap →
 * insert pipeline is unit-testable and the same JSON survives the OS clipboard
 * between surfaces (effect IDE ↔ playground ↔ live Resolume tabs).
 *
 * Capture keeps each item's SOURCE instance_key purely so the group-internal
 * wires can be remapped at paste time; paste always mints fresh keys via the
 * caller-supplied generators (key allocation stays a controller concern).
 */

import type { EffectsClipboard, EffectClipboardItem } from './types';
import type { Sketch, Wire } from '../sketch-types';
import { sketchChain, UI_ONLY_KEY } from '../sketch-types';
import { isMidiInstanceKey } from '../midi/midi-types';

/** Parsed form of an effect-card selection path (`effect/<sketchId>/<colIdx>/<chainIdx>`). */
export interface EffectPathParts {
  sketchId: string;
  colIdx: number;
  chainIdx: number;
}

export function effectPath(sketchId: string, colIdx: number, chainIdx: number): string {
  return `effect/${sketchId}/${colIdx}/${chainIdx}`;
}

/** Parse an effect-card path; null for any other selectable kind. */
export function parseEffectPath(path: string): EffectPathParts | null {
  const parts = path.split('/');
  if (parts[0] !== 'effect' || parts.length < 4) return null;
  const colIdx = parseInt(parts[2], 10);
  const chainIdx = parseInt(parts[3], 10);
  if (Number.isNaN(colIdx) || Number.isNaN(chainIdx)) return null;
  return { sketchId: parts[1], colIdx, chainIdx };
}

/**
 * Capture a group of instances (by instance_key) from a PLAIN (already
 * de-proxied) sketch into a multi-card payload. Items land in CHAIN order
 * regardless of the order keys are given in, so paste reproduces the stack
 * top-to-bottom. Captures the wires whose BOTH endpoints are inside the group;
 * a wire reaching outside is dropped (its far end won't exist where this gets
 * pasted) — EXCEPT `midi:` sources, which live outside any chain (the
 * app-level MIDI device library) and stay valid wherever the group lands, so
 * a MIDI mapping into a copied card rides along. Returns null when none of
 * the keys resolve to a live chain entry.
 */
export function buildEffectsPayload(sk: Sketch, instanceKeys: string[]): EffectsClipboard | null {
  const wanted = new Set(instanceKeys);
  const items: EffectClipboardItem[] = [];
  for (const entry of sketchChain(sk)) {
    if (entry.type !== 'module' || !wanted.has(entry.instance_key)) continue;
    const inst = sk.instances?.[entry.instance_key];
    if (!inst) continue;
    const state = JSON.parse(JSON.stringify(inst.state ?? {})) as Record<string, any>;
    delete state[UI_ONLY_KEY];
    items.push({
      moduleType: inst.module_type,
      state,
      ...(entry.fieldOptions
        ? { fieldOptions: JSON.parse(JSON.stringify(entry.fieldOptions)) }
        : {}),
      key: entry.instance_key,
    });
  }
  if (items.length === 0) return null;
  const inGroup = new Set(items.map(i => i.key));
  const wires = (sk.wires ?? [])
    .filter(w => inGroup.has(w.dest.instanceKey)
      && (inGroup.has(w.src.instanceKey) || isMidiInstanceKey(w.src.instanceKey)))
    .map(w => JSON.parse(JSON.stringify(w)) as Wire);
  return { kind: 'effects', items, wires };
}

/** A payload rewritten onto freshly-minted instance keys, ready to splice in. */
export interface RemappedEffects {
  items: Array<EffectClipboardItem & { newKey: string }>;
  wires: Wire[];
}

/**
 * Rewrite a multi-card payload onto fresh identities: every item gets a new
 * instance_key from `makeInstanceKey`, and each captured wire gets its
 * endpoints remapped onto those keys plus a fresh id from `makeWireId`
 * (clipboard wire ids may collide with ids already in the target sketch —
 * colliding ids make selection highlight both and mod edits hit the wrong
 * wire). A `midi:` source is kept VERBATIM — it names an app-level device,
 * not a chain instance, so the pasted card keeps its MIDI mapping (dormant if
 * that device isn't present here, matching `normalizeSketchChains`). Any
 * other wire whose endpoint key is missing from the items (hand-edited JSON)
 * is dropped rather than inserted dangling.
 */
export function remapEffectsPayload(
  payload: EffectsClipboard,
  makeInstanceKey: (moduleType: string, index: number) => string,
  makeWireId: (index: number) => string,
): RemappedEffects {
  const keyMap = new Map<string, string>();
  const items = payload.items.map((item, i) => {
    const newKey = makeInstanceKey(item.moduleType, i);
    keyMap.set(item.key, newKey);
    return {
      ...(JSON.parse(JSON.stringify(item)) as EffectClipboardItem),
      newKey,
    };
  });
  const wires: Wire[] = [];
  for (const w of payload.wires ?? []) {
    const src = keyMap.get(w.src.instanceKey)
      ?? (isMidiInstanceKey(w.src.instanceKey) ? w.src.instanceKey : undefined);
    const dest = keyMap.get(w.dest.instanceKey);
    if (!src || !dest) continue;
    const copy = JSON.parse(JSON.stringify(w)) as Wire;
    copy.id = makeWireId(wires.length);
    copy.src = { ...copy.src, instanceKey: src };
    copy.dest = { ...copy.dest, instanceKey: dest };
    wires.push(copy);
  }
  return { items, wires };
}

/**
 * Structural check for JSON read back from the OS clipboard (which may hold
 * anything, including hand-edited payloads) — the multi-card counterpart of
 * `resolveClipboardPayload`'s single-effect check.
 */
export function isEffectsClipboard(parsed: any): parsed is EffectsClipboard {
  return !!parsed && parsed.kind === 'effects' && Array.isArray(parsed.items)
    && parsed.items.length > 0
    && parsed.items.every((it: any) =>
      it && typeof it.moduleType === 'string' && typeof it.key === 'string'
      && it.state && typeof it.state === 'object')
    && (parsed.wires === undefined || Array.isArray(parsed.wires));
}
