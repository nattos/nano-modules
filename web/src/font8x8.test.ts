import { describe, it, expect } from 'vitest';
import { kFont8x8, buildFontAtlas, FONT_ATLAS_W, FONT_ATLAS_H, FONT_GLYPH_W, FONT_GLYPH_H } from './font8x8';

describe('font8x8', () => {
  it('has 96 glyphs', () => {
    expect(kFont8x8.length).toBe(96);
  });

  it('each glyph has 8 rows', () => {
    for (const glyph of kFont8x8) {
      expect(glyph.length).toBe(8);
    }
  });

  it('space glyph is all zeros', () => {
    // ASCII 32 = space = index 0
    expect(kFont8x8[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('A glyph has non-zero data', () => {
    // ASCII 65 = 'A' = index 33
    const a = kFont8x8[65 - 32];
    const sum = a.reduce((s, v) => s + v, 0);
    expect(sum).toBeGreaterThan(0);
  });
});

describe('buildFontAtlas', () => {
  it('returns correct size', () => {
    const atlas = buildFontAtlas();
    expect(atlas.length).toBe(FONT_ATLAS_W * FONT_ATLAS_H);
    expect(atlas.length).toBe(128 * 48);
  });

  it('space region is all zeros', () => {
    const atlas = buildFontAtlas();
    // Space is glyph 0, at column 0, row 0 → pixels [0,0] to [7,7]
    for (let y = 0; y < FONT_GLYPH_H; y++) {
      for (let x = 0; x < FONT_GLYPH_W; x++) {
        expect(atlas[y * FONT_ATLAS_W + x]).toBe(0);
      }
    }
  });

  it('A glyph region has non-zero pixels', () => {
    const atlas = buildFontAtlas();
    // 'A' is glyph 33, col=33%16=1, row=33/16=2
    const col = 1;
    const row = 2;
    let sum = 0;
    for (let y = 0; y < FONT_GLYPH_H; y++) {
      for (let x = 0; x < FONT_GLYPH_W; x++) {
        sum += atlas[(row * FONT_GLYPH_H + y) * FONT_ATLAS_W + col * FONT_GLYPH_W + x];
      }
    }
    expect(sum).toBeGreaterThan(0);
  });

  it('only contains 0 or 255 values', () => {
    const atlas = buildFontAtlas();
    for (const v of atlas) {
      expect(v === 0 || v === 255).toBe(true);
    }
  });
});
