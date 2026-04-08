/**
 * Centralized trace registration controller.
 *
 * UI components (texture-monitor, edit preview) register their trace needs here.
 * The controller coalesces registrations, deduplicates targets, and batches
 * calls to appController.setTracePoints().
 */

import type { TracePoint } from '../engine-types';

export interface TraceRegistration {
  /** Unique ID for this registration (caller-provided). */
  id: string;
  /** The trace point target. */
  target: TracePoint['target'];
  /** Resolution tier: 'low' for thumbnails, 'high' for full-res monitors. */
  resolution: 'low' | 'high';
}

/** Low-res thumbnail dimensions. */
const LOW_RES = { width: 128, height: 72 };

function targetKey(target: TracePoint['target']): string {
  switch (target.type) {
    case 'sketch_output': return `so:${target.sketchId}`;
    case 'plugin_output': return `po:${target.pluginKey}`;
    case 'chain_entry': return `ce:${target.sketchId}/${target.colIdx}/${target.chainIdx}/${target.side}`;
  }
}

export class TraceController {
  private registrations = new Map<string, TraceRegistration>();
  private dirty = false;
  private rafId = 0;

  /** Callback set by the controller to push trace points to the engine. */
  public onFlush: ((tracePoints: TracePoint[]) => void) | null = null;

  /**
   * Register a trace point. The trace ID used in tracedFrames will be
   * the registration's `id`.
   */
  register(reg: TraceRegistration): void {
    this.registrations.set(reg.id, reg);
    this.markDirty();
  }

  unregister(id: string): void {
    if (this.registrations.delete(id)) {
      this.markDirty();
    }
  }

  private markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.rafId = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.dirty = false;

    // Group registrations by target, pick max resolution per target
    const byTarget = new Map<string, { target: TracePoint['target']; ids: string[]; needsHigh: boolean }>();

    for (const [, reg] of this.registrations) {
      const tk = targetKey(reg.target);
      let group = byTarget.get(tk);
      if (!group) {
        group = { target: reg.target, ids: [], needsHigh: false };
        byTarget.set(tk, group);
      }
      group.ids.push(reg.id);
      if (reg.resolution === 'high') group.needsHigh = true;
    }

    // Build trace points. Each registration gets its own trace point ID
    // so its bitmap appears at tracedFrames[reg.id].
    // If multiple registrations share a target, we still emit separate trace points
    // (the engine captures each independently). Future optimization: share captures.
    const tracePoints: TracePoint[] = [];
    for (const [, group] of byTarget) {
      for (const id of group.ids) {
        const reg = this.registrations.get(id)!;
        const tp: TracePoint = {
          id,
          target: group.target,
        };
        if (reg.resolution === 'low' && !group.needsHigh) {
          tp.size = LOW_RES;
        }
        tracePoints.push(tp);
      }
    }

    this.onFlush?.(tracePoints);
  }

  dispose(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.registrations.clear();
  }
}

export const traceController = new TraceController();
