import { describe, it, expect } from 'vitest';
import {
  consecutiveAddresses, defaultStripLayout, slotFootprints, validDest,
  type LightRig, type LightType,
} from './light-types';
import { buildLightPlan, rigWarnings } from './light-plan';
import type { Composition } from '../views/arrangement/model/composition';

const bar: LightType = {
  kind: 'type', id: 'bar', templateId: 'light.strip', parentId: 'light.strip', name: 'Bar',
  pixels: 10, ledsPerPixel: 1, format: 'rgbw', gamma: 2.5, forkedAt: 0, updatedAt: 0,
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

  it('cuts a slot into pixel footprints along its long axis; reverse flips them', () => {
    const tall = slotFootprints({ x: 0.125, y: 0, w: 0.25, h: 1 }, 4);
    expect(tall[0]).toEqual([0.125, 0, 0.375, 0.25]);
    expect(tall[3][1]).toBe(0.75);
    const rev = slotFootprints({ x: 0.125, y: 0, w: 0.25, h: 1 }, 4, true);
    expect(rev[0][1]).toBe(0.75);
    const wide = slotFootprints({ x: 0, y: 0.5, w: 1, h: 0.1 }, 2);
    expect(wide[1]).toEqual([0.5, 0.5, 1, 0.6]);
  });

  it('validates destinations', () => {
    expect(validDest('broadcast')).toBe(true);
    expect(validDest('192.168.1.40')).toBe(true);
    expect(validDest('2.0.0.1:6454')).toBe(true);
    expect(validDest('300.1.1.1')).toBe(false);
    expect(validDest('node-a')).toBe(false);
  });
});

describe('the light plan', () => {
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
