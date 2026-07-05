import { describe, it, expect } from 'vitest';
import {
  decideMode, bannerOffer,
  instanceThumbTraceId, instanceKeyFromThumbTraceId, groupPreviewRequests,
  laneUrl, NbpcReassembler, previewTransportPorts,
} from './resolume-mode';
import type { TracePoint } from './engine-types';

describe('decideMode', () => {
  it('bare URL defaults to barrel at the fixed shared-server port', () => {
    expect(decideMode('')).toEqual({ mode: 'barrel', barrelUrl: 'ws://localhost:8081' });
  });

  it('?playground enters the playground', () => {
    expect(decideMode('?playground').mode).toBe('playground');
  });

  it('?barrel stays as an explicit barrel form', () => {
    expect(decideMode('?barrel')).toEqual({ mode: 'barrel', barrelUrl: 'ws://localhost:8081' });
  });

  it('?barrel=ws://host:port overrides the server URL', () => {
    expect(decideMode('?barrel=ws://vjbox:9000').barrelUrl).toBe('ws://vjbox:9000');
  });

  it('?playground wins over ?barrel', () => {
    expect(decideMode('?playground&barrel=ws://vjbox:9000').mode).toBe('playground');
  });

  it('unrelated params leave the default barrel mode intact', () => {
    expect(decideMode('?foo=1&bar').mode).toBe('barrel');
  });
});

describe('bannerOffer', () => {
  const base = {
    barrelMode: true,
    connection: 'closed' as const,
    graceElapsed: true,
    barrelDetected: false,
    dismissed: false,
  };

  it('barrel mode offers the playground only after the grace window', () => {
    expect(bannerOffer(base)).toBe('offer-playground');
    expect(bannerOffer({ ...base, graceElapsed: false })).toBeNull();
  });

  it('an open connection never offers, even with grace elapsed', () => {
    expect(bannerOffer({ ...base, connection: 'open' })).toBeNull();
  });

  it('still-connecting counts as unreachable once grace elapses', () => {
    expect(bannerOffer({ ...base, connection: 'connecting' })).toBe('offer-playground');
  });

  it('playground offers live only once a server is detected', () => {
    const pg = { ...base, barrelMode: false, connection: 'connecting' as const, graceElapsed: false };
    expect(bannerOffer(pg)).toBeNull();
    expect(bannerOffer({ ...pg, barrelDetected: true })).toBe('offer-live');
  });

  it('dismissal silences both offers', () => {
    expect(bannerOffer({ ...base, dismissed: true })).toBeNull();
    expect(bannerOffer({
      ...base, barrelMode: false, barrelDetected: true, dismissed: true,
    })).toBeNull();
  });
});

describe('instance thumbnail trace ids', () => {
  it('round-trips an instance key', () => {
    const key = 'D0C7A9E2-5F31-4B2A-9E1C-77AA00BB11CC';
    expect(instanceKeyFromThumbTraceId(instanceThumbTraceId(key))).toBe(key);
  });

  it('returns null for non-thumbnail ids', () => {
    expect(instanceKeyFromThumbTraceId('edit_preview')).toBeNull();
    expect(instanceKeyFromThumbTraceId('')).toBeNull();
  });
});

describe('groupPreviewRequests', () => {
  const KEY_A = 'AAAA-1111';
  const KEY_B = 'BBBB-2222';
  const thumb = (key: string): TracePoint => ({
    id: instanceThumbTraceId(key),
    target: { type: 'sketch_output', sketchId: key },
    size: { width: 192, height: 108 },
  });
  const editPreview: TracePoint = {
    id: 'edit_preview',
    target: { type: 'sketch_output', sketchId: 'barrel' },
    size: { width: 640, height: 360 },
  };

  it('routes thumbnails to their own instance, the rest to the wired one', () => {
    const groups = groupPreviewRequests([editPreview, thumb(KEY_A), thumb(KEY_B)], KEY_A);
    expect([...groups.keys()].sort()).toEqual([KEY_A, KEY_B]);
    expect(Object.keys(groups.get(KEY_A)!).sort()).toEqual(
      ['edit_preview', instanceThumbTraceId(KEY_A)].sort());
    expect(Object.keys(groups.get(KEY_B)!)).toEqual([instanceThumbTraceId(KEY_B)]);
  });

  it('drops non-thumbnail points when no instance is wired', () => {
    const groups = groupPreviewRequests([editPreview, thumb(KEY_B)], null);
    expect([...groups.keys()]).toEqual([KEY_B]);
  });

  it('serializes chain_entry targets and skips plugin_output', () => {
    const points: TracePoint[] = [
      {
        id: 'ce_mon',
        target: { type: 'chain_entry', sketchId: 'barrel', colIdx: 0, chainIdx: 2, side: 'output' },
        size: { width: 128, height: 72 },
      },
      { id: 'po_mon', target: { type: 'plugin_output', pluginKey: 'x' } as any },
    ];
    const groups = groupPreviewRequests(points, KEY_A);
    const reqs = groups.get(KEY_A)!;
    expect(Object.keys(reqs)).toEqual(['ce_mon']);
    expect(reqs['ce_mon']).toEqual({
      target: { type: 'chain_entry', sketchId: 'barrel', colIdx: 0, chainIdx: 2, side: 'output' },
      width: 128,
      height: 72,
    });
  });

  it('routes sidechannel targets to the channel writer, drops unwritten ones', () => {
    const points: TracePoint[] = [
      { id: 'sc_thumb:2', target: { type: 'sidechannel', channel: '2' } },
      { id: 'sc_thumb:9', target: { type: 'sidechannel', channel: '9' } },
    ];
    const groups = groupPreviewRequests(points, KEY_A, { '2': KEY_B });
    expect([...groups.keys()]).toEqual([KEY_B]);
    expect(groups.get(KEY_B)!['sc_thumb:2'].target).toEqual(
      { type: 'sidechannel', channel: '2' });
  });

  it('defaults missing sizes to 0 (native falls back to source size)', () => {
    const groups = groupPreviewRequests(
      [{ id: 'edit_preview', target: { type: 'sketch_output', sketchId: 'barrel' } }], KEY_A);
    expect(groups.get(KEY_A)!['edit_preview']).toMatchObject({ width: 0, height: 0 });
  });
});

describe('laneUrl + previewTransportPorts', () => {
  it('swaps the port, keeping scheme and host', () => {
    expect(laneUrl('ws://localhost:8081', 8082)).toBe('ws://localhost:8082/');
  });

  it('handles ?barrel= host overrides and wss', () => {
    expect(laneUrl('wss://vjbox:9000/', 9003)).toBe('wss://vjbox:9003/');
  });

  it('extracts valid ports from the transport doc, defensively', () => {
    expect(previewTransportPorts({ version: 1, ports: [8082, 8083] })).toEqual([8082, 8083]);
    expect(previewTransportPorts({ version: 1, ports: [] })).toEqual([]);
    expect(previewTransportPorts({ version: 1, ports: [0, -1, 70000, 'x', 8082] })).toEqual([8082]);
    expect(previewTransportPorts(null)).toEqual([]);
    expect(previewTransportPorts('nope')).toEqual([]);
    expect(previewTransportPorts({ version: 1 })).toEqual([]);
  });
});

describe('NbpcReassembler', () => {
  /** Build one NBPC chunk envelope around a payload slice. */
  const chunk = (seq: number, idx: number, cnt: number, payload: Uint8Array): ArrayBuffer => {
    const out = new Uint8Array(12 + payload.length);
    out[0] = 0x4e; out[1] = 0x42; out[2] = 0x50; out[3] = 0x43; // NBPC
    new DataView(out.buffer).setUint32(4, seq, true);
    new DataView(out.buffer).setUint16(8, idx, true);
    new DataView(out.buffer).setUint16(10, cnt, true);
    out.set(payload, 12);
    return out.buffer;
  };
  const bytes = (...vals: number[]) => new Uint8Array(vals);

  it('passes non-NBPC buffers through unchanged', () => {
    const r = new NbpcReassembler();
    const nbpv = new Uint8Array(20).fill(7);
    nbpv.set([0x4e, 0x42, 0x50, 0x56]); // NBPV
    expect(r.ingest(nbpv.buffer)).toBe(nbpv.buffer);
  });

  it('reassembles in-order chunks', () => {
    const r = new NbpcReassembler();
    expect(r.ingest(chunk(1, 0, 2, bytes(1, 2, 3)))).toBeNull();
    const full = r.ingest(chunk(1, 1, 2, bytes(4, 5)));
    expect(full).not.toBeNull();
    expect([...new Uint8Array(full!)]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reassembles out-of-order chunks (lanes deliver unordered)', () => {
    const r = new NbpcReassembler();
    expect(r.ingest(chunk(9, 2, 3, bytes(30)))).toBeNull();
    expect(r.ingest(chunk(9, 0, 3, bytes(10)))).toBeNull();
    const full = r.ingest(chunk(9, 1, 3, bytes(20)));
    expect([...new Uint8Array(full!)]).toEqual([10, 20, 30]);
  });

  it('handles interleaved sequences independently', () => {
    const r = new NbpcReassembler();
    expect(r.ingest(chunk(1, 0, 2, bytes(1)))).toBeNull();
    expect(r.ingest(chunk(2, 0, 2, bytes(9)))).toBeNull();
    expect([...new Uint8Array(r.ingest(chunk(2, 1, 2, bytes(8)))!)]).toEqual([9, 8]);
    expect([...new Uint8Array(r.ingest(chunk(1, 1, 2, bytes(2)))!)]).toEqual([1, 2]);
  });

  it('ignores duplicate chunks', () => {
    const r = new NbpcReassembler();
    expect(r.ingest(chunk(3, 0, 2, bytes(1)))).toBeNull();
    expect(r.ingest(chunk(3, 0, 2, bytes(99)))).toBeNull(); // dup — first wins
    expect([...new Uint8Array(r.ingest(chunk(3, 1, 2, bytes(2)))!)]).toEqual([1, 2]);
  });

  it('drops malformed chunks (idx >= cnt, cnt 0)', () => {
    const r = new NbpcReassembler();
    expect(r.ingest(chunk(4, 2, 2, bytes(1)))).toBeNull();
    expect(r.ingest(chunk(4, 0, 0, bytes(1)))).toBeNull();
  });

  it('evicts stale partials beyond the window instead of leaking', () => {
    const r = new NbpcReassembler();
    r.ingest(chunk(100, 0, 2, bytes(1))); // never completed
    for (let s = 0; s < 40; s++) r.ingest(chunk(200 + s, 0, 2, bytes(1)));
    // Completing the evicted seq starts a fresh partial (returns null), not
    // a corrupted frame.
    expect(r.ingest(chunk(100, 1, 2, bytes(2)))).toBeNull();
  });

  it('single-chunk frames complete immediately', () => {
    const r = new NbpcReassembler();
    const full = r.ingest(chunk(5, 0, 1, bytes(42, 43)));
    expect([...new Uint8Array(full!)]).toEqual([42, 43]);
  });
});
