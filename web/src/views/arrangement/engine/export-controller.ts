/**
 * export-controller — the app-wide singleton that runs an export and exposes its
 * progress as observable state (mirrors the `engineBridge` / `store` singletons).
 *
 * Why a singleton (not component-local state): the inspector's Export panel is
 * re-rendered / unmounted as the user switches right-tabs, but an export keeps
 * running. Holding the run-state here (MobX-observable) means the panel can show
 * progress, the user can leave and come back, and a second worker render survives
 * the UI churn.
 *
 * It reads the persisted export settings off the composition (`store.exportSettings`
 * / `exportResolution` / `exportFps`), prompts for a save location and STREAMS the
 * MP4 to disk via the File System Access API when available (low memory), and falls
 * back to an in-memory render + download when it isn't.
 */

import { makeAutoObservable, runInAction, toJS } from 'mobx';
import { exportComposition, canExport, defaultBitrate, evenDim, planExportFrames } from './export-renderer';
import { makeWarpClock } from './warp-clock';
import { engineBridge } from './engine-bridge';
import { store } from '../state/store';
import { electronIpc } from '../../../state/paths';
import { compositionLengthBeats, type ExportQuality } from '../model/composition';

export type ExportPhase = 'idle' | 'rendering' | 'done' | 'error' | 'canceled';

/** Bits-per-pixel-per-frame budget per quality tier (→ H.264 bitrate). */
const QUALITY_BPP: Record<ExportQuality, number> = { low: 0.06, medium: 0.12, high: 0.24 };

class ExportController {
  phase: ExportPhase = 'idle';
  framesDone = 0;
  framesTotal = 0;
  message = '';
  private abortCtl: AbortController | null = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get busy(): boolean { return this.phase === 'rendering'; }
  get progress(): number { return this.framesTotal > 0 ? this.framesDone / this.framesTotal : 0; }

  /** Whether a usable loop region exists to export. */
  get hasLoop(): boolean { return store.loopEnabled && store.loopEndBeat > store.loopStartBeat; }

  /** Whether the timeline currently has a time box to export. */
  get hasSelection(): boolean {
    return store.hasTimeSelection && store.timeSelEnd > (store.timeSelStart ?? 0);
  }

  /** The beat range the current settings export: the loop region, the live time
   *  selection, or the whole arrangement (also the fallback when the chosen
   *  range has since gone away — a cleared loop / collapsed box). */
  get range(): { startBeat: number; endBeat: number } {
    const kind = store.exportSettings.range;
    if (kind === 'loop' && this.hasLoop) {
      return { startBeat: store.loopStartBeat, endBeat: store.loopEndBeat };
    }
    if (kind === 'selection' && this.hasSelection) {
      return { startBeat: store.timeSelStart!, endBeat: store.timeSelEnd };
    }
    return { startBeat: 0, endBeat: compositionLengthBeats(store.composition) };
  }

  /** Estimated output frame count for the current persisted settings (range-aware). */
  get estimateFrames(): number {
    try {
      const clock = makeWarpClock(store.composition);
      const { startBeat, endBeat } = this.range;
      return planExportFrames(clock, store.exportFps, startBeat, endBeat).length;
    } catch {
      return 0;
    }
  }

  cancel(): void { this.abortCtl?.abort(); }

  private async runNative(
    native: NonNullable<ReturnType<typeof engineBridge.nativeExporter>>,
    ipc: { invoke(ch: string, ...args: unknown[]): Promise<any> },
  ): Promise<void> {
    const fps = store.exportFps;
    const eff = store.exportResolution;
    const w = evenDim(eff.width);
    const h = evenDim(eff.height);
    const { startBeat, endBeat } = this.range;
    const bitrate = defaultBitrate(w, h, fps, QUALITY_BPP[store.exportSettings.quality]);
    const baseName = (store.currentName ?? 'arrangement').replace(/\.[^/.]+$/, '').split('/').pop() || 'arrangement';
    const path: string | undefined = await ipc.invoke('paths.showSaveDialog', {
      defaultPath: `${baseName}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (!path) return;

    this.abortCtl = new AbortController();
    runInAction(() => {
      this.phase = 'rendering';
      this.framesDone = 0;
      this.framesTotal = this.estimateFrames;
      this.message = '';
    });
    const t0 = performance.now();
    try {
      const res = await native.exportFile({
        json: JSON.stringify(toJS(store.composition)),
        path, width: w, height: h, fps, startBeat, endBeat, bitrate,
        ignoreSolo: store.exportSettings.ignoreSolo,
        background: backdropRgb(),
      }, (done, total) => runInAction(() => { this.framesDone = done; this.framesTotal = total; }),
      this.abortCtl.signal);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      runInAction(() => {
        this.phase = 'done';
        this.framesDone = res.frames;
        this.framesTotal = res.frames;
        this.message = `${res.frames} frames · ${res.durationSec.toFixed(1)}s · rendered in ${secs}s · saved`;
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        runInAction(() => { this.phase = 'canceled'; this.message = 'Export canceled.'; });
      } else {
        runInAction(() => { this.phase = 'error'; this.message = err instanceof Error ? err.message : String(err); });
        console.error('[export] native export failed', err);
      }
    } finally {
      this.abortCtl = null;
    }
  }

  /**
   * Run an export with the composition's persisted settings. Prompts for a save
   * location and streams to disk when the File System Access API is available;
   * otherwise renders in memory and downloads. MUST be invoked from a user gesture
   * (the picker needs one) — call it directly from the button handler.
   */
  async run(): Promise<void> {
    if (this.phase === 'rendering') return;
    // The native engine exports in its own process (AVFoundation decode, a
    // hardware encode, straight to a path) — the desktop app's route whenever
    // it's the engine running.
    const native = engineBridge.nativeExporter();
    const ipc = electronIpc();
    if (native && ipc) return this.runNative(native, ipc);
    if (!canExport()) {
      runInAction(() => { this.phase = 'error'; this.message = 'This browser does not support video export (WebCodecs).'; });
      return;
    }

    const fps = store.exportFps;
    const eff = store.exportResolution;
    const w = evenDim(eff.width);
    const h = evenDim(eff.height);
    const { startBeat, endBeat } = this.range;
    const bitrate = defaultBitrate(w, h, fps, QUALITY_BPP[store.exportSettings.quality]);
    const baseName = (store.currentName ?? 'arrangement').replace(/\.[^/.]+$/, '').split('/').pop() || 'arrangement';

    // Prefer streaming to a user-chosen file (flat memory). The picker call must
    // ride this method's gesture, so it happens before any long await.
    let writable: FileSystemWritableFileStream | undefined;
    const picker = (window as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: `${baseName}.mp4`,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writable = await handle.createWritable();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // user dismissed the picker
        writable = undefined; // any other picker failure → fall back to in-memory + download
      }
    }

    this.abortCtl = new AbortController();
    runInAction(() => {
      this.phase = 'rendering';
      this.framesDone = 0;
      this.framesTotal = this.estimateFrames;
      this.message = '';
    });
    const t0 = performance.now();
    try {
      const res = await exportComposition({
        width: w, height: h, fps, startBeat, endBeat, bitrate, writable,
        ignoreSolo: store.exportSettings.ignoreSolo,
        signal: this.abortCtl.signal,
        onProgress: (done, total) => runInAction(() => { this.framesDone = done; this.framesTotal = total; }),
      });
      if (!writable && res.blob) {
        const url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName}.mp4`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const size = res.blob ? ` · ${(res.blob.size / (1024 * 1024)).toFixed(1)} MB` : '';
      runInAction(() => {
        this.phase = 'done';
        this.message = `${res.frames} frames · ${res.durationSec.toFixed(1)}s${size} · rendered in ${secs}s${writable ? ' · saved' : ''}`;
      });
    } catch (err) {
      try { await writable?.abort(); } catch { /* discard the partial file best-effort */ }
      if (err instanceof DOMException && err.name === 'AbortError') {
        runInAction(() => { this.phase = 'canceled'; this.message = 'Export canceled.'; });
      } else {
        runInAction(() => { this.phase = 'error'; this.message = err instanceof Error ? `${err.name}: ${err.message}` : String(err); });
        console.error('[export] failed', err);
      }
    } finally {
      this.abortCtl = null;
    }
  }
}

/** The export's backdrop: MP4 has no alpha, so transparent and the default
 *  are black; a custom colour is itself (export-renderer.ts backgroundBitmap). */
function backdropRgb(): [number, number, number] {
  const bg = store.composition.meta.background;
  const m = bg?.mode === 'custom' && bg.color ? /^#?([0-9a-f]{6})$/i.exec(bg.color.trim()) : null;
  if (!m) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number];
}

/** App-wide singleton (mirrors `store` / `engineBridge`). */
export const exportController = new ExportController();
