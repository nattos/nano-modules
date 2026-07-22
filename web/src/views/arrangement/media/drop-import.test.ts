import { describe, it, expect } from 'vitest';
import { isImageFile, probeContainerMetadata } from './drop-import';

describe('isImageFile', () => {
  it('detects images by MIME type', () => {
    expect(isImageFile({ type: 'image/png', name: 'x.png' })).toBe(true);
    expect(isImageFile({ type: 'image/jpeg', name: 'anything' })).toBe(true);
  });

  // The bug: FileSystem-handle drops often report an empty type → a PNG would
  // misroute to the <video> probe and lose its dimensions. Extension saves it.
  it('detects images by extension when the MIME type is empty', () => {
    expect(isImageFile({ type: '', name: 'photo.PNG' })).toBe(true);
    expect(isImageFile({ type: '', name: 'shot.jpeg' })).toBe(true);
    expect(isImageFile({ type: '', name: 'art.webp' })).toBe(true);
    expect(isImageFile({ type: 'application/octet-stream', name: 'a.gif' })).toBe(true);
  });

  it('does NOT treat videos / unknown files as images', () => {
    expect(isImageFile({ type: 'video/mp4', name: 'clip.mp4' })).toBe(false);
    expect(isImageFile({ type: '', name: 'clip.mov' })).toBe(false);
    expect(isImageFile({ type: '', name: 'noext' })).toBe(false);
  });
});

// ── Container probe: reads real durations out of ISO-BMFF/QuickTime files
// WITHOUT decoding (a DXV .mov Chrome can't play still has an ordinary moov),
// including non-faststart files whose moov sits after mdat. Atoms synthesized
// byte-for-byte below.

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const cc = (s: string) => [...s].map((c) => c.charCodeAt(0));
const atom = (type: string, ...bodies: number[][]): number[] => {
  const body = bodies.flat();
  return [...be32(8 + body.length), ...cc(type), ...body];
};
const zeros = (n: number) => new Array<number>(n).fill(0);
const fixed1616 = (n: number) => be32(Math.round(n * 65536));

/** mvhd v0: timescale 100, duration 600 → 6 s movie. */
const mvhd = atom('mvhd', zeros(4), zeros(8), be32(100), be32(600), zeros(80));

/** Video trak: 1920×1080, mdhd 30000/180000 (6 s), stts 150 samples → 25 fps. */
const videoTrak = atom('trak',
  atom('tkhd', zeros(4), zeros(72), fixed1616(1920), fixed1616(1080)),
  atom('mdia',
    atom('mdhd', zeros(4), zeros(8), be32(30000), be32(180000), zeros(4)),
    atom('hdlr', zeros(4), zeros(4), cc('vide'), zeros(12)),
    atom('minf', atom('stbl', atom('stts', zeros(4), be32(1), be32(150), be32(1200)))),
  ),
);

/** Audio trak — must be ignored by the video scan. */
const audioTrak = atom('trak',
  atom('tkhd', zeros(4), zeros(72), fixed1616(0), fixed1616(0)),
  atom('mdia',
    atom('mdhd', zeros(4), zeros(8), be32(48000), be32(288000), zeros(4)),
    atom('hdlr', zeros(4), zeros(4), cc('soun'), zeros(12)),
  ),
);

const file = (bytes: number[], name = 'clip.mov') =>
  new File([new Uint8Array(bytes)], name);

describe('probeContainerMetadata', () => {
  it('reads duration/fps/frames/pixels from a faststart mov', async () => {
    const bytes = [
      ...atom('ftyp', cc('qt  '), be32(0)),
      ...atom('moov', mvhd, audioTrak, videoTrak),
      ...atom('mdat', zeros(32)),
    ];
    const m = (await probeContainerMetadata(file(bytes)))!;
    expect(m.durationSec).toBeCloseTo(6, 9);
    expect(m.fps).toBeCloseTo(25, 9);
    expect(m.frameCount).toBe(150);
    expect(m.width).toBe(1920);
    expect(m.height).toBe(1080);
  });

  it('finds a trailing moov (non-faststart) by walking top-level atoms', async () => {
    const bytes = [
      ...atom('ftyp', cc('isom'), be32(0)),
      ...atom('mdat', zeros(4096)),
      ...atom('moov', mvhd, videoTrak),
    ];
    const m = (await probeContainerMetadata(file(bytes)))!;
    expect(m.durationSec).toBeCloseTo(6, 9);
    expect(m.fps).toBeCloseTo(25, 9);
  });

  it('falls back to the video trak duration when mvhd is unusable', async () => {
    const badMvhd = atom('mvhd', zeros(4), zeros(8), be32(0), be32(0), zeros(80));
    const bytes = [...atom('ftyp', cc('qt  '), be32(0)), ...atom('moov', badMvhd, videoTrak)];
    const m = (await probeContainerMetadata(file(bytes)))!;
    expect(m.durationSec).toBeCloseTo(6, 9);
  });

  it('rejects non-BMFF bytes without throwing', async () => {
    expect(await probeContainerMetadata(file(cc('RIFFxxxxWEBP'), 'x.webp'))).toBe(null);
    expect(await probeContainerMetadata(file(zeros(4), 'tiny.bin'))).toBe(null);
  });

  it('survives a malformed child atom (truncated size) by stopping cleanly', async () => {
    const truncated = [...be32(9999), ...cc('trak')]; // claims 9999 bytes, has 0
    const bytes = [...atom('ftyp', cc('qt  '), be32(0)), ...atom('moov', mvhd, truncated)];
    const m = (await probeContainerMetadata(file(bytes)))!;
    expect(m.durationSec).toBeCloseTo(6, 9); // mvhd parsed before the bad child
  });
});
