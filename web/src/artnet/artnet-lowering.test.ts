import { describe, expect, it } from 'vitest';
import { buildInjectedScalars, collectArtnetRequests } from './artnet-lowering';
import type { Sketch } from '../sketch-types';

function sketch(instances: Array<{ key: string; state?: Record<string, any> }>,
                moduleType = 'control.artnet'): Sketch {
  return {
    chain: instances.map(i => ({
      type: 'module' as const, module_type: moduleType, instance_key: i.key,
    })),
    wires: [],
    instances: Object.fromEntries(instances.map(i =>
      [i.key, { module_type: moduleType, state: i.state ?? {} }])),
  } as unknown as Sketch;
}

const u = (...bytes: number[]) => new Uint8Array(bytes);

describe('collectArtnetRequests', () => {
  it('reads each card\'s own address — two cards resolve independently', () => {
    const reqs = collectArtnetRequests({
      s1: sketch([
        { key: 'a', state: { universe: 1, base_channel: 1, channel_count: 4 } },
        { key: 'b', state: { subnet: 2, universe: 5, base_channel: 9, channel_count: 2 } },
      ]),
    });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ universe: 1, baseChannel: 1, count: 4, subnet: 0 });
    expect(reqs[1]).toMatchObject({ subnet: 2, universe: 5, baseChannel: 9, count: 2 });
  });

  it('defaults to universe 1 — not 0, where Resolume floods its own output', () => {
    const reqs = collectArtnetRequests({ s1: sketch([{ key: 'a' }]) });
    expect(reqs[0]).toMatchObject({ net: 0, subnet: 0, universe: 1, baseChannel: 1, count: 4 });
  });

  it('clamps out-of-range state rather than addressing a bogus universe', () => {
    const reqs = collectArtnetRequests({
      s1: sketch([{ key: 'a', state: { universe: 99, channel_count: 400, base_channel: 0 } }]),
    });
    expect(reqs[0]).toMatchObject({ universe: 15, count: 16, baseChannel: 1 });
  });

  it('ignores other module types', () => {
    expect(collectArtnetRequests({
      s1: sketch([{ key: 'a' }], 'control.barrel_macros'),
    })).toHaveLength(0);
  });
});

describe('buildInjectedScalars', () => {
  it('normalizes the addressed slice to 0..1', () => {
    const json = buildInjectedScalars(
      { s1: sketch([{ key: 'a', state: { universe: 1, base_channel: 1, channel_count: 4 } }]) },
      k => (k === '0.0.1' ? u(255, 128, 0, 64) : undefined));
    expect(JSON.parse(json)).toEqual({
      a: { ch_0: 1, ch_1: 128 / 255, ch_2: 0, ch_3: 64 / 255 },
    });
  });

  it('offsets by base_channel, 1-based as a desk shows it', () => {
    const json = buildInjectedScalars(
      { s1: sketch([{ key: 'a', state: { base_channel: 3, channel_count: 2 } }]) },
      () => u(10, 20, 30, 40));
    expect(JSON.parse(json)).toEqual({ a: { ch_0: 30 / 255, ch_1: 40 / 255 } });
  });

  it('OMITS a card whose universe was never heard — dormant, not blacked out', () => {
    // Emitting zeros here would overwrite the card's authored values with a
    // blackout no sender ever sent.
    const json = buildInjectedScalars(
      { s1: sketch([{ key: 'a', state: { universe: 7 } }]) },
      () => undefined);
    expect(JSON.parse(json)).toEqual({});
  });

  it('reads past the end of a short packet as 0, not undefined', () => {
    const json = buildInjectedScalars(
      { s1: sketch([{ key: 'a', state: { base_channel: 1, channel_count: 4 } }]) },
      () => u(9, 9));
    expect(JSON.parse(json)).toEqual({ a: { ch_0: 9 / 255, ch_1: 9 / 255, ch_2: 0, ch_3: 0 } });
  });

  it('is stable across calls so callers can dedupe by string compare', () => {
    const sk = {
      s1: sketch([{ key: 'b' }, { key: 'a' }]),
    };
    const one = buildInjectedScalars(sk, () => u(1, 2, 3, 4));
    const two = buildInjectedScalars(sk, () => u(1, 2, 3, 4));
    expect(one).toBe(two);
    expect(Object.keys(JSON.parse(one))).toEqual(['a', 'b']);
  });
});
