/**
 * Playground-instance CRUD + persistence routing (see controller's
 * "Playground instances" section).
 *
 * The invariants under test:
 *   - create/delete manage `pg:` sketches, mirror the shared instances list,
 *     and pick sensible labels/selection.
 *   - deletion is undoable (label included) and the list follows undo/redo.
 *   - the persistence flush writes ONLY to the playground store — the
 *     effect-IDE `projects` store must never see playground traffic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runInAction } from 'mobx';

// Capture playground-store traffic without a real IndexedDB.
const pgSaves: Array<{ id: string; label: string }> = [];
const pgDeletes: string[] = [];
vi.mock('./playground-store', () => ({
  savePlaygroundInstance: (id: string, label: string) => {
    pgSaves.push({ id, label });
    return Promise.resolve();
  },
  deletePlaygroundInstance: (id: string) => {
    pgDeletes.push(id);
    return Promise.resolve();
  },
  loadAllPlaygroundInstances: () => Promise.resolve([]),
}));
// Capture projects-store traffic — it must stay silent in playground mode.
const projectSaves: string[] = [];
vi.mock('./project-store', () => ({
  saveProject: (id: string) => { projectSaves.push(id); return Promise.resolve(); },
  deleteProject: () => Promise.resolve(),
  loadAllProjects: () => Promise.resolve({}),
}));

import { appState } from './app-state';
import { appController } from './controller';
import { PLAYGROUND_ID_PREFIX } from './types';

const pgIds = () =>
  Object.keys(appState.database.sketches).filter(id => id.startsWith(PLAYGROUND_ID_PREFIX));
const labels = () => appState.local.barrelInstances.map(i => i.label);

beforeEach(() => {
  vi.useFakeTimers();
  pgSaves.length = 0;
  pgDeletes.length = 0;
  projectSaves.length = 0;
  appController.setPlaygroundMode(true);
  // The controller is a singleton — clear its private per-session playground
  // bookkeeping so label allocation and flush dedupe start fresh per test.
  (appController as any).playgroundLabels.clear();
  (appController as any).playgroundLastSavedJson.clear();
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.barrelInstances = [];
    appState.local.selectedBarrelKey = null;
    appState.local.editingSketchId = null;
  });
});

afterEach(() => {
  vi.useRealTimers();
  appController.setPlaygroundMode(false);
  appController.setBarrelSelectHandler(null);
  runInAction(() => { appState.database.sketches = {} as any; });
});

async function flushSaves() {
  await vi.advanceTimersByTimeAsync(1000);
}

describe('playground instance CRUD', () => {
  it('create seeds an empty pg: sketch, labels it, lists it, selects it', () => {
    const opened: string[] = [];
    appController.setBarrelSelectHandler((k) => opened.push(k));

    const id = appController.createPlaygroundInstance();
    expect(id.startsWith(PLAYGROUND_ID_PREFIX)).toBe(true);
    expect(appState.database.sketches[id]).toEqual(
      { anchor: null, chain: [], wires: [], instances: {} });
    expect(labels()).toEqual(['Instance 1']);
    expect(appState.local.selectedBarrelKey).toBe(id);
    expect(opened).toEqual([id]);  // select handler opens it for editing

    const id2 = appController.createPlaygroundInstance();
    expect(labels()).toEqual(['Instance 1', 'Instance 2']);
    expect(appState.local.selectedBarrelKey).toBe(id2);
  });

  it('delete removes the sketch + card and repairs the selection', () => {
    const a = appController.createPlaygroundInstance();
    const b = appController.createPlaygroundInstance();
    appController.selectBarrelInstance(a);

    appController.deletePlaygroundInstanceById(a);
    expect(pgIds()).toEqual([b]);
    expect(appState.local.barrelInstances.map(i => i.key)).toEqual([b]);
    expect(appState.local.selectedBarrelKey).toBe(b);
  });

  it('undoing a delete restores the instance with its label', () => {
    const a = appController.createPlaygroundInstance();
    appController.createPlaygroundInstance();
    appController.deletePlaygroundInstanceById(a);
    expect(labels()).toEqual(['Instance 2']);

    appController.undo();
    expect(pgIds()).toContain(a);
    expect(labels()).toEqual(expect.arrayContaining(['Instance 1', 'Instance 2']));
  });

  it('label allocation reuses the lowest free slot', () => {
    const a = appController.createPlaygroundInstance();      // Instance 1
    appController.createPlaygroundInstance();                // Instance 2
    appController.deletePlaygroundInstanceById(a);
    appController.createPlaygroundInstance();
    expect(labels().sort()).toEqual(['Instance 1', 'Instance 2']);
  });
});

describe('playground persistence routing', () => {
  it('flushes pg: sketches to the playground store only; projects stays untouched', async () => {
    appController.enablePersistence();
    const id = appController.createPlaygroundInstance();
    await flushSaves();

    expect(pgSaves.map(s => s.id)).toContain(id);
    expect(pgSaves.find(s => s.id === id)?.label).toBe('Instance 1');
    expect(projectSaves).toEqual([]);
  });

  it('deletion reaches the playground store on the next flush', async () => {
    appController.enablePersistence();
    const id = appController.createPlaygroundInstance();
    await flushSaves();
    appController.deletePlaygroundInstanceById(id);
    await flushSaves();
    expect(pgDeletes).toContain(id);
  });

  it('does not save playground records outside playground mode', async () => {
    appController.setPlaygroundMode(false);
    appController.enablePersistence();
    runInAction(() => {
      appState.database.sketches['pg:stray'] = { anchor: null, chain: [], wires: [], instances: {} } as any;
    });
    appController.mutate('touch', () => { /* trigger postRecordHook */ });
    await flushSaves();
    expect(pgSaves).toEqual([]);
  });
});
