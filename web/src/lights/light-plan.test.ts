import { describe, it, expect } from 'vitest';
import {
  consecutiveAddresses, defaultStripLayout, parseCidr, resolveNetworkDest, slotFootprints, validDest,
  type LightNetwork, type LightRig, type LightType,
} from './light-types';
import { buildLightPlan, rigWarnings } from './light-plan';
import type { Composition } from '../views/arrangement/model/composition';

const bar: LightType = {
  kind: 'type', id: 'bar', templateId: 'light.strip', parentId: 'light.strip', name: 'Bar',
  pixels: 10, ledsPerPixel: 1, format: 'rgbw', gamma: 2.5, vertical: true, forkedAt: 0, updatedAt: 0,
};

function rig(slots = 4): LightRig {
  const addrs = consecutiveAddresses(slots, bar, { universe: 0, channel: 1, dest: 'broadcast' });
  return {
    kind: 'rig', id: 'rig', parentId: 'bar', name: 'Rig', forkedAt: 0, updatedAt: 0,
    slots: addrs.map((address, i) => ({ id: `s${i}`, typeId: 'bar', address, layout: defaultStripLayout(i, slots) })),
  };
}

function comp(devices: Composition['devices']): Composition {
  return { devices } as unknown as Composition;
}

describe('light types', () => {
  it('addresses bars one after another (the Lights Base rig: 1, 41, 81, 121)', () => {
    expect(rig().slots.map((s) => s.address.channel)).toEqual([1, 41, 81, 121]);
  });

  it('starts the next universe when a bar would not fit', () => {
    const addrs = consecutiveAddresses(3, { pixels: 60, format: 'rgbw' }, { universe: 2, channel: 1, dest: 'broadcast' });
    // 240 channels each: 1..240, 241..480, then universe 3
    expect(addrs.map((a) => [a.universe, a.channel])).toEqual([[2, 1], [2, 241], [3, 1]]);
  });

  it('spreads the default layout as vertical strips (the Resolume geometry)', () => {
    const centres = [0, 1, 2, 3].map((i) => { const r = defaultStripLayout(i, 4); return r.x + r.w / 2; });
    expect(centres).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(defaultStripLayout(0, 4).h).toBe(1);
  });

  it('stacks a horizontal type\'s default layout down the frame', () => {
    const centres = [0, 1, 2, 3].map((i) => { const r = defaultStripLayout(i, 4, false); return r.y + r.h / 2; });
    expect(centres.map((c) => Math.round(c * 1000) / 1000)).toEqual([0.125, 0.375, 0.625, 0.875]);
    expect(defaultStripLayout(0, 4, false)).toMatchObject({ x: 0, w: 1 });
  });

  it('cuts a slot into pixel footprints along its type\'s axis; reverse flips them', () => {
    const tall = slotFootprints({ x: 0.125, y: 0, w: 0.25, h: 1 }, 4, true);
    expect(tall[0]).toEqual([0.125, 0, 0.375, 0.25]);
    expect(tall[3][1]).toBe(0.75);
    const rev = slotFootprints({ x: 0.125, y: 0, w: 0.25, h: 1 }, 4, true, true);
    expect(rev[0][1]).toBe(0.75);
    const wide = slotFootprints({ x: 0, y: 0.5, w: 1, h: 0.1 }, 2, false);
    expect(wide[1]).toEqual([0.5, 0.5, 1, 0.6]);
    // The TYPE decides, not the rect's shape: a vertical bar in a wide rect
    // still runs top → bottom.
    const squat = slotFootprints({ x: 0, y: 0, w: 1, h: 0.5 }, 2, true);
    expect(squat[1]).toEqual([0, 0.25, 1, 0.5]);
  });

  it('validates destinations', () => {
    expect(validDest('broadcast')).toBe(true);
    expect(validDest('192.168.1.40')).toBe(true);
    expect(validDest('2.0.0.1:6454')).toBe(true);
    expect(validDest('300.1.1.1')).toBe(false);
    expect(validDest('node-a')).toBe(false);
  });
});

function net(patch: Partial<LightNetwork>): LightNetwork {
  return {
    kind: 'network', id: 'venue', parentId: 'net.auto', name: 'Venue', forkedAt: 0, updatedAt: 0,
    iface: 'en7', ...patch,
  };
}

describe('networks', () => {
  it('parses subnets', () => {
    expect(parseCidr('10.0.5.0/24')).toEqual({ net: 0x0a000500, mask: 0xffffff00 });
    expect(parseCidr('10.0.5.9/24')?.net).toBe(0x0a000500);
    expect(parseCidr('10.0.5.0')).toBeNull();
    expect(parseCidr('10.0.5.0/33')).toBeNull();
  });

  it('rebases unicast destinations, keeping host part and port; broadcast stays', () => {
    const n = net({ rebase: '10.0.5.0/24' });
    expect(resolveNetworkDest('192.168.1.40', n)).toBe('10.0.5.40');
    expect(resolveNetworkDest('192.168.1.40:7000', n)).toBe('10.0.5.40:7000');
    expect(resolveNetworkDest('broadcast', n)).toBe('broadcast');
    expect(resolveNetworkDest('192.168.1.40', net({ rebase: '2.0.0.0/8' }))).toBe('2.168.1.40');
    expect(resolveNetworkDest('192.168.1.40', net({ rebase: 'nonsense' }))).toBe('192.168.1.40');
  });

  it('overrides come first: exact, by ip (port kept), and broadcast', () => {
    const n = net({
      rebase: '10.0.5.0/24',
      overrides: [
        { from: '192.168.1.41', to: '10.9.9.9' },
        { from: '192.168.1.42:7000', to: '10.9.9.8:7001' },
        { from: 'broadcast', to: '2.255.255.255' },
        { from: '', to: '1.1.1.1' },
      ],
    });
    expect(resolveNetworkDest('192.168.1.41', n)).toBe('10.9.9.9');
    expect(resolveNetworkDest('192.168.1.41:7000', n)).toBe('10.9.9.9:7000');
    expect(resolveNetworkDest('192.168.1.42:7000', n)).toBe('10.9.9.8:7001');
    expect(resolveNetworkDest('broadcast', n)).toBe('2.255.255.255');
    expect(resolveNetworkDest('192.168.1.43', n)).toBe('10.0.5.43');
    expect(resolveNetworkDest('192.168.1.43', undefined)).toBe('192.168.1.43');
  });
});

describe('the light plan', () => {
  it('sends each bar on its network: its interface, its patched destination', () => {
    const r = rig(2);
    r.slots[0].address = { ...r.slots[0].address, dest: '192.168.1.40', network: 'venue' };
    const plan = buildLightPlan(comp([{ id: 'p1', kind: 'light', deviceId: 'rig' }]),
      [bar, r, net({ rebase: '10.0.5.0/24' })]);
    const [a, b] = plan.outputs[0].fixtures;
    expect([a.iface, a.dest]).toEqual(['en7', '10.0.5.40']);
    expect([b.iface, b.dest]).toEqual(['', 'broadcast']);  // Auto
  });

  it('a bar whose network is gone (or deleted) is sent on Auto, with a warning', () => {
    const r = rig(1);
    r.slots[0].address = { ...r.slots[0].address, network: 'venue' };
    const lib = [bar, r, net({ deleted: true, rebase: '10.0.5.0/24' })];
    const f = buildLightPlan(comp([{ id: 'p1', kind: 'light', deviceId: 'rig' }]), lib).outputs[0].fixtures[0];
    expect([f.iface, f.dest]).toEqual(['', 'broadcast']);
    expect(rigWarnings(r, lib)[0].message).toContain('network is gone');
  });

  it('resolves placed rigs into fixtures, with the show layout over the rig default', () => {
    const r = rig(2);
    const plan = buildLightPlan(comp([
      { id: 'p1', kind: 'light', deviceId: 'rig', layout: { s1: { x: 0.5, y: 0, w: 0.1, h: 0.5 } } },
      { id: 'm1', kind: 'midi', deviceId: 'twister' },
      { id: 'gone', kind: 'light', deviceId: 'not-in-this-library' },
    ]), [bar, r]);
    expect(plan.outputs).toHaveLength(1);
    const out = plan.outputs[0];
    expect(out).toMatchObject({ placementId: 'p1', enabled: true });
    expect(out.fixtures.map((f) => [f.slotId, f.channel, f.format, f.gamma])).toEqual([
      ['s0', 1, 'rgbw', 2.5], ['s1', 41, 'rgbw', 2.5],
    ]);
    expect(out.fixtures[0].footprints).toHaveLength(10);
    expect(out.fixtures[0].footprints[0][0]).toBeCloseTo(0.25 - 1 / 120);
    // slot 1 samples where THIS show put it
    expect(out.fixtures[1].footprints[0]).toEqual([0.5, 0, 0.6, 0.05]);
  });

  it('carries the output switch', () => {
    const plan = buildLightPlan(comp([{ id: 'p1', kind: 'light', deviceId: 'rig', enabled: false }]), [bar, rig(1)]);
    expect(plan.outputs[0].enabled).toBe(false);
  });

  it('warns about channels past 512, overlaps and missing types', () => {
    const r = rig(2);
    r.slots[0].address = { universe: 0, channel: 500, dest: 'broadcast' };
    r.slots[1].address = { universe: 0, channel: 510, dest: 'broadcast' };
    const w = rigWarnings(r, [bar]).map((x) => x.message);
    expect(w.some((m) => m.includes('past channel 512'))).toBe(true);
    expect(w.some((m) => m.includes('share channels'))).toBe(true);
    expect(rigWarnings(rig(4), [bar])).toEqual([]);
    const orphan = rig(1);
    orphan.slots[0].typeId = 'nope';
    expect(rigWarnings(orphan, [bar])[0].message).toContain('type is missing');
  });
});
