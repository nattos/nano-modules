/**
 * Pure layout for the Instances-tab "Trigger Channels" grid.
 *
 * The shared server publishes channels as a sparse map keyed by 1-based channel
 * number (only channels that have registered clips). The grid always shows a
 * whole multiple of 8 columns (at least 8), padding the gaps with empty
 * placeholder columns — so channels line up in banks of 8 and there's always a
 * drop target to reassign a clip onto an unused channel.
 */

import type { TriggerChannelClips, TriggerChannelClip } from '../engine-types';

export interface TriggerChannelColumn {
  /** 1-based channel number. */
  channel: number;
  /** Cosmetic column label ("" when unnamed → caller falls back to `Channel N`). */
  name: string;
  /** Registered clips on this channel (empty for placeholder columns). */
  clips: TriggerChannelClip[];
  /** True when the channel has no registered clips (renders as `<empty>`). */
  empty: boolean;
}

/** Round `n` up to the next multiple of `step` (with `step` as the minimum). */
export function padToMultiple(n: number, step: number): number {
  if (n <= step) return step;
  return Math.ceil(n / step) * step;
}

/**
 * Build the padded, ordered column list for the grid. `bank` is the padding
 * granularity (8). Columns run 1..N where N = padToMultiple(highestChannel, bank).
 */
export function triggerChannelColumns(
  channels: Record<string, TriggerChannelClips>,
  bank = 8,
): TriggerChannelColumn[] {
  let maxCh = 0;
  for (const k of Object.keys(channels)) {
    const n = Number(k);
    if (Number.isFinite(n) && n > maxCh) maxCh = n;
  }
  const total = padToMultiple(maxCh, bank);
  const cols: TriggerChannelColumn[] = [];
  for (let ch = 1; ch <= total; ch++) {
    const col = channels[String(ch)];
    const clips = col?.clips ?? [];
    cols.push({ channel: ch, name: col?.name ?? '', clips, empty: clips.length === 0 });
  }
  return cols;
}
