/**
 * device-wires-model — cross-composition collection/grouping of the wires a
 * device (or a control subset) drives.
 */
import { describe, it, expect } from 'vitest';
import type { Sketch, Wire } from '../../sketch-types';
import { collectDeadMidiWires, collectDeviceWires } from './device-wires-model';

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

describe('collectDeadMidiWires', () => {
  it('collects only midi: wires whose device uuid is unknown', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([
        wire('w1', 'b0/e00/turn', 'bc', 'brightness'),                    // live (DEV known)
        wire('w2', 'b0/e01/turn', 'bc', 'contrast', 'midi:ghost-dev'),    // dead
        wire('w3', 'output', 'bc', 'saturation', 'lfo'),                  // module wire — never dead
      ]),
      b: sketch([
        wire('w4', 'b1/e05/press', 'bc', 'hue', 'midi:ghost-dev'),        // dead
        wire('w5', 'b0/e02/turn', 'bc', 'gain', 'midi:other-ghost'),      // dead, second uuid
      ]),
    };
    const dead = collectDeadMidiWires(sketches, ['a', 'b'], new Set([DEV]));
    expect(dead.total).toBe(3);
    expect(dead.groups).toEqual([
      { sketchId: 'a', wireIds: ['w2'] },
      { sketchId: 'b', wireIds: ['w4', 'w5'] },
    ]);
    expect([...dead.deadIds].sort()).toEqual(['ghost-dev', 'other-ghost']);
  });

  it('reports nothing when every midi wire matches a known device', () => {
    const sketches: Record<string, Sketch | undefined> = {
      a: sketch([wire('w1', 'b0/e00/turn', 'bc', 'brightness')]),
    };
    const dead = collectDeadMidiWires(sketches, ['a', 'a', 'missing'], new Set([DEV]));
    expect(dead.total).toBe(0);
    expect(dead.groups).toEqual([]);
  });
});
