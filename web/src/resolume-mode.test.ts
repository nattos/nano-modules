import { describe, it, expect } from 'vitest';
import {
  decideMode, bannerOffer,
  instanceThumbTraceId, instanceKeyFromThumbTraceId, groupPreviewRequests,
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

  it('defaults missing sizes to 0 (native falls back to source size)', () => {
    const groups = groupPreviewRequests(
      [{ id: 'edit_preview', target: { type: 'sketch_output', sketchId: 'barrel' } }], KEY_A);
    expect(groups.get(KEY_A)!['edit_preview']).toMatchObject({ width: 0, height: 0 });
  });
});
