import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runInAction } from 'mobx';
import { store } from './store';
import { lightController } from './light-controller';
import { PORT_OUT } from '../model/composition';
import type { FieldConnectInfo } from '../../../sketch-types';
import type { LightRig, LightType } from '../../../lights/light-types';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

/**
 * Lights in the show: a placement puts a library rig IN the show (a row, an
 * output switch, a per-show layout per slot), and a route from an out port
 * tells it what to sample instead of the main output.
 */
describe('light placements', () => {
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
  const lightIn = (placementId: string): FieldConnectInfo => ({
    sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0,
    schemaDef: null, lightInput: { placementId },
  });

  it('includes a rig as a light, on by default; the switch turns it off', () => {
    const pid = store.includeDevice('rig-1', { kind: 'light', label: 'Bars' });
    expect(store.lightPlacements).toHaveLength(1);
    expect(store.lightPlacements[0]).toMatchObject({ id: pid, kind: 'light', deviceId: 'rig-1' });
    expect(store.lightPlacements[0].enabled).toBeUndefined();
    store.setLightEnabled(pid, false);
    expect(store.lightPlacements[0].enabled).toBe(false);
    store.setLightEnabled(pid, true);
    expect(store.lightPlacements[0].enabled).toBeUndefined();
  });

  it('a layout drag is one undo point; reset returns to the rig', () => {
    const pid = store.includeDevice('rig-1', { kind: 'light' });
    store.setLightLayout(pid, 's1', { x: 0.1, y: 0, w: 0.02, h: 1 }, 'drag-1');
    store.setLightLayout(pid, 's1', { x: 0.2, y: 0, w: 0.02, h: 1 }, 'drag-1');
    store.setLightLayout(pid, 's1', { x: 0.3, y: 0, w: 0.02, h: 1 }, 'drag-1');
    expect(store.placementById(pid)!.layout!.s1.x).toBeCloseTo(0.3);
    store.undo();
    expect(store.placementById(pid)!.layout).toBeUndefined();
    store.redo();
    // clamped into the frame
    store.setLightLayout(pid, 's2', { x: 1.5, y: -1, w: 0.1, h: 0.5 });
    expect(store.placementById(pid)!.layout!.s2).toEqual({ x: 0.9, y: 0, w: 0.1, h: 0.5 });
    store.resetLightLayout(pid, 's2');
    expect(store.placementById(pid)!.layout!.s2).toBeUndefined();
    store.resetLightLayout(pid);
    expect(store.placementById(pid)!.layout).toBeUndefined();
  });

  it('an out port routes into a light (either gesture direction); one route per light', () => {
    const pid = store.includeDevice('rig-1', { kind: 'light' });
    store.connectSketchWire(lightIn(pid), port(trackId));
    expect(store.lightInputRoute(pid)).toMatchObject({
      src: { kind: 'port', trackId, portId: PORT_OUT },
      dest: { kind: 'device', placementId: pid },
    });
    const t2 = store.addTrack();
    store.connectSketchWire(port(t2), lightIn(pid));
    expect((store.composition.routes ?? []).length).toBe(1);
    expect(store.lightInputRoute(pid)!.src).toMatchObject({ trackId: t2 });
    // an IN port can't feed a light
    store.connectSketchWire(port(trackId, '__in__', 'in'), lightIn(pid));
    expect(store.lightInputRoute(pid)!.src).toMatchObject({ trackId: t2 });
  });

  it('removing the light removes its route, in the same undo step', () => {
    const pid = store.includeDevice('rig-1', { kind: 'light' });
    store.connectSketchWire(port(trackId), lightIn(pid));
    store.removeDevicePlacement(pid);
    expect(store.composition.routes ?? []).toHaveLength(0);
    store.undo();
    expect(store.lightInputRoute(pid)).toBeTruthy();
  });

  it('a MIDI placement is never a route destination', () => {
    const mid = store.includeDevice('twister');
    store.connectSketchWire(port(trackId), lightIn(mid));
    expect(store.composition.routes ?? []).toHaveLength(0);
  });
});

describe('light library', () => {
  beforeEach(() => {
    vi.useFakeTimers();  // the debounced saves
    const bar: LightType = {
      kind: 'type', id: 'bar', templateId: 'light.strip', parentId: 'light.strip', name: 'Bar',
      pixels: 10, ledsPerPixel: 1, format: 'rgbw', gamma: 2.5, vertical: true, forkedAt: 0, updatedAt: 0,
    };
    runInAction(() => { lightController.library = [bar]; });
  });

  it('a new rig addresses its bars one after another', () => {
    const rig = lightController.newRig({
      typeId: 'bar', count: 4, start: { universe: 0, channel: 1, dest: 'broadcast' },
    })!;
    expect(rig.slots.map((s) => s.address.channel)).toEqual([1, 41, 81, 121]);
    expect(rig.name).toBe('4 × Bar');
  });

  it('turning a type horizontal lays its rigs out again, stacked down the frame', () => {
    const rig = lightController.newRig({
      typeId: 'bar', count: 2, start: { universe: 0, channel: 1, dest: 'broadcast' },
    })!;
    expect(rig.slots[0].layout.h).toBe(1);
    lightController.editType('bar', { vertical: false });
    const r = lightController.rig(rig.id)!;
    expect(r.slots.map((s) => s.layout.w)).toEqual([1, 1]);
    expect(r.slots[0].layout.y).toBeLessThan(r.slots[1].layout.y);
    // Another edit that doesn't turn it leaves a hand-made layout alone.
    lightController.editSlot(rig.id, r.slots[0].id, { layout: { x: 0.1, y: 0.1, w: 0.5, h: 0.05 } });
    lightController.editType('bar', { vertical: false, gamma: 2 });
    expect(lightController.rig(rig.id)!.slots[0].layout.w).toBe(0.5);
  });

  it('a bar\'s network: Auto is stored as none; switch all puts the rig on one; swap carries it', () => {
    const rig = lightController.newRig({
      typeId: 'bar', count: 3, start: { universe: 0, channel: 1, dest: 'broadcast' },
    })!;
    const n = lightController.newNetwork();
    expect(n).toMatchObject({ kind: 'network', iface: '' });
    lightController.editNetwork(n.id, { iface: ' en7 ', rebase: '10.0.5.0/24' });
    expect(lightController.network(n.id)).toMatchObject({ iface: 'en7', rebase: '10.0.5.0/24' });
    lightController.editSlot(rig.id, rig.slots[0].id, { address: { network: n.id } });
    expect(lightController.rig(rig.id)!.slots[0].address.network).toBe(n.id);
    lightController.swapSlots(rig.id, rig.slots[0].id, rig.slots[1].id);
    expect(lightController.rig(rig.id)!.slots.map((s) => s.address.network)).toEqual([undefined, n.id, undefined]);
    lightController.setRigNetwork(rig.id, n.id);
    expect(lightController.networkUsers(n.id)).toHaveLength(3);
    lightController.setRigNetwork(rig.id, 'net.auto');
    expect(lightController.rig(rig.id)!.slots.every((s) => !('network' in s.address))).toBe(true);
    expect(lightController.networkUsers('net.auto')).toHaveLength(3);
  });

  it('swapping two slots exchanges where they SEND, not where they sample', () => {
    const rig = lightController.newRig({
      typeId: 'bar', count: 4, start: { universe: 0, channel: 1, dest: 'broadcast' },
    })!;
    const [a, b] = [rig.slots[1], rig.slots[2]];
    const layouts = [a.layout.x, b.layout.x];
    lightController.editSlot(rig.id, a.id, { reverse: true });
    lightController.swapSlots(rig.id, a.id, b.id);
    const r = lightController.rig(rig.id)!;
    expect(r.slots[1].address.channel).toBe(81);
    expect(r.slots[2].address.channel).toBe(41);
    expect(r.slots[2].reverse).toBe(true);
    expect(r.slots[1].reverse).toBeFalsy();
    expect([r.slots[1].layout.x, r.slots[2].layout.x]).toEqual(layouts);
  });

  it('adding a slot continues the addressing', () => {
    const rig = lightController.newRig({
      typeId: 'bar', count: 2, start: { universe: 3, channel: 11, dest: '10.0.0.9' },
    })!;
    lightController.addSlot(rig.id);
    const r = lightController.rig(rig.id)!;
    expect(r.slots[2].address).toEqual({ universe: 3, channel: 91, dest: '10.0.0.9' });
  });
});
