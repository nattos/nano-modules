import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import { seedTestPlugins } from '../engine/test-plugins';
seedTestPlugins(); // offline registry: catalogEffect resolves source/effect roles

/**
 * Several effect cards can be selected as a GROUP (Cmd-click to add, Shift-click
 * for a range), and Delete takes the whole group out in ONE undo entry. Before
 * this, the arrangement's column adapter simply didn't implement the
 * multi-selection hooks column-group offers, so a modified click fell back to a
 * plain select and Delete only ever removed one card.
 */
describe('effect card groups', () => {
  let trackId: string;
  let clipId: string;
  let sk: string;
  const path = (i: number) => `effect/${sk}/0/${i}`;
  const types = () => store.clipIn(trackId, clipId)!.sketch.devices.map((d) => d.moduleType);

  beforeEach(() => {
    store.clearSelection();
    store.clearChainFocus();
    trackId = store.addTrack();
    const p = store.createEmptyClip(trackId, 0, 8)!;
    clipId = p.split('/')[2];
    sk = `clip/${trackId}/${clipId}`;
    for (const t of ['source.solid_color', 'color.saturate', 'color.invert']) {
      store.addClipDeviceType(trackId, clipId, t);
    }
    expect(types()).toHaveLength(3);
  });

  it('a plain select collapses the group to one card', () => {
    store.setChainFocus(path(0));
    store.toggleChainSelect(path(2));
    expect(store.chainMultiSelection).toHaveLength(2);
    store.setChainFocus(path(1));
    expect(store.chainMultiSelection).toEqual([path(1)]);
  });

  it('Cmd-click adds in chain order and hands the primary to the new card', () => {
    store.setChainFocus(path(2));
    store.toggleChainSelect(path(0));
    expect(store.chainMultiSelection).toEqual([path(0), path(2)]);
    expect(store.chainFocusPath).toBe(path(0));
    expect(store.isChainMultiSelected(path(1))).toBe(false);
  });

  it('Cmd-clicking the primary again drops it and re-homes the primary', () => {
    store.setChainFocus(path(0));
    store.toggleChainSelect(path(1));
    expect(store.chainFocusPath).toBe(path(1));
    store.toggleChainSelect(path(1));
    expect(store.chainMultiSelection).toEqual([path(0)]);
    expect(store.chainFocusPath).toBe(path(0));
  });

  it('Shift-click takes the contiguous range from the focused card', () => {
    store.setChainFocus(path(2));
    store.rangeChainSelect(path(0));
    expect(store.chainMultiSelection).toEqual([path(0), path(1), path(2)]);
  });

  it('deletes the whole group as ONE undo entry', () => {
    store.setChainFocus(path(0));
    store.toggleChainSelect(path(2));
    store.deleteChainFocus();
    expect(types()).toEqual(['color.saturate']);
    store.undo();
    expect(types()).toEqual(['source.solid_color', 'color.saturate', 'color.invert']);
  });

  it('a lone selection still deletes just that card', () => {
    store.setChainFocus(path(1));
    store.deleteChainFocus();
    expect(types()).toEqual(['source.solid_color', 'color.invert']);
  });

  it('a new top-level selection drops the group (Delete must not reach it)', () => {
    store.setChainFocus(path(0));
    store.toggleChainSelect(path(2));
    expect(store.chainMultiSelection).toHaveLength(2);
    // Clicking a clip / track / the background clears the chain focus; the group
    // has to go with it, or the next Delete would gut a chain you left behind.
    store.selectClipOnly(`clip/${trackId}/${clipId}`);
    expect(store.chainMultiSelection).toEqual([]);
    store.deleteChainFocus();
    expect(types()).toHaveLength(3);
  });

  it('never groups across two different chains', () => {
    const otherTrack = store.addTrack();
    const otherClip = store.createEmptyClip(otherTrack, 0, 8)!;
    store.addClipDeviceType(otherTrack, otherClip.split('/')[2], 'color.invert');
    store.setChainFocus(path(0));
    const foreign = `effect/${otherClip}/0/0`;
    store.toggleChainSelect(foreign);
    expect(store.chainMultiSelection).toEqual([foreign]);
  });
});
