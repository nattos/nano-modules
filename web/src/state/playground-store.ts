/**
 * Playground-instance CRUD on top of `idb-store` — the persistence for the
 * local shared-server playground's fake barrel instances.
 *
 * Each instance is one sketch keyed by `pg:<uuid>` plus a user-facing label.
 * Mirrors `project-store.ts` but over its OWN object store: the playground is
 * expressly its own environment (a local stand-in for the shared NanoBarrel
 * server) and never touches effect-IDE projects.
 *
 * Save scheduling is the controller's job (`requestPlaygroundSave()` after
 * commits, debounced); never a MobX reaction.
 */

import { toJS } from 'mobx';
import type { Sketch } from '../sketch-types';
import { ENGINE_VERSION } from '../version';
import { idbGetAll, idbPut, idbDelete, STORE_PLAYGROUND } from './idb-store';

export interface PlaygroundInstanceRecord {
  id: string;          // `pg:<uuid>`
  label: string;       // user-facing instance name
  sketch: Sketch;
  updatedAt: number;
}

export async function loadAllPlaygroundInstances(): Promise<PlaygroundInstanceRecord[]> {
  const records = await idbGetAll<PlaygroundInstanceRecord>(STORE_PLAYGROUND);
  return records.filter((r) => r && typeof r.id === 'string' && !!r.sketch);
}

export async function savePlaygroundInstance(id: string, label: string, sketch: Sketch): Promise<void> {
  // toJS + JSON round-trip to avoid sending MobX proxies into IDB.
  const safe = JSON.parse(JSON.stringify(toJS(sketch)));
  safe.engineVersion = ENGINE_VERSION;
  await idbPut(STORE_PLAYGROUND, {
    id, label, sketch: safe, updatedAt: Date.now(),
  } satisfies PlaygroundInstanceRecord);
}

export async function deletePlaygroundInstance(id: string): Promise<void> {
  await idbDelete(STORE_PLAYGROUND, id);
}
