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
} from './sketch-input-store';

interface VideoPump {
  video: HTMLVideoElement;
  objectUrl: string;
  sketchId: string;
  rafId: number;
  stopped: boolean;
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

  constructor(private engineSetInput: EngineSetInput) {}

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
        const bitmap = await createImageBitmap(record.blob);
        if (token !== this.switchToken) {
          bitmap.close();
          return;
        }
        this.engineSetInput(sketchId, bitmap);
      } catch (err) {
        console.warn('[sketch-input-manager] image decode failed', err);
      }
    } else if (record.kind === 'video') {
      this.startVideoPump(sketchId, record.blob);
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
    if (file.type.startsWith('image/')) {
      try {
        const bitmap = await createImageBitmap(file);
        if (token !== this.switchToken) {
          bitmap.close();
          return;
        }
        this.engineSetInput(sketchId, bitmap);
      } catch (err) {
        console.warn('[sketch-input-manager] image decode failed', err);
      }
    } else if (file.type.startsWith('video/')) {
      this.startVideoPump(sketchId, file);
    } else {
      console.warn('[sketch-input-manager] unsupported file type:', file.type);
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
    this.pump.stopped = true;
    if (this.pump.rafId) cancelAnimationFrame(this.pump.rafId);
    try { this.pump.video.pause(); } catch {}
    try { URL.revokeObjectURL(this.pump.objectUrl); } catch {}
    this.pump = null;
  }

  private startVideoPump(sketchId: string, blob: Blob) {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(blob);
    video.src = objectUrl;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';

    const session: VideoPump = {
      video,
      objectUrl,
      sketchId,
      rafId: 0,
      stopped: false,
    };
    this.pump = session;

    const useRvfc = typeof (video as any).requestVideoFrameCallback === 'function';

    const pumpOnce = async () => {
      if (session.stopped) return;
      if (video.readyState < 2 || video.videoWidth === 0) return;
      try {
        const bitmap = await createImageBitmap(video);
        if (session.stopped) {
          bitmap.close();
          return;
        }
        this.engineSetInput(session.sketchId, bitmap);
      } catch (err) {
        // Decoding can fail transiently while the video seeks.
        console.debug('[sketch-input-manager] frame decode failed', err);
      }
    };

    const tickRvfc = () => {
      if (session.stopped) return;
      (video as any).requestVideoFrameCallback(async () => {
        await pumpOnce();
        tickRvfc();
      });
    };
    const tickRaf = () => {
      if (session.stopped) return;
      session.rafId = requestAnimationFrame(async () => {
        await pumpOnce();
        tickRaf();
      });
    };

    video.play().catch(err => {
      console.warn('[sketch-input-manager] video play failed', err);
    });
    if (useRvfc) tickRvfc();
    else tickRaf();
  }
}
