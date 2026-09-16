/**
 * device-wires-model — cross-composition collection/grouping of the wires a
 * device (or a control subset) drives.
 */
import { describe, it, expect } from 'vitest';
import type { Sketch, Wire } from '../../sketch-types';
import { collectDeviceWires, collectGhostDevices } from './device-wires-model';

const DEV = 'dev-1';

const wire = (id: string, srcField: string, destKey: string, destField: string,
              srcKey = `midi:${DEV}`): Wire => ({
  id,
  src: { instanceKey: srcKey, field: srcField },
  dest: { instanceKey: destKey, field: destField },
});

const sketch = (wires: Wire[], moduleKeys: string[] = ['bc']): Sketch => ({
  anchor: null,
  chain: moduleKeys.map(k => ({ type: 'module' as const, module_type: 'video.bc', instance_key: k })),
  wires,
});

describe('collectDeviceWires', () => {
  it('groups per sketch in scan order, resolving chain positions', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([wire('w1', 'b0/e00/turn', 'bc', 'brightness')]),
      b: sketch([wire('w2', 'b0/e01/press', 'fx', 'amount')], ['bc', 'fx']),
    };
    const groups = collectDeviceWires(sketches, ['b', 'a'], DEV, null);
    expect(groups.map(g => g.sketchId)).toEqual(['b', 'a']);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0]).toMatchObject({
      controlId: 'b0/e01', gesture: 'press', chainIdx: 1,
      dest: { instance_key: 'fx' },
    });
    expect(groups[1].rows[0].wire.id).toBe('w1');
  });

  it('ignores other devices, module-sourced wires, and malformed endpoints', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        wire('w1', 'b0/e00/turn', 'bc', 'brightness'),
        wire('w2', 'b0/e00/turn', 'bc', 'contrast', 'midi:other-dev'),
        wire('w3', 'output', 'bc', 'saturation', 'lfo'),        // module wire
        wire('w4', 'not-an-endpoint', 'bc', 'hue'),             // malformed
      ]),
    };
    const groups = collectDeviceWires(sketches, ['a'], DEV, null);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.wire.id)).toEqual(['w1']);
  });

  it('scopes to controlIds across all gestures of those controls', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        wire('w1', 'b0/e00/turn', 'bc', 'brightness'),
        wire('w2', 'b0/e00/press', 'bc', 'contrast'),
        wire('w3', 'b0/e01/turn', 'bc', 'saturation'),
      ]),
    };
    const groups = collectDeviceWires(sketches, ['a'], DEV, ['b0/e00']);
    expect(groups[0].rows.map(r => r.wire.id)).toEqual(['w1', 'w2']);
  });

  it('skips dangling dests, missing sketches, and duplicate scan ids', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        wire('w1', 'b0/e00/turn', 'gone', 'brightness'),   // dest not in chain
        wire('w2', 'b0/e00/turn', 'bc', 'brightness'),
      ]),
    };
    const groups = collectDeviceWires(sketches, ['a', 'a', 'missing'], DEV, null);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.wire.id)).toEqual(['w2']);
  });

  it('omits groups with no matching wires entirely', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([wire('w1', 'b0/e00/turn', 'bc', 'brightness')]),
      b: sketch([]),
    };
    const groups = collectDeviceWires(sketches, ['b', 'a'], DEV, null);
    expect(groups.map(g => g.sketchId)).toEqual(['a']);
  });
});

describe('collectDeviceWires with control aliases', () => {
  const alias = (id: string, aField: string, bDev: string, bField: string, aDev = DEV): Wire => ({
    id,
    src: { instanceKey: `midi:${aDev}`, field: aField },
    dest: { instanceKey: `midi:${bDev}`, field: bField },
  });

  it('matches at EITHER end, since an alias is undirected', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        alias('a1', 'b0/e00/turn', 'dev-2', 'b1/e02/turn'),
        alias('a2', 'b3/e00/turn', DEV, 'b0/e01/turn', 'dev-2'),
      ]),
    };
    const rows = collectDeviceWires(sketches, ['a'], DEV, null)[0].rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'alias', controlId: 'b0/e00', gesture: 'turn',
      peer: { deviceId: 'dev-2', controlId: 'b1/e02', gesture: 'turn' },
    });
    // The second names us at its DEST end, so `peer` is the other side.
    expect(rows[1]).toMatchObject({
      kind: 'alias', controlId: 'b0/e01',
      peer: { deviceId: 'dev-2', controlId: 'b3/e00' },
    });
  });

  it('emits a row per end when a device is aliased to itself', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([alias('a1', 'b0/e00/turn', DEV, 'b0/e01/turn')]),
    };
    const rows = collectDeviceWires(sketches, ['a'], DEV, null)[0].rows;
    expect(rows.map(r => r.controlId)).toEqual(['b0/e00', 'b0/e01']);
  });

  it('honours the control scope', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        alias('a1', 'b0/e00/turn', 'dev-2', 'b1/e02/turn'),
        alias('a2', 'b0/e09/turn', 'dev-2', 'b1/e03/turn'),
      ]),
    };
    const rows = collectDeviceWires(sketches, ['a'], DEV, ['b0/e00'])[0].rows;
    expect(rows.map(r => r.wire.id)).toEqual(['a1']);
  });

  it('keeps modulation rows discriminable from alias rows', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        wire('w1', 'b0/e00/turn', 'bc', 'brightness'),
        alias('a1', 'b0/e00/turn', 'dev-2', 'b1/e02/turn'),
      ]),
    };
    const rows = collectDeviceWires(sketches, ['a'], DEV, null)[0].rows;
    expect(rows.map(r => r.kind)).toEqual(['mod', 'alias']);
  });
});

describe('collectGhostDevices', () => {
  it('groups dead wires per missing uuid with control/gesture/sketch tallies', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        wire('w1', 'b0/e05/turn', 'bc', 'brightness', 'midi:ghost-1'),
        wire('w2', 'b0/e05/press', 'bc', 'contrast', 'midi:ghost-1'),
        wire('w3', 'b1/e08/turn', 'bc', 'saturation', 'midi:ghost-2'),
        wire('w4', 'b0/e00/turn', 'bc', 'hue'),                  // live (DEV)
        wire('w5', 'output', 'bc', 'gain', 'lfo'),               // module wire
      ]),
      b: sketch([
        wire('w6', 'b0/e05/shift', 'bc', 'mix', 'midi:ghost-1'),
      ]),
    };
    const ghosts = collectGhostDevices(sketches, ['a', 'b'], new Set([DEV]));
    expect(ghosts.map(g => g.deviceId).sort()).toEqual(['ghost-1', 'ghost-2']);
    const g1 = ghosts.find(g => g.deviceId === 'ghost-1')!;
    expect(g1.wireCount).toBe(3);
    expect(g1.sketchCount).toBe(2);
    expect(g1.perSketch).toEqual([
      { sketchId: 'a', wireIds: ['w1', 'w2'] },
      { sketchId: 'b', wireIds: ['w6'] },
    ]);
    expect(g1.controls).toEqual([
      { controlId: 'b0/e05', gestures: ['turn', 'press', 'shift'] },
    ]);
    const g2 = ghosts.find(g => g.deviceId === 'ghost-2')!;
    expect(g2.wireCount).toBe(1);
    expect(g2.controls).toEqual([{ controlId: 'b1/e08', gestures: ['turn'] }]);
  });

  it('sees a missing device at an alias DEST too', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([{
        id: 'a1',
        src: { instanceKey: `midi:${DEV}`, field: 'b0/e00/turn' },
        dest: { instanceKey: 'midi:gone', field: 'b1/e02/turn' },
      }]),
    };
    const ghosts = collectGhostDevices(sketches, ['a'], new Set([DEV]));
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({
      deviceId: 'gone', wireCount: 1,
      controls: [{ controlId: 'b1/e02', gestures: ['turn'] }],
    });
  });

  it('treats knownAs aliases as known (no ghost)', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([wire('w1', 'b0/e05/turn', 'bc', 'brightness', 'midi:aliased-uuid')]),
    };
    const ghosts = collectGhostDevices(sketches, ['a'], new Set([DEV, 'aliased-uuid']));
    expect(ghosts).toEqual([]);
  });
});
