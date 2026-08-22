import { describe, expect, it } from 'vitest';
import {
  decodeArtDmx, encodeArtDmx, patternFrame, portAddress, universeKey,
} from './artnet-packet';

/** Build a raw frame the way a sender does, for decode tests. */
function raw(net: number, subnet: number, universe: number,
             channels: number[], seq = 1, claimLen?: number): Uint8Array {
  const p = new Uint8Array(18 + channels.length);
  for (let i = 0; i < 7; i++) p[i] = 'Art-Net'.charCodeAt(i);
  p[8] = 0x00; p[9] = 0x50;
  p[11] = 14;
  p[12] = seq;
  p[14] = ((subnet & 0x0f) << 4) | (universe & 0x0f);
  p[15] = net & 0x7f;
  const len = claimLen ?? channels.length;
  p[16] = (len >> 8) & 0xff;
  p[17] = len & 0xff;
  p.set(channels, 18);
  return p;
}

describe('decodeArtDmx', () => {
  it('splits Net | Subnet | Universe rather than one packed number', () => {
    const f = decodeArtDmx(raw(3, 1, 5, [255, 0]))!;
    expect(f).not.toBeNull();
    expect(f.net).toBe(3);
    expect(f.subnet).toBe(1);
    expect(f.universe).toBe(5);
    // The trap this guards: 0x15 in the low byte is subnet 1 / universe 5, not
    // "universe 21".
    expect(portAddress(f.net, f.subnet, f.universe)).toBe((3 << 8) | 0x15);
  });

  it('reads the BIG-endian length even though the opcode is little-endian', () => {
    const ch = new Array(300).fill(7);
    const f = decodeArtDmx(raw(0, 0, 1, ch))!;
    expect(f.channels.length).toBe(300);
  });

  it('trusts what arrived over what the header claims', () => {
    // Header says 512 channels, 4 bytes follow. Trusting the header would read
    // past the buffer.
    const f = decodeArtDmx(raw(0, 0, 1, [1, 2, 3, 4], 1, 512))!;
    expect(f.channels.length).toBe(4);
    expect([...f.channels]).toEqual([1, 2, 3, 4]);
  });

  it('ignores ArtSync, ArtPoll, non-Art-Net and runts', () => {
    const sync = raw(0, 0, 1, [1, 2]); sync[8] = 0x00; sync[9] = 0x52;
    expect(decodeArtDmx(sync)).toBeNull();

    const poll = raw(0, 0, 1, [1, 2]); poll[8] = 0x00; poll[9] = 0x20;
    expect(decodeArtDmx(poll)).toBeNull();

    const notArtnet = raw(0, 0, 1, [1, 2]); notArtnet[0] = 'X'.charCodeAt(0);
    expect(decodeArtDmx(notArtnet)).toBeNull();

    expect(decodeArtDmx(new Uint8Array([65, 114, 116]))).toBeNull();
  });
});

describe('encodeArtDmx', () => {
  it('round-trips through decode', () => {
    const p = encodeArtDmx(2, 1, 4, new Uint8Array([10, 20, 30, 40]), 9);
    const f = decodeArtDmx(p)!;
    expect(f.net).toBe(2);
    expect(f.subnet).toBe(1);
    expect(f.universe).toBe(4);
    expect(f.seq).toBe(9);
    expect([...f.channels]).toEqual([10, 20, 30, 40]);
  });

  it('rounds an odd channel count up to even', () => {
    // The spec requires it; a lenient receiver accepts odd and a strict one
    // silently drops, which reads as "Art-Net doesn't work".
    const p = encodeArtDmx(0, 0, 1, new Uint8Array([1, 2, 3]), 1);
    expect(p.length).toBe(18 + 4);
    expect(decodeArtDmx(p)!.channels.length).toBe(4);
  });

  it('never emits fewer than 2 channels', () => {
    const p = encodeArtDmx(0, 0, 1, new Uint8Array([255]), 1);
    expect(p.length).toBe(18 + 2);
  });
});

describe('universeKey', () => {
  it('is stable and distinguishes subnet from universe', () => {
    expect(universeKey(0, 0, 1)).toBe('0.0.1');
    expect(universeKey(0, 1, 1)).not.toBe(universeKey(0, 0, 1));
  });
});

describe('patternFrame', () => {
  it('flat holds every channel at full — the downstream wire check', () => {
    expect([...patternFrame('flat', 0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...patternFrame('flat', 1234, 4)]).toEqual([255, 255, 255, 255]);
  });

  it('chase lights one channel at a time, in order', () => {
    const lit = (t: number) => [...patternFrame('chase', t, 4)].findIndex(v => v > 0);
    expect(lit(10)).toBe(0);
    expect(lit(510)).toBe(1);
    expect(lit(1010)).toBe(2);
    expect(lit(1510)).toBe(3);
    expect(lit(2010)).toBe(0);       // wraps
  });

  it('gates fall back to 0 within the beat — the duty pause', () => {
    // A gate that never closed would merge consecutive hits into one hold.
    expect(patternFrame('pulse', 0, 2)[0]).toBe(255);
    expect(patternFrame('pulse', 200, 2)[0]).toBe(0);
  });

  it('beatsync mimic varies velocity rather than pinning full', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 8000; t += 500) {
      const v = patternFrame('beatsync', t, 4)[0];
      if (v > 0) seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeLessThanOrEqual(255);
  });

  it('never exceeds the requested channel count', () => {
    for (const p of ['chase', 'pulse', 'ramp', 'flat', 'beatsync'] as const) {
      expect(patternFrame(p, 777, 3).length).toBe(3);
    }
  });
});
