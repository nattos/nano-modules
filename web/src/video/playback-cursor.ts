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
  const delta = i.targetSec - i.curSec; // how far AHEAD the target is

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

export class PlaybackCursor {
  private device: GPUDevice;
  private seeking = false;
  private released = false;
  /** Whether at least one frame has been copied into the texture. */
  private hasFrame = false;

  /**
   * @param gpuHost   the shared GPU stack.
   * @param video     a loaded, paused <video> (its own element — cursors never share one).
   * @param texHandle a GPUHost texture handle (width×height) the cursor copies frames into.
   * @param fps       source frame rate.
   * @param durationSec source duration.
   */
  constructor(
    private gpuHost: GPUHost,
    private video: HTMLVideoElement,
    private texHandle: number,
    private fps: number,
    private durationSec: number,
  ) {
    this.device = gpuHost.device;
    this.video.muted = true;
    this.video.loop = false; // looping is a SLICE decision (the mapper wraps the target); we re-seek
  }

  /** True when the presented frame is within ~a frame of `targetSec` and no seek is in
   *  flight — i.e. the texture shows the right frame. The Precise gate reads this. */
  ready(targetSec: number): boolean {
    if (this.released || !this.hasFrame || this.seeking) return false;
    if (this.video.readyState < 2) return false;
    return Math.abs(this.video.currentTime - targetSec) <= 1.5 / Math.max(1, this.fps);
  }

  /**
   * Present `targetSec` (source seconds) for this frame, given the transport `rate`
   * (source-sec per real-sec). Drives the element (play / seek / hold), copies the
   * current frame into the cursor's texture, and returns its handle. The compositor
   * blits this texture to the render size. Returns null until the first frame is ready.
   */
  present(targetSec: number, rate: number): number | null {
    if (this.released) return null;
    const v = this.video;
    if (v.readyState < 1 || !Number.isFinite(v.duration)) return null; // metadata not loaded yet

    const action = decideCursorAction({
      curSec: v.currentTime,
      targetSec,
      durationSec: this.durationSec,
      fps: this.fps,
      rate,
      seeking: this.seeking,
    });

    switch (action.kind) {
      case 'play':
        v.playbackRate = action.rate;
        if (v.paused) void v.play().catch(() => { /* autoplay blocked */ });
        break;
      case 'seek':
        if (!v.paused) v.pause();
        this.beginSeek(action.sec);
        break;
      case 'hold':
        if (rate <= 1e-6 && !v.paused) v.pause(); // frozen transport → stop drifting
        break;
    }

    // Sample whatever frame is current into the texture (best-available; the gate uses
    // ready() to decide whether it's the RIGHT frame).
    if (v.readyState >= 2) this.copyFrame();
    return this.hasFrame ? this.texHandle : null;
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
    try { v.currentTime = sec; } catch { this.seeking = false; return; }
    void awaitFrame(v, SEEK_TIMEOUT_MS).then(() => {
      if (this.released) return;
      this.seeking = false;
      if (v.readyState >= 2) this.copyFrame();
    });
  }

  private copyFrame(): void {
    const tex = this.gpuHost.getTextureByHandle(this.texHandle);
    if (!tex) return;
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.video, flipY: false },
        { texture: tex },
        { width: this.video.videoWidth, height: this.video.videoHeight, depthOrArrayLayers: 1 },
      );
      this.hasFrame = true;
    } catch { /* element not presentable this frame → keep the last copy */ }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch { /* ignore */ }
  }
}
