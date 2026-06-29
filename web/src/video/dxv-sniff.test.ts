import { describe, it, expect } from 'vitest';
import { hasDxTag, classifySource } from './dxv-sniff';

/** Build an ISO-BMFF/QuickTime atom: [size:u32 BE][type:4][payload]. */
function atom(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const txt = (s: string) => new TextEncoder().encode(s);

describe('hasDxTag', () => {
  it('matches DXD* / DXT* fourccs', () => {
    expect(hasDxTag(txt('....DXD3....'))).toBe(true);
    expect(hasDxTag(txt('....DXT5....'))).toBe(true);
  });
  it('rejects non-DX bytes (avc1, hvc1)', () => {
    expect(hasDxTag(txt('....avc1....hvc1....'))).toBe(false);
  });
});

describe('classifySource', () => {
  it('classifies images by MIME without reading bytes', async () => {
    expect(await classifySource(new Blob([new Uint8Array(0)], { type: 'image/png' }))).toBe('image');
  });

  it('classifies non-quicktime video by MIME alone (h264 mp4 → video)', async () => {
    // No moov needed — mp4 short-circuits on MIME, so it never touches the DXV decoder.
    const blob = new Blob([new Uint8Array(16)], { type: 'video/mp4' });
    expect(await classifySource(blob)).toBe('video');
  });

  it('finds the DXV tag inside a quicktime moov atom', async () => {
    const moov = atom('moov', atom('stsd', txt('xxxxxxxxDXD3yyyy')));
    const file = concat(atom('ftyp', txt('qt  ')), moov, atom('mdat', new Uint8Array(64)));
    const blob = new Blob([file], { type: 'video/quicktime' });
    expect(await classifySource(blob)).toBe('dxv');
  });

  it('routes a non-DXV quicktime (e.g. ProRes/h264 .mov) to video', async () => {
    const moov = atom('moov', atom('stsd', txt('xxxxxxxxavc1yyyy')));
    const file = concat(atom('ftyp', txt('qt  ')), moov, atom('mdat', new Uint8Array(64)));
    const blob = new Blob([file], { type: 'video/quicktime' });
    expect(await classifySource(blob)).toBe('video');
  });
});
