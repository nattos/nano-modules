/**
 * export-renderer — render the arrangement to an MP4 (H.264) offline.
 *
 * Strategy (the user's instinct, realized): spin a SECOND `ArrEngine` — its own
 * worker + WebGPU device — at the FULL composition resolution, hold it PAUSED, and
 * drive it one frame at a time. For each output frame we:
 *   1. map the output time (real, warp-aware seconds) → its (warped) beat,
 *   2. await-decode every active video clip's exact source frame (ExportVideoPump),
 *      injecting each as a host texture,
 *   3. fold the active engine layers into one composite (the SAME builder the live
 *      preview uses — composite-frame.ts — so the export matches the preview),
 *   4. push automation, set the effect clock to the frame's seconds, `stepFrame()`,
 *   5. capture the traced composite ImageBitmap and feed it to a WebCodecs
 *      `VideoEncoder`, muxed to MP4 via mp4-muxer.
 *
 * Because step 2 AWAITS each decode, every frame is fully resolved before it's
 * composited — no realtime Precise-gate, no dropped frames. The live preview engine
 * is untouched, so the editor keeps working while an export runs.
 *
 * The frame PLANNER (`planExportFrames`) and the small numeric helpers are pure and
 * unit-tested; the GPU/encoder loop needs a real browser (WebGPU + WebCodecs).
 */

import { ArrEngine } from './arr-engine';
import { ExportVideoPump } from './export-video-pump';
import { automationEntriesAtBeat, buildCompositeRenderAtBeat, videoDescFor } from './composite-frame';
import { makeWarpClock, type WarpClock } from './warp-clock';
import { store } from '../state/store';
import { compositionLengthBeats, compositionFps, type BackgroundConfig } from '../model/composition';

/** The export engine's single composite sketch id (its sole trace target). */
const EXPORT_SKETCH_ID = 'arr-export';

export interface FramePlan {
  /** 0-based output frame index. */
  index: number;
  /** Absolute transport seconds for this frame (drives the effect clock). */
  tSec: number;
  /** The (warp-resolved) beat playing at `tSec`. */
  beat: number;
}

/**
 * Plan the output frames over `[startBeat, endBeat]` at `fps`: walk REAL (warped)
 * seconds in `1/fps` steps from the start's seconds to the end's, mapping each tick
 * back to its (warped) beat. Walking in seconds (not beats) makes the output cadence
 * uniform in time — a warp that slows a region simply yields more frames there.
 * Pure; the unit-test surface for export timing.
 */
export function planExportFrames(
  clock: WarpClock,
  fps: number,
  startBeat: number,
  endBeat: number,
): FramePlan[] {
  const startSec = clock.secondsAt(Math.max(0, startBeat));
  const endSec = clock.secondsAt(Math.max(startBeat, endBeat));
  const durSec = Math.max(0, endSec - startSec);
  const total = Math.max(1, Math.round(durSec * fps));
  const frames: FramePlan[] = [];
  for (let i = 0; i < total; i++) {
    const tSec = startSec + i / fps;
    frames.push({ index: i, tSec, beat: clock.beatAtSeconds(tSec) });
  }
  return frames;
}

/** Default H.264 bitrate (bits/s) from resolution × fps × a bits-per-pixel budget. */
export function defaultBitrate(width: number, height: number, fps: number, bpp = 0.12): number {
  return Math.max(1_000_000, Math.round(width * height * fps * bpp));
}

/** Presentation timestamp (microseconds) of output frame `index` at `fps`. */
export function frameTimestampMicros(index: number, fps: number): number {
  return Math.round((index * 1_000_000) / fps);
}

/** Round up to an even integer ≥ 2 (clean GPU/codec dimensions). */
export function evenDim(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** H.264 codec strings to probe, best-quality (High profile, higher level) first. */
const AVC_CANDIDATES = [
  'avc1.640034', 'avc1.64002A', 'avc1.640028', 'avc1.640020',
  'avc1.4D4028', 'avc1.42E028', 'avc1.42001F',
];

/** Pick the first H.264 codec string the platform's encoder actually supports. */
async function pickAvcCodec(width: number, height: number, fps: number, bitrate: number): Promise<string> {
  if (typeof VideoEncoder === 'undefined' || !VideoEncoder.isConfigSupported) return 'avc1.42001F';
  for (const codec of AVC_CANDIDATES) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (supported) return codec;
    } catch { /* probe the next candidate */ }
  }
  return 'avc1.42001F';
}

/** Render the composition backdrop (a solid frame) for beats with no engine layer.
 *  MP4 has no alpha, so `transparent`/default → black; `custom` → its color. */
async function backgroundBitmap(width: number, height: number, bg?: BackgroundConfig): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.fillStyle = bg?.mode === 'custom' && bg.color ? bg.color : '#000000';
  ctx.fillRect(0, 0, width, height);
  return canvas.transferToImageBitmap();
}

export interface ExportOptions {
  /** Output width (default: composition resolution). Rounded to even. */
  width?: number;
  /** Output height (default: composition resolution). Rounded to even. */
  height?: number;
  /** Frames per second (default: the composition's fps). */
  fps?: number;
  /** Beat range (default: 0 → composition length). */
  startBeat?: number;
  endBeat?: number;
  /** H.264 bitrate, bits/s (default: derived from resolution + fps). */
  bitrate?: number;
  /** Per-frame progress (1-based done / total). */
  onProgress?: (done: number, total: number) => void;
  /** Abort the export between frames. */
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSec: number;
}

/** True when this browser can run an export (needs WebGPU-via-worker + WebCodecs). */
export function canExport(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

/**
 * Render the current composition to an MP4 H.264 blob. Resolves with the file (and
 * its dimensions/length); rejects on abort (`AbortError`) or an encoder/GPU error.
 */
export async function exportComposition(opts: ExportOptions = {}): Promise<ExportResult> {
  if (!canExport()) {
    throw new Error('Video export needs WebCodecs (VideoEncoder), which this browser does not provide.');
  }
  const comp = store.composition;
  const width = evenDim(opts.width ?? comp.meta.resolution.width);
  const height = evenDim(opts.height ?? comp.meta.resolution.height);
  const fps = Math.max(1, Math.round(opts.fps ?? compositionFps(comp)));
  const clock = makeWarpClock(comp);
  const startBeat = Math.max(0, opts.startBeat ?? 0);
  const endBeat = opts.endBeat ?? compositionLengthBeats(comp);
  const plan = planExportFrames(clock, fps, startBeat, endBeat);
  const total = plan.length;
  const bitrate = opts.bitrate ?? defaultBitrate(width, height, fps);

  // ── Muxer + encoder ─────────────────────────────────────────────────────
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encErr: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e; },
  });
  const codec = await pickAvcCodec(width, height, fps, bitrate);
  encoder.configure({ codec, width, height, bitrate, framerate: fps });

  // ── Export engine (second worker), full-res, paused for deterministic steps ─
  const engine = new ArrEngine(width, height);
  await engine.ready;
  engine.setPaused(true);
  let resolveFrame: ((bitmap: ImageBitmap | undefined) => void) | null = null;
  engine.onFrameSet = (frames) => {
    const r = resolveFrame;
    resolveFrame = null;
    r?.(frames[EXPORT_SKETCH_ID]);
  };

  const pump = new ExportVideoPump(width, height);
  await pump.init();

  /** Step the engine one frame and resolve with its traced composite bitmap. */
  const stepAndCapture = (): Promise<ImageBitmap | undefined> => new Promise((res, rej) => {
    const timer = setTimeout(() => { resolveFrame = null; rej(new Error('export: engine frame timed out')); }, 20_000);
    resolveFrame = (b) => { clearTimeout(timer); res(b); };
    engine.stepFrame();
  });

  const keyEvery = Math.max(1, fps * 2); // a keyframe roughly every 2 seconds
  let lastSig = '';

  try {
    for (const fr of plan) {
      if (opts.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
      if (encErr) throw encErr instanceof Error ? encErr : new Error(String(encErr));

      const layers = store.compositeLayersAtBeat(fr.beat);
      // Await-decode + inject every active video clip's exact frame (null = clear).
      for (const l of layers) {
        const d = videoDescFor(l.clip);
        if (!d) continue;
        const bmp = await pump.frameBitmapAt(d, fr.beat, (b) => clock.secondsAt(b));
        engine.setInstanceTexture(d.instanceKey, bmp);
      }

      const render = buildCompositeRenderAtBeat(layers, fr.beat);
      let bitmap: ImageBitmap | undefined;
      if (render) {
        if (render.sig !== lastSig) {
          lastSig = render.sig;
          await engine.showComposite([{ sketchId: EXPORT_SKETCH_ID, sketch: render.sketch, opts: render.opts }]);
        }
        engine.setAutomation(automationEntriesAtBeat(fr.beat));
        engine.setTime(fr.tSec);
        bitmap = await stepAndCapture();
      }
      if (!bitmap) {
        // No engine layer at this beat → emit the composition backdrop.
        bitmap = await backgroundBitmap(width, height, comp.meta.background);
        lastSig = ''; // re-issue the sketch when content returns
      }

      const vf = new VideoFrame(bitmap, {
        timestamp: frameTimestampMicros(fr.index, fps),
        duration: Math.round(1_000_000 / fps),
      });
      encoder.encode(vf, { keyFrame: fr.index % keyEvery === 0 });
      vf.close();
      bitmap.close();

      opts.onProgress?.(fr.index + 1, total);
      // Backpressure: keep the encoder queue bounded so memory stays flat.
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    }

    await encoder.flush();
    if (encErr) throw encErr instanceof Error ? encErr : new Error(String(encErr));
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return { blob, width, height, fps, frames: total, durationSec: total / fps };
  } finally {
    try { encoder.close(); } catch { /* already errored / closed */ }
    engine.destroy();
    await pump.close();
  }
}
