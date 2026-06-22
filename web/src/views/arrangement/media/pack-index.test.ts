import { describe, it, expect } from 'vitest';
import { encodeIndex, decodeIndex, type ChunkIndex } from './pack-index';

describe('pack index', () => {
  it('round-trips frame → {offset,len} entries', () => {
    const idx: ChunkIndex = new Map([
      [0, { offset: 0, len: 1200 }],
      [4, { offset: 1200, len: 980 }],
      [255, { offset: 2180, len: 4096 }],
    ]);
    const out = decodeIndex(encodeIndex(idx));
    expect(out.size).toBe(3);
    expect(out.get(0)).toEqual({ offset: 0, len: 1200 });
    expect(out.get(4)).toEqual({ offset: 1200, len: 980 });
    expect(out.get(255)).toEqual({ offset: 2180, len: 4096 });
  });

  it('round-trips an empty index', () => {
    expect(decodeIndex(encodeIndex(new Map())).size).toBe(0);
  });

  it('treats a foreign/corrupt blob as an empty index (re-decode rather than crash)', () => {
    expect(decodeIndex(new ArrayBuffer(3)).size).toBe(0); // too short
    const bad = new ArrayBuffer(8);
    new DataView(bad).setUint32(0, 0xdeadbeef); // wrong magic
    expect(decodeIndex(bad).size).toBe(0);
  });
});
