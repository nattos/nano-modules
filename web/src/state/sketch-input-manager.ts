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

/** Default playback rate for the IDE's looping preview. The frame
 *  sources don't expose an exact source fps, so we drive the loop at a
 *  sensible default; the clip plays end-to-end in ~(frameCount / this). */
const PLAYBACK_FPS = 30;

interface VideoPump {
  sketchId: string;
  clip: ClipHandle;
  playhead: Playhead;
  width: number;
  height: number;
  rafId: number;
  stopped: boolean;
  busy: boolean;
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
    this.servicePromise = (async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) throw new Error('no WebGPU adapter for video playback');
      const required: GPUFeatureName[] = [];
      // DXV's BC1 fast path needs this; harmless when the host lacks it
      // (only the DXV codec is then unavailable — <video> formats still work).
      if (adapter.features.has('texture-compression-bc')) {
        required.push('texture-compression-bc');
      }
      const device = await adapter.requestDevice({ requiredFeatures: required });
      this.gpuHost = new GPUHost(device, 'rgba8unorm');
      this.blitter = new FrameBlitter(device);
      // Absolute path: the dev server (and the built app) serve /wasm/
      // at the root regardless of which page loaded the module.
      return new VideoPlaybackService(this.gpuHost, { dxvWasmUrl: '/wasm/dxv_decoder.wasm' });
    })();
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
      clip = await service.open(blob, sketchId);
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
    playhead.start(performance.now());

    const session: VideoPump = {
      sketchId, clip, playhead,
      width: info.width, height: info.height,
      rafId: 0, stopped: false, busy: false,
    };
    this.pump = session;

    const tick = () => {
      if (session.stopped) return;
      session.rafId = requestAnimationFrame(tick);
      if (session.busy) return;        // a previous pull is still decoding
      session.busy = true;
      void this.pumpFrame(session, service);
    };
    session.rafId = requestAnimationFrame(tick);
  }

  private async pumpFrame(session: VideoPump, service: VideoPlaybackService) {
    try {
      const frameIdx = session.playhead.frameAt(performance.now());
      const texHandle = await service.pull(session.clip, frameIdx);
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
