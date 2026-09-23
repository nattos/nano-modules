import { describe, it, expect } from 'vitest';
import { parseNbps } from './preview-surfaces';
import { groupPreviewRequests } from './resolume-mode';

/** Build an NBPS message the way BarrelRuntime::publishSurfaceFrame does. */
function nbps(opts: { slot: number; key: string; traceId: string; w: number; h: number;
                      seq: number; token: bigint }): ArrayBuffer {
  const key = new TextEncoder().encode(opts.key);
  const id = new TextEncoder().encode(opts.traceId);
  const buf = new ArrayBuffer(26 + key.length + id.length);
  const dv = new DataView(buf);
  [0x4E, 0x42, 0x50, 0x53].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint8(4, 1);
  dv.setUint8(5, opts.slot);
  dv.setUint16(6, key.length, true);
  dv.setUint16(8, id.length, true);
  dv.setUint16(10, opts.w, true);
  dv.setUint16(12, opts.h, true);
  dv.setUint32(14, opts.seq, true);
  dv.setBigUint64(18, opts.token, true);
  new Uint8Array(buf, 26).set(key);
  new Uint8Array(buf, 26 + key.length).set(id);
  return buf;
}

describe('NBPS (shared-surface preview announcements)', () => {
  it('parses what the barrel sends', () => {
    const m = parseNbps(nbps({ slot: 2, key: 'K-1', traceId: 'ce:0/3/output', w: 3840, h: 2160,
                                seq: 77, token: 4242n }));
    expect(m).toEqual({ slot: 2, key: 'K-1', traceId: 'ce:0/3/output', width: 3840, height: 2160,
                        seq: 77, token: 4242 });
  });

  it('refuses NBPV, a future version, and a truncated message', () => {
    const good = nbps({ slot: 0, key: 'k', traceId: 't', w: 1, h: 1, seq: 1, token: 1n });
    const nbpv = good.slice(0);
    new DataView(nbpv).setUint8(3, 0x56);   // 'V'
    expect(parseNbps(nbpv)).toBeNull();
    const v2 = good.slice(0);
    new DataView(v2).setUint8(4, 2);
    expect(parseNbps(v2)).toBeNull();
    expect(parseNbps(good.slice(0, good.byteLength - 1))).toBeNull();
  });
});

describe('preview requests ask for the transport', () => {
  const tp = [{ id: 'mon', target: { type: 'sketch_output', sketchId: 's' },
                size: { width: 640, height: 360 } }] as any;
  it('marks every request when surfaces are on', () => {
    const g = groupPreviewRequests(tp, 'KEY', {}, 'surface');
    expect(g.get('KEY')?.mon.transport).toBe('surface');
  });
  it('leaves requests unmarked (NBPV) otherwise', () => {
    const g = groupPreviewRequests(tp, 'KEY');
    expect('transport' in (g.get('KEY')?.mon ?? {})).toBe(false);
  });
});
