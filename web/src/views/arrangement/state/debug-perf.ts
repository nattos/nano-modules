/**
 * debugPerf — a tiny bus for the Debug tab's performance stats.
 *
 * Producers (the video compositor, the monitor, …) PUBLISH snapshots here; the Debug tab
 * READS them. `active` is true only while the Debug tab is mounted — producers gate any
 * collection that would itself cost performance (per-frame snapshots, GPU timing, readbacks)
 * on it, so the instrumentation is free when nobody's looking. Plain object, polled by the
 * tab (no MobX) so publishing from hot paths stays allocation-light.
 */

export interface MonitorPerf {
  drawsPerSec: number;
  newFramesPerSec: number;
  arrivalsPerSec: number;
  gapAvgMs: number;
  gapMaxMs: number;
}

export interface ClipPerf {
  clipId: string;
  label: string;
  /** Which decode path is feeding this clip. */
  path: 'cursor' | 'service';
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  // Cursor stats (cursor path) — per 1s window.
  ticks?: number;
  play?: number;
  seek?: number;
  hold?: number;
  notReady?: number;
  driftAvgMs?: number;
  driftMaxMs?: number;
  seeks?: number;
  seekAvgMs?: number;
  // Inject cadence (both paths) — the real frame rate the viewer sees.
  injectN?: number;
  injectAvgMs?: number;
  injectMaxMs?: number;
  // Frame cache (cursor path).
  cacheEntries?: number;
  cacheMB?: number;
  cacheHitRate?: number; // recent window, 0..1
  cachePinned?: number;
}

/** One on-screen composite frame — the SYSTEM-level timing the top panel summarises over
 *  60s. `gapMs` is the end-to-end interval since the previous presented frame (captures any
 *  stall: engine, GPU, postMessage, main thread); `gpuMs`/`fps` are the worker's concurrent
 *  numbers so a spike can be attributed (GPU-bound vs not). */
export interface FrameSample {
  t: number;
  gapMs: number;
  gpuMs: number;
  fps: number;
}

class DebugPerf {
  /** True while the Debug tab is mounted. Producers gate expensive collection on this. */
  active = false;
  monitor: MonitorPerf | null = null;
  clips: ClipPerf[] = [];
  /** Per-presented-frame samples over ~60s (the system-timing ring; pruned by the monitor). */
  frames: FrameSample[] = [];
  /** Latest worker GPU time (ms), stamped onto each frame sample. */
  lastGpuMs = 0;
  /** performance.now() of the last clips / monitor publish — the tab uses these to detect
   *  staleness (a section/clip that stopped updating) and to retain it briefly before drop. */
  clipsAt = 0;
  monitorAt = 0;
}

export const debugPerf = new DebugPerf();
