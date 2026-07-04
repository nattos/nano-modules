/**
 * Instance display labels — shared by the Instances-tab cards/inspector and
 * anything that names an instance (sidechannel writer lines, etc.), so a
 * renamed instance reads the same everywhere.
 *
 * An instance's DEFAULT (auto-)name is its shared-server label — the first
 * UUID segment in barrel mode, the playground label locally. The user can set
 * a per-instance override TEMPLATE (`userSettings.instanceNames`): every "#"
 * in it expands to the auto-name, and an absent/blank template behaves as "#"
 * (pure default) — so "Main out" fully renames, "Main #" decorates, and
 * clearing the field reverts. Same contract as sidechannel renames.
 */

import { appState } from './app-state';

/** The instance's auto-name — what the UI shows with no override. */
export function instanceDefaultLabel(key: string): string {
  const inst = appState.local.barrelInstances.find(i => i.key === key);
  if (inst) return inst.label;
  return key.split('-')[0] || key;
}

/** The user-facing label: the override template with "#" expanded. */
export function instanceDisplayLabel(key: string): string {
  const stored = appState.local.userSettings.instanceNames[key];
  const template = (stored ?? '#').trim() || '#';
  return template.split('#').join(instanceDefaultLabel(key));
}
