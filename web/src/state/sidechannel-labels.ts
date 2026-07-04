/**
 * Sidechannel display labels — shared by the Instances-tab sidechannel cards
 * and the channel dropdown in the sidechannel effect inspector, so a renamed
 * channel reads the same everywhere.
 *
 * A channel's DEFAULT label is "<channel> — <writer instance label>" once
 * something has written to it ("3 — Instance 2"), or just the channel name
 * before that. The user can set a per-channel override TEMPLATE
 * (`userSettings.sidechannelNames`): every "#" in it expands to the default
 * label, and an absent/blank template behaves as "#" (pure default) — so
 * "Drums" fully renames, "Drums #" decorates, and clearing the field reverts.
 */

import { appState } from './app-state';

/**
 * Human label for a sidechannel writer tag: a `pg:` sketch id (playground) or
 * a plugin key (barrel) — both resolve through the shared instances list;
 * unknown tags fall back to the barrel label convention (first UUID segment).
 */
export function sidechannelWriterLabel(writerTag: string): string {
  if (!writerTag) return '';
  const inst = appState.local.barrelInstances.find(i => i.key === writerTag);
  if (inst) return inst.label;
  return writerTag.split('-')[0] || writerTag;
}

/** The channel's default label — what the UI shows with no override. */
export function sidechannelDefaultLabel(channel: string): string {
  const info = appState.local.engine.sidechannels[channel];
  const writer = info?.writer ? sidechannelWriterLabel(info.writer) : '';
  return writer ? `${channel} — ${writer}` : channel;
}

/** The user-facing label: the override template with "#" expanded. */
export function sidechannelDisplayLabel(channel: string): string {
  const stored = appState.local.userSettings.sidechannelNames[channel];
  const template = (stored ?? '#').trim() || '#';
  return template.split('#').join(sidechannelDefaultLabel(channel));
}
