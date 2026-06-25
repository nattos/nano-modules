/**
 * offline-curve-service.ts — main-thread front for the offline-eval worker. A
 * single shared worker serves every return lane. Requests are COALESCED per rail
 * (only the latest matters) and stale results are dropped, so rapid scroll / zoom /
 * edits never queue up or paint an out-of-date curve. The heavy block evaluation
 * happens in the worker; the lane only gathers a cheap spec and draws the result.
 */

import type { RailCurveSpec, RailCurve } from './offline-curve-eval';

export type RailCurveListener = (curve: RailCurve) => void;

interface Pending {
  latestReqId: number;
  listener: RailCurveListener;
}

class OfflineCurveService {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private nextReqId = 1;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null; // non-browser (tests) → no-op
    this.worker = new Worker(new URL('./offline-eval-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const { reqId, railId, mean, lo, hi } = e.data as {
        reqId: number; railId: string; mean: Float32Array; lo: Float32Array; hi: Float32Array;
      };
      const p = this.pending.get(railId);
      if (!p || reqId !== p.latestReqId) return; // superseded → drop
      p.listener({ mean, lo, hi });
    };
    return this.worker;
  }

  /**
   * Request `railId`'s curve for `spec`. The newest request per rail wins; older
   * in-flight results are discarded. `listener` is invoked (on the main thread) when
   * THIS request's result lands. Registering a new listener for a rail replaces the
   * previous one. Returns a `cancel` that detaches the lane's listener.
   */
  request(railId: string, spec: RailCurveSpec, listener: RailCurveListener): () => void {
    const w = this.ensureWorker();
    const reqId = this.nextReqId++;
    this.pending.set(railId, { latestReqId: reqId, listener });
    // Transfer the sample beats — the lane rebuilds a fresh array each request.
    w?.postMessage({ reqId, railId, spec }, [spec.beats.buffer]);
    return () => { if (this.pending.get(railId)?.listener === listener) this.pending.delete(railId); };
  }
}

/** Shared singleton — one worker for all return lanes. */
export const offlineCurveService = new OfflineCurveService();
