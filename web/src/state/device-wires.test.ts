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
  });
}
const wires = () => (appState.database.sketches.sk.wires ?? []) as any[];

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
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

  it('replaces an existing wire into the same dest field (last wins)', () => {
    seedSketch();
    appController.connectWire(deviceEnd('b0/e05/turn'), field({ chainIdx: 0 }));
    appController.connectWire(deviceEnd('b1/e00/press'), field({ chainIdx: 0 }));
    expect(wires()).toHaveLength(1);
    expect(wires()[0].src.field).toBe('b1/e00/press');
  });

  it('rejects device→device and device→output connections', () => {
    seedSketch();
    appController.connectWire(deviceEnd('b0/e00/turn'), deviceEnd('b0/e01/turn'));
    appController.connectWire(deviceEnd(), field({ chainIdx: 0, fieldPath: 'output', isOutput: true }));
    expect(wires()).toHaveLength(0);
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
