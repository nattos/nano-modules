/**
 * Undo/redo history using Immer patches.
 *
 * Every mutation to `database` is recorded as forward + inverse patches.
 * Undo replays inverse patches; redo replays forward patches.
 */

import { observable, action, runInAction } from 'mobx';
import { produce, Patch } from 'immer';
import type { AppState } from './app-state';
import type { DatabaseState } from './types';

export interface Mutation {
  id: string;
  description: string;
  patches: Patch[];
  inversePatches: Patch[];
  timestamp: number;
}

export class HistoryManager {
  @observable.shallow public history: Mutation[] = [];
  @observable.shallow public redoStack: Mutation[] = [];

  constructor(private appState: AppState) {}

  /** Apply a mutation recipe to the database state, recording history. */
  @action
  record(description: string, recipe: (draft: DatabaseState) => void) {
    let patches: Patch[] = [];
    let inversePatches: Patch[] = [];

    // Produce the next immutable state and capture patches
    const nextState = produce(this.appState.database, recipe, (p, inv) => {
      patches = p;
      inversePatches = inv;
    });

    if (patches.length === 0) return; // no-op

    // Apply patches to the live MobX observable
    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, patches);
    });

    const mutation: Mutation = {
      id: crypto.randomUUID(),
      description,
      patches,
      inversePatches,
      timestamp: Date.now(),
    };

    runInAction(() => {
      this.history.push(mutation);
      this.redoStack.length = 0;
    });
  }

  @action
  undo() {
    const mutation = this.history.pop();
    if (!mutation) return;

    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, mutation.inversePatches);
      this.redoStack.push(mutation);
    });
  }

  @action
  redo() {
    const mutation = this.redoStack.pop();
    if (!mutation) return;

    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, mutation.patches);
      this.history.push(mutation);
    });
  }

  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /**
   * Apply incoming remote patches (from engine worker).
   * If they conflict with our current state, log a warning.
   */
  @action
  applyRemotePatches(patches: Patch[]) {
    // For now, just apply. TODO: conflict detection.
    runInAction(() => {
      this.applyPatchesToObservable(this.appState.database, patches);
    });
  }

  /** Apply Immer patches to a MobX observable tree (in-place). */
  private applyPatchesToObservable(target: any, patches: Patch[]) {
    for (const patch of patches) {
      const { path, op, value } = patch;
      let current = target;
      for (let i = 0; i < path.length - 1; i++) {
        current = current[path[i]];
        if (current === undefined) {
          console.warn('[history] patch path not found:', path);
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
}
