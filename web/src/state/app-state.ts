/**
 * Root application state — MobX observable tree.
 *
 * Split into:
 * - `database`: Persisted, undo/redo-able (sketches, module configs)
 * - `local`: Ephemeral UI state (selection, active tab, engine status)
 */

import { observable, configure, makeObservable } from 'mobx';
import { enableMapSet, setAutoFreeze, enablePatches } from 'immer';
import type { DatabaseState, LocalState } from './types';
import { defaultUserSettings } from './user-settings';

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
    activeTab: 'edit',
    plugins: [],
    availableEffects: [],
    editingSketchId: null,
    engine: { fps: 0, gpuTimeMs: 0, error: null, tracedFrames: {}, frameGeneration: 0, sketchState: {}, pluginStates: {}, modulationData: {}, debugConsoleLog: [], sidechannels: {} },
    tappingMode: false,
    helpMode: false,
    selection: null,
    multiSelection: [],
    queuedSelectionPath: null,
    clipboard: null,
    userSettings: defaultUserSettings(),
    barrelMode: false,
    barrelInstances: [],
    selectedBarrelKey: null,
    selectedSidechannel: null,
    barrelConnection: 'connecting',
    barrelDetected: false,
  };

  constructor() {
    makeObservable(this);
  }
}

export const appState = new AppState();
