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

import type { Sketch, InstanceState, ChainEntry } from '../../../sketch-types';
import type { ShowSketchOpts } from './arr-engine';
import type { Clip, Device } from '../model/composition';
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

/** One engine layer to fold into the composite (clip + effective opacity). */
export interface CompositeLayerInput {
  clip: Clip;
  opacity: number;
}

/**
 * Build ONE sketch that composites a STACK of engine layers (top track first)
 * into a single chain. Each layer's devices are appended in order — a generator
 * first (if any), then its effects — with NO per-clip implicit anchor. So:
 *   - an effect-only clip processes the RUNNING composite (the tracks above it),
 *     not an isolated gray stand-in;
 *   - the executor feeds the first entry transparent black (anchor null), and
 *     each later entry reads the previous output;
 *   - per-track opacity rides the reserved `__opacity__` key on the layer's first
 *     entry — a real wet/dry over-blend, so opacity < 1 lets the stack below show
 *     through and real alpha (e.g. a crop's transparency) composites correctly.
 *
 * Returns null when no layer contributes anything. A `sig` lets the bridge
 * re-issue only when the composite actually changes.
 */
export function buildCompositeSketch(
  layers: CompositeLayerInput[],
): { sig: string; sketch: Sketch; opts: ShowSketchOpts } | null {
  const bundles = new Set<string>();
  const chain: ChainEntry[] = [];
  const instances: Record<string, InstanceState> = {};

  const push = (moduleType: string, key: string, state: Record<string, unknown>) => {
    const cat = catalogEffect(moduleType);
    bundles.add(cat ? cat.bundle : IMPLICIT_ANCHOR.bundle);
    chain.push({ type: 'module', module_type: moduleType, instance_key: key });
    instances[key] = { module_type: moduleType, state };
  };

  for (const { clip, opacity } of layers) {
    const cat = clip.sketch.devices.filter((d) => catalogEffect(d.moduleType));
    const gen = cat.find((d) => catalogEffect(d.moduleType)!.role === 'generator');
    const fx = cat.filter((d) => catalogEffect(d.moduleType)!.role === 'effect');
    const segment: Device[] = gen ? [gen, ...fx] : fx;

    const op = (i: number): Record<string, unknown> => (i === 0 && opacity < 1 ? { __opacity__: opacity } : {});

    if (segment.length === 0) {
      // Non-catalog / legacy clip: a solid stand-in so the layer still draws.
      push(IMPLICIT_ANCHOR.type, clipInstanceKey(clip.id, 'src'), op(0));
      continue;
    }
    segment.forEach((d, i) => {
      push(d.moduleType, clipInstanceKey(clip.id, d.id), {
        ...defaultStateFor(d.moduleType), ...(d.state ?? {}), ...op(i),
      });
    });
  }

  if (chain.length === 0) return null;
  const sketch: Sketch = { anchor: null, chain, instances };
  const opts: ShowSketchOpts = { bundles: [...bundles], traceId: TRACE };
  const sig = JSON.stringify({ chain, instances });
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
