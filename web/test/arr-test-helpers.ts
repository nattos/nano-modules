/**
 * Arrangement e2e helpers: read what the monitor shows, on any engine.
 *
 * The monitor's canvas is an implementation detail — a 2D canvas for the
 * worker engine's ImageBitmaps, a WebGPU canvas for GPU-resident frames — so
 * suites never read it. They ask the bridge instead
 * (`window.__engineBridge.sampleComposite`): the engine's raw readback of the
 * composite, composited over the monitor's backdrop exactly as the monitor
 * draws it.
 *
 * Coordinates are normalized frame coordinates, (u, v) in 0..1 from the top
 * left, so they don't depend on the composition or render resolution.
 */
import type { Page } from 'puppeteer';

export interface MonitorSample { u: number; v: number; r: number; g: number; b: number; a: number }
export type UV = readonly [number, number];

/** The monitor's centre. */
export const CENTER: UV = [0.5, 0.5];

/** Cell centres of an n×n grid, column-major (all of column 0 first). */
export function gridUVs(n: number): UV[] {
  const out: UV[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out.push([(i + 0.5) / n, (j + 0.5) / n]);
  }
  return out;
}

/** The interior grid points of an n×n split: (n-1)² points at i/n, j/n,
 *  column-major. */
export function interiorGridUVs(n: number): UV[] {
  const out: UV[] = [];
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) out.push([i / n, j / n]);
  }
  return out;
}

/** Max − min luma over some samples: how far from a flat fill they are. */
export function lumaSpread(samples: ReadonlyArray<{ r: number; g: number; b: number }>): number {
  const ls = samples.map(luma);
  return Math.max(...ls) - Math.min(...ls);
}

/** Sample the monitor at `uvs`; null before the engine boots. */
export async function sampleMonitor(page: Page, uvs: readonly UV[]): Promise<MonitorSample[] | null> {
  return page.evaluate(async (pts) => {
    const bridge = (window as any).__engineBridge;
    if (!bridge) return null;
    return bridge.sampleComposite(pts.map(([u, v]: [number, number]) => ({ u, v })));
  }, uvs as UV[]);
}

/** Rec. 601 luma of a sample, rounded. */
export function luma(s: { r: number; g: number; b: number }): number {
  return Math.round(0.299 * s.r + 0.587 * s.g + 0.114 * s.b);
}

/**
 * Poll the monitor at `uvs` until `pred` holds, and return the samples that
 * satisfied it. Throws on timeout with the last samples seen.
 */
export async function waitForMonitor(
  page: Page,
  uvs: readonly UV[],
  pred: (s: MonitorSample[]) => boolean,
  { timeout = 30_000, interval = 50 }: { timeout?: number; interval?: number } = {},
): Promise<MonitorSample[]> {
  const deadline = Date.now() + timeout;
  let last: MonitorSample[] | null = null;
  for (;;) {
    last = await sampleMonitor(page, uvs);
    if (last && pred(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`waitForMonitor timed out after ${timeout}ms; last samples: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
