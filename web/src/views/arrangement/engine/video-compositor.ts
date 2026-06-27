/**
 * VideoCompositor — main-thread video decode pump for the arrangement.
 *
 * Each active video clip (a clip backed by on-disk / object-URL media) decodes
 * on the MAIN thread via `VideoPlaybackService` (its own WebGPU device), and each
 * frame's GPU texture is blitted to an ImageBitmap and pushed to the executor
 * worker, bound to that clip's `source.video.file` chain entry
 * (`setInstanceTexture`). So the video becomes a normal SOURCE inside the GPU
 * composite — its effects process it and it composites via composite.blend —
 * mirroring the IDE's video preview path, but for many clips at once and driven
 * by the arrangement TRANSPORT clock instead of a free-running loop.
 *
 * Reuses the proven decode stack (VideoPlaybackService / FrameBlitter); only the
 * multi-clip lifecycle + transport→frame mapping are arrangement-specific.
 */

import { GPUHost } from '../../../gpu-host';
import { VideoPlaybackService, ClipHandle } from '../../../video/playback-service';
import { FrameBlitter, type BlitFit, type BlitTransform } from '../../../video/frame-blitter';
import { thumbnailController } from '../media/thumbnail-controller';
import { clipSourceFrameAt, clipNoiseSeed, type ClipTimeCtx } from './clip-time';
import type { ClipLoopConfig } from '../model/composition';
import { RANDOM_DEFAULTS } from '../model/composition';

/** The neutral placement transform (centred, unscaled, unrotated, unflipped). */
const IDENTITY_TRANSFORM: BlitTransform = {
  anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false,
};

/** One active video clip the pump should feed. */
export interface VideoClipDesc {
  clipId: string;
  /** Engine instance key of the clip's `source.video.file` entry. */
  instanceKey: string;
  /** Fetchable media URL (object URL or served asset). */
  url: string;
  /** Stable cache identity. */
  sourceKey: string;
  startBeat: number;
  lengthBeat: number;
  durationFrames: number;
  fps?: number;
  speed?: number;
  /** How the frame scales into the output canvas (default 'fit'). */
  scaleMode?: BlitFit;
  /** Placement transform (anchor / scale / rotation / flip) over the scale mode. */
  transform?: BlitTransform;
  /** Play-mode timing (slice + mode); drives the beat→source-frame mapping. */
  loop?: ClipLoopConfig;
}

/** Current transport position the frame mapping reads. */
export type TransportClock = () => { beat: number; bpm: number };

/** Warp-aware beat→real-seconds resolver (WarpClock.secondsAt). */
export type TimeResolver = (beat: number) => number;

/** Fallback timing for a clip missing its loop config (older/repaired data): loop
 *  the whole source in `time` mode at neutral speed. */
const DEFAULT_LOOP: ClipLoopConfig = { mode: 'time', startSec: 0, speed: 1, direction: 'forward' };

interface Pump {
  desc: VideoClipDesc;
  clip: ClipHandle;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  busy: boolean;
  /** Last injected {frame|scaleMode|size} — skip redundant re-decodes (a static
   *  image / a paused video would otherwise re-blit the same frame every rAF;
   *  the worker re-binds the stored texture each tick regardless). */
  lastKey?: string;
  /** Last frame decoded for LOOKAHEAD warming (not injected) — dedupe warm pulls. */
  warmedKey?: string;
  /** Stateful 'random' play-mode walk, driven like a synth oscillator. `phase` is the
   *  NORMALISED progress [0,1) through the current dwell cycle; each frame it advances by
   *  `delta / effectiveDwell`, where `effectiveDwell` is read fresh from the live `dwell`
   *  param every frame — so a dwell change re-rates the in-flight cycle IMMEDIATELY (no
   *  waiting for the old interval to elapse). A jump fires whenever `phase` wraps past 1
   *  (or below 0 when scrubbing back). `jitterFactor` is this cycle's dwell multiplier
   *  (resampled at each jump). `lastBeat` is the previous query beat (delta source); `srcSec`
   *  drifts at `speed` between jumps, looping at the slice end. */
  rand?: { srcSec: number; phase: number; jitterFactor: number; lastBeat: number };
}

export class VideoCompositor {
  private device: GPUDevice | null = null;
  private gpuHost: GPUHost | null = null;
  private blitter: FrameBlitter | null = null;
  private service: VideoPlaybackService | null = null;
  private servicePromise: Promise<VideoPlaybackService> | null = null;

  /** Open pumps, keyed by clipId. */
  private pumps = new Map<string, Pump>();
  /** Clips currently being opened (async), to avoid double-open. */
  private opening = new Set<string>();
  /** Clips whose source FAILED to open/decode (missing file, bad codec, …). They'll
   *  never produce a frame, so the Precise transport gate must treat them as "ready"
   *  (don't hold the playhead) and render them transparent. Cleared on source swap. */
  private failedClips = new Set<string>();
  private raf = 0;

  /** Warp-aware beat→seconds. Defaults to the un-warped base-BPM clock; the bridge
   *  pushes a WarpClock-backed resolver (engine-bridge.ts) when the composition changes. */
  private secondsAt: TimeResolver | null = null;

  // ── Diagnostics (read via the bridge) ──
  /** Count of decoded frames pushed to the executor. */
  framesInjected = 0;
  /** Last error from a pull/open (pump errors are otherwise debug-only). */
  lastError: string | null = null;
  /** Last pulled frame index + the source texture handle (per clip). */
  lastPulled: Record<string, { frame: number; handle: number; w: number; h: number }> = {};

  constructor(
    /** Push a decoded frame to the executor for `instanceKey`. */
    private readonly setInstanceTexture: (instanceKey: string, bitmap: ImageBitmap | null) => void,
    /** Render size the frames are blitted to (matches the composite sketch). */
    private renderW: number,
    private renderH: number,
    private readonly clock: TransportClock,
    /** Composition resolution — what 'none' scale reasons about (1:1 vs the
     *  composition, NOT the possibly-downscaled preview). Defaults to render size. */
    private compW = renderW,
    private compH = renderH,
  ) {}

  /** Install the warp-aware beat→seconds resolver (shared with the visual grid). */
  setTimeResolver(fn: TimeResolver | null) {
    this.secondsAt = fn;
  }

  /** Update the blit render (preview) size + the composition resolution. */
  setRenderSize(w: number, h: number, compW = w, compH = h) {
    this.renderW = w;
    this.renderH = h;
    this.compW = compW;
    this.compH = compH;
  }

  private ensureService(): Promise<VideoPlaybackService> {
    if (this.service) return Promise.resolve(this.service);
    if (!this.servicePromise) {
      this.servicePromise = (async () => {
        // Reuse the thumbnailController's main-thread GPU device + decode service
        // (one device per page — a second requestDevice fails under headless
        // WebGPU). We only add our own FrameBlitter on the shared device.
        const { device, gpuHost, service } = await thumbnailController.sharedGpu();
        this.device = device;
        this.gpuHost = gpuHost;
        this.blitter = new FrameBlitter(device);
        this.service = service;
        return service;
      })();
    }
    return this.servicePromise;
  }

  /**
   * Reconcile the active video clips: open new ones, close departed ones, and
   * keep timing in sync. Cheap to call every frame (diffed by clipId).
   */
  setActiveClips(descs: VideoClipDesc[]) {
    const wanted = new Map(descs.map((d) => [d.clipId, d]));
    // Close departed.
    for (const [clipId, pump] of [...this.pumps]) {
      if (!wanted.has(clipId)) {
        this.pumps.delete(clipId);
        pump.desc && this.setInstanceTexture(pump.desc.instanceKey, null);
        this.service?.close(pump.clip).catch(() => {});
      }
    }
    // Forget broken clips that are no longer active (re-adding retries fresh).
    for (const id of [...this.failedClips]) if (!wanted.has(id)) this.failedClips.delete(id);
    // Open new / update existing timing.
    for (const d of descs) {
      const existing = this.pumps.get(d.clipId);
      if (existing) {
        // If the SOURCE changed under this clipId (a source swap, or — defensively —
        // duplicate clip ids), the open decoder is for the wrong video: tear it down
        // so it re-opens, else the pump keeps injecting the old clip's frames.
        if (existing.desc.sourceKey !== d.sourceKey || existing.desc.url !== d.url) {
          this.setInstanceTexture(existing.desc.instanceKey, null);
          this.service?.close(existing.clip).catch(() => {});
          this.pumps.delete(d.clipId);
          this.failedClips.delete(d.clipId); // new source → give it a fresh chance
          if (!this.opening.has(d.clipId)) void this.openClip(d);
        } else {
          existing.desc = d; // startBeat/length/instanceKey may have changed
        }
      } else if (!this.opening.has(d.clipId) && !this.failedClips.has(d.clipId)) {
        // Skip clips already known-broken at this URL — don't re-attempt every frame.
        void this.openClip(d);
      }
    }
    if (this.pumps.size > 0 || this.opening.size > 0) this.start();
    else this.stop();
  }

  private async openClip(d: VideoClipDesc) {
    this.opening.add(d.clipId);
    try {
      const service = await this.ensureService();
      const resp = await fetch(d.url);
      const blob = await resp.blob();
      // Random-access (not sequential): the timeline scrubs anywhere.
      const clip = await service.open(blob, d.sourceKey, { sequential: false });
      if (!this.opening.has(d.clipId)) { service.close(clip).catch(() => {}); return; } // canceled
      const info = service.inspect(clip);
      this.pumps.set(d.clipId, {
        desc: d,
        clip,
        width: info.width,
        height: info.height,
        frameCount: info.frameCount > 0 ? info.frameCount : Math.max(1, d.durationFrames),
        fps: info.fps > 0 ? info.fps : d.fps ?? 30,
        busy: false,
      });
    } catch (err) {
      console.warn('[video-compositor] open failed:', d.url, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      // Mark broken so the Precise gate stops waiting on it (the playhead barrels
      // through; the clip renders transparent) and we don't re-open it every frame.
      this.failedClips.add(d.clipId);
      this.setInstanceTexture(d.instanceKey, null);
    } finally {
      this.opening.delete(d.clipId);
      if (this.pumps.size > 0) this.start();
    }
  }

  private start() {
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      this.pumpAll();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private pumpAll() {
    if (this.pumps.size === 0) return;
    const { beat, bpm } = this.clock();
    for (const pump of this.pumps.values()) {
      if (pump.busy) continue;
      pump.busy = true;
      void this.pumpClip(pump, beat, bpm);
    }
  }

  /**
   * Map the transport position to a clip-local source frame per the clip's play mode,
   * or `null` to render transparent (one-shot off the slice). Warp-aware via the
   * installed time resolver; falls back to the base-BPM clock.
   */
  private frameFor(p: Pump, beat: number, bpm: number): number | null {
    const d = p.desc;
    const secondsAt = this.secondsAt ?? ((b: number) => b * (60 / Math.max(1, bpm)));
    const ctx: ClipTimeCtx = {
      startBeat: d.startBeat,
      lengthBeat: d.lengthBeat,
      videoDurSec: p.frameCount / Math.max(1, p.fps),
      secondsAt,
      seed: clipNoiseSeed(p.desc.clipId),
    };
    const loop = d.loop ?? DEFAULT_LOOP;
    // 'random' is the REAL stochastic dwell-jump algorithm for playback (the strips use
    // the deterministic smooth-noise approximation in the mapper instead).
    if (loop.mode === 'random') return this.randomFrame(p, loop, ctx, beat);
    return clipSourceFrameAt(loop, ctx, beat, p.fps, p.frameCount);
  }

  /**
   * Stateful stochastic 'random' driver. Between jumps the source position drifts at
   * `speed` (forward, or BACKWARD when scrubbing back) looping at the slice end; a jump
   * fires when the accumulated dwell (a
   * jittered `dwell`) elapses, relocating by a ±distance sampled uniformly in
   * [jumpDistanceMin, jumpDistanceMax] (fraction-of-slice or seconds), reflected at the
   * slice edges. Truly
   * non-deterministic (Math.random). The dwell runs as a NORMALISED phase accumulator whose
   * rate is `1 / dwell` sampled live each frame (synth-style), so editing `dwell` re-rates the
   * current cycle immediately, and rewinding then replaying keeps jumping rather than stalling
   * until the playhead reaches its pre-seek position. A same-beat re-query (the Precise gate's
   * clipReady) sees delta 0 ⇒ returns the identical frame as pumpClip.
   */
  private randomFrame(p: Pump, loop: ClipLoopConfig, ctx: ClipTimeCtx, beat: number): number {
    const lo = loop.startSec ?? 0;
    const hi = loop.endSec ?? ctx.videoDurSec;
    const range = Math.max(0, hi - lo);
    const speed = loop.speed ?? 1;
    const dwell = loop.dwell ?? RANDOM_DEFAULTS.dwell;
    const unit = loop.dwellUnit ?? RANDOM_DEFAULTS.dwellUnit;
    const jitter = loop.dwellJitter ?? RANDOM_DEFAULTS.dwellJitter;
    const jMin = Math.max(0, loop.jumpDistanceMin ?? RANDOM_DEFAULTS.jumpDistanceMin);
    const jMax = Math.max(jMin, loop.jumpDistanceMax ?? RANDOM_DEFAULTS.jumpDistanceMax);
    const jumpUnit = loop.jumpDistanceUnit ?? RANDOM_DEFAULTS.jumpDistanceUnit;
    const toSec = (v: number) => (jumpUnit === 'fraction' ? v * range : v);
    // Warp-ignoring: convert seconds↔beats via the clip's local sec/beat rate.
    const secPerBeat = Math.max(1e-3, ctx.secondsAt(ctx.startBeat + 1) - ctx.secondsAt(ctx.startBeat));
    const dwellBeats = Math.max(0.05, unit === 'sec' ? dwell / secPerBeat : dwell);
    const wrap = (s: number): number => (range <= 1e-9 ? lo : lo + (((s - lo) % range) + range) % range);
    // Billiard-fold any target back into [lo,hi]. Handles a distance larger than the gap
    // to one wall (e.g. a full-range jump from the middle) — a single ± flip + clamp
    // would snap to the slice START, i.e. a once-per-dwell flash of frame 0.
    const reflectInto = (x: number): number => {
      const period = 2 * range;
      let t = (((x - lo) % period) + period) % period; // [0, 2·range)
      if (t > range) t = period - t; // fold the far half back
      return lo + t;
    };
    const pick = (from: number): number => {
      if (range <= 1e-9) return lo;
      // Distance ~ U(min, max); random ± direction; reflected (not clamped) into the slice.
      const dist = toSec(jMin + Math.random() * (jMax - jMin));
      const sign = Math.random() < 0.5 ? -1 : 1;
      return reflectInto(from + sign * dist);
    };
    // This cycle's dwell multiplier ∈ ~[1-jitter, 1+jitter], clamped positive.
    const newJitter = () => Math.max(0.05, 1 + jitter * (Math.random() * 2 - 1));
    let st = p.rand;
    if (!st) st = p.rand = { srcSec: pick(lo + range * 0.5), phase: 0, jitterFactor: newJitter(), lastBeat: beat };
    const delta = beat - st.lastBeat;
    st.lastBeat = beat;
    if (delta !== 0) {
      // Playback drifts through the source at `speed` (signed ⇒ reverse when scrubbing
      // back), looping the slice. The dwell phase advances like a synth oscillator: its
      // rate is `1 / effectiveDwell` evaluated from the LIVE `dwell` param each frame, so
      // turning the knob re-rates the current cycle instantly. Jumps fire forward each time
      // the phase wraps past 1, and — symmetrically — backward when it falls below 0 (a
      // backward scrub runs the phase in reverse and re-jumps; jumps are stochastic, so
      // they're re-randomized, not literally undone).
      st.srcSec = wrap(st.srcSec + speed * delta * secPerBeat);
      const effDwell = Math.max(0.01, dwellBeats * st.jitterFactor);
      st.phase += delta / effDwell;
      let guard = 0;
      while (st.phase >= 1 && guard++ < 4096) {
        st.phase -= 1;
        st.srcSec = pick(st.srcSec);
        st.jitterFactor = newJitter();
      }
      while (st.phase < 0 && guard++ < 4096) {
        st.srcSec = pick(st.srcSec);
        st.jitterFactor = newJitter();
        st.phase += 1;
      }
    }
    return Math.min(p.frameCount - 1, Math.max(0, Math.floor(st.srcSec * p.fps)));
  }

  private async pumpClip(p: Pump, beat: number, bpm: number) {
    try {
      if (!this.gpuHost || !this.blitter || !this.service) return;
      const d = p.desc;
      const active = beat >= d.startBeat - 1e-6 && beat < d.startBeat + d.lengthBeat - 1e-6;
      const ahead = beat < d.startBeat - 1e-6;
      // For a clip not yet reached, warm its ENTRY frame (what it shows AT its start),
      // not the current beat extrapolated into the future (which is null / a wrong loop
      // phase) — so the lookahead actually pre-decodes the frame we'll need on arrival.
      const frame = this.frameFor(p, ahead ? d.startBeat : beat, bpm);
      const mode = d.scaleMode ?? 'fit';
      const xf = d.transform ?? IDENTITY_TRANSFORM;
      const key = this.frameKey(p, frame);
      if (!active) {
        // LOOKAHEAD warming: decode the upcoming frame into the service cache so
        // reaching this clip doesn't stall — but DON'T inject (the instance isn't
        // composited yet, so the texture would go nowhere and poison `lastKey`).
        if (frame === null || key === p.warmedKey) return; // nothing to warm off-slice
        const h = await this.service.pull(p.clip, frame);
        if (h > 0) p.warmedKey = key;
        return;
      }
      if (key === p.lastKey) return; // unchanged → the bound texture is already correct
      if (frame === null) {
        // Off the slice (one-shot before/after the source): clear the bound texture so
        // the clip composites as transparent rather than holding a stale frame.
        // Mark lastKey BEFORE injecting: setInstanceTexture fires the bridge's Precise
        // re-check synchronously, which reads lastKey via clipReady.
        p.lastKey = key;
        this.setInstanceTexture(p.desc.instanceKey, null);
        return;
      }
      const handle = await this.service.pull(p.clip, frame);
      if (handle <= 0 || !this.pumps.has(p.desc.clipId)) return;
      const tex = this.gpuHost.getTextureByHandle(handle);
      if (!tex) { this.lastError = `no texture for handle ${handle}`; return; }
      // Blit + scale (per the clip's scale mode) to the composite render size,
      // so source.video.file just copies a ready-to-composite frame.
      const bitmap = this.blitter.toImageBitmap(tex, this.renderW, this.renderH, mode, xf, this.compW, this.compH);
      this.lastPulled[p.desc.clipId] = { frame, handle, w: bitmap.width, h: bitmap.height };
      // Mark lastKey BEFORE injecting: setInstanceTexture fires the bridge's Precise
      // re-check synchronously, and it reads lastKey via clipReady to know we're ready.
      p.lastKey = key;
      this.framesInjected++;
      this.setInstanceTexture(p.desc.instanceKey, bitmap);
    } catch (err) {
      this.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.debug('[video-compositor] pump failed', err);
    } finally {
      p.busy = false;
    }
  }

  destroy() {
    this.stop();
    for (const pump of this.pumps.values()) this.service?.close(pump.clip).catch(() => {});
    this.pumps.clear();
    this.opening.clear();
  }

  /**
   * Has this clip's decoded frame for `beat` been injected yet? Used by the
   * bridge's "Precise" transport gate to avoid compositing/stepping before a
   * video input is ready (which flashes a not-yet-decoded clip). A clip with no
   * pump (still opening) is NOT ready.
   */
  clipReady(clipId: string, beat: number, bpm: number): boolean {
    if (this.failedClips.has(clipId)) return true; // broken → "ready" so the gate stops waiting
    if (this.opening.has(clipId)) return false;
    const pump = this.pumps.get(clipId);
    if (!pump) return false;
    const frame = this.frameFor(pump, beat, bpm);
    return pump.lastKey === this.frameKey(pump, frame);
  }

  /** Per-frame inject/dedup key. Folds in the scale mode + placement transform +
   *  render size, so a mode/transform/resize edit re-blits AND the Precise gate's
   *  `clipReady` agrees with what `pumpClip` last injected (shared, no drift). */
  private frameKey(p: Pump, frame: number | null): string {
    const mode = p.desc.scaleMode ?? 'fit';
    const x = p.desc.transform ?? IDENTITY_TRANSFORM;
    const xfSig = `${x.anchorX},${x.anchorY},${x.scale},${x.rotation},${x.flipH ? 1 : 0}${x.flipV ? 1 : 0}`;
    return `${frame ?? 'null'}:${mode}:${xfSig}:${this.renderW}x${this.renderH}`;
  }

  /** Active pump count (diagnostic / tests). */
  get pumpCount(): number {
    return this.pumps.size;
  }
}
