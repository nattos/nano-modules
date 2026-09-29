import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import type { Track } from '../model/composition';
import { LAYER_TARGET_ID, compositionSketches } from '../model/composition';
import type { FieldConnectInfo } from '../../../sketch-types';
import { seedTestPlugins } from '../engine/test-plugins';

seedTestPlugins();

/**
 * Devices in the arrangement: a MIDI control dragged onto an input lands a
 * `midi:<uuid>` sketch wire — no placement needed. A placement only puts the
 * device on the timeline as a row; removing the row keeps its wires.
 */
describe('device placements', () => {
  let t: Track;

  beforeEach(() => {
    while (store.composition.tracks.filter((x) => x.kind === 'track').length < 1) store.addTrack();
    for (const x of store.composition.tracks) {
      if (x.kind !== 'track') continue;
      x.clips = []; x.sketch.devices = []; x.sketch.wires = [];
    }
    store.composition.devices = undefined;
    t = store.composition.tracks.find((x) => x.kind === 'track')!;
  });

  const control = (deviceId: string, controlId = 'b0/e00/turn'): FieldConnectInfo => ({
    sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: true, viewportY: 0,
    schemaDef: null, deviceControl: { deviceInstanceId: deviceId, controlId },
  });
  const field = (sketchId: string, chainIdx: number, fieldPath: string,
                 def: Record<string, unknown> = { type: 'float', io: 1 }): FieldConnectInfo => ({
    sketchId, colIdx: 0, chainIdx, fieldPath, isOutput: false, viewportY: 0, schemaDef: def,
  });
  const midiWires = () => Object.values(compositionSketches(store.composition))
    .flatMap((sk) => sk.wires ?? []).filter((w) => w.src.instanceKey.startsWith('midi:'));

  it('puts a device on the timeline once', () => {
    const p1 = store.includeDevice('dev-1', { label: 'Twister', templateId: 'com.nano.midi.mft' });
    const p2 = store.includeDevice('dev-1');
    expect(p2).toBe(p1);
    expect(store.devicePlacements).toHaveLength(1);
    expect(store.devicePlacements[0]).toMatchObject({ kind: 'midi', deviceId: 'dev-1', label: 'Twister' });
  });

  it('a control onto a clip input lands a midi wire, with no placement', () => {
    const clipPath = store.createEmptyClip(t.id, 0, 4)!;
    const clipId = clipPath.split('/')[2];
    store.addClipDeviceType(t.id, clipId, 'color.hsl');
    store.connectSketchWire(control('dev-1'), field(`clip/${t.id}/${clipId}`, 0, 'hue_shift'));
    const ws = midiWires();
    expect(ws).toHaveLength(1);
    const dev = store.composition.tracks.find((x) => x.id === t.id)!.clips[0].sketch.devices[0];
    expect(ws[0]).toMatchObject({
      src: { instanceKey: 'midi:dev-1', field: 'b0/e00/turn' },
      dest: { instanceKey: dev.id, field: 'hue_shift' },
      combine: 'add',
    });
    expect(store.devicePlacements).toHaveLength(0);
    // The same control again replaces; another control stacks.
    store.connectSketchWire(control('dev-1'), field(`clip/${t.id}/${clipId}`, 0, 'hue_shift'));
    expect(midiWires()).toHaveLength(1);
    store.connectSketchWire(control('dev-1', 'b0/e01/turn'), field(`clip/${t.id}/${clipId}`, 0, 'hue_shift'));
    expect(midiWires()).toHaveLength(2);
  });

  it('refuses pure outputs and textures; drives a track layer opacity', () => {
    const dev = store.insertTrackDeviceAt(t.id, 0, 'mod.source.lfo')!;
    expect(dev).toBeTruthy();
    const out: FieldConnectInfo = { ...field(`track/${t.id}`, 0, 'output', { type: 'float', io: 2 }), isOutput: true };
    store.connectSketchWire(control('dev-1'), out);
    store.connectSketchWire(control('dev-1'), field(`track/${t.id}`, 0, 'rate', { type: 'texture', io: 1 }));
    expect(midiWires()).toHaveLength(0);

    const layer: FieldConnectInfo = {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: false, viewportY: 0,
      schemaDef: null, layerOwner: t.id, layerField: 'opacity',
    };
    store.connectSketchWire(layer, control('dev-1', 'b0/e03/turn'));
    const ws = store.composition.tracks.find((x) => x.id === t.id)!.sketch.wires!;
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      src: { instanceKey: 'midi:dev-1', field: 'b0/e03/turn' },
      dest: { instanceKey: LAYER_TARGET_ID, field: 'opacity' },
      combine: 'replace',
    });
  });

  it('removing a timeline row keeps its wires — undoably', () => {
    store.insertTrackDeviceAt(t.id, 0, 'color.hsl');
    store.connectSketchWire(control('dev-1'), field(`track/${t.id}`, 0, 'saturation'));
    const pid = store.includeDevice('dev-1');
    expect(store.deviceWireCount('dev-1')).toBe(1);
    store.removeDevicePlacement(pid);
    expect(store.devicePlacements).toHaveLength(0);
    expect(store.composition.devices).toBeUndefined();
    expect(midiWires()).toHaveLength(1);
    store.undo();
    expect(store.devicePlacements).toHaveLength(1);
  });
});
