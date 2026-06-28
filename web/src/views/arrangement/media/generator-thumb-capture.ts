/**
 * Live push-capture of GENERATOR-clip thumbnails (#120).
 *
 * Driven once per rendered frame from the arrangement rAF tick. For each generator
 * clip CURRENTLY under the playhead it taps the live composite's render of that
 * clip's output (reusing the bridge's per-device trace seam — the same one the
 * inspector output cards use) and pushes a downscaled frame into
 * `generatorThumbCache`, keyed by the clip's param fingerprint + a fixed SAMPLE
 * index (decoupled from the zoom-dependent draw cell count). As the playhead sweeps
 * the clip, samples fill in.
 *
 * Non-blocking by construction:
 *  - the trace produces the bitmap GPU-side in the worker (no main-thread readback);
 *  - downscale uses async `createImageBitmap` (off the main thread);
 *  - a clip's trace is registered ONLY while it has uncached samples, then dropped —
 *    so the compositor does no thumbnail blits in steady state;
 *  - the per-frame work is throttled and skips already-cached samples.
 */

import { store } from '../state/store';
import { engineBridge } from '../engine/engine-bridge';
import { catalogEffect } from '../engine/effect-catalog';
import {
  generatorFingerprint,
  generatorIsTimeIndependent,
  isGeneratorClip,
} from '../engine/generator-fingerprint';
import { generatorThumbCache } from './generator-thumb-cache';
import type { Clip } from '../model/composition';

/** Fixed capture granularity across a clip (independent of timeline zoom). */
export const GENERATOR_THUMB_SAMPLES = 24;
const THUMB_H = 90;
const TRACE_PREFIX = 'gthumb_';
/** Only attempt a capture every Nth frame — cheap checks dominate otherwise. */
const THROTTLE = 3;

/** Which fixed sample index the playhead's clip-relative position maps to. */
export function generatorSampleAt(clip: Clip, beat: number): number {
  const frac = (beat - clip.startBeat) / Math.max(1e-6, clip.lengthBeat);
  return Math.min(GENERATOR_THUMB_SAMPLES - 1, Math.max(0, Math.floor(frac * GENERATOR_THUMB_SAMPLES)));
}

class GeneratorThumbCapturer {
  private registered = new Set<string>(); // clipIds with a live capture trace
  private inFlight = new Set<string>();   // `${fp}|${sample}` currently downscaling
  private frame = 0;

  /** Run one capture pass for the playhead at `beat`. */
  tick(beat: number): void {
    if (this.frame++ % THROTTLE !== 0) return;

    const active = store.compositeClipsAtBeat(beat).filter(({ clip }) => isGeneratorClip(clip));
    const activeIds = new Set(active.map(({ clip }) => clip.id));
    // Stop tracing clips that left the playhead (compositor stops blitting them).
    for (const id of [...this.registered]) if (!activeIds.has(id)) this.unregister(id);

    for (const { track, clip } of active) {
      const fp = generatorFingerprint(clip);
      if (!fp) continue;
      const ti = generatorIsTimeIndependent(clip);
      const complete = ti
        ? generatorThumbCache.has(fp, 0)
        : generatorThumbCache.count(fp) >= GENERATOR_THUMB_SAMPLES;
      if (complete) { this.unregister(clip.id); continue; } // strip done → drop the trace

      const sample = ti ? 0 : generatorSampleAt(clip, beat);
      if (generatorThumbCache.has(fp, sample)) continue; // this sample already captured

      // Ensure the live output trace is registered, then grab this frame's bitmap.
      this.ensureRegistered(track.id, clip);
      const src = engineBridge.traceSource.frame(TRACE_PREFIX + clip.id);
      if (!src) continue; // trace not produced yet (clip not active this frame / 1-frame latency)

      const key = `${fp}|${sample}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      const aspect = store.compositionAspect || 16 / 9;
      // Independent copy (don't close `src` — the trace system owns it). Off-main-thread.
      createImageBitmap(src, { resizeWidth: Math.round(THUMB_H * aspect), resizeHeight: THUMB_H, resizeQuality: 'low' })
        .then((bmp) => generatorThumbCache.put(fp, sample, bmp))
        .catch(() => { /* source closed mid-flight / unsupported — skip */ })
        .finally(() => this.inFlight.delete(key));
    }
  }

  /** The last texture-advancing catalog device (the clip's final visible output). */
  private outputChainIdx(clip: Clip): number {
    let idx = 0;
    clip.sketch.devices.forEach((d, i) => {
      if (catalogEffect(d.moduleType) && !d.moduleType.startsWith('mod.')) idx = i;
    });
    return idx;
  }

  private ensureRegistered(trackId: string, clip: Clip): void {
    if (this.registered.has(clip.id)) return;
    this.registered.add(clip.id);
    const aspect = store.compositionAspect || 16 / 9;
    engineBridge.traceSource.register({
      id: TRACE_PREFIX + clip.id,
      target: { type: 'chain_entry', sketchId: `clip/${trackId}/${clip.id}`, colIdx: 0, chainIdx: this.outputChainIdx(clip), side: 'output' },
      resolution: 'low',
      size: { width: Math.round(THUMB_H * aspect), height: THUMB_H },
    });
  }

  private unregister(clipId: string): void {
    if (!this.registered.delete(clipId)) return;
    engineBridge.traceSource.unregister(TRACE_PREFIX + clipId);
  }
}

export const generatorThumbCapturer = new GeneratorThumbCapturer();
