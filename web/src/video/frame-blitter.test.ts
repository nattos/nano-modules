import { describe, it, expect } from 'vitest';
import { __placeGeomForTest as placeGeom, type BlitTransform } from './frame-blitter';

const ID: BlitTransform = { anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false };
const xf = (o: Partial<BlitTransform>): BlitTransform => ({ ...ID, ...o });

// rect is the destination in normalised canvas coords [x, y, w, h]; w/h may exceed
// 1 (overflow → clipped) and x/y go negative (panned crop window).
describe('placeGeom scale modes (canvas 1000×500)', () => {
  it('stretch fills the canvas', () => {
    expect(placeGeom(640, 480, 1000, 500, 'stretch', ID).rect).toEqual([0, 0, 1, 1]);
  });

  it('fit (contain) letterboxes a 1:1 source, centred', () => {
    expect(placeGeom(1000, 1000, 1000, 500, 'fit', ID).rect).toEqual([0.25, 0, 0.5, 1]);
  });

  it('cover fills + overflows a 1:1 source (clipped by the canvas)', () => {
    expect(placeGeom(1000, 1000, 1000, 500, 'cover', ID).rect).toEqual([0, -0.5, 1, 2]);
  });

  it('none pads a smaller source 1:1, centred', () => {
    expect(placeGeom(100, 100, 1000, 500, 'none', ID).rect).toEqual([0.45, 0.4, 0.1, 0.2]);
  });

  it('none overflows a larger source 1:1, centred', () => {
    expect(placeGeom(2000, 2000, 1000, 500, 'none', ID).rect).toEqual([-0.5, -1.5, 2, 4]);
  });
});

describe('placeGeom none with a downscaled preview (comp 1920×1080 @ 1280×720)', () => {
  it('a source matching the composition fills the preview', () => {
    expect(placeGeom(1920, 1080, 1280, 720, 'none', ID, 1920, 1080).rect).toEqual([0, 0, 1, 1]);
  });
  it('a source larger than the composition overflows 1:1 at comp res', () => {
    expect(placeGeom(3840, 2160, 1280, 720, 'none', ID, 1920, 1080).rect).toEqual([-0.5, -0.5, 2, 2]);
  });
  it('a source smaller than the composition is padded 1:1 at comp res', () => {
    expect(placeGeom(960, 540, 1280, 720, 'none', ID, 1920, 1080).rect).toEqual([0.25, 0.25, 0.5, 0.5]);
  });
});

describe('placeGeom placement transform', () => {
  // fit 1:1 into 1000×500 → a 500×500 frame; anchor X slides it L↔R.
  it('anchorX 0 aligns left edges, 1 aligns right edges, 0.5 centres', () => {
    expect(placeGeom(1000, 1000, 1000, 500, 'fit', xf({ anchorX: 0 })).rect[0]).toBeCloseTo(0);
    expect(placeGeom(1000, 1000, 1000, 500, 'fit', xf({ anchorX: 1 })).rect[0]).toBeCloseTo(0.5);
    expect(placeGeom(1000, 1000, 1000, 500, 'fit', xf({ anchorX: 0.5 })).rect[0]).toBeCloseTo(0.25);
  });

  it('scale zooms about the centre (2× a 500-wide fit frame fills the width, overflows height)', () => {
    expect(placeGeom(1000, 1000, 1000, 500, 'fit', xf({ scale: 2 })).rect).toEqual([0, -0.5, 1, 2]);
  });

  it('rotation 90 fits by the turned bounding box and reports rot=1', () => {
    // 1000×500 (2:1) turned 90° fits into 1000×500 as a 250×500 upright rect.
    const g = placeGeom(1000, 500, 1000, 500, 'fit', xf({ rotation: 90 }));
    expect(g.rect).toEqual([0.375, 0, 0.25, 1]);
    expect(g.rot).toBe(1);
  });

  it('rotation normalises to 0..3 and carries flips through', () => {
    expect(placeGeom(640, 480, 1000, 500, 'fit', xf({ rotation: 270 })).rot).toBe(3);
    const f = placeGeom(640, 480, 1000, 500, 'fit', xf({ flipH: true, flipV: true }));
    expect([f.flipH, f.flipV]).toEqual([true, true]);
  });
});
