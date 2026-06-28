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

class DebugPerf {
  /** True while the Debug tab is mounted. Producers gate expensive collection on this. */
  active = false;
  monitor: MonitorPerf | null = null;
  clips: ClipPerf[] = [];
  /** performance.now() of the last publish, so the tab can show staleness. */
  updatedAt = 0;
}

export const debugPerf = new DebugPerf();
