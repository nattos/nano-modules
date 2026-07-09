/**
 * Pure device-library logic: physical-port ↔ instance matching and forking.
 *
 * Kept free of Web MIDI / MobX / IndexedDB so the lineage + matching rules are
 * unit-testable and shared verbatim by the native host's port matching.
 *
 * Matching strategy (Web MIDI port ids are NOT stable across browsers or
 * machines): rank an exact platform-id hit above a (name, manufacturer) tuple
 * hit. Tuple matches against two identical physical units are inherently
 * ambiguous — resolution is deterministic by library order, and the caller
 * re-stamps the platform id on the winner so the pairing sticks for this
 * browser (documented v1 limitation).
 */

import { getDeviceTemplate } from './device-registry';
import type { DeviceInstance, DeviceTemplate, PhysicalIdentity } from './midi-types';

/** Do two identities refer to the same *model + labeling* of hardware? */
export function identityTupleEquals(a: PhysicalIdentity, b: PhysicalIdentity): boolean {
  return a.name === b.name && a.manufacturer === b.manufacturer;
}

export interface InstanceMatch {
  instance: DeviceInstance;
  /** Index into `instance.identities` that matched. */
  identityIndex: number;
  /** True when the match was by platform port id (else tuple). */
  exact: boolean;
}

/**
 * Find the instance claiming a physical port. Exact `webPortId` matches win
 * over tuple matches; among tuple matches the first non-deleted instance in
 * library order wins. `taken` excludes instances already paired this pass
 * (two identical units → second unit falls through to the next claimant).
 */
export function matchInstanceForPort(
  library: readonly DeviceInstance[],
  port: PhysicalIdentity,
  taken?: ReadonlySet<string>,
): InstanceMatch | null {
  let tuple: InstanceMatch | null = null;
  for (const instance of library) {
    if (instance.deleted || taken?.has(instance.id)) continue;
    for (let i = 0; i < instance.identities.length; i++) {
      const identity = instance.identities[i];
      if (port.webPortId !== undefined && identity.webPortId === port.webPortId) {
        return { instance, identityIndex: i, exact: true };
      }
      if (!tuple && identityTupleEquals(identity, port)) {
        tuple = { instance, identityIndex: i, exact: false };
      }
    }
  }
  return tuple;
}

/**
 * Fork a template or an existing instance into a new `DeviceInstance` — the
 * ShaderToy model: a full config copy, lineage recorded for bookkeeping only.
 * Identities are NOT inherited (a fork is a new logical unit until it claims
 * a port); the caller persists the result.
 */
export function forkInstance(
  source: DeviceTemplate | DeviceInstance,
  existingNames: readonly string[] = [],
): DeviceInstance {
  const fromTemplate = 'templateId' in source && !('parentId' in source);
  const template = fromTemplate
    ? source as DeviceTemplate
    : getDeviceTemplate((source as DeviceInstance).templateId);
  if (!template) throw new Error(`unknown template for fork: ${JSON.stringify((source as DeviceInstance).templateId)}`);
  const config = structuredClone(
    fromTemplate ? template.defaultConfig : (source as DeviceInstance).config);
  const baseName = fromTemplate ? template.name : (source as DeviceInstance).name;
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    templateId: template.templateId,
    parentId: fromTemplate ? template.templateId : (source as DeviceInstance).id,
    forkedAt: now,
    name: uniqueName(baseName, existingNames),
    config,
    identities: [],
    updatedAt: now,
  };
}

/** 'Twister' → 'Twister 2' → 'Twister 3' … against the taken-name set. */
function uniqueName(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!existing.includes(candidate)) return candidate;
  }
}
