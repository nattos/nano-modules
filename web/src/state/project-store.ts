/**
 * Project CRUD on top of `idb-store`.
 *
 * Projects are `Sketch` objects keyed by `user:<uuid>`. Default projects
 * (`default:<effectId>`) are virtual and never stored. Template user copies
 * (`isTemplate: true`) are also skipped — they're transient previews of
 * defaults that the user is browsing without editing.
 *
 * Save scheduling is the controller's job: `mutate()` calls
 * `requestProjectsSave()` after committing, which debounces a flush. We
 * never use a MobX reaction for persistence.
 */

import { toJS } from 'mobx';
import type { Sketch } from '../sketch-types';
import { idbGetAll, idbPut, idbDelete, STORE_PROJECTS } from './idb-store';

interface ProjectRecord {
  id: string;
  sketch: Sketch;
  updatedAt: number;
}

export async function loadAllProjects(): Promise<Record<string, Sketch>> {
  const records = await idbGetAll<ProjectRecord>(STORE_PROJECTS);
  const out: Record<string, Sketch> = {};
  for (const r of records) {
    if (r && typeof r.id === 'string' && r.sketch) {
      out[r.id] = r.sketch;
    }
  }
  return out;
}

export async function saveProject(id: string, sketch: Sketch): Promise<void> {
  // toJS + JSON round-trip to avoid sending MobX proxies into IDB.
  const safe = JSON.parse(JSON.stringify(toJS(sketch)));
  await idbPut(STORE_PROJECTS, { id, sketch: safe, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  await idbDelete(STORE_PROJECTS, id);
}
