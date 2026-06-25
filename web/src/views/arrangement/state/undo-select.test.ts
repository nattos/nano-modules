import { describe, it, expect, beforeEach } from 'vitest';
import { store, paths } from './store';

/**
 * After undo/redo, a SINGLY-created clip or track auto-selects (so re-creating
 * a thing focuses it). Zero / multiple additions leave selection as-is.
 */
describe('undo/redo auto-selects a singly-created clip or track', () => {
  beforeEach(() => {
    store.clearSelection();
    store.clearTimeSelection();
  });

  it('redo that re-creates exactly one clip selects it', () => {
    const trk = store.addTrack();
    const clipPath = store.createEmptyClip(trk, 0, 8)!;
    const clipId = clipPath.split('/')[2];
    store.clearSelection();

    store.undo(); // removes the clip (0 added → selection unchanged)
    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)).toBeUndefined();
    expect(store.isSelected(paths.clip(trk, clipId))).toBe(false);

    store.redo(); // re-creates exactly one clip → it becomes selected
    expect(store.trackById(trk)!.clips.find((c) => c.id === clipId)).toBeDefined();
    expect(store.isSelected(paths.clip(trk, clipId))).toBe(true);
    expect(store.primaryPath).toBe(paths.clip(trk, clipId));
  });

  it('redo that re-creates exactly one track selects it', () => {
    const trk = store.addTrack();
    store.clearSelection();
    store.undo(); // removes the track
    expect(store.trackById(trk)).toBeUndefined();
    store.redo(); // re-creates exactly one track → selected
    expect(store.trackById(trk)).toBeDefined();
    expect(store.isSelected(paths.track(trk))).toBe(true);
  });

  it('an undo/redo that adds NO clip/track leaves selection unchanged', () => {
    const trk = store.addTrack();
    store.createEmptyClip(trk, 0, 4);
    store.select(paths.track(trk)); // a known, stable selection
    const before = [...store.selection];

    store.undo(); // undoes the clip creation → removes a clip (0 added)
    expect([...store.selection]).toEqual(before);
    expect(store.primaryPath).toBe(paths.track(trk));
  });

  it('a redo that re-creates MORE than one clip leaves selection unchanged', () => {
    const trk = store.addTrack();
    const a = store.createEmptyClip(trk, 0, 4)!;
    const b = store.createEmptyClip(trk, 8, 4)!;
    store.clearTimeSelection(); // drop the clip-extent box so copy takes whole clips
    store.setSelection([a, b]);
    expect(store.copyClips()).toBe(true);

    // Paste two clips at a fresh spot in ONE undo entry.
    store.setCaret({ anchorBeat: 24, anchorTrackId: trk, headBeat: 24, headTrackId: trk });
    const countBefore = store.trackById(trk)!.clips.length;
    store.pasteClips();
    expect(store.trackById(trk)!.clips.length).toBe(countBefore + 2);

    store.select(paths.track(trk)); // stable known selection
    store.undo(); // removes the 2 pasted clips (0 added)
    expect(store.primaryPath).toBe(paths.track(trk));

    store.redo(); // re-adds 2 clips → NOT exactly one → selection unchanged
    expect(store.trackById(trk)!.clips.length).toBe(countBefore + 2);
    expect(store.primaryPath).toBe(paths.track(trk));
  });
});
