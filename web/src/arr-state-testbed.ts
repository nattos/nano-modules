/**
 * Arrangement state testbed boot — Component B harness.
 *
 * Drives the real `ArrangementStore` (immer/patch undo via DocHistory + disk
 * persistence through a WorkspaceBackend). Puppeteer exercises the full
 * create → mutate → undo/redo → save → reload-from-disk round-trip against an
 * OPFS-backed workspace via window.__arrState.
 */

import { store } from './views/arrangement/state/store';
import { mountOpfs, type WorkspaceBackend } from './views/arrangement/workspace/backend';
import { emptyComposition, type Composition } from './views/arrangement/model/composition';

const out = document.getElementById('out')!;
const dump = () => {
  out.textContent = JSON.stringify(
    {
      name: store.currentName,
      bpm: store.composition.meta.baseBPM,
      clips: store.composition.tracks.reduce((n, t) => n + t.clips.length, 0),
      canUndo: store.canUndo,
      canRedo: store.canRedo,
    },
    null,
    2,
  );
};
dump();

(window as any).__arrState = {
  store,
  emptyComposition,
  async mountOpfs(subdir?: string): Promise<WorkspaceBackend> {
    return mountOpfs(subdir);
  },
  async create(backend: WorkspaceBackend, name: string, comp?: Composition) {
    await store.createArrangement(backend, name, comp);
    dump();
  },
  async open(backend: WorkspaceBackend, name: string) {
    await store.openArrangement(backend, name);
    dump();
  },
  async saveNow() {
    await store.saveNow();
  },
  setBpm: (b: number) => { store.setBpm(b); dump(); },
  createClip: (trackId: string, start: number) => { const p = store.createEmptyClip(trackId, start); dump(); return p; },
  firstTrackId: () => store.composition.tracks.find((t) => t.kind === 'track')?.id ?? null,
  clipCount: () => store.composition.tracks.reduce((n, t) => n + t.clips.length, 0),
  get bpm() { return store.composition.meta.baseBPM; },
  get canUndo() { return store.canUndo; },
  get canRedo() { return store.canRedo; },
  undo: () => { store.undo(); dump(); },
  redo: () => { store.redo(); dump(); },
};
