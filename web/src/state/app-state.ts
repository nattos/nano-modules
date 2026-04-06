/**
 * Root application state — MobX observable tree.
 *
 * Split into:
 * - `database`: Persisted, undo/redo-able (sketches, module configs)
 * - `local`: Ephemeral UI state (selection, active tab, staging)
 */

import { observable, configure } from 'mobx';
import { enableMapSet, setAutoFreeze, enablePatches } from 'immer';
import type { DatabaseState, LocalState } from './types';

// Immer setup
enableMapSet();
enablePatches();
setAutoFreeze(false); // Let MobX wrap immer output as observable

// MobX strict mode
configure({
  enforceActions: 'always',
  computedRequiresReaction: false,
  reactionRequiresObservable: false,
  observableRequiresReaction: false,
});

export class AppState {
  public database: DatabaseState;
  public local: LocalState;

  constructor() {
    this.database = observable({
      sketches: {},
    });

    this.local = observable({
      activeTab: 'create',
      plugins: [],
      staging: [],
      selectedSketchId: null,
      editingSketchId: null,
      engine: { fps: 0, error: null, tracedFrames: {} },
    });
  }
}

export const appState = new AppState();
