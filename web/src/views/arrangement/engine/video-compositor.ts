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
import { FrameBlitter, type BlitFit, type BlitTransform } from '../../../video/frame-blitter';
import { PlaybackCursor, createPlaybackCursor } from '../../../video/playback-cursor';
import { thumbnailController } from '../media/thumbnail-controller';
import { clipSourceTimeAt, clipNoiseSeed, type ClipTimeCtx } from './clip-time';
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

/** Open-retry policy (see {@link VideoCompositor.failedAt}): give a failing clip a few
 *  spaced attempts before declaring it permanently broken (cold-start failures recover). */
const FAIL_GIVEUP_TRIES = 4;
const FAIL_RETRY_MS = 350;
/** Monotonic-ish millis for the retry backoff (test/headless-safe fallback). */
const nowMs = (): number => globalThis.performance?.now?.() ?? Date.now();

interface Pump {
  desc: VideoClipDesc;
  /** This clip's caller-held read cursor — its own <video> playing forward (native
   *  speed), seeking only on a jump. Replaces per-frame service decode. */
  cursor: PlaybackCursor;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  durationSec: number;
  busy: boolean;
  /** Rate tracking: the source-seconds-per-real-second the target is advancing at,
   *  derived from the beat delta between ticks — drives the cursor's play-vs-seek. */
  lastTargetSec?: number;
  lastTickMs?: number;
  rateEwma: number;
  // Telemetry (logged when `globalThis.__arrVideoLog` is on): inject cadence + scenario-once.
  lastInjectMs?: number;
  injectGapSumMs: number;
  injectGapMax: number;
  injectCount: number;
  loggedScenario?: boolean;
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
  private gpuPromise: Promise<void> | null = null;

  /** Open pumps, keyed by clipId. */
  private pumps = new Map<string, Pump>();
  /** Clips currently being opened (async), to avoid double-open. */
  private opening = new Set<string>();
  /** Open failures per clip (timestamp of the last attempt + count). A SINGLE failure
   *  is often transient — the very first clip is warmed before the decode service /
   *  GPU host is hot, so its open can throw once and then succeed. We therefore RETRY
   *  (with a short backoff) and only treat a clip as permanently broken — letting the
   *  Precise gate barrel past it (transparent, no stall) — after {@link FAIL_GIVEUP_TRIES}
   *  attempts. Cleared on success / source swap. */
  private failedAt = new Map<string, { at: number; tries: number }>();
  private raf = 0;

  /** Notified with a clip's TRUE decoded pixel size the first time it opens, so the
   *  host can backfill `source.width/height` (authoritative — fixes the placement
   *  widget's aspect for clips whose stored dimensions are missing). */
  onClipInfo?: (clipId: string, width: number, height: number) => void;

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

  private ensureGpu(): Promise<void> {
    if (this.gpuHost && this.blitter) return Promise.resolve();
    if (!this.gpuPromise) {
      this.gpuPromise = (async () => {
        // Reuse the thumbnailController's main-thread GPU device (one device per page — a
        // second requestDevice fails under headless WebGPU). Cursors own their own <video>
        // elements; we only need the shared device + our own FrameBlitter on it.
        const { device, gpuHost } = await thumbnailController.sharedGpu();
        this.device = device;
        this.gpuHost = gpuHost;
        this.blitter = new FrameBlitter(device);
      })();
    }
    return this.gpuPromise;
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
        pump.cursor.release();
      }
    }
    // Forget broken clips that are no longer active (re-adding retries fresh).
    for (const id of [...this.failedAt.keys()]) if (!wanted.has(id)) this.failedAt.delete(id);
    // Open new / update existing timing.
    for (const d of descs) {
      const existing = this.pumps.get(d.clipId);
      if (existing) {
        // If the SOURCE changed under this clipId (a source swap, or — defensively —
        // duplicate clip ids), the open decoder is for the wrong video: tear it down
        // so it re-opens, else the pump keeps injecting the old clip's frames.
        if (existing.desc.sourceKey !== d.sourceKey || existing.desc.url !== d.url) {
          this.setInstanceTexture(existing.desc.instanceKey, null);
          existing.cursor.release();
          this.pumps.delete(d.clipId);
          this.failedAt.delete(d.clipId); // new source → give it a fresh chance
          if (!this.opening.has(d.clipId)) void this.openClip(d);
        } else {
          existing.desc = d; // startBeat/length/instanceKey may have changed
        }
      } else if (!this.opening.has(d.clipId)) {
        // Open new — or RETRY a recent failure after a backoff (cold-start failures
        // recover), but stop re-attempting once it's declared permanently broken.
        const f = this.failedAt.get(d.clipId);
        if (!f || (f.tries < FAIL_GIVEUP_TRIES && nowMs() - f.at >= FAIL_RETRY_MS)) {
          void this.openClip(d);
        }
      }
    }
    if (this.pumps.size > 0 || this.opening.size > 0) this.start();
    else this.stop();
  }

  private async openClip(d: VideoClipDesc) {
    this.opening.add(d.clipId);
    try {
      await this.ensureGpu();
      const resp = await fetch(d.url);
      const blob = await resp.blob();
      // Build this clip's read cursor — its own <video> that plays forward (native speed)
      // and seeks only on jumps. createPlaybackCursor measures the TRUE fps + native size.
      const { cursor, info } = await createPlaybackCursor(this.gpuHost!, blob);
      if (!this.opening.has(d.clipId)) { cursor.release(); return; } // canceled mid-open
      this.pumps.set(d.clipId, {
        desc: d,
        cursor,
        width: info.width,
        height: info.height,
        frameCount: info.frameCount > 0 ? info.frameCount : Math.max(1, d.durationFrames),
        fps: info.fps > 0 ? info.fps : d.fps ?? 30,
        durationSec: info.durationSec,
        busy: false,
        rateEwma: 0,
        injectGapSumMs: 0,
        injectGapMax: 0,
        injectCount: 0,
      });
      this.failedAt.delete(d.clipId); // opened cleanly → clear any prior failure
      // Backfill the clip's authoritative native size (the placement widget's aspect).
      if (info.width > 0 && info.height > 0) this.onClipInfo?.(d.clipId, info.width, info.height);
    } catch (err) {
      console.warn('[video-compositor] open failed:', d.url, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      // Record the failure (count + time). It's RETRIED with a backoff (the first clip
      // often fails once on a cold service, then opens) and only declared permanently
      // broken after FAIL_GIVEUP_TRIES, at which point the Precise gate barrels past it.
      const prev = this.failedAt.get(d.clipId);
      this.failedAt.set(d.clipId, { at: nowMs(), tries: (prev?.tries ?? 0) + 1 });
      if (!this.pumps.has(d.clipId)) this.setInstanceTexture(d.instanceKey, null);
    } finally {
      this.opening.delete(d.clipId);
      if (this.pumps.size > 0 || this.opening.size > 0) this.start();
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
    this.maybeLog(beat);
  }

  private lastLogMs = 0;
  /** Periodic playback telemetry (≈1Hz). Enable in the console with
   *  `globalThis.__arrVideoLog = true`. Logs each clip's action mix (play/seek/hold),
   *  drift, seek durations, and the real inject cadence — so a stutter's cause (loop-wrap
   *  seeks vs decode lag vs gate holds) is visible. */
  private maybeLog(beat: number) {
    if (!(globalThis as unknown as { __arrVideoLog?: boolean }).__arrVideoLog) return;
    const t = nowMs();
    if (this.lastLogMs && t - this.lastLogMs < 1000) return;
    this.lastLogMs = t;
    for (const [id, p] of this.pumps) {
      if (!p.loggedScenario) {
        p.loggedScenario = true;
        const l = p.desc.loop;
        console.log(`[vid ${id}] scenario ${p.width}x${p.height} fps=${p.fps.toFixed(2)} frames=${p.frameCount} dur=${p.durationSec.toFixed(2)}s mode=${l?.mode ?? 'time'} slice=[${(l?.startSec ?? 0).toFixed(2)},${(l?.endSec ?? p.durationSec).toFixed(2)}]s speed=${l?.speed ?? 1} dir=${l?.direction ?? 'forward'}`);
      }
      const s = p.cursor.snapshotStats();
      const driftAvg = s.ticks ? (s.driftSumSec / s.ticks) * 1000 : 0;
      const seekAvg = s.seeksDone ? s.seekMsSum / s.seeksDone : 0;
      const injAvg = p.injectCount ? p.injectGapSumMs / p.injectCount : 0;
      console.log(
        `[vid ${id}] ${s.ticks}t play=${s.play} seek=${s.seek} hold=${s.hold} notReady=${s.notReady}` +
        ` | drift avg=${driftAvg.toFixed(0)}ms max=${(s.driftMaxSec * 1000).toFixed(0)}ms` +
        ` | seeks=${s.seeksDone} avg=${seekAvg.toFixed(0)}ms max=${s.seekMsMax.toFixed(0)}ms` +
        ` | inject n=${p.injectCount} avg=${injAvg.toFixed(0)}ms max=${p.injectGapMax.toFixed(0)}ms` +
        ` | beat=${beat.toFixed(2)} rate=${p.rateEwma.toFixed(3)}`,
      );
      p.injectGapSumMs = 0; p.injectGapMax = 0; p.injectCount = 0;
    }
  }

  /**
   * Map the transport position to a clip-local source frame per the clip's play mode,
   * or `null` to render transparent (one-shot off the slice). Warp-aware via the
   * installed time resolver; falls back to the base-BPM clock.
   */
  private targetSecFor(p: Pump, beat: number, bpm: number): number | null {
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
    if (loop.mode === 'random') return this.randomSec(p, loop, ctx, beat);
    return clipSourceTimeAt(loop, ctx, beat);
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
  private randomSec(p: Pump, loop: ClipLoopConfig, ctx: ClipTimeCtx, beat: number): number {
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
    return st.srcSec; // source SECOND (the cursor maps to a frame); already folded into the slice
  }

  /** Source-seconds advanced per real-second the target is moving (from the beat delta
   *  between ticks, so warp/speed/beat-sync all fold in). Drives the cursor's play vs
   *  seek: a smooth forward value ⇒ play the element; 0 (paused) or a backward/huge spike
   *  (loop wrap, scrub) ⇒ the cursor holds/seeks. EWMA-smoothed to steady playbackRate. */
  private trackRate(p: Pump, targetSec: number | null): number {
    const tMs = nowMs();
    const prevSec = p.lastTargetSec, prevMs = p.lastTickMs;
    if (targetSec != null) p.lastTargetSec = targetSec;
    p.lastTickMs = tMs;
    if (targetSec == null || prevSec == null || prevMs == null) return p.rateEwma;
    const dReal = (tMs - prevMs) / 1000;
    if (dReal <= 1e-4) return p.rateEwma;
    const inst = (targetSec - prevSec) / dReal;
    // Heavy smoothing so the rate (→ playbackRate) is STEADY — the dReal jitter between rAF
    // ticks makes `inst` noisy, and a noisy playbackRate judders the video. Snap immediately
    // on resume (rateEwma was ~0) so playback starts at the right speed, then ease.
    if (inst > 1e-3 && inst < 8) p.rateEwma = p.rateEwma > 1e-3 ? p.rateEwma * 0.9 + inst * 0.1 : inst;
    else if (inst <= 1e-3) p.rateEwma = 0; // paused / reversed → don't chase
    return p.rateEwma;
  }

  private async pumpClip(p: Pump, beat: number, bpm: number) {
    try {
      if (!this.gpuHost || !this.blitter) return;
      const d = p.desc;
      const active = beat >= d.startBeat - 1e-6 && beat < d.startBeat + d.lengthBeat - 1e-6;
      const ahead = beat < d.startBeat - 1e-6;
      // For a clip not yet reached, target its ENTRY (what it shows AT its start) so the
      // cursor pre-seeks there rather than chasing a future / wrong-phase frame.
      const targetSec = this.targetSecFor(p, ahead ? d.startBeat : beat, bpm);
      const rate = this.trackRate(p, targetSec);
      // Seamless native loop (like a plain <video loop>, no per-wrap seek) for a FORWARD,
      // WHOLE-FILE looping slice — the wrap point matches the file end. Sub-slice / one-shot
      // / reverse keep seek-on-wrap.
      const loop = d.loop ?? DEFAULT_LOOP;
      const fullFile = (loop.startSec ?? 0) <= 0.05 && (loop.endSec ?? p.durationSec) >= p.durationSec - 0.05;
      const looping = loop.mode === 'time' || loop.mode === 'beat-sync';
      p.cursor.setNativeLoop(looping && fullFile && (loop.direction ?? 'forward') === 'forward' ? p.durationSec : 0);

      if (!active) {
        // LOOKAHEAD: pre-seek the cursor to the entry frame (no inject) so arrival doesn't
        // stall — but DON'T inject (the instance isn't composited yet).
        if (targetSec == null) return;
        const key = `warm:${Math.floor(targetSec * p.fps)}`;
        if (key === p.warmedKey) return;
        p.cursor.present(targetSec, 0); // rate 0 ⇒ seek to the entry frame
        p.warmedKey = key;
        return;
      }

      if (targetSec == null) {
        // Off the slice (one-shot before/after the source) → transparent. Mark lastKey
        // BEFORE injecting: setInstanceTexture fires the Precise re-check synchronously.
        if (p.lastKey === 'null') return;
        p.lastKey = 'null';
        this.setInstanceTexture(d.instanceKey, null);
        return;
      }

      // Drive the cursor (play forward / seek / hold) and sample the current frame.
      const res = p.cursor.present(targetSec, rate);
      if (!res || !this.pumps.has(d.clipId)) return; // no frame ready yet
      // Dedup on the PRESENTED frame: a playing frame advances (inject each new one); a
      // held/paused frame repeats (skip the re-blit — the worker keeps the bound texture).
      const presentedFrame = Math.max(0, Math.floor(res.sec * p.fps));
      const key = this.frameKey(p, presentedFrame);
      if (key === p.lastKey) return;
      const tex = this.gpuHost.getTextureByHandle(res.handle);
      if (!tex) { this.lastError = `no texture for handle ${res.handle}`; return; }
      const mode = d.scaleMode ?? 'fit';
      const xf = d.transform ?? IDENTITY_TRANSFORM;
      const bitmap = this.blitter.toImageBitmap(tex, this.renderW, this.renderH, mode, xf, this.compW, this.compH);
      this.lastPulled[d.clipId] = { frame: presentedFrame, handle: res.handle, w: bitmap.width, h: bitmap.height };
      p.lastKey = key;
      this.framesInjected++;
      // Telemetry: gap since the last NEW frame was pushed (the real cadence the viewer sees).
      const tNow = nowMs();
      if (p.lastInjectMs != null) {
        const gap = tNow - p.lastInjectMs;
        p.injectGapSumMs += gap;
        if (gap > p.injectGapMax) p.injectGapMax = gap;
        p.injectCount++;
      }
      p.lastInjectMs = tNow;
      this.setInstanceTexture(d.instanceKey, bitmap);
    } catch (err) {
      this.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.debug('[video-compositor] pump failed', err);
    } finally {
      p.busy = false;
    }
  }

  /** Force every active pump to RE-INJECT its current frame on the next tick. Call
   *  after the composite SKETCH is reissued: that recreates the `source.video.file`
   *  instances (dropping their bound textures), and any frame injected DURING a Precise
   *  hold went to an instance that didn't exist yet — so without this a static frame (a
   *  still image, or a paused video's first frame) would stay blank, since its frame key
   *  never changes and the `key === lastKey` guard blocks a re-inject. */
  reinjectActive() {
    let any = false;
    for (const p of this.pumps.values()) { p.lastKey = undefined; p.warmedKey = undefined; any = true; }
    if (any) this.start();
  }

  destroy() {
    this.stop();
    for (const pump of this.pumps.values()) pump.cursor.release();
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
    // Only treat as "ready" (barrel the gate past it) once it's PERMANENTLY broken;
    // while it still has retries left it stays not-ready so the gate waits for one to land.
    const f = this.failedAt.get(clipId);
    if (f && f.tries >= FAIL_GIVEUP_TRIES) return true;
    if (this.opening.has(clipId)) return false;
    const pump = this.pumps.get(clipId);
    if (!pump) return false;
    const targetSec = this.targetSecFor(pump, beat, bpm);
    if (targetSec == null) return true; // off-slice ⇒ transparent is a valid "ready"
    return pump.cursor.ready(targetSec);
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
