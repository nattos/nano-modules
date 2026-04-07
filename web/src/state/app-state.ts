/**
 * Root application state — MobX observable tree.
 *
 * Split into:
 * - `database`: Persisted, undo/redo-able (sketches, module configs)
 * - `local`: Ephemeral UI state (selection, active tab, staging)
 */

import { observable, configure, makeObservable } from 'mobx';
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
  @observable
  public database: DatabaseState = {
    sketches: {},
  };
  @observable
  public local: LocalState = {
    activeTab: 'create',
    plugins: [],
    staging: [],
    selectedSketchId: null,
    editingSketchId: null,
    engine: { fps: 0, error: null, tracedFrames: {}, frameGeneration: 0 },
  };

  constructor() {
    makeObservable(this);
  }
}

export const appState = new AppState();
