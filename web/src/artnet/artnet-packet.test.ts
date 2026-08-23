import { describe, expect, it } from 'vitest';
import {
  clampVelSquash, decodeArtDmx, encodeArtDmx, patternFrame, portAddress,
  universeKey, velSquash, VEL_SQUASH_N,
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

  it('beat pattern puts ch 1 on the beat and arps ch 2-4 between', () => {
    const lit = (t: number) => [...patternFrame('beatsync', t, 4)].findIndex(v => v > 0);
    // Every quarter (4 x 125 ms) is ch 1; the three 16ths between it are not.
    expect(lit(5)).toBe(0);
    expect(lit(505)).toBe(0);
    expect(lit(1005)).toBe(0);
    for (const t of [130, 255, 380]) expect(lit(t)).toBeGreaterThan(0);
    // ... and those three are distinct channels within one beat.
    expect(new Set([lit(130), lit(255), lit(380)]).size).toBe(3);
  });

  it('beat gates are one 16th long — a hit, not a hold', () => {
    // 125 ms grid at 0.9 duty: lit for ~112 ms, dark for the rest of the step.
    expect(patternFrame('beatsync', 100, 4)[0]).toBeGreaterThan(0);
    expect(patternFrame('beatsync', 120, 4).every(v => v === 0)).toBe(true);
  });

  it('beat pattern stays on the four roles beatsync actually sends', () => {
    // A 16-channel card must not light channels the real source never uses.
    for (let t = 0; t < 4000; t += 7) {
      for (const [i, v] of patternFrame('beatsync', t, 16).entries()) {
        if (i >= 4) expect(v).toBe(0);
      }
    }
  });

  it('beat pattern varies velocity rather than pinning full', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 8000; t += 5) {
      for (const v of patternFrame('beatsync', t, 4)) if (v > 0) seen.add(v);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(Math.max(...seen)).toBeLessThanOrEqual(255);
  });

  it('never exceeds the requested channel count', () => {
    for (const p of ['chase', 'pulse', 'ramp', 'flat', 'beatsync'] as const) {
      expect(patternFrame(p, 777, 3).length).toBe(3);
    }
  });
});

describe('velSquash', () => {
  it('is inert at position 0 — bit-for-bit the generator before the control', () => {
    for (const v of [0, 0.13, 0.45, 0.8, 1]) expect(velSquash(v, 0)).toBe(v);
    for (let t = 0; t < 4000; t += 11) {
      expect([...patternFrame('beatsync', t, 4, 0)])
        .toEqual([...patternFrame('beatsync', t, 4)]);
    }
  });

  it('pins both ends at every position', () => {
    for (let n = 0; n < VEL_SQUASH_N; n++) {
      expect(velSquash(0, n)).toBe(0);
      expect(velSquash(1, n)).toBe(1);
    }
  });

  it('only ever squashes UPWARD, monotonically along the ladder', () => {
    const v = 0.3;
    let prev = velSquash(v, 0);
    for (let n = 1; n < VEL_SQUASH_N; n++) {
      const cur = velSquash(v, n);
      expect(cur).toBeGreaterThan(prev);
      expect(cur).toBeLessThanOrEqual(1);
      prev = cur;
    }
  });

  it('is one gamma family halved per rung, ending in its limit', () => {
    expect(velSquash(0.25, 1)).toBeCloseTo(Math.pow(0.25, 1 / 2), 6);
    expect(velSquash(0.25, 2)).toBeCloseTo(Math.pow(0.25, 1 / 4), 6);
    expect(velSquash(0.25, 3)).toBeCloseTo(Math.pow(0.25, 1 / 8), 6);
    // The last rung is the family's LIMIT, not another exponent: anything above
    // zero reads full.
    expect(velSquash(0.01, VEL_SQUASH_N - 1)).toBe(1);
  });

  it('clamps a position from outside the ladder onto a real rung', () => {
    expect(clampVelSquash(-3)).toBe(0);
    expect(clampVelSquash(99)).toBe(VEL_SQUASH_N - 1);
    expect(clampVelSquash(NaN)).toBe(0);
    expect(velSquash(0.4, 99)).toBe(1);
  });
});

describe('patternFrame squash', () => {
  it('lifts the beat pattern\'s quiet hits without dimming the loud ones', () => {
    const levels = (squash: number) => {
      const seen = new Set<number>();
      for (let t = 0; t < 8000; t += 5) {
        for (const v of patternFrame('beatsync', t, 4, squash)) if (v > 0) seen.add(v);
      }
      return [...seen].sort((a, b) => a - b);
    };
    const raw = levels(0);
    const lifted = levels(2);
    expect(Math.min(...lifted)).toBeGreaterThan(Math.min(...raw));
    expect(Math.max(...lifted)).toBe(255);          // the full hits stay full
    expect(lifted.every(v => v <= 255)).toBe(true);
  });

  it('is inert on the gate-only patterns — both ends are pinned', () => {
    for (const p of ['flat', 'pulse', 'chase'] as const) {
      for (let t = 0; t < 2200; t += 13) {
        expect([...patternFrame(p, t, 4, 3)]).toEqual([...patternFrame(p, t, 4, 0)]);
      }
    }
  });

  it('the last rung is every gate at full', () => {
    for (let t = 0; t < 4000; t += 5) {
      for (const v of patternFrame('beatsync', t, 4, VEL_SQUASH_N - 1)) {
        expect(v === 0 || v === 255).toBe(true);
      }
    }
  });
});
