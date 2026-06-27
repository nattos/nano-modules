/**
 * PlaybackCursor — a caller-held read position into a video, designed to match a
 * plain <video> element's performance.
 *
 * THE PROBLEM it solves: the playback service's "seekable" path decodes every frame
 * by setting `<video>.currentTime` and waiting for `seeked` — fine for scrubbing, but
 * for straight-through playback it re-seeks per frame and stutters. A native <video>
 * *playing forward* decodes continuously and is always smooth (and loops + single-
 * keyframe clips Just Work). A cursor reproduces that: a caller (e.g. the compositor
 * pump, one cursor per active video clip) acquires a cursor, asks it to PRESENT a
 * source time every frame, and releases it on teardown. The cursor:
 *   - lets its element PLAY FORWARD to track a forward-advancing target (native speed),
 *   - SEEKS natively only when the target jumps (scrub / loop-wrap / reverse),
 *   - marks "ready" at the real present moment (rVFC), so the UI updates on time.
 *
 * `decideCursorAction` is the pure brain (unit-tested); `PlaybackCursor` executes it
 * against a real <video> + GPU texture (DOM/GPU — verified on real media).
 */

import type { GPUHost } from '../gpu-host';
import { measureFps } from './video-element-frame-source';

// ── Pure decision policy (unit-tested) ────────────────────────────────────────

export type CursorAction =
  /** Ensure the element is PLAYING at `rate` (source-sec per real-sec) — it tracks a
   *  forward-advancing target itself, the fast native path. */
  | { kind: 'play'; rate: number }
  /** Native seek to `sec` — the target jumped (scrub, loop wrap, reverse, big drift). */
  | { kind: 'seek'; sec: number }
  /** Already on target (or a seek is in flight) — just sample the current frame. */
  | { kind: 'hold' };

export interface CursorDecisionInput {
  /** The element's current time (s). */
  curSec: number;
  /** The source time we want presented (s) — already resolved by the clip-time mapper
   *  (slice + loop + speed + direction all folded in). */
  targetSec: number;
  /** Source duration (s). */
  durationSec: number;
  fps: number;
  /** Transport rate: source-seconds advanced per real-second. >0 forward play, 0
   *  paused/frozen, <0 reverse (reverse can't play forward → always seeks). */
  rate: number;
  /** A seek issued by a previous decision is still in flight. */
  seeking: boolean;
  /** When the element loops the WHOLE file natively (`video.loop`), the target wraps at
   *  this period; fold the delta so a wrap reads as ~0 (keep playing) rather than a
   *  full-file backward jump (a seek). 0/undefined ⇒ no native loop. */
  loopPeriodSec?: number;
}

/** Browser playbackRate is clamped to a sane window (very high rates desync audio-less
 *  decode anyway; we re-seek for big jumps instead). */
export function clampPlaybackRate(rate: number): number {
  return Math.max(0.0625, Math.min(16, rate));
}

/** Clamp a target second into the decodable range (a hair inside the end). */
export function clampSec(sec: number, durationSec: number, frame: number): number {
  return Math.max(0, Math.min(Math.max(0, durationSec - frame * 0.5), sec));
}

/**
 * Decide how to reach `targetSec`: let the element PLAY forward (when the transport is
 * playing and the target is at/just ahead of us — the native fast path), HOLD (already
 * there, or mid-seek), or SEEK (a jump). The "just ahead" window lets a playing element
 * coast to catch a target that's a few frames in front without a re-seek.
 */
export function decideCursorAction(i: CursorDecisionInput): CursorAction {
  if (i.seeking) return { kind: 'hold' }; // an issued seek hasn't landed yet
  const frame = 1 / Math.max(1, i.fps);
  const tol = 1.5 * frame; // within ~1.5 frames ⇒ "on target"
  let delta = i.targetSec - i.curSec; // how far AHEAD the target is
  // Under native loop, fold the delta to the minimal signed distance around the period, so
  // a wrap (target just looped to 0 while the element is near the end, or vice-versa) reads
  // as ~0 — the element's own loop kept playing, no seek needed.
  if (i.loopPeriodSec && i.loopPeriodSec > frame) {
    const p = i.loopPeriodSec;
    delta = (((delta % p) + p + p / 2) % p) - p / 2;
  }

  // Forward play: transport advancing + the target is at or a little ahead of us → let
  // the element play to track it (continuous decode, no per-frame seek).
  const fwdCatchup = Math.max(0.5, 8 * frame); // coast up to ~0.5s ahead before re-seeking
  if (i.rate > 1e-6 && delta >= -tol && delta <= fwdCatchup) {
    return { kind: 'play', rate: clampPlaybackRate(i.rate) };
  }
  // On target (within a frame) → just sample what's there.
  if (Math.abs(delta) <= tol) return { kind: 'hold' };
  // Anything else — a jump (scrub / loop wrap / reverse / big drift) → native seek.
  return { kind: 'seek', sec: clampSec(i.targetSec, i.durationSec, frame) };
}

// ── The cursor (DOM + GPU; verified on real media) ────────────────────────────

/** Wait for a seek/frame on `video`, resolving at the real present time (rVFC) or on
 *  `seeked`, or after `timeoutMs` (never rejects, so a no-op seek can't hang). */
function awaitFrame(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const rvfc = (video as unknown as { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback;
    const timer = setTimeout(done, timeoutMs);
    const cleanup = () => { video.removeEventListener('seeked', done); clearTimeout(timer); };
    video.addEventListener('seeked', done);
    if (typeof rvfc === 'function') rvfc.call(video, () => done());
  });
}

/** Cap on a single seek's wait (matches the service's seekable budget). */
const SEEK_TIMEOUT_MS = 300;

/** Frames buffered per cursor for drift correction by FRAME SELECTION (present the neighbour
 *  frame) instead of a speed change — the "nudge" the cache will eventually own. */
const RING_CAP = 3;
/** Play this far AHEAD of the target (in frames) so the ring straddles it — giving a
 *  "future" frame to pick as well as past ones, so the presented frame can match the target
 *  exactly without ever changing playbackRate. */
const LEAD_FRAMES = 1;

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

/** Per-cursor rolling telemetry (drained + reset by the pump's periodic logger). Answers
 *  "is playback a steady forward play, or is it thrashing seeks / drifting / stalling?" */
export interface CursorStats {
  ticks: number;
  play: number; seek: number; hold: number;
  /** present() returned a frame but it WASN'T within tolerance of the target (gate would hold). */
  notReady: number;
  driftSumSec: number; driftMaxSec: number; // |presented − target|
  seeksDone: number; seekMsSum: number; seekMsMax: number; // begin→landed durations
}

function freshStats(): CursorStats {
  return { ticks: 0, play: 0, seek: 0, hold: 0, notReady: 0, driftSumSec: 0, driftMaxSec: 0, seeksDone: 0, seekMsSum: 0, seekMsMax: 0 };
}

export class PlaybackCursor {
  private device: GPUDevice;
  private seeking = false;
  private released = false;
  /** Source second of the frame actually selected/presented last (telemetry + gate). */
  private lastPresentedSec = 0;
  private stats = freshStats();
  private seekStartMs = 0;
  /** Full-file native-loop period (s); 0 ⇒ seek-on-wrap. Set by the pump. */
  private loopPeriodSec = 0;
  /** Recent decoded frames (FIFO, newest last), each a GPUHost texture + its source second.
   *  present() picks the one nearest the target ⇒ frame-exact phase with NO rate change. */
  private ring: { tex: number; sec: number }[] = [];
  /** Source second of the most recent frame copied into the ring (dedup repeats). */
  private lastPushedSec = -1;

  /**
   * @param gpuHost   the shared GPU stack.
   * @param video     a loaded, paused <video> (its own element — cursors never share one).
   * @param texHandles RING_CAP GPUHost texture handles (width×height) cycled as the frame ring.
   * @param fps       source frame rate.
   * @param durationSec source duration.
   */
  constructor(
    private gpuHost: GPUHost,
    private video: HTMLVideoElement,
    private texHandles: number[],
    private fps: number,
    private durationSec: number,
  ) {
    this.device = gpuHost.device;
    this.video.muted = true;
    this.video.loop = false; // default: sub-slice loops seek-on-wrap; setNativeLoop flips it
  }

  /** Enable seamless native looping over a WHOLE-file slice of length `periodSec` (the
   *  element loops in the decoder like a plain <video loop> — no per-wrap seek). 0 ⇒ off
   *  (sub-slice / one-shot, which seek on wrap). The pump sets this per the clip's slice. */
  setNativeLoop(periodSec: number): void {
    const p = Math.max(0, periodSec);
    if (p === this.loopPeriodSec) return;
    this.loopPeriodSec = p;
    this.video.loop = p > 0;
  }

  /** Minimal signed distance `d`, folded around the native-loop period so a wrap reads as
   *  ~0 instead of a full-file jump. */
  private fold(d: number): number {
    const p = this.loopPeriodSec;
    return p > 1 / Math.max(1, this.fps) ? (((d % p) + p + p / 2) % p) - p / 2 : d;
  }

  /** The buffered frame whose source second is nearest `targetSec` (loop-folded), or null
   *  if the ring is empty. This IS the "nudge": correct phase by picking the neighbour
   *  frame, never by changing playbackRate. */
  private pickClosest(targetSec: number): { tex: number; sec: number } | null {
    let best: { tex: number; sec: number } | null = null;
    let bestD = Infinity;
    for (const e of this.ring) {
      const d = Math.abs(this.fold(e.sec - targetSec));
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** True when a buffered frame sits within ~a frame of `targetSec` and no seek is in
   *  flight — i.e. we can present the right frame. The Precise gate reads this. */
  ready(targetSec: number): boolean {
    if (this.released || this.seeking || !this.ring.length) return false;
    if (this.video.readyState < 2) return false;
    const best = this.pickClosest(targetSec)!;
    return Math.abs(this.fold(best.sec - targetSec)) <= 1.5 / Math.max(1, this.fps);
  }

  /**
   * Present `targetSec` (source seconds) for this frame, given the transport `rate`
   * (source-sec per real-sec). Drives the element (play / seek / hold), copies the
   * current frame into the cursor's texture, and returns its handle. The compositor
   * blits this texture to the render size. Returns null until the first frame is ready.
   */
  present(targetSec: number, rate: number, speed = rate): { handle: number; sec: number } | null {
    if (this.released) return null;
    const v = this.video;
    if (v.readyState < 1 || !Number.isFinite(v.duration)) return null; // metadata not loaded yet

    // AIM the element a frame AHEAD of the target so the ring straddles it (a future frame to
    // pick as well as past ones). present() then selects the buffered frame nearest the
    // UN-led target — so phase is corrected by frame choice, not by touching playbackRate.
    const lead = LEAD_FRAMES / Math.max(1, this.fps);
    const aimSec = clampSec(targetSec + lead, this.durationSec, 1 / Math.max(1, this.fps));
    const action = decideCursorAction({
      curSec: v.currentTime,
      targetSec: aimSec,
      durationSec: this.durationSec,
      fps: this.fps,
      rate,
      seeking: this.seeking,
      loopPeriodSec: this.loopPeriodSec,
    });

    this.stats.ticks++;
    this.stats[action.kind]++;

    switch (action.kind) {
      case 'play': {
        // playbackRate is a KNOWN value, never a measured one — a measured rate wobbles with
        // rAF-dt jitter, and ANY playbackRate wobble plays the video at a variable speed →
        // uneven frame times → judder (proven: a plain `= 1` is glass-smooth). `speed` is the
        // clip's clean nominal rate from the pump; snap ~1 to exactly native. NO phase-lock:
        // drift is corrected by the seek path (and, later, frame-selection from a buffer).
        let pr = clampPlaybackRate(speed);
        if (Math.abs(pr - 1) < 0.03) pr = 1; // normal-speed playback ⇒ exactly native
        v.playbackRate = pr;
        if (v.paused) void v.play().catch(() => { /* autoplay blocked */ });
        break;
      }
      case 'seek':
        if (!v.paused) v.pause();
        this.beginSeek(action.sec);
        break;
      case 'hold':
        if (rate <= 1e-6 && !v.paused) v.pause(); // frozen transport → stop drifting
        break;
    }

    // Buffer the current frame each tick (NOT mid-seek — currentTime has already jumped to
    // the aim while the old frame is still presented; the seek's landing callback pushes
    // instead). Per-rAF sampling beat an rVFC loop under several 1080p decodes.
    if (!this.seeking && v.readyState >= 2) this.pushFrame();
    // SELECT the buffered frame nearest the (un-led) target — the phase nudge.
    const best = this.pickClosest(targetSec);
    if (best) this.lastPresentedSec = best.sec;
    const drift = best ? Math.abs(this.fold(best.sec - targetSec)) : 0;
    this.stats.driftSumSec += drift;
    if (drift > this.stats.driftMaxSec) this.stats.driftMaxSec = drift;
    if (!this.ready(targetSec)) this.stats.notReady++;
    return best ? { handle: best.tex, sec: best.sec } : null;
  }

  /** Drain + reset the rolling telemetry (the pump logs it periodically). */
  snapshotStats(): CursorStats {
    const s = this.stats;
    this.stats = freshStats();
    return s;
  }

  /** Explicit seek (e.g. a scrub) — pauses + seeks; ready() flips true when it lands. */
  seek(targetSec: number): void {
    if (this.released) return;
    if (!this.video.paused) this.video.pause();
    this.beginSeek(clampSec(targetSec, this.durationSec, 1 / Math.max(1, this.fps)));
  }

  private beginSeek(sec: number): void {
    const v = this.video;
    if (this.seeking) return;
    if (Math.abs(v.currentTime - sec) < 0.5 / Math.max(1, this.fps) && v.readyState >= 2) return; // already there
    this.seeking = true;
    this.seekStartMs = now();
    this.ring.length = 0; // the buffered frames are from the OLD position → drop them
    this.lastPushedSec = -1;
    try { v.currentTime = sec; } catch { this.seeking = false; return; }
    void awaitFrame(v, SEEK_TIMEOUT_MS).then(() => {
      if (this.released) return;
      this.seeking = false;
      if (v.readyState >= 2) this.pushFrame();
      const ms = now() - this.seekStartMs;
      this.stats.seeksDone++;
      this.stats.seekMsSum += ms;
      if (ms > this.stats.seekMsMax) this.stats.seekMsMax = ms;
    });
  }

  /** Copy the element's current frame into the ring (FIFO, reusing RING_CAP textures),
   *  tagged with its source second. Skips a repeat of the same frame so the ring holds the
   *  last RING_CAP *distinct* frames. */
  private pushFrame(): void {
    const cur = this.video.currentTime;
    if (this.ring.length && Math.abs(cur - this.lastPushedSec) < 0.5 / Math.max(1, this.fps)) return; // same frame
    // Reuse the oldest slot when full, else grab the next free texture.
    const slot = this.ring.length < RING_CAP
      ? { tex: this.texHandles[this.ring.length], sec: cur }
      : (() => { const s = this.ring.shift()!; s.sec = cur; return s; })();
    const tex = this.gpuHost.getTextureByHandle(slot.tex);
    if (!tex) return;
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.video, flipY: false },
        { texture: tex },
        { width: this.video.videoWidth, height: this.video.videoHeight, depthOrArrayLayers: 1 },
      );
      this.ring.push(slot);
      this.lastPushedSec = cur;
    } catch { /* element not presentable this frame → keep the ring as-is */ }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch { /* ignore */ }
  }
}

export interface CursorInfo {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
}

/**
 * Build a cursor for `blob`: load a dedicated <video> (metadata), measure its true fps
 * (drop-import can't), allocate an rgba8 GPU texture for it, and return the cursor + the
 * decoder-authoritative info. Main-thread only (uses `document`). Throws if the blob has
 * no decodable dimensions/duration.
 */
export async function createPlaybackCursor(
  gpuHost: GPUHost, blob: Blob, opts?: { fps?: number },
): Promise<{ cursor: PlaybackCursor; info: CursorInfo; objectUrl: string }> {
  if (typeof document === 'undefined') throw new Error('PlaybackCursor requires a DOM (main thread)');
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  try {
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup();
        if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration)) {
          reject(new Error('video has no decodable dimensions/duration'));
        } else resolve();
      };
      const onErr = () => { cleanup(); reject(new Error(`<video> load failed (code ${video.error?.code ?? '?'})`)); };
      const cleanup = () => { video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onErr); };
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('error', onErr);
      video.src = objectUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
  video.pause();
  const fps = opts?.fps && opts.fps > 0 ? opts.fps : await measureFps(video);
  try { video.currentTime = 0; } catch { /* ignore */ }
  const width = video.videoWidth, height = video.videoHeight;
  const durationSec = video.duration;
  // RING_CAP rgba8 textures cycled as the frame ring (drift correction by frame selection).
  const texHandles = Array.from({ length: RING_CAP }, () => gpuHost.createTexture(width, height, 1 /* rgba8unorm */));
  const cursor = new PlaybackCursor(gpuHost, video, texHandles, fps, durationSec);
  return {
    cursor,
    info: { width, height, fps, frameCount: Math.max(1, Math.round(durationSec * fps)), durationSec },
    objectUrl,
  };
}
