/**
 * The export controller's RANGE resolution: whole arrangement / loop region /
 * live time selection, with a graceful fall back to the whole arrangement when
 * the chosen source has gone away (loop cleared, selection collapsed).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { exportController } from './export-controller';
import { store } from '../state/store';
import { compositionLengthBeats } from '../model/composition';

describe('exportController.range', () => {
  let track: string;
  beforeEach(() => {
    track = store.addTrack();
    store.loopEnabled = false;
    store.clearTimeSelection();
    store.setPlayFrom(0);
    store.setExportSettings({ range: 'all' });
  });

  const whole = () => ({ startBeat: 0, endBeat: compositionLengthBeats(store.composition) });

  it("'all' exports the whole arrangement", () => {
    expect(exportController.range).toEqual(whole());
  });

  it("'loop' exports the loop region only while one is enabled", () => {
    store.setTimeSelection(8, 24, [track]);
    store.toggleLoopOrSetToTimeBox();   // snaps the loop to the box + enables it
    store.clearTimeSelection();
    store.setExportSettings({ range: 'loop' });
    expect(exportController.hasLoop).toBe(true);
    expect(exportController.range).toEqual({ startBeat: 8, endBeat: 24 });
    store.loopEnabled = false;
    expect(exportController.hasLoop).toBe(false);
    expect(exportController.range).toEqual(whole()); // falls back, never exports 0 frames
  });

  it("'selection' exports the live time box", () => {
    store.setTimeSelection(4, 12, [track]);
    store.setExportSettings({ range: 'selection' });
    expect(exportController.hasSelection).toBe(true);
    expect(exportController.range).toEqual({ startBeat: 4, endBeat: 12 });
    // Frame count tracks the selection, not the whole composition.
    expect(exportController.estimateFrames).toBeGreaterThan(0);
    expect(exportController.estimateFrames)
      .toBeLessThan(planFramesFor(whole().endBeat - whole().startBeat));
  });

  it("'selection' falls back to the whole arrangement once the box collapses", () => {
    store.setTimeSelection(4, 12, [track]);
    store.setExportSettings({ range: 'selection' });
    store.clearTimeSelection();
    expect(exportController.hasSelection).toBe(false);
    expect(exportController.range).toEqual(whole());
  });
});

/** Frames a `beats`-long span would plan at the current export fps. */
function planFramesFor(beats: number): number {
  const spb = 60 / Math.max(1, store.composition.meta.baseBPM);
  return Math.round(beats * spb * store.exportFps) + 1;
}
