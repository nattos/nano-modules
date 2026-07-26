/**
 * export-renderer — render the arrangement to an MP4 (H.264) offline.
 *
 * Strategy: spin a SECOND `ArrEngine` — its own worker + WebGPU device — at the
 * FULL composition resolution, running the SAME in-wasm composition executor as
 * the live preview (so export ≡ preview by construction), hold it PAUSED, and
 * drive it one frame at a time. For each output frame we:
 *   1. map the output time (real, warp-aware seconds) → its (warped) beat,
 *   2. await-decode every active video clip's exact source frame (ExportVideoPump),
 *      injecting each as a host texture,
 *   3. `comp_seek_beat` + `stepFrame()` — the comp executor evaluates the timeline,
 *      automation, and rails at that beat and renders the composite (the effect
 *      clock advances by the seek's seconds delta: exactly 1/fps per frame),
 *   4. capture the traced composite ImageBitmap and feed it to a WebCodecs
 *      `VideoEncoder`, muxed to MP4 via mp4-muxer.
 *
 * Because step 2 AWAITS each decode, every frame is fully resolved before it's
 * composited — the comp transport stays in Fluid mode (no realtime Precise gate,
 * readiness is guaranteed by construction), no dropped frames. The live preview
 * engine is untouched, so the editor keeps working while an export runs.
 *
 * The frame PLANNER (`planExportFrames`) and the small numeric helpers are pure and
 * unit-tested; the GPU/encoder loop needs a real browser (WebGPU + WebCodecs).
 */

import { ArrEngine } from './arr-engine';
import { ExportVideoPump } from './export-video-pump';
import { videoDescFor } from './video-compositor';
import { makeWarpClock, type WarpClock } from './warp-clock';
import { store } from '../state/store';
import { EFFECT_BUNDLES } from '../../../effect-bundles';
import { compositionLengthBeats, exportFps, type BackgroundConfig } from '../model/composition';

/** The comp executor publishes its output under this fixed sketch id. */
const COMPOSITE_ID = 'arr-composite';

/** Warm-up: consecutive structure-stable frames required before recording, and the
 *  hard cap on warm-up steps (a chain that never settles must not hang an export). */
const WARMUP_SETTLED_FRAMES = 3;
const MAX_WARMUP_FRAMES = 30;

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
  /** Export the full mix, ignoring any soloed-track restriction. */
  ignoreSolo?: boolean;
  /**
   * Stream the MP4 to this writable as it encodes (low memory — the file never
   * lives fully in the page heap). When omitted the output is buffered in memory
   * and returned as `result.blob`. Obtain one from
   * `showSaveFilePicker().createWritable()`.
   */
  writable?: FileSystemWritableFileStream;
  /** Per-frame progress (1-based done / total). */
  onProgress?: (done: number, total: number) => void;
  /** Abort the export between frames. */
  signal?: AbortSignal;
}

export interface ExportResult {
  /** The encoded MP4 — only when buffered in memory (no `writable`). */
  blob?: Blob;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** How many frames the comp executor rendered (the rest were the backdrop
   *  fallback for timeline gaps) — a 0 here on a non-empty timeline means the
   *  export engine never produced content (diagnostic). */
  engineFrames: number;
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
  const fps = Math.max(1, Math.round(opts.fps ?? exportFps(comp)));
  const clock = makeWarpClock(comp);
  const startBeat = Math.max(0, opts.startBeat ?? 0);
  const endBeat = opts.endBeat ?? compositionLengthBeats(comp);
  const plan = planExportFrames(clock, fps, startBeat, endBeat);
  const total = plan.length;
  const bitrate = opts.bitrate ?? defaultBitrate(width, height, fps);

  // ── Muxer + encoder ─────────────────────────────────────────────────────
  // Streaming-to-disk (a file-handle writable) keeps memory flat: data flushes to
  // the file as it encodes, so only a small index is held (moov lands at the end,
  // `fastStart: false`). No writable ⇒ buffer in memory + relocate moov to front.
  const { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } = await import('mp4-muxer');
  const memTarget = opts.writable ? null : new ArrayBufferTarget();
  const target = opts.writable
    ? new FileSystemWritableFileStreamTarget(opts.writable)
    : memTarget!;
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: opts.writable ? false : 'in-memory',
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
    r?.(frames[COMPOSITE_ID]);
  };

  // Boot the comp executor: warm every shipping bundle, wait for effect discovery
  // to settle (the worker seeds each discovered plugin's schema into the comp
  // catalog before the first update — an unknown module type renders a stand-in),
  // then mirror the document once. The transport stays PAUSED in Fluid mode: each
  // frame is an explicit seek + step, and decode is awaited host-side, so the
  // Precise gate has nothing to guard.
  await engine.warmBundles(EFFECT_BUNDLES);
  await (async () => {
    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < 20_000) {
      const n = engine.discovered.size;
      if (n > 0 && n === last) return;
      last = n;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (engine.discovered.size === 0) throw new Error('export: effect discovery timed out');
  })();
  await engine.compEnable(COMPOSITE_ID);
  engine.compLoadDoc(JSON.stringify(comp));
  engine.compControl({ op: 'pause' });
  engine.compControl({ op: 'mode', precise: false });
  engine.compControl({ op: 'loop', enabled: false });
  engine.compControl({ op: 'ignoreSolo', on: !!opts.ignoreSolo });

  const pump = new ExportVideoPump(width, height);
  await pump.init();

  // Track the comp executor's per-frame structure report so the warm-up below can
  // tell "the chain is still being instantiated" from "steady state".
  let lastStructureChanged = true;
  engine.onCompInfo = (info) => { lastStructureChanged = info.structureChanged; };

  /** Step the engine one frame and resolve with its traced composite bitmap.
   *  `dtSec` is the effect-clock advance; 0 makes the step a pure
   *  build/instantiate pass that moves no stateful effect (the warm-up below). */
  const stepAndCapture = (dtSec?: number): Promise<ImageBitmap | undefined> => new Promise((res, rej) => {
    const timer = setTimeout(() => { resolveFrame = null; rej(new Error('export: engine frame timed out')); }, 20_000);
    resolveFrame = (b) => { clearTimeout(timer); res(b); };
    engine.stepFrame(dtSec);
  });

  /** Await-decode + inject every active video clip's exact frame at `beat`
   *  (null = clear the slot). */
  const injectVideo = async (beat: number) => {
    for (const l of store.compositeLayersAtBeat(beat, opts.ignoreSolo)) {
      const d = videoDescFor(l.clip);
      if (!d) continue;
      const bmp = await pump.frameBitmapAt(d, beat, (b) => clock.secondsAt(b));
      engine.setInstanceTexture(d.instanceKey, bmp);
    }
  };

  const keyEvery = Math.max(1, fps * 2); // a keyframe roughly every 2 seconds
  let engineFrames = 0;

  try {
    // ── Warm-up: settle the chain BEFORE recording ────────────────────────────
    // The comp executor reports a structure change, and only THEN does the worker
    // instantiate the new chain — so a cold engine's first frames render with
    // missing instances (layers blank, generators un-created, host services like
    // the text atlas not yet primed). The live preview hides this behind a
    // fraction of a second; an export would bake it into the opening frames.
    //
    // The steps run at the start beat with dt = 0, so they build the graph
    // without moving ANY clock: the recorded frame 0 is still exactly the frame
    // at `plan[0].beat`, with a fully-instantiated chain behind it.
    if (plan.length) {
      const warmBeat = plan[0].beat;
      await injectVideo(warmBeat);
      let settled = 0;
      for (let i = 0; i < MAX_WARMUP_FRAMES && settled < WARMUP_SETTLED_FRAMES; i++) {
        if (opts.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
        engine.compControl({ op: 'seek', beat: warmBeat });
        const warm = await stepAndCapture(0);
        warm?.close();
        settled = lastStructureChanged ? 0 : settled + 1;
      }
    }

    for (const fr of plan) {
      if (opts.signal?.aborted) throw new DOMException('Export canceled', 'AbortError');
      if (encErr) throw encErr instanceof Error ? encErr : new Error(String(encErr));

      await injectVideo(fr.beat);

      // Seek + step: the comp executor rebuilds/evaluates at exactly this beat and
      // publishes under COMPOSITE_ID; a gap in the timeline steps too (the frame
      // event still fires) and resolves undefined → the backdrop below.
      engine.compControl({ op: 'seek', beat: fr.beat });
      let bitmap = await stepAndCapture();
      if (bitmap) {
        engineFrames++;
      } else {
        // No engine layer at this beat → emit the composition backdrop.
        bitmap = await backgroundBitmap(width, height, comp.meta.background);
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
    if (opts.writable) {
      await opts.writable.close(); // commit the streamed file to disk
      return { width, height, fps, frames: total, engineFrames, durationSec: total / fps };
    }
    const blob = new Blob([memTarget!.buffer], { type: 'video/mp4' });
    return { blob, width, height, fps, frames: total, engineFrames, durationSec: total / fps };
  } finally {
    try { encoder.close(); } catch { /* already errored / closed */ }
    engine.destroy();
    await pump.close();
  }
}
