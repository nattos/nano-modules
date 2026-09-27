import { describe, it, expect } from 'vitest';
import { compareVersions, groupEffects, pushRecentEmoji, toggleReaction, versionBadge } from './store-model';
import type { AvailableEffect, EffectStoreSettings } from '../../state/types';
import { defaultEffectStoreSettings } from '../../state/user-settings';

const fx = (id: string, name: string, extra: Partial<AvailableEffect> = {}): AvailableEffect =>
  ({ id, name, description: '', category: '', keywords: [], bundle: 'com.nano.core', ...extra });

const ALL = [
  fx('color.tone.levels', 'Levels', { changedIn: '1.1.0', addedIn: '1.0.0' }),
  fx('color.tone.brightness_contrast', 'Brightness & Contrast', { changedIn: '1.10.0', addedIn: '1.10.0' }),
  fx('source.noise', 'Noise'),
  fx('mod.source.lfo', 'LFO', { bundle: 'com.nano.lights' }),
  fx('debug.spinningtris', 'Spinning Tris', { bundle: 'com.nano.testonly' }),
];
const kinds: Record<string, 'image' | 'generator' | 'modulation'> = {
  'color.tone.levels': 'image', 'color.tone.brightness_contrast': 'image',
  'source.noise': 'generator', 'mod.source.lfo': 'modulation', 'debug.spinningtris': 'generator',
};
const kindOf = (id: string) => kinds[id] ?? 'image';
const view = (over: Partial<EffectStoreSettings>) => ({ ...defaultEffectStoreSettings(), ...over });
const shape = (gs: ReturnType<typeof groupEffects>) => gs.map((g) => [g.label, g.effects.map((e) => e.id)]);

describe('store model', () => {
  it('compares release versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions(undefined, '1.0.0')).toBeLessThan(0);
  });

  it('badges new vs updated', () => {
    expect(versionBadge(ALL[0])).toBe('updated');
    expect(versionBadge(ALL[1])).toBe('new');
    expect(versionBadge(ALL[2])).toBeNull();
  });

  it('groups by category in domain order, hiding debug effects by default', () => {
    expect(shape(groupEffects(ALL, view({}), kindOf, {}, []))).toEqual([
      ['Source', ['source.noise']],
      ['Color', ['color.tone.brightness_contrast', 'color.tone.levels']],
      ['Mod', ['mod.source.lfo']],
    ]);
    const withDebug = groupEffects(ALL, view({ showDebug: true }), kindOf, {}, []);
    expect(withDebug.some((g) => g.effects.some((e) => e.id === 'debug.spinningtris'))).toBe(true);
  });

  it('groups by bundle, core first', () => {
    expect(shape(groupEffects(ALL, view({ collection: 'bundle' }), kindOf, {}, []))).toEqual([
      ['Core', ['color.tone.brightness_contrast', 'color.tone.levels', 'source.noise']],
      ['Lights', ['mod.source.lfo']],
    ]);
  });

  it('groups by release, newest first, untagged last', () => {
    expect(shape(groupEffects(ALL, view({ collection: 'updated' }), kindOf, {}, []))).toEqual([
      ['Release 1.10.0', ['color.tone.brightness_contrast']],
      ['Release 1.1.0', ['color.tone.levels']],
      ['Earlier', ['mod.source.lfo', 'source.noise']],
    ]);
  });

  it('groups favs by emoji, in recent-use order', () => {
    const reactions = { 'source.noise': ['🔥', '⭐'], 'mod.source.lfo': ['⭐'] };
    expect(shape(groupEffects(ALL, view({ collection: 'favs' }), kindOf, reactions, ['⭐', '🔥']))).toEqual([
      ['⭐', ['mod.source.lfo', 'source.noise']],
      ['🔥', ['source.noise']],
    ]);
  });

  it('filters by kind, and a plain query ranks into one Results group', () => {
    expect(shape(groupEffects(ALL, view({ show: 'modulation' }), kindOf, {}, []))).toEqual([['Mod', ['mod.source.lfo']]]);
    expect(shape(groupEffects(ALL, view({ query: 'lev' }), kindOf, {}, []))).toEqual([['Results', ['color.tone.levels']]]);
    // A path query narrows but keeps the grouping.
    expect(shape(groupEffects(ALL, view({ query: 'color.' }), kindOf, {}, []))).toEqual([
      ['Color', ['color.tone.brightness_contrast', 'color.tone.levels']],
    ]);
  });

  it('sorts within groups, and flattens with no collection', () => {
    const flat = (over: Partial<EffectStoreSettings>) => shape(groupEffects(ALL, view({ collection: 'none', ...over }), kindOf, reactions, []));
    const reactions = { 'source.noise': ['🔥', '⭐'], 'color.tone.levels': ['⭐'] };
    expect(flat({})).toEqual([['All effects', ['color.tone.brightness_contrast', 'color.tone.levels', 'mod.source.lfo', 'source.noise']]]);
    expect(flat({ sort: 'newest' })).toEqual([['All effects', ['color.tone.brightness_contrast', 'color.tone.levels', 'mod.source.lfo', 'source.noise']]]);
    expect(flat({ sort: 'category' })).toEqual([['All effects', ['source.noise', 'color.tone.brightness_contrast', 'color.tone.levels', 'mod.source.lfo']]]);
    expect(flat({ sort: 'reacted' })).toEqual([['All effects', ['source.noise', 'color.tone.levels', 'color.tone.brightness_contrast', 'mod.source.lfo']]]);
    // Within a category group too.
    expect(shape(groupEffects(ALL, view({ sort: 'newest', query: 'color.' }), kindOf, {}, []))).toEqual([
      ['Color', ['color.tone.brightness_contrast', 'color.tone.levels']],
    ]);
  });

  it('keeps search relevance under Relevance, re-sorts results otherwise', () => {
    const q = (sort: EffectStoreSettings['sort']) =>
      shape(groupEffects(ALL, view({ query: 'l', sort }), kindOf, {}, []))[0]?.[1] as string[];
    const relevance = q('relevance');
    expect(relevance.length).toBeGreaterThan(1);
    expect(q('name')).toEqual([...relevance].sort((a, b) =>
      ALL.find((e) => e.id === a)!.name.localeCompare(ALL.find((e) => e.id === b)!.name)));
  });

  it('keeps the recent-emoji list deduped, newest first, capped at 6', () => {
    expect(pushRecentEmoji(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecentEmoji(['1', '2', '3', '4', '5', '6'], '7')).toEqual(['7', '1', '2', '3', '4', '5']);
    expect(toggleReaction(['⭐'], '⭐')).toEqual([]);
    expect(toggleReaction(undefined, '⭐')).toEqual(['⭐']);
  });
});
