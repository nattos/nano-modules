/**
 * DocHistory — undo/redo for the arrangement document via Immer patches.
 *
 * A standalone, generic adaptation of the effect-IDE's `state/history.ts`
 * (the arrangement owns its own store and must not couple to the IDE's
 * AppState). Same mechanics: a mutation recipe runs against a plain snapshot
 * to capture forward + inverse patches, which are then applied in-place to the
 * live MobX observable document. Undo replays inverse patches; redo the forward.
 *
 * Patches (not full snapshots) so the same channel can later feed the
 * timeline-worker diff-mirror, exactly as the IDE feeds its engine worker.
 */

import { observable, makeObservable, runInAction, toJS } from 'mobx';
import { produce, enablePatches, type Patch } from 'immer';

enablePatches();

export interface DocMutation {
  description: string;
  patches: Patch[];
  inverse: Patch[];
  timestamp: number;
  /** Consecutive same-key records within the coalesce window fold into one. */
  coalesceKey?: string;
}

export class DocHistory<T extends object> {
  @observable.shallow private undoStack: DocMutation[] = [];
  @observable.shallow private redoStack: DocMutation[] = [];

  /** Fires after any record/undo/redo that changed state (persistence + sync). */
  public postRecordHook: ((description: string) => void) | null = null;

  /** Consecutive same-key records within this window collapse to one undo point. */
  public coalesceWindowMs = 500;

  /** @param read returns the live observable document to patch in place. */
  constructor(private read: () => T) {
    makeObservable(this);
  }

  /**
   * Apply a mutation recipe, recording a single undo point.
   *
   * Pass `coalesceKey` for continuous, absolute-valued edits (clip drag, slider
   * scrub): consecutive same-key records inside `coalesceWindowMs` fold into the
   * previous undo entry instead of stacking. Recipes MUST be absolute (depend
   * only on the pre-edit base + target value) for coalescing to stay correct —
   * the entry is recomputed from its original base each step.
   */
  record(description: string, recipe: (draft: T) => void, coalesceKey?: string): void {
    const top = this.undoStack[this.undoStack.length - 1];
    const coalescing =
      coalesceKey != null &&
      this.redoStack.length === 0 &&
      top?.coalesceKey === coalesceKey &&
      Date.now() - top.timestamp < this.coalesceWindowMs;

    // When coalescing, revert the live doc to the entry's pre-edit base so the
    // recipe re-derives from the same starting point as the first step.
    if (coalescing) {
      runInAction(() => applyPatchesToObservable(this.read(), top!.inverse));
    }

    let patches: Patch[] = [];
    let inverse: Patch[] = [];
    // Produce from a plain snapshot so Immer never sees a MobX proxy as base;
    // the resulting paths still line up with the (identically-shaped) observable.
    const base = toJS(this.read());
    produce(base, recipe, (p, inv) => {
      patches = p;
      inverse = inv;
    });

    if (patches.length === 0) {
      // No-op vs. the (possibly reverted) base. If we were coalescing, the doc
      // is back at the entry's base — keep the entry, it already encodes that.
      return;
    }

    runInAction(() => {
      applyPatchesToObservable(this.read(), patches);
      if (coalescing) {
        top!.patches = patches;
        top!.inverse = inverse;
        top!.description = description;
        top!.timestamp = Date.now();
      } else {
        this.undoStack.push({ description, patches, inverse, timestamp: Date.now(), coalesceKey });
        this.redoStack.length = 0;
      }
    });
    this.postRecordHook?.(description);
  }

  undo(): void {
    const m = this.undoStack.pop();
    if (!m) return;
    runInAction(() => {
      applyPatchesToObservable(this.read(), m.inverse);
      this.redoStack.push(m);
    });
    this.postRecordHook?.(`undo: ${m.description}`);
  }

  redo(): void {
    const m = this.redoStack.pop();
    if (!m) return;
    runInAction(() => {
      applyPatchesToObservable(this.read(), m.patches);
      this.undoStack.push(m);
    });
    this.postRecordHook?.(`redo: ${m.description}`);
  }

  /** Drop all history (e.g. after loading a fresh document). */
  reset(): void {
    runInAction(() => {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    });
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

/** Apply Immer patches to a MobX observable tree in place (verbatim from the IDE). */
function applyPatchesToObservable(target: any, patches: Patch[]): void {
  for (const patch of patches) {
    const { path, op, value } = patch;
    let current = target;
    for (let i = 0; i < path.length - 1; i++) {
      current = current[path[i]];
      if (current === undefined) {
        console.warn('[arr-history] patch path not found:', path);
        return;
      }
    }
    const key = path[path.length - 1];
    if (op === 'replace' || op === 'add') {
      current[key] = value;
    } else if (op === 'remove') {
      if (Array.isArray(current)) {
        current.splice(key as number, 1);
      } else {
        delete current[key];
      }
    }
  }
}
