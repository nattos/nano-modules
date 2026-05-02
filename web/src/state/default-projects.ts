/**
 * Synthesize a virtual default project for an effect.
 *
 * Default projects are derived on demand from `availableEffects` — they only
 * exist in `appState.database.sketches` after a user selects them. They are
 * never written to IndexedDB. On first edit, they are materialized into a
 * `user:<uuid>` project (see `effect-ide-controller`).
 */

import type { Sketch } from '../sketch-types';
import type { AvailableEffect } from './types';

export const DEFAULT_PROJECT_PREFIX = 'default:';
export const USER_PROJECT_PREFIX = 'user:';

export function isDefaultProjectId(id: string): boolean {
  return id.startsWith(DEFAULT_PROJECT_PREFIX);
}

export function isUserProjectId(id: string): boolean {
  return id.startsWith(USER_PROJECT_PREFIX);
}

/**
 * True for any id that the IDE persists in IndexedDB — `default:<effectId>`
 * (saved defaults) or `user:<uuid>` (legacy / future user-created projects).
 * Sketches keyed under other prefixes (e.g. resolume's `sketch_N`) are
 * managed separately and aren't touched by the project autosave.
 */
export function isPersistableProjectId(id: string): boolean {
  return isDefaultProjectId(id) || isUserProjectId(id);
}

export function effectIdFromDefaultProjectId(id: string): string {
  return id.slice(DEFAULT_PROJECT_PREFIX.length);
}

export function defaultProjectIdForEffect(effectId: string): string {
  return DEFAULT_PROJECT_PREFIX + effectId;
}

/**
 * Build the canonical single-column shape for a fresh default project:
 *   texture_input → module → texture_output
 *
 * Returns null if the effect isn't in the available set yet (e.g. the WASM
 * module hasn't loaded). Caller should retry once effects are discovered.
 */
export function synthesizeDefaultProject(
  effectId: string,
  effects: AvailableEffect[],
): Sketch | null {
  const effect = effects.find(e => e.id === effectId);
  if (!effect) return null;
  const instanceKey = `${effectId}@default`;
  return {
    anchor: null,
    columns: [{
      name: effect.name,
      chain: [
        { type: 'texture_input', id: 'primary_in' },
        { type: 'module', module_type: effectId, instance_key: instanceKey },
        { type: 'texture_output', id: 'primary_out' },
      ],
    }],
    instances: {
      [instanceKey]: { module_type: effectId, state: {} },
    },
  };
}
