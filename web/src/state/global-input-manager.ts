/**
 * GlobalInputManager — drives the single, global "test input" frame that feeds
 * EVERY running instance in offline/playground mode (the stand-in for
 * Resolume's live layer feed, which those surfaces don't have).
 *
 * Unlike `SketchInputManager` (one active sketch, per-sketch persisted blobs),
 * this broadcasts one source to the worker's shared global-input texture via
 * `engineSetGlobalInput`, so it applies to all instances at once. The chosen
 * file is persisted as a `FileSystemFileHandle` (see `input-video-store.ts`)
 * and restored at app start.
 *
 * The video loop is free-running (rAF): the engine's own pause freezes the
 * rendered output regardless, so the input needn't mirror pause/step here.
 */

import { inferSketchInputKind } from './sketch-input-store';
import { getMainThreadVideoStack, type MainThreadVideoStack } from '../video/main-thread-video-stack';
import { VideoPlaybackService, type ClipHandle } from '../video/playback-service';
import { Playhead, defaultParams } from '../video/playhead-controllers';

const PLAYBACK_FPS = 30;

interface GlobalPump {
  clip: ClipHandle;
  playhead: Playhead;
  service: VideoPlaybackService;
  width: number;
  height: number;
  rafId: number;
  stopped: boolean;
  busy: boolean;
  startedMs: number;
}

type EngineSetGlobalInput = (bitmap: ImageBitmap | null) => void;

export class GlobalInputManager {
  private token = 0;
  private pump: GlobalPump | null = null;
  private stack: MainThreadVideoStack | null = null;
  /** The current source's display name (file name), for the input-card UI. */
  private currentLabel: string | null = null;

  constructor(private engineSetGlobalInput: EngineSetGlobalInput) {}

  get label(): string | null { return this.currentLabel; }
  get active(): boolean { return this.currentLabel !== null; }

  /**
   * Set (or replace) the global test input from a file. `null` clears.
   * `label` overrides the display name (defaults to the file's name).
   */
  async setSource(file: File | null, label?: string): Promise<void> {
    this.stopPump();
    const token = ++this.token;
    this.engineSetGlobalInput(null);
    this.currentLabel = null;
    if (!file) return;

    this.currentLabel = label ?? file.name;
    const kind = inferSketchInputKind(file);
    if (kind === 'image') {
      try {
        const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none' });
        if (token !== this.token) { bitmap.close(); return; }
        this.engineSetGlobalInput(bitmap);
      } catch (err) {
        console.warn('[global-input] image decode failed', err);
      }
    } else if (kind === 'video') {
      await this.startVideoPump(file, token);
    } else {
      console.warn('[global-input] unsupported file type', (file as File).type);
      this.currentLabel = null;
    }
  }

  /** Stop pumping and clear the global input entirely. */
  clear(): void {
    this.stopPump();
    this.token++;
    this.engineSetGlobalInput(null);
    this.currentLabel = null;
  }

  private stopPump(): void {
    if (!this.pump) return;
    const p = this.pump;
    p.stopped = true;
    if (p.rafId) cancelAnimationFrame(p.rafId);
    p.service.close(p.clip).catch(() => {});
    this.pump = null;
  }

  private async startVideoPump(blob: Blob, token: number): Promise<void> {
    let stack: MainThreadVideoStack;
    try {
      stack = this.stack ?? (this.stack = await getMainThreadVideoStack());
    } catch (err) {
      console.warn('[global-input] video stack unavailable', err);
      return;
    }
    if (token !== this.token) return;

    let clip: ClipHandle;
    try {
      clip = await stack.service.open(blob, 'global-input', { sequential: true });
    } catch (err) {
      console.warn('[global-input] could not open video', err);
      return;
    }
    if (token !== this.token) { stack.service.close(clip).catch(() => {}); return; }

    const info = stack.service.inspect(clip);
    const fps = info.fps > 0 ? info.fps : PLAYBACK_FPS;
    const playhead = new Playhead(defaultParams('loop', info.frameCount, fps), info.frameCount);
    playhead.start(0);

    const session: GlobalPump = {
      clip, playhead, service: stack.service,
      width: info.width, height: info.height,
      rafId: 0, stopped: false, busy: false, startedMs: performance.now(),
    };
    this.pump = session;
    if (info.streaming) stack.service.setPlaying(clip, true);

    const tick = () => {
      if (session.stopped) return;
      session.rafId = requestAnimationFrame(tick);
      if (session.busy) return;
      session.busy = true;
      void this.pumpFrame(session, stack);
    };
    session.busy = true;
    void this.pumpFrame(session, stack);
    session.rafId = requestAnimationFrame(tick);
  }

  private async pumpFrame(session: GlobalPump, stack: MainThreadVideoStack): Promise<void> {
    try {
      const clockMs = performance.now() - session.startedMs;
      const frameIdx = session.playhead.frameAt(clockMs);
      const texHandle = await session.service.pull(session.clip, frameIdx);
      if (session.stopped || texHandle <= 0) return;
      const tex = stack.gpuHost.getTextureByHandle(texHandle);
      if (!tex) return;
      const bitmap = stack.blitter.toImageBitmap(tex, session.width, session.height);
      if (session.stopped) { bitmap.close(); return; }
      this.engineSetGlobalInput(bitmap);
    } catch (err) {
      console.debug('[global-input] pump frame failed', err);
    } finally {
      session.busy = false;
    }
  }
}
