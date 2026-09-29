import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInAction } from 'mobx';
import { store } from './store';
import { displayController } from './display-controller';
import { PORT_OUT } from '../model/composition';
import type { FieldConnectInfo } from '../../../sketch-types';
import type { DisplayPlan } from '../../../displays/display-plan';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

/**
 * Displays in the show: a placement puts a display slot IN the show (a row,
 * an on/off switch, how the frame fits), and a route from an out port tells
 * it what to show instead of the main output. The machine's library says
 * which screen fills the slot.
 */
describe('display placements', () => {
  let trackId: string;

  beforeEach(() => {
    while (store.composition.tracks.filter((x) => x.kind === 'track').length < 1) store.addTrack();
    store.composition.devices = undefined;
    store.composition.routes = undefined;
    trackId = store.composition.tracks.find((x) => x.kind === 'track')!.id;
  });

  const port = (tid: string, portId = PORT_OUT, dir: 'in' | 'out' = 'out'): FieldConnectInfo => ({
    sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: dir === 'out', viewportY: 0,
    schemaDef: null, trackPort: { trackId: tid, portId, dir },
  });
  const input = (placementId: string): FieldConnectInfo => ({
    sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0,
    schemaDef: null, deviceInput: { placementId },
  });

  it('includes a slot as a display, on and Fit by default; each switch is one undo', () => {
    const pid = store.includeDevice('display.1', { kind: 'display', label: 'Display 1' });
    expect(store.displayPlacements).toHaveLength(1);
    expect(store.displayPlacements[0]).toMatchObject({ id: pid, kind: 'display', deviceId: 'display.1' });
    expect(store.displayPlacements[0].enabled).toBeUndefined();
    expect(store.displayPlacements[0].fit).toBeUndefined();
    store.setDisplayFit(pid, 'stretch');
    expect(store.placementById(pid)!.fit).toBe('stretch');
    store.setDisplayEnabled(pid, false);
    expect(store.placementById(pid)!.enabled).toBe(false);
    store.undo();
    expect(store.placementById(pid)!.enabled).toBeUndefined();
    store.undo();
    expect(store.placementById(pid)!.fit).toBeUndefined();
    // Fit is the default: stored as none.
    store.setDisplayFit(pid, 'fill');
    store.setDisplayFit(pid, 'fit');
    expect(store.placementById(pid)!.fit).toBeUndefined();
  });

  it('an out port routes into a display; removing the display removes it', () => {
    const pid = store.includeDevice('display.1', { kind: 'display' });
    store.connectSketchWire(port(trackId), input(pid));
    expect(store.deviceInputRoute(pid)).toMatchObject({
      src: { kind: 'port', trackId, portId: PORT_OUT },
      dest: { kind: 'device', placementId: pid },
    });
    store.removeDevicePlacement(pid);
    expect(store.composition.routes ?? []).toHaveLength(0);
  });
});

describe('display library', () => {
  let sent: DisplayPlan[];
  let identified: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();  // the debounced saves
    store.composition.devices = undefined;
    runInAction(() => { displayController.library = []; });
    sent = [];
    identified = [];
    displayController.bindEngine({ plan: (p) => sent.push(p), identify: (m) => identified.push(m) });
  });

  it('a new display comes after the highest; editing Display 1 stores its row', () => {
    expect(displayController.slots.map((s) => s.id)).toEqual(['display.1', 'display.2']);
    expect(displayController.newDisplay().name).toBe('Display 3');
    expect(displayController.newDisplay().id).toBe('display.4');
    expect(displayController.library.map((r) => r.id)).toEqual(['display.3', 'display.4']);
    displayController.bindScreen('display.1', { uuid: 'B', name: 'Projector' });
    expect(displayController.slot('display.1')).toMatchObject({ screen: { uuid: 'B' } });
    displayController.bindScreen('display.1', null);
    expect(displayController.slot('display.1')!.screen).toBeUndefined();
    // Display 1 and 2 can't go.
    displayController.setDeleted('display.1', true);
    expect(displayController.slots.map((s) => s.id)).toContain('display.1');
    displayController.setDeleted('display.4', true);
    expect(displayController.slots.map((s) => s.id)).toEqual(['display.1', 'display.2', 'display.3']);
  });

  it('the plan follows the show and the library; window mode rides along', () => {
    const pid = store.includeDevice('display.2', { kind: 'display' });
    displayController.pushPlan();
    expect(sent.at(-1)!.outputs).toMatchObject([{ placementId: pid, ordinal: 2, window: false }]);
    displayController.setWindow('display.2', true);
    expect(sent.at(-1)!.outputs[0].window).toBe(true);
  });

  it('the viewer closing a window turns the display off; a moved window is remembered', () => {
    const pid = store.includeDevice('display.1', { kind: 'display' });
    displayController.setWindow('display.1', true);
    displayController.setTelemetry(undefined, undefined, [
      { type: 'moved', slotId: 'display.1', frame: { x: 100.4, y: 50, w: 960, h: 540 } },
      { type: 'closed', placementId: pid },
    ]);
    expect(displayController.slot('display.1')!.windowFrame).toEqual({ x: 100, y: 50, w: 960, h: 540 });
    expect(store.placementById(pid)!.enabled).toBe(false);
    store.undo();
    expect(store.placementById(pid)!.enabled).toBeUndefined();
  });

  it('identify names the slot and where it binds', () => {
    displayController.bindScreen('display.2', { uuid: 'C', name: 'Monitor' });
    displayController.identify('display.2');
    expect(identified).toEqual([{ label: 'Display 2', screenUuid: 'C', ordinal: 2, window: false }]);
  });
});
