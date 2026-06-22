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
import { gpuTestSketch } from './slice-sketches';

export interface ClipRender {
  /** Signature of the content; bridge re-issues to the engine only when it changes. */
  sig: string;
  sketch: Sketch;
  opts: ShowSketchOpts;
}

const TRACE = 'arr-monitor';

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
    const s = gpuTestSketch(TRACE);
    return { sig: 'fallback:solid', sketch: s.sketch, opts: s.opts };
  }
  return null;
}

function buildRealChain(clip: Clip, catDevices: Device[]): ClipRender {
  const bundles = new Set<string>();
  const chain: ChainEntry[] = [];
  const instances: Record<string, InstanceState> = {};

  const addEntry = (moduleType: string, keySuffix: string, state: Record<string, unknown>) => {
    const cat = catalogEffect(moduleType);
    bundles.add(cat ? cat.bundle : IMPLICIT_ANCHOR.bundle); // gpu_test ships in testonly
    const key = `clip_${clip.id}_${keySuffix}`;
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
