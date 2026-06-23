import { describe, it, expect } from 'vitest';
import { __blitGeomForTest as blitGeom } from './frame-blitter';

// Target canvas is 1000×500 (2:1).
describe('blitGeom scale modes', () => {
  it('stretch fills the canvas, full UV', () => {
    const g = blitGeom(640, 480, 1000, 500, 'stretch');
    expect([g.vx, g.vy, g.vw, g.vh]).toEqual([0, 0, 1000, 500]);
    expect([...g.uScale]).toEqual([1, 1]);
  });

  it('fit (contain) letterboxes a 1:1 source, full UV', () => {
    const g = blitGeom(1000, 1000, 1000, 500, 'fit');
    expect([g.vw, g.vh]).toEqual([500, 500]); // scaled to height
    expect([g.vx, g.vy]).toEqual([250, 0]);   // centred horizontally
    expect([...g.uScale]).toEqual([1, 1]);
  });

  it('cover fills + crops a 1:1 source via UV', () => {
    const g = blitGeom(1000, 1000, 1000, 500, 'cover');
    expect([g.vx, g.vy, g.vw, g.vh]).toEqual([0, 0, 1000, 500]); // full viewport
    expect(g.uScale[0]).toBeCloseTo(1);
    expect(g.uScale[1]).toBeCloseTo(0.5);     // crop vertically
    expect(g.uOff[1]).toBeCloseTo(0.25);      // centred crop
  });

  it('none pads a smaller source 1:1, centred', () => {
    const g = blitGeom(100, 100, 1000, 500, 'none');
    expect([g.vx, g.vy, g.vw, g.vh]).toEqual([450, 200, 100, 100]);
    expect([...g.uScale]).toEqual([1, 1]);
  });

  it('none crops a larger source 1:1, centred', () => {
    const g = blitGeom(2000, 2000, 1000, 500, 'none');
    expect([g.vx, g.vy, g.vw, g.vh]).toEqual([0, 0, 1000, 500]);
    expect(g.uScale[0]).toBeCloseTo(0.5);
    expect(g.uScale[1]).toBeCloseTo(0.25);
    expect(g.uOff[0]).toBeCloseTo(0.25);
    expect(g.uOff[1]).toBeCloseTo(0.375);
  });
});

// The bug: 'none' must be 1:1 vs the COMPOSITION, not the (downscaled) preview.
// Composition 1920×1080 previewed at 1280×720.
describe('blitGeom none with a downscaled preview', () => {
  it('a source matching the composition fills the preview (no zoom/crop)', () => {
    const g = blitGeom(1920, 1080, 1280, 720, 'none', 1920, 1080);
    expect([g.vx, g.vy, g.vw, g.vh]).toEqual([0, 0, 1280, 720]);
    expect([...g.uScale]).toEqual([1, 1]); // whole source, no crop
  });

  it('a source larger than the composition is cropped 1:1 at comp res', () => {
    const g = blitGeom(3840, 2160, 1280, 720, 'none', 1920, 1080);
    expect([g.vx, g.vy, g.vw, g.vh]).toEqual([0, 0, 1280, 720]); // fills preview
    expect(g.uScale[0]).toBeCloseTo(0.5); // centre 1920 of 3840 sampled
    expect(g.uScale[1]).toBeCloseTo(0.5);
  });

  it('a source smaller than the composition is padded (1:1 at comp res)', () => {
    const g = blitGeom(960, 540, 1280, 720, 'none', 1920, 1080);
    expect([g.vw, g.vh]).toEqual([640, 360]); // half the comp → half the preview
    expect([g.vx, g.vy]).toEqual([320, 180]); // centred
    expect([...g.uScale]).toEqual([1, 1]);
  });
});
