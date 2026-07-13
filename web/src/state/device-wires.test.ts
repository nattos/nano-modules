/**
 * MIDI device wires — connectWire with `deviceControl` endpoints and the
 * normalize keep-rule for `midi:` sources.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { FieldConnectInfo } from './controller';
import { normalizeSketchChains, Sketch } from '../sketch-types';

const field = (over: Partial<FieldConnectInfo> = {}): FieldConnectInfo => ({
  sketchId: 'sk', colIdx: 0, chainIdx: 0, fieldPath: 'brightness',
  isOutput: false, viewportY: 0, schemaDef: null, ...over,
});

const deviceEnd = (controlId = 'b0/e05/turn'): FieldConnectInfo => field({
  sketchId: '', chainIdx: -1, fieldPath: '',
  deviceControl: { deviceInstanceId: 'dev-1', controlId },
});

function seedSketch() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'video.bc', instance_key: 'bc' },
        ],
      },
    } as any;
    // connectWire lazy-forks unknown device ids (and DROPS unknown ids that
    // aren't templates either) — the tests use a real library instance.
    appState.local.midi.library = [{
      id: 'dev-1', templateId: 'com.nano.midi.mft', parentId: 'com.nano.midi.mft',
      forkedAt: 0, name: 'Test Twister', config: {}, identities: [], updatedAt: 0,
    }];
  });
}
const wires = () => (appState.database.sketches.sk.wires ?? []) as any[];

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.midi.library = [];
  });
});

describe('connectWire with a device endpoint', () => {
  it('stores src as midi:<uuid> + endpoint field, dest as the sketch field', () => {
    seedSketch();
    appController.connectWire(deviceEnd(), field({ chainIdx: 0, fieldPath: 'brightness' }));
    expect(wires()).toHaveLength(1);
    expect(wires()[0]).toMatchObject({
      src: { instanceKey: 'midi:dev-1', field: 'b0/e05/turn' },
      dest: { instanceKey: 'bc', field: 'brightness' },
      combine: 'add',
    });
  });

  it('argument order does not matter — the device is always the writer', () => {
    seedSketch();
    appController.connectWire(field({ chainIdx: 0, fieldPath: 'brightness' }), deviceEnd());
    expect(wires()[0].src.instanceKey).toBe('midi:dev-1');
  });

  it('re-dragging the SAME control onto the same dest replaces (no duplicates)', () => {
    seedSketch();
    appController.connectWire(deviceEnd('b0/e05/turn'), field({ chainIdx: 0 }));
    appController.connectWire(deviceEnd('b0/e05/turn'), field({ chainIdx: 0 }));
    expect(wires()).toHaveLength(1);
  });

  it('a different control onto the same dest STACKS (combines fold them)', () => {
    seedSketch();
    appController.connectWire(deviceEnd('b0/e05/turn'), field({ chainIdx: 0 }));
    appController.connectWire(deviceEnd('b1/e00/press'), field({ chainIdx: 0 }));
    expect(wires()).toHaveLength(2);
    expect(wires().map(w => w.src.field).sort()).toEqual(['b0/e05/turn', 'b1/e00/press']);
  });

  it('lazy-forks a TEMPLATE source into a library instance on connect', () => {
    seedSketch();
    runInAction(() => { appState.local.midi.library = []; });
    const end = field({
      sketchId: '', chainIdx: -1, fieldPath: '',
      deviceControl: { deviceInstanceId: 'com.nano.midi.mft', controlId: 'b0/e00/turn' },
    });
    appController.connectWire(end, field({ chainIdx: 0, fieldPath: 'brightness' }));
    const lib = appState.local.midi.library;
    expect(lib).toHaveLength(1);
    expect(lib[0].parentId).toBe('com.nano.midi.mft');
    expect(wires()[0].src.instanceKey).toBe(`midi:${lib[0].id}`);
  });

  it('drops gestures from ids that are neither instances nor templates', () => {
    seedSketch();
    const end = field({
      sketchId: '', chainIdx: -1, fieldPath: '',
      deviceControl: { deviceInstanceId: 'garbage-id', controlId: 'b0/e00/turn' },
    });
    appController.connectWire(end, field({ chainIdx: 0, fieldPath: 'brightness' }));
    expect(wires()).toHaveLength(0);
  });

  it('rejects device→device and device→pure-output connections', () => {
    seedSketch();
    appController.connectWire(deviceEnd('b0/e00/turn'), deviceEnd('b0/e01/turn'));
    // A pure output (no input io bit — e.g. an LFO's `output`).
    appController.connectWire(deviceEnd(), field({
      chainIdx: 0, fieldPath: 'output', isOutput: true, schemaDef: { io: 6 } as any }));
    // isOutput with no schema info at all stays rejected too.
    appController.connectWire(deviceEnd(), field({ chainIdx: 0, fieldPath: 'output', isOutput: true }));
    expect(wires()).toHaveLength(0);
  });

  it('accepts a RELAY field (io = in|out, e.g. a dashboard knob) as dest', () => {
    seedSketch();
    // Dashboard knobs surface as outputs in the UI (they're wire sources) but
    // declare the input bit too — a device wire modulating one is the whole
    // "map MIDI to a macro knob" flow.
    appController.connectWire(deviceEnd(), field({
      chainIdx: 0, fieldPath: 'knob_0', isOutput: true, schemaDef: { io: 11 } as any }));
    expect(wires()).toHaveLength(1);
    expect(wires()[0]).toMatchObject({
      src: { instanceKey: 'midi:dev-1', field: 'b0/e05/turn' },
      dest: { instanceKey: 'bc', field: 'knob_0' },
    });
  });
});

describe('normalizeSketchChains with device wires', () => {
  it('keeps midi: sources (even when no device exists) but prunes dead dests', () => {
    const sketch = {
      anchor: null,
      chain: [{ type: 'module', module_type: 'video.bc', instance_key: 'bc' }],
      wires: [
        { id: 'w1', src: { instanceKey: 'midi:ghost', field: 'b0/e00/turn' }, dest: { instanceKey: 'bc', field: 'brightness' } },
        { id: 'w2', src: { instanceKey: 'midi:ghost', field: 'b0/e01/turn' }, dest: { instanceKey: 'gone', field: 'x' } },
        { id: 'w3', src: { instanceKey: 'gone', field: 'y' }, dest: { instanceKey: 'bc', field: 'contrast' } },
      ],
    } as unknown as Sketch;
    const result = normalizeSketchChains(sketch);
    expect(result.wires?.map(w => w.id)).toEqual(['w1']);
  });
});
