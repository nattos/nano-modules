/**
 * SketchInputManager — owns the off-screen `<video>` element / image
 * lifecycle that drives a sketch's `texture_input`.
 *
 * Decouples the pumping from the texture-drop-zone widget: when the user
 * switches between IDE tabs, the editor is unmounted and so is its
 * drop-zone. The pump must outlive that. This singleton-ish manager,
 * owned by AppController, keeps the active sketch's frame source alive
 * regardless of UI lifecycle.
 *
 * Persistence: every dropped file is saved to IndexedDB
 * (see `sketch-input-store.ts`), and reactivated when the project is
 * re-selected (boot or user click).
 */

import {
  loadSketchInput,
  saveSketchInput,
  deleteSketchInput,
  inferSketchInputKind,
} from './sketch-input-store';
import { GPUHost } from '../gpu-host';
import { VideoPlaybackService, type ClipHandle } from '../video/playback-service';
import { Playhead, defaultParams } from '../video/playhead-controllers';
import { FrameBlitter } from '../video/frame-blitter';
import { getMainThreadVideoStack } from '../video/main-thread-video-stack';

/** Default playback rate for the IDE's looping preview. The frame
 *  sources don't expose an exact source fps, so we drive the loop at a
 *  sensible default; the clip plays end-to-end in ~(frameCount / this). */
const PLAYBACK_FPS = 30;

interface VideoPump {
  sketchId: string;
  clip: ClipHandle;
  playhead: Playhead;
  service: VideoPlaybackService;
  width: number;
  height: number;
  rafId: number;
  stopped: boolean;
  busy: boolean;
  /** True for play-forward (<video>) sources: the element is its own clock,
   *  so pause/step drive it directly (setPlaying / stepForward) rather than
   *  the virtual playhead. False for random-access (DXV) sources. */
  streaming: boolean;
}

type EngineSetInput = (sketchId: string, bitmap: ImageBitmap | null) => void;

export class SketchInputManager {
  private activeSketchId: string | null = null;
  /**
   * Monotonic token to invalidate in-flight async restores. Each
   * `setActiveSketch` increments this; async work that races with a
   * subsequent switch checks the token before applying.
   */
  private switchToken = 0;
  private pump: VideoPump | null = null;

  // The IDE video preview is a UI-only mechanism (decoded on the main thread,
  // pushed to the engine as bitmaps), so it must mirror the engine's pause /
  // frame-step itself. Rather than the wall clock, the playhead runs off
  // `videoClockMs`, a virtual clock that only advances while running (by real
  // dt) or by one engine frame per `stepFrame()`. `lastWallMs` tracks real
  // time between rAF ticks; it keeps updating while paused so resuming doesn't
  // jump the playhead by the whole paused duration.
  private paused = false;
  private videoClockMs = 0;
  private lastWallMs = 0;

  // Lazily-created main-thread GPU video stack. The service decodes DXV
  // (WASM) and any browser-playable format (<video>) into GPU textures on
  // this device; the blitter turns each pulled frame into an ImageBitmap
  // for the existing engine-worker hand-off. Created on first video load.
  private servicePromise: Promise<VideoPlaybackService> | null = null;
  private gpuHost: GPUHost | null = null;
  private blitter: FrameBlitter | null = null;

  constructor(private engineSetInput: EngineSetInput) {}

  private ensureService(): Promise<VideoPlaybackService> {
    if (this.servicePromise) return this.servicePromise;
    this.servicePromise = getMainThreadVideoStack().then(({ service, gpuHost, blitter }) => {
      this.gpuHost = gpuHost;
      this.blitter = blitter;
      return service;
    });
    return this.servicePromise;
  }

  /**
   * Switch which sketch's input the manager drives. Stops any existing
   * video pump. If the new sketch has a persisted source file, restores
   * it (one-shot for images, continuous for videos).
   *
   * Pass `null` to deactivate (no current selection).
   */
  async setActiveSketch(sketchId: string | null): Promise<void> {
    this.stopPump();
    const token = ++this.switchToken;
    this.activeSketchId = sketchId;
    if (!sketchId) return;

    const record = await loadSketchInput(sketchId);
    if (token !== this.switchToken) return; // user already switched away
    if (!record) return;

    if (record.kind === 'image') {
      try {
        // premultiplyAlpha:'none' so the bitmap holds straight alpha
        // — the engine's pipeline (bake_alpha, video_blend, etc.)
        // assumes non-premultiplied input. Browser default is to
        // premultiply on decode, which would silently double-multiply
        // when shaders also apply alpha-over math.
        const bitmap = await createImageBitmap(record.blob, { premultiplyAlpha: 'none' });
        if (token !== this.switchToken) {
          bitmap.close();
          return;
        }
        this.engineSetInput(sketchId, bitmap);
      } catch (err) {
        console.warn('[sketch-input-manager] image decode failed', err);
      }
    } else if (record.kind === 'video') {
      void this.startVideoPump(sketchId, record.blob);
    }
  }

  /**
   * Handle a fresh drop: persist the file to IndexedDB and start using it
   * if the dropped target is the currently-active sketch.
   */
  async handleDrop(sketchId: string, file: File): Promise<void> {
    try {
      await saveSketchInput(sketchId, file);
    } catch (err) {
      console.warn('[sketch-input-manager] save failed', err);
    }
    if (this.activeSketchId !== sketchId) return;

    this.stopPump();
    const token = ++this.switchToken;
    const kind = inferSketchInputKind(file);
    if (kind === 'image') {
      try {
        const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none' });
        if (token !== this.switchToken) {
          bitmap.close();
          return;
        }
        this.engineSetInput(sketchId, bitmap);
      } catch (err) {
        console.warn('[sketch-input-manager] image decode failed', err);
      }
    } else if (kind === 'video') {
      void this.startVideoPump(sketchId, file);
    } else {
      console.warn('[sketch-input-manager] unsupported file type:', file.type, file.name);
    }
  }

  /**
   * Drop any persisted source for `sketchId` and stop pumping if it's the
   * active one. Called when a sketch is deleted or a template is GC'd.
   */
  async clear(sketchId: string): Promise<void> {
    if (this.activeSketchId === sketchId) {
      this.stopPump();
      this.engineSetInput(sketchId, null);
    }
    try {
      await deleteSketchInput(sketchId);
    } catch (err) {
      console.warn('[sketch-input-manager] delete failed', sketchId, err);
    }
  }

  private stopPump() {
    if (!this.pump) return;
    const p = this.pump;
    p.stopped = true;
    if (p.rafId) cancelAnimationFrame(p.rafId);
    // Fire-and-forget close: flushes the profile to IDB and releases the
    // clip's GPU cache. The service itself stays alive for the next clip.
    this.servicePromise?.then(svc => svc.close(p.clip)).catch(() => {});
    this.pump = null;
  }

  /** Mirror the engine's pause state: freeze the video preview on its current
   *  frame (the playhead stops advancing and no new frames are pushed). For
   *  play-forward sources the element is its own clock, so we must pause it
   *  too — otherwise it drifts ahead while "paused" and jumps on resume. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (this.pump?.streaming) {
      this.pump.service.setPlaying(this.pump.clip, !paused);
    }
  }

  /** Advance the video preview by exactly one engine frame. Awaited by the
   *  caller so the new bitmap reaches the worker before the engine's own step
   *  command (worker messages are processed in order). No-op without a pump. */
  async stepFrame(): Promise<void> {
    const session = this.pump;
    if (!session || session.stopped || session.busy) return;
    session.busy = true;
    if (session.streaming) {
      // Play-forward source: nudge the (paused) element forward one frame,
      // then sample it. pumpFrame ignores frameIdx for streaming sources.
      try {
        await session.service.stepForward(session.clip);
      } catch (err) {
        console.debug('[sketch-input-manager] step failed', err);
      }
    } else {
      // One engine frame == 1/60 s, matching the executor's fixed step dt, so
      // the video and sim stay in temporal lock-step regardless of source fps.
      this.videoClockMs += 1000 / 60;
    }
    await this.pumpFrame(session);
  }

  /**
   * Drive a sketch's texture_input from the VideoPlaybackService. The
   * service handles DXV (WASM) and any browser-playable format
   * (<video>) uniformly, with caching + profiling. We run a Loop
   * playhead at PLAYBACK_FPS and bridge each pulled GPU texture to the
   * engine-worker as an ImageBitmap (the engine's render device lives in
   * the worker, so a main-thread texture can't cross directly).
   */
  private async startVideoPump(sketchId: string, blob: Blob) {
    const token = this.switchToken;
    let service: VideoPlaybackService;
    try {
      service = await this.ensureService();
    } catch (err) {
      console.warn('[sketch-input-manager] video service unavailable', err);
      return;
    }
    if (token !== this.switchToken) return;   // switched away during init

    let clip: ClipHandle;
    try {
      // The IDE preview only ever plays the clip forward on a loop, so tell
      // the service: it forces play-forward decoding for <video> sources
      // (smooth) instead of the choppy per-frame seek path.
      clip = await service.open(blob, sketchId, { sequential: true });
    } catch (err) {
      console.warn('[sketch-input-manager] could not open video', err);
      return;
    }
    if (token !== this.switchToken) { service.close(clip).catch(() => {}); return; }

    const info = service.inspect(clip);
    // Drive the loop at the SOURCE's real frame rate. A faster playhead
    // would request frames faster than a <video> source can play,
    // drifting ahead into mid-GOP seeks that return black on
    // sparse-keyframe clips. info.fps falls back to a sane default.
    const fps = info.fps > 0 ? info.fps : PLAYBACK_FPS;
    const playhead = new Playhead(
      defaultParams('loop', info.frameCount, fps), info.frameCount);
    // Run the playhead off the virtual clock (see `videoClockMs`), starting
    // both at 0 so pause / frame-step are honoured.
    playhead.start(0);
    this.videoClockMs = 0;
    this.lastWallMs = performance.now();

    const session: VideoPump = {
      sketchId, clip, playhead, service,
      width: info.width, height: info.height,
      rafId: 0, stopped: false, busy: false,
      streaming: info.streaming,
    };
    this.pump = session;

    // Play-forward sources run on the element's own clock; start it playing
    // (or hold it if we loaded while the engine is paused). Random-access
    // sources are driven entirely by the per-tick pull below.
    if (session.streaming) service.setPlaying(clip, !this.paused);

    const tick = () => {
      if (session.stopped) return;
      session.rafId = requestAnimationFrame(tick);
      const wallNow = performance.now();
      // Cap the wall-clock step: a stall (hidden tab, long recompile) would
      // otherwise leap the video playhead far ahead — a long mid-GOP seek on
      // sparse-keyframe clips. Capped, the preview just resumes smoothly.
      const wallDt = Math.min(wallNow - this.lastWallMs, 100);
      this.lastWallMs = wallNow;
      // Frozen while the engine is paused: keep the last frame and don't
      // advance. Stepping while paused goes through stepFrame() instead.
      if (this.paused) return;
      this.videoClockMs += wallDt;
      if (session.busy) return;        // a previous pull is still decoding
      session.busy = true;
      void this.pumpFrame(session);
    };
    // Push frame 0 right away so a preview that loads while paused shows the
    // first frame instead of nothing (the rAF tick skips pumping while paused).
    session.busy = true;
    void this.pumpFrame(session);
    session.rafId = requestAnimationFrame(tick);
  }

  private async pumpFrame(session: VideoPump) {
    try {
      const frameIdx = session.playhead.frameAt(this.videoClockMs);
      const texHandle = await session.service.pull(session.clip, frameIdx);
      if (session.stopped || texHandle <= 0) return;
      const tex = this.gpuHost!.getTextureByHandle(texHandle);
      if (!tex) return;
      const bitmap = this.blitter!.toImageBitmap(tex, session.width, session.height);
      if (session.stopped) { bitmap.close(); return; }
      this.engineSetInput(session.sketchId, bitmap);
    } catch (err) {
      console.debug('[sketch-input-manager] pump frame failed', err);
    } finally {
      session.busy = false;
    }
  }
}
