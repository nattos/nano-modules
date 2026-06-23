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
