/**
 * Project CRUD on top of `idb-store`.
 *
 * Projects are `Sketch` objects keyed by `user:<uuid>`. Default projects
 * (`default:<effectId>`) are virtual and never stored.
 *
 * Auto-save: an autorun watches `appState.database.sketches`, debounces,
 * then writes any user: sketch whose serialization has changed since the
 * last save. Deletes are detected as keys that disappear from the map.
 */

import { autorun, toJS } from 'mobx';
import { appState } from './app-state';
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

/**
 * Subscribe a debounced autorun that writes any user: sketch to IDB whenever
 * its serialized form changes, and deletes any user: sketch whose key is
 * removed from `appState.database.sketches`.
 *
 * Returns a dispose function.
 */
export function subscribeProjectsAutosave(debounceMs = 300): () => void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const lastSaved = new Map<string, string>();

  const dispose = autorun(() => {
    // Read the sketches map — toJS deeply touches every observable so the
    // autorun re-fires on any nested change.
    const sketches = toJS(appState.database.sketches);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      // Skip user: sketches still flagged as templates — these are virtual
      // copies of defaults that the user is browsing without editing.
      const userIds = new Set(
        Object.keys(sketches).filter(k =>
          k.startsWith('user:') && !sketches[k]?.isTemplate
        )
      );

      for (const id of userIds) {
        const json = JSON.stringify(sketches[id]);
        if (lastSaved.get(id) === json) continue;
        try {
          await saveProject(id, sketches[id]);
          lastSaved.set(id, json);
        } catch (err) {
          console.warn('[project-store] save failed', id, err);
        }
      }

      // Detect deletions (previously saved, now missing).
      for (const id of Array.from(lastSaved.keys())) {
        if (!userIds.has(id)) {
          try {
            await deleteProject(id);
            lastSaved.delete(id);
          } catch (err) {
            console.warn('[project-store] delete failed', id, err);
          }
        }
      }
    }, debounceMs);
  });

  return () => {
    dispose();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
}
