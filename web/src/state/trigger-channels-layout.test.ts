import { describe, it, expect } from 'vitest';
import { padToMultiple, triggerChannelColumns } from './trigger-channels-layout';
import type { TriggerChannelClips } from '../engine-types';

const clip = (key: string) => ({ key, clip: key, connected: false });
const chans = (m: Record<number, string[]>): Record<string, TriggerChannelClips> => {
  const out: Record<string, TriggerChannelClips> = {};
  for (const [ch, keys] of Object.entries(m)) out[ch] = { name: '', clips: keys.map(clip) };
  return out;
};

describe('padToMultiple', () => {
  it('never returns less than the step', () => {
    expect(padToMultiple(0, 8)).toBe(8);
    expect(padToMultiple(1, 8)).toBe(8);
    expect(padToMultiple(8, 8)).toBe(8);
  });
  it('rounds up past the step', () => {
    expect(padToMultiple(9, 8)).toBe(16);
    expect(padToMultiple(16, 8)).toBe(16);
    expect(padToMultiple(17, 8)).toBe(24);
  });
});

describe('triggerChannelColumns', () => {
  it('always yields at least 8 columns, even when empty', () => {
    const cols = triggerChannelColumns({});
    expect(cols).toHaveLength(8);
    expect(cols.every(c => c.empty)).toBe(true);
    expect(cols.map(c => c.channel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('pads a few used channels up to 8, marking gaps empty', () => {
    const cols = triggerChannelColumns(chans({ 1: ['a'], 3: ['b', 'c'] }));
    expect(cols).toHaveLength(8);
    expect(cols[0].clips.map(c => c.key)).toEqual(['a']);
    expect(cols[0].empty).toBe(false);
    expect(cols[1].empty).toBe(true);   // channel 2 unused
    expect(cols[2].clips.map(c => c.key)).toEqual(['b', 'c']);
  });

  it('grows to the next bank of 8 when a higher channel is used', () => {
    const cols = triggerChannelColumns(chans({ 9: ['x'] }));
    expect(cols).toHaveLength(16);
    expect(cols[8].channel).toBe(9);
    expect(cols[8].clips.map(c => c.key)).toEqual(['x']);
  });

  it('carries the channel name through', () => {
    const cols = triggerChannelColumns({ 2: { name: 'Bass', clips: [] } });
    expect(cols[1].name).toBe('Bass');
  });
});
