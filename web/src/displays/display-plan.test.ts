import { describe, it, expect } from 'vitest';
import { emptyComposition } from '../views/arrangement/model/composition';
import type { Composition } from '../views/arrangement/model/composition';
import { buildDisplayPlan } from './display-plan';
import { validDisplayRows } from '../state/display-device-store';
import {
  librarySlot, librarySlots, resolveDisplayScreen, type DisplayScreen, type DisplaySlot,
} from './display-types';

const screens: DisplayScreen[] = [
  { uuid: 'A', name: 'Built-in', w: 2880, h: 1800, hz: 120, main: true },
  { uuid: 'B', name: 'Projector', w: 1920, h: 1080, hz: 60, main: false },
  { uuid: 'C', name: 'Monitor', w: 2560, h: 1440, hz: 60, main: false },
];

describe('display slots', () => {
  it('Display 1 and 2 always exist; the library adds more, in order', () => {
    expect(librarySlots([]).map((s) => s.name)).toEqual(['Display 1', 'Display 2']);
    const rows: DisplaySlot[] = [
      { kind: 'display', id: 'display.4', name: 'Side wall', updatedAt: 1 },
      { kind: 'display', id: 'display.1', name: 'Main', updatedAt: 1, mode: 'window' },
      { kind: 'display', id: 'display.3', name: 'Gone', updatedAt: 1, deleted: true },
    ];
    expect(librarySlots(rows).map((s) => s.name)).toEqual(['Main', 'Display 2', 'Side wall']);
  });

  it('a slot this machine never configured is still a slot (a show from elsewhere)', () => {
    expect(librarySlot([], 'display.7', 'Display 7')).toMatchObject({ id: 'display.7', name: 'Display 7' });
    expect(librarySlot([], 'rig-uuid')).toBeUndefined();
  });

  it('binding: remembered screen, else the Nth screen that is not the main one', () => {
    const d1 = { id: 'display.1' }, d2 = { id: 'display.2' }, d3 = { id: 'display.3' };
    expect(resolveDisplayScreen(d1, screens)).toBe(1);
    expect(resolveDisplayScreen(d2, screens)).toBe(2);
    expect(resolveDisplayScreen(d3, screens)).toBe(-1);
    // The main screen only when chosen.
    expect(resolveDisplayScreen({ ...d1, screen: { uuid: 'A', name: 'Built-in' } }, screens)).toBe(0);
    // A remembered screen that isn't connected: automatic.
    expect(resolveDisplayScreen({ ...d1, screen: { uuid: 'Z', name: 'Old' } }, screens)).toBe(1);
    // A laptop alone: nowhere to go.
    expect(resolveDisplayScreen(d1, [screens[0]])).toBe(-1);
  });
});

describe('stored display rows', () => {
  it('a row from before modes (window: true) is a window', () => {
    const rows = validDisplayRows([
      { kind: 'display', id: 'display.1', name: 'A', updatedAt: 1, window: true },
      { kind: 'display', id: 'display.2', name: 'B', updatedAt: 1, window: false },
    ]);
    expect(rows.map((r) => [r.mode, 'window' in r])).toEqual([['window', false], [undefined, false]]);
  });
});

describe('display plan', () => {
  const comp = (): Composition => {
    const c = emptyComposition();
    c.devices = [
      { id: 'p1', kind: 'display', deviceId: 'display.1' },
      { id: 'p2', kind: 'display', deviceId: 'display.3', label: 'Display 3', enabled: false, fit: 'fill' },
      { id: 'm1', kind: 'midi', deviceId: 'twister' },
      { id: 'l1', kind: 'light', deviceId: 'rig' },
    ];
    return c;
  };

  it('resolves each display against the library; MIDI and lights are not displays', () => {
    const lib: DisplaySlot[] = [{
      kind: 'display', id: 'display.1', name: 'Main', updatedAt: 1,
      screen: { uuid: 'B', name: 'Projector' }, mode: 'window', windowFrame: { x: 10, y: 20, w: 800, h: 450 },
    }];
    const plan = buildDisplayPlan(comp(), lib, true);
    expect(plan.armed).toBe(true);
    expect(buildDisplayPlan(comp(), lib, false).armed).toBe(false);
    expect(plan.outputs).toEqual([
      { placementId: 'p1', slotId: 'display.1', name: 'Main', enabled: true, screenUuid: 'B', ordinal: 1,
        mode: 'window', windowFrame: { x: 10, y: 20, w: 800, h: 450 }, fit: 'fit' },
      { placementId: 'p2', slotId: 'display.3', name: 'Display 3', enabled: false, screenUuid: '', ordinal: 3,
        mode: 'fullscreen', fit: 'fill' },
    ]);
  });
});
