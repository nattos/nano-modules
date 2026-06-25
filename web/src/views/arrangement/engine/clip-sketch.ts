/**
 * ClipSketch → real Structor Sketch mapping (Component F: real clip chains).
 *
 * A clip hosts a `ClipSketch` (a device list). When those devices are REAL
 * effects (present in `effect-catalog.ts`) this builds a real Structor `Sketch`:
 *   - a `generator` device → the sketch ANCHOR (a real source module the
 *     executor renders and feeds into the chain),
 *   - `effect` devices → chain entries the executor runs in order, with each
 *     device's editable params in `sketch.instances[key].state`,
 *   - an effect-only chain (no generator) gets an implicit solid anchor so the
 *     effects have a real input to process.
 * So editing a real param visibly changes the rendered output.
 *
 * Clips whose devices aren't real (legacy fake-data, or media clips previewed
 * from decoded frames) fall back to the coarse kind-based slice sketches, or to
 * null (the monitor handles those).
 *
 * Returns a content `sig` (a signature of the built sketch); the engine bridge
 * re-issues to the executor only when the sig changes — so clip switches AND
 * param edits both refresh, while steady-state ticks don't churn.
 */

import type { Sketch, InstanceState, ChainEntry, Wire } from '../../../sketch-types';
import type { ShowSketchOpts } from './arr-engine';
import type { Clip, Device, Track, BackgroundConfig, RailRead } from '../model/composition';
import { deviceIsSource, clipProcessesTexture } from '../model/composition';
import { catalogEffect, defaultStateFor, IMPLICIT_ANCHOR } from './effect-catalog';
import { solidSketch } from './slice-sketches';

export interface ClipRender {
  /** Signature of the content; bridge re-issues to the engine only when it changes. */
  sig: string;
  sketch: Sketch;
  opts: ShowSketchOpts;
}

const TRACE = 'arr-monitor';

/**
 * The engine instance key a clip's device renders under. Engine telemetry
 * (pluginStates / modulationData) is keyed by this, so any reader mapping a
 * device back to its live engine state MUST go through here to stay in lock-step
 * with `buildRealChain`.
 */
export function clipInstanceKey(clipId: string, suffix: string): string {
  return `clip_${clipId}_${suffix}`;
}

/**
 * The engine instance key a TRACK-level device renders under. Keyed per TRACK
 * (not per clip), so a track's effect chain is ONE stable instance shared across
 * whichever clip is active on the track — its state + automation persist as the
 * active clip changes. Track automation targets these keys.
 */
export function trackInstanceKey(trackId: string, suffix: string): string {
  return `track_${trackId}_${suffix}`;
}

/**
 * Map a clip to a renderable sketch, or null when there's nothing to render
 * (empty / modulation-only clip, or a media clip the monitor previews directly).
 */
export function clipToRender(clip: Clip): ClipRender | null {
  // Media-backed clip → previewed from decoded frames (monitor video path).
  if (clip.source?.url) return null;

  const devices = clip.sketch.devices;
  const catDevices = devices.filter((d) => catalogEffect(d.moduleType));
  if (catDevices.length > 0) return buildRealChain(clip, catDevices);

  // Fallback for legacy fake-data clips (non-catalog devices): a solid stand-in.
  if (clip.kind === 'video' || devices.some(deviceIsSource) ||
      (devices.length > 0 && clipProcessesTexture(clip))) {
    const s = solidSketch(TRACE);
    return { sig: 'fallback:solid', sketch: s.sketch, opts: s.opts };
  }
  return null;
}

/** One engine layer to fold into the composite (clip + effective opacity + blend). */
export interface CompositeLayerInput {
  clip: Clip;
  opacity: number;
  /** composite.blend mode for a source clip (0 = Normal/over). */
  blendMode?: number;
  /** The owning track — its `sketch` effect chain runs over the clip output (a
   *  per-track FX bus), keyed `track_<id>_<dev>` so track automation can target it. */
  track?: Track;
}

const BLEND = 'composite.blend';

/** Parse '#rgb' / '#rrggbb' → normalized [r,g,b] in 0..1 (black on failure). */
function hexToRgb01(hex: string): [number, number, number] {
  const h = (hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = (i: number) => { const x = parseInt(n.slice(i, i + 2), 16) / 255; return Number.isFinite(x) ? x : 0; };
  return n.length >= 6 ? [v(0), v(2), v(4)] : [0, 0, 0];
}

/**
 * Build ONE sketch that composites a STACK of engine layers (top track first)
 * into the final image, distinguishing the two kinds of clip:
 *
 *   - A SOURCE clip (a generator at the top of its chain) is a self-contained
 *     image producer: its sub-chain (generator → its effects) renders to its own
 *     buffer, then a wired `composite.blend` composites that buffer OVER the
 *     running accumulator using the clip's blend mode (Normal/over default) +
 *     per-track opacity — so its real alpha reveals the tracks above it.
 *   - An EFFECT-only clip (no generator) is an adjustment layer: its effects
 *     chain inline and process the running accumulator (the composite of the
 *     tracks above it); per-track opacity rides the reserved `__opacity__` key.
 *
 * The accumulator starts from the composition BACKGROUND: an opaque solid-color
 * base (black, or `bg.color`) is laid down first so every clip composites over
 * it — baked into the engine output, not just the monitor. `transparent` (or no
 * bg) keeps the old transparent base. Returns null when no layer contributes. A
 * `sig` lets the bridge re-issue only when the composite changes.
 */
export function buildCompositeSketch(
  layers: CompositeLayerInput[],
  bg?: BackgroundConfig,
): { sig: string; sketch: Sketch; opts: ShowSketchOpts } | null {
  const bundles = new Set<string>();
  const chain: ChainEntry[] = [];
  const wires: Wire[] = [];
  const instances: Record<string, InstanceState> = {};
  let wid = 0;
  /** Instance key whose `tex_out` is the running composite, or null (empty). */
  let accKey: string | null = null;

  // Rail (return) routing: collect active writers + readers across all layers, then
  // emit a cross-clip wire per (writer, reader) pair so the executor's native wire
  // pipeline (tap_mod: combine / magnitude / scale) does the value routing — no
  // separate rail engine. A reader only resolves when a writer of the same rail is
  // ALSO active at this beat (both clips' devices are in the composite). Base-curve
  // seeding + per-export combine staging are deferred (Phase 2).
  const railWriters = new Map<string, Array<{ key: string; field: string; scale: number }>>();
  const railReaders: Array<{ railId: string; key: string; field: string; tap: RailRead }> = [];

  const push = (moduleType: string, key: string, state: Record<string, unknown>) => {
    // A key must appear ONCE. Duplicate device ids within a clip (a data bug)
    // would otherwise emit the same instance key twice with different module
    // types → the executor retypes + recreates the instance every frame (1000s of
    // "module initialized"). Keep the first; drop the collision.
    if (instances[key]) return;
    const cat = catalogEffect(moduleType);
    bundles.add(cat ? cat.bundle : IMPLICIT_ANCHOR.bundle);
    chain.push({ type: 'module', module_type: moduleType, instance_key: key });
    instances[key] = { module_type: moduleType, state };
  };

  // mod.* nodes are texture-passthrough modulation sources/shapers: they run +
  // publish their scalar `output` but never touch the image, so they're pushed
  // inline (so they execute + can be wired) yet must NOT advance the texture
  // accumulator (a blend reads `<accKey>.tex_out`, which a mod node lacks).
  const isMod = (t: string) => t.startsWith('mod.');

  // A track's own effect chain (`track.sketch`) run OVER the clip output, as a
  // per-track FX bus: each device chained (implicit linear input) after `startKey`,
  // keyed per TRACK so it's one stable instance across the track's clips. Returns
  // the new last texture key. mod.* nodes execute but don't advance the texture.
  const pushTrackFx = (track: Track | undefined, startKey: string): string => {
    if (!track) return startKey;
    const tcat = track.sketch.devices.filter((d) => catalogEffect(d.moduleType));
    const tfx = tcat.filter((d) => catalogEffect(d.moduleType)!.role === 'effect');
    let last = startKey;
    for (const d of tfx) {
      const key = trackInstanceKey(track.id, d.id);
      push(d.moduleType, key, { ...defaultStateFor(d.moduleType), ...(d.state ?? {}) });
      if (!isMod(d.moduleType)) last = key;
    }
    const tpushed = new Set(tcat.map((d) => d.id));
    for (const w of track.sketch.wires ?? []) {
      if (!tpushed.has(w.src.instanceKey) || !tpushed.has(w.dest.instanceKey)) continue;
      wires.push({
        ...w,
        id: `tw${wid++}`,
        src: { instanceKey: trackInstanceKey(track.id, w.src.instanceKey), field: w.src.field },
        dest: { instanceKey: trackInstanceKey(track.id, w.dest.instanceKey), field: w.dest.field },
      });
    }
    return last;
  };

  // Background base: an opaque solid-color layer UNDER all clips (so the bg is
  // baked into the composite, revealed by clip transparency / between clips).
  // Only when there ARE clips — an empty timeline renders nothing (the monitor
  // draws its own backdrop). `transparent` keeps the old transparent base.
  const bgMode = bg?.mode ?? 'black';
  if (layers.length > 0 && bgMode !== 'transparent') {
    const rgb = bgMode === 'custom' ? hexToRgb01(bg?.color ?? '#000000') : [0, 0, 0];
    push('source.solid_color', 'arr_bg', { color: rgb });
    accKey = 'arr_bg';
  }

  for (const { clip, opacity, blendMode, track } of layers) {
    const cat = clip.sketch.devices.filter((d) => catalogEffect(d.moduleType));
    const gen = cat.find((d) => catalogEffect(d.moduleType)!.role === 'generator');
    const fx = cat.filter((d) => catalogEffect(d.moduleType)!.role === 'effect');

    if (gen || cat.length === 0) {
      // ── SOURCE clip: render standalone, then composite OVER the accumulator ──
      let firstKey = '';
      let lastKey = '';
      if (gen) {
        const segment: Device[] = [gen, ...fx];
        segment.forEach((d) => {
          const key = clipInstanceKey(clip.id, d.id);
          push(d.moduleType, key, { ...defaultStateFor(d.moduleType), ...(d.state ?? {}) });
          if (!isMod(d.moduleType)) { if (!firstKey) firstKey = key; lastKey = key; }
        });
      } else {
        // Legacy / non-catalog clip → a solid stand-in so the layer still draws.
        firstKey = lastKey = clipInstanceKey(clip.id, 'src');
        push(IMPLICIT_ANCHOR.type, firstKey, {});
      }

      if (lastKey) {
        lastKey = pushTrackFx(track, lastKey); // track FX bus over the clip output
        if (accKey == null) {
          // First (top) layer becomes the accumulator. A sub-1 opacity fades it
          // over the transparent base via the reserved wet/dry key.
          if (opacity < 1) instances[firstKey].state = { ...instances[firstKey].state, __opacity__: opacity };
          accKey = lastKey;
        } else {
          const b = clipInstanceKey(clip.id, 'blend');
          push(BLEND, b, { mode: blendMode ?? 0, opacity });
          // 0 = A (the accumulator / tracks above), 1 = B (this clip, drawn on top).
          wires.push({ id: `w${wid++}`, src: { instanceKey: accKey, field: 'tex_out' }, dest: { instanceKey: b, field: '0' } });
          wires.push({ id: `w${wid++}`, src: { instanceKey: lastKey, field: 'tex_out' }, dest: { instanceKey: b, field: '1' } });
          accKey = b;
        }
      }
    } else {
      // ── EFFECT-only clip: process the accumulator inline (adjustment layer) ──
      let appliedOpacity = false;
      fx.forEach((d) => {
        const state: Record<string, unknown> = { ...defaultStateFor(d.moduleType), ...(d.state ?? {}) };
        if (!isMod(d.moduleType) && !appliedOpacity && opacity < 1) { state['__opacity__'] = opacity; appliedOpacity = true; }
        push(d.moduleType, clipInstanceKey(clip.id, d.id), state);
        if (!isMod(d.moduleType)) accKey = clipInstanceKey(clip.id, d.id);
      });
      if (accKey) accKey = pushTrackFx(track, accKey); // track FX bus over the adjustment
    }

    // Fold this clip's modulation wires into the composite, remapping device ids
    // → composite instance keys. Both endpoints must have been pushed.
    const pushed = new Set(cat.map((d) => d.id));
    for (const w of clip.sketch.wires ?? []) {
      if (!pushed.has(w.src.instanceKey) || !pushed.has(w.dest.instanceKey)) continue;
      wires.push({
        ...w,
        id: `cw${wid++}`,
        src: { instanceKey: clipInstanceKey(clip.id, w.src.instanceKey), field: w.src.field },
        dest: { instanceKey: clipInstanceKey(clip.id, w.dest.instanceKey), field: w.dest.field },
      });
    }

    // Collect this clip's rail writers/readers (only devices actually pushed).
    for (const exp of clip.exports ?? []) {
      if (!pushed.has(exp.sourceDeviceId)) continue;
      const arr = railWriters.get(exp.railId) ?? [];
      arr.push({ key: clipInstanceKey(clip.id, exp.sourceDeviceId), field: exp.sourceField, scale: exp.scale ?? 1 });
      railWriters.set(exp.railId, arr);
    }
    for (const read of clip.reads ?? []) {
      if (!pushed.has(read.targetDeviceId)) continue;
      railReaders.push({ railId: read.railId, key: clipInstanceKey(clip.id, read.targetDeviceId), field: read.targetField, tap: read });
    }
  }

  // Emit cross-clip rail wires: each reader pulls from every active writer of its rail.
  for (const r of railReaders) {
    for (const w of railWriters.get(r.railId) ?? []) {
      const scale = w.scale * (r.tap.scale ?? 1);
      wires.push({
        id: `rw${wid++}`,
        src: { instanceKey: w.key, field: w.field },
        dest: { instanceKey: r.key, field: r.field },
        combine: r.tap.combine,
        magnitude: r.tap.magnitude,
        ...(scale !== 1 ? { mod: { scale } } : {}),
      });
    }
  }

  if (chain.length === 0) return null;
  const sketch: Sketch = { anchor: null, chain, wires, instances };
  const opts: ShowSketchOpts = { bundles: [...bundles], traceId: TRACE };
  const sig = JSON.stringify({ chain, wires, instances });
  return { sig, sketch, opts };
}

function buildRealChain(clip: Clip, catDevices: Device[]): ClipRender {
  const bundles = new Set<string>();
  const chain: ChainEntry[] = [];
  const instances: Record<string, InstanceState> = {};

  const addEntry = (moduleType: string, keySuffix: string, state: Record<string, unknown>) => {
    const cat = catalogEffect(moduleType);
    bundles.add(cat ? cat.bundle : IMPLICIT_ANCHOR.bundle); // solid_color ships in core
    const key = clipInstanceKey(clip.id, keySuffix);
    chain.push({ type: 'module', module_type: moduleType, instance_key: key });
    instances[key] = { module_type: moduleType, state };
  };

  const gen = catDevices.find((d) => catalogEffect(d.moduleType)!.role === 'generator');
  const fx = catDevices.filter((d) => catalogEffect(d.moduleType)!.role === 'effect');

  // Self-contained chain (anchor stays null — the executor runs the chain
  // top-to-bottom). The FIRST entry is a source that produces output with no
  // input: the clip's generator, or a solid stand-in so an effect-only chain
  // has a real input; each effect then consumes the previous entry's output.
  if (gen) {
    addEntry(gen.moduleType, gen.id, { ...defaultStateFor(gen.moduleType), ...(gen.state ?? {}) });
  } else if (fx.length > 0) {
    addEntry(IMPLICIT_ANCHOR.type, 'src', {});
  }
  for (const d of fx) {
    addEntry(d.moduleType, d.id, { ...defaultStateFor(d.moduleType), ...(d.state ?? {}) });
  }

  const sketch: Sketch = { anchor: null, chain, instances };
  const opts: ShowSketchOpts = { bundles: [...bundles], traceId: TRACE };
  const sig = JSON.stringify({ chain, instances });
  return { sig, sketch, opts };
}
