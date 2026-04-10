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

// ========================================================================
// Continuous edit (LongEdit) — preview without creating undo points
// ========================================================================

export interface LongEditCallbacks {
  /** Apply the current edit to the state. Called on begin and each update. */
  apply: (recipe: (draft: DatabaseState) => void) => void;
}

/**
 * A long-running edit that can be previewed, updated, and finally committed
 * as a single undo point. Used for live-preview during smart-input, sliders, etc.
 */
export class LongEdit {
  constructor(
    private manager: HistoryManager,
    private description: string,
    private recipe: (draft: DatabaseState) => void,
  ) {}

  /** Update the edit with a new recipe (reverts previous, applies new). */
  update(recipe: (draft: DatabaseState) => void) {
    this.recipe = recipe;
    this.manager._updateLongEdit(this);
  }

  /** Commit the current state as a single undo point. */
  accept() {
    this.manager._acceptLongEdit(this);
  }

  /** Revert the preview and discard the edit. */
  cancel() {
    this.manager._cancelLongEdit(this);
  }

  /** @internal */
  _getRecipe() { return this.recipe; }
  /** @internal */
  _getDescription() { return this.description; }
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

  // ========================================================================
  // Long edit (continuous edit) support
  // ========================================================================

  private activeLongEdit: LongEdit | null = null;
  /** Inverse patches to revert the current long edit preview. */
  private longEditInverse: Patch[] = [];

  /** Begin a new long edit. Returns a LongEdit handle for update/accept/cancel. */
  beginLongEdit(description: string, recipe: (draft: DatabaseState) => void): LongEdit {
    // Cancel any existing long edit
    if (this.activeLongEdit) {
      this._cancelLongEdit(this.activeLongEdit);
    }
    const edit = new LongEdit(this, description, recipe);
    this.activeLongEdit = edit;
    this.applyLongEditPreview(recipe);
    return edit;
  }

  /** @internal Apply (or re-apply) the long edit preview to the observable state. */
  private applyLongEditPreview(recipe: (draft: DatabaseState) => void) {
    // Revert previous preview if any
    if (this.longEditInverse.length > 0) {
      runInAction(() => {
        this.applyPatchesToObservable(this.appState.database, this.longEditInverse);
      });
      this.longEditInverse = [];
    }

    // Apply new preview (capture inverse patches for later revert)
    let patches: Patch[] = [];
    let inversePatches: Patch[] = [];
    produce(this.appState.database, recipe, (p, inv) => {
      patches = p;
      inversePatches = inv;
    });

    if (patches.length > 0) {
      runInAction(() => {
        this.applyPatchesToObservable(this.appState.database, patches);
      });
      this.longEditInverse = inversePatches;
    }
  }

  /** @internal */
  _updateLongEdit(edit: LongEdit) {
    if (this.activeLongEdit !== edit) return;
    this.applyLongEditPreview(edit._getRecipe());
  }

  /** @internal Commit the long edit as a single undo point. */
  @action
  _acceptLongEdit(edit: LongEdit) {
    if (this.activeLongEdit !== edit) return;

    // The observable already has the preview applied.
    // We need to produce the patches relative to the un-previewed state.
    // First revert, then re-apply via record() to get proper undo history.
    const recipe = edit._getRecipe();
    const description = edit._getDescription();

    // Revert the preview from observable
    if (this.longEditInverse.length > 0) {
      runInAction(() => {
        this.applyPatchesToObservable(this.appState.database, this.longEditInverse);
      });
    }

    this.activeLongEdit = null;
    this.longEditInverse = [];

    // Now record normally — this creates the undo point
    this.record(description, recipe);
  }

  /** @internal Revert the preview and discard the edit. */
  @action
  _cancelLongEdit(edit: LongEdit) {
    if (this.activeLongEdit !== edit) return;

    if (this.longEditInverse.length > 0) {
      runInAction(() => {
        this.applyPatchesToObservable(this.appState.database, this.longEditInverse);
      });
    }

    this.activeLongEdit = null;
    this.longEditInverse = [];
  }

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
