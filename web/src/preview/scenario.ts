/**
 * Preview scenarios → runnable sketches.
 *
 * The effect store shows each effect by running a tiny sketch on the preview
 * engine. An effect may describe that sketch itself — its PREVIEW SCENARIO, a
 * JSON string built in its wasm by nano::PreviewScenario
 * (native/wasm_modules/include/preview_scenario.h documents the format) — or
 * leave it to the defaults here.
 *
 * The previewed effect is the sketch's last LINEAR entry, so it reads the
 * scenario's input picture as its chain input (through any `pre` entries —
 * upstream stages it needs, like a motion-vector producer) and its output is
 * the sketch output. Every helper (a second picture, an LFO) is a sidecar-CANVAS node:
 * canvas stages never touch the linear image chain, so helpers can feed the
 * effect over wires without replacing its input. The execution order that
 * lets a helper run first is computed exactly as the editor does it.
 *
 * The scenario string comes from wasm and is untrusted: anything malformed is
 * dropped piecewise, never thrown.
 */

import type { Sketch, ChainEntry, Wire, TapCombine, WireMagnitude, InstanceState } from '../sketch-types';
import { computeExecOrder } from '../state/exec-order';
import { DEFAULT_GENERATOR, GENERATORS } from './generators';

/** How the store presents an effect — decides the default scenario. */
export type PreviewKind = 'image' | 'generator' | 'modulation';

/** The effect that plays an aux generator node: its injected input slot 0
 *  is the generator's picture, passed through to `tex_out`. */
export const GENERATOR_NODE_EFFECT = 'source.video.file';
const GENERATOR_NODE_OUTPUT = 'tex_out';

export const DEFAULT_CAPTURE_SEC = 1.5;
export const DEFAULT_LOOP_SEC = 4;

export interface CompiledScenario {
  sketch: Sketch;
  /** The previewed effect's instance key. */
  selfKey: string;
  /** Generator for the sketch's input picture, or null for none. */
  input: string | null;
  /** Generator pictures injected into aux nodes, by instance key. */
  instanceGenerators: Record<string, string>;
  /** Every effect id the sketch instantiates (the previewed one first). */
  effects: string[];
  captureSec: number;
  loopSec: number;
  /** 'icon': nothing worth rendering (a pass-through utility) — the store
   *  shows the effect's category tile instead of baking. */
  thumb: 'auto' | 'icon';
  /** A modulation effect's plotted output field (null = its primary one). */
  plotOutput: string | null;
  /** Extra series drawn ghosted under a modulation effect's plot. */
  plotSeries: Array<{ instanceKey: string; field: string }>;
}

/** Just the scenario's `thumb` mode, without compiling it (the store's grid
 *  asks this per card). */
export function scenarioThumb(previewJson: string | undefined): 'auto' | 'icon' {
  return parse(previewJson).thumb === 'icon' ? 'icon' : 'auto';
}

interface RawAux { key?: unknown; effect?: unknown; generator?: unknown; params?: unknown }
interface RawWire { src?: unknown; dest?: unknown; combine?: unknown; magnitude?: unknown; mixFactor?: unknown }

const COMBINES: readonly TapCombine[] = ['replace', 'mix', 'add', 'mul'];
const MAGNITUDES: readonly WireMagnitude[] = ['auto', 'signed', 'unsigned', 'absolute'];
const KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;

function parse(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Field overrides: numbers, short number vectors (colours, points) and
 *  strings (text); anything else is dropped. */
function sceneParams(v: unknown): Record<string, number | number[] | string> {
  const out: Record<string, number | number[] | string> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith('__')) continue; // engine-reserved keys aren't the scene's
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (Array.isArray(x) && x.length >= 1 && x.length <= 4 && x.every((n) => typeof n === 'number' && Number.isFinite(n))) out[k] = x as number[];
    else if (typeof x === 'string' && x.length <= 16384) out[k] = x;
  }
  return out;
}

function seconds(v: unknown, fallback: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
}

function knownGenerator(v: unknown): string | null {
  return typeof v === 'string' && GENERATORS.some((g) => g.key === v) ? v : null;
}

/**
 * Build the preview sketch for `effectId`. `prefix` namespaces the instance
 * keys (the preview engine is one worker, and keys must be unique in it).
 *
 * `baseOf` gives each instance what a fresh editor insert would have: its
 * effect's CURRENT version (a scenario's params are written in today's units;
 * an unversioned instance counts as legacy and is migrated — the LFO's old
 * 0..1 `rate` would be multiplied up tenfold) and its default state, under
 * the scenario's params (an `add` wire seeds from the field's value; an
 * absent one reads as the field's minimum).
 */
export function compileScenario(
  effectId: string,
  previewJson: string | undefined,
  kind: PreviewKind,
  prefix = 'pv',
  baseOf?: (effectId: string) => { version: InstanceState['version']; state: Record<string, unknown> },
): CompiledScenario {
  const raw = parse(previewJson);
  const selfKey = `${prefix}:self`;

  // The input picture. A generator effect makes its own; everything else
  // defaults to the motion picture. "none" opts out.
  let input: string | null;
  if (raw.input === 'none') input = null;
  else if (typeof raw.input === 'string') input = knownGenerator(raw.input) ?? DEFAULT_GENERATOR;
  else input = kind === 'image' ? DEFAULT_GENERATOR : null;

  const chain: ChainEntry[] = [];
  const instances: NonNullable<Sketch['instances']> = {};
  const effects = [effectId];
  const instanceGenerators: Record<string, string> = {};
  // Scenario-local key → instance key + whether it's a generator node.
  const nodes = new Map<string, { instanceKey: string; generator: boolean }>([
    ['$self', { instanceKey: selfKey, generator: false }],
  ]);

  // `pre`: linear stages ahead of the effect (the chain input flows through
  // them into it) — for effects that read something only an upstream stage
  // makes, like motion.blur's motion vectors.
  const pre = Array.isArray(raw.pre) ? raw.pre as RawAux[] : [];
  for (const a of pre) {
    if (!a || typeof a !== 'object' || typeof a.key !== 'string' || !KEY_RE.test(a.key)) continue;
    if (nodes.has(a.key) || typeof a.effect !== 'string' || !a.effect) continue;
    const instanceKey = `${prefix}:${a.key}`;
    chain.push({ type: 'module', module_type: a.effect, instance_key: instanceKey });
    instances[instanceKey] = { module_type: a.effect, state: sceneParams(a.params) };
    if (!effects.includes(a.effect)) effects.push(a.effect);
    nodes.set(a.key, { instanceKey, generator: false });
  }
  chain.push({ type: 'module', module_type: effectId, instance_key: selfKey });
  instances[selfKey] = { module_type: effectId, state: sceneParams(raw.params) };

  const aux = Array.isArray(raw.aux) ? raw.aux as RawAux[] : [];
  let col = 0;
  for (const a of aux) {
    if (!a || typeof a !== 'object' || typeof a.key !== 'string' || !KEY_RE.test(a.key)) continue;
    if (nodes.has(a.key)) continue;
    const generator = a.generator !== undefined ? (knownGenerator(a.generator) ?? DEFAULT_GENERATOR) : null;
    const effect = generator ? GENERATOR_NODE_EFFECT : (typeof a.effect === 'string' && a.effect ? a.effect : null);
    if (!effect) continue;
    const instanceKey = `${prefix}:${a.key}`;
    chain.push({
      type: 'module', module_type: effect, instance_key: instanceKey,
      canvas: { x: 40 + (col % 3) * 260, y: 40 + Math.floor(col / 3) * 220 },
    });
    col++;
    instances[instanceKey] = { module_type: effect, state: generator ? {} : sceneParams(a.params) };
    if (!effects.includes(effect)) effects.push(effect);
    if (generator) instanceGenerators[instanceKey] = generator;
    nodes.set(a.key, { instanceKey, generator: !!generator });
  }

  const wires: Wire[] = [];
  const rawWires = Array.isArray(raw.wires) ? raw.wires as RawWire[] : [];
  const endpoint = (s: unknown): { instanceKey: string; field: string } | null => {
    if (typeof s !== 'string') return null;
    const dot = s.indexOf('.');
    const key = dot < 0 ? s : s.slice(0, dot);
    const field = dot < 0 ? '' : s.slice(dot + 1);
    const node = nodes.get(key);
    if (!node) return null;
    // A generator node has exactly one output, whatever the scenario calls it.
    if (node.generator) return { instanceKey: node.instanceKey, field: GENERATOR_NODE_OUTPUT };
    return field ? { instanceKey: node.instanceKey, field } : null;
  };
  rawWires.forEach((w, i) => {
    if (!w || typeof w !== 'object') return;
    const src = endpoint(w.src);
    const dest = endpoint(w.dest);
    if (!src || !dest || src.instanceKey === dest.instanceKey) return;
    const wire: Wire = { id: `${prefix}:w${i}`, src, dest };
    if (COMBINES.includes(w.combine as TapCombine)) wire.combine = w.combine as TapCombine;
    if (MAGNITUDES.includes(w.magnitude as WireMagnitude)) wire.magnitude = w.magnitude as WireMagnitude;
    if (typeof w.mixFactor === 'number' && Number.isFinite(w.mixFactor)) wire.mixFactor = w.mixFactor;
    wires.push(wire);
  });

  const plotSeries: CompiledScenario['plotSeries'] = [];
  for (const p of Array.isArray(raw.plot) ? raw.plot : []) {
    const ep = endpoint(p);
    if (ep && plotSeries.length < 4) plotSeries.push(ep);
  }

  if (baseOf) {
    for (const [key, inst] of Object.entries(instances)) {
      const base = baseOf(inst.module_type);
      inst.version = base.version;
      // A generator node's picture is injected; its effect state stays empty.
      if (!instanceGenerators[key]) inst.state = { ...base.state, ...inst.state };
    }
  }
  const sketch: Sketch = { anchor: null, chain, instances };
  if (wires.length) sketch.wires = wires;
  if (chain.length > 1) {
    const order = computeExecOrder(sketch);
    if (order.some((k, i) => k !== chain[i]?.instance_key)) sketch.execOrder = order;
  }

  return {
    sketch,
    selfKey,
    input,
    instanceGenerators,
    effects,
    captureSec: seconds(raw.capture, DEFAULT_CAPTURE_SEC, 30),
    loopSec: seconds(raw.loop, DEFAULT_LOOP_SEC, 60) || DEFAULT_LOOP_SEC,
    thumb: raw.thumb === 'icon' ? 'icon' : 'auto',
    plotOutput: typeof raw.output === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(raw.output) ? raw.output : null,
    plotSeries,
  };
}

/** A stable short hash of a string (FNV-1a, hex) — for cache keys. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
