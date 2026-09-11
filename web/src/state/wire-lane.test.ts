/**
 * Wires that address ONE LANE of a vector field.
 *
 * The lane lives on the endpoint as a structured `lane`, never as a suffix on
 * `dest.field` — so a schema lookup on a wire's destination keeps working. The
 * consequence these tests pin is the dedupe rule: "the same edge" now has to
 * include the lane, or connecting to Y would silently replace the wire on X.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { FieldConnectInfo } from '../sketch-types';

const VEC2 = { type: 'float2', io: 1, min: -1, max: 1, default: [0, 0] };

const field = (over: Partial<FieldConnectInfo> = {}): FieldConnectInfo => ({
  sketchId: 'sk', colIdx: 0, chainIdx: 0, fieldPath: 'translate',
  isOutput: false, viewportY: 0, schemaDef: null, ...over,
});

const lfoOut = () => field({ chainIdx: 0, fieldPath: 'output', isOutput: true });
const translate = (lane?: number) =>
  field({ chainIdx: 1, fieldPath: 'translate', lane, schemaDef: VEC2 });

function seed() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo' },
          { type: 'module', module_type: 'warp.transform', instance_key: 'tf' },
        ],
      },
    } as any;
  });
}

const wires = () => (appState.database.sketches.sk.wires ?? []) as any[];

afterEach(() => {
  runInAction(() => { appState.database.sketches = {} as any; });
});

describe('lane-addressed wires', () => {
  it('puts the lane on the endpoint, leaving the field name alone', () => {
    seed();
    appController.connectWire(lfoOut(), translate(1));
    expect(wires()).toHaveLength(1);
    expect(wires()[0].dest).toEqual({ instanceKey: 'tf', field: 'translate', lane: 1 });
  });

  it('omits the lane entirely for a whole-field wire', () => {
    seed();
    appController.connectWire(lfoOut(), translate());
    expect(wires()[0].dest).toEqual({ instanceKey: 'tf', field: 'translate' });
    expect('lane' in wires()[0].dest).toBe(false);
  });

  it('two lanes of one field are two wires, not one replacing the other', () => {
    seed();
    appController.connectWire(lfoOut(), translate(0));
    appController.connectWire(lfoOut(), translate(1));
    expect(wires()).toHaveLength(2);
    expect(wires().map((w) => w.dest.lane).sort()).toEqual([0, 1]);
  });

  it('re-dragging the SAME lane still replaces', () => {
    seed();
    appController.connectWire(lfoOut(), translate(1));
    appController.connectWire(lfoOut(), translate(1));
    expect(wires()).toHaveLength(1);
  });

  it('a whole-field wire and a lane wire coexist', () => {
    seed();
    appController.connectWire(lfoOut(), translate());
    appController.connectWire(lfoOut(), translate(0));
    expect(wires()).toHaveLength(2);
  });

  it('a vector destination defaults to replace, a scalar one to add', () => {
    // Vec wires ignored `combine` entirely before lanes existed, i.e. they
    // behaved as replace. Defaulting them to `add` would quietly start adding
    // to the authored colour/position.
    seed();
    appController.connectWire(lfoOut(), translate(1));
    expect(wires()[0].combine).toBe('replace');

    runInAction(() => { appState.database.sketches.sk.wires = []; });
    appController.connectWire(
      lfoOut(),
      field({ chainIdx: 1, fieldPath: 'rotation', schemaDef: { type: 'float', io: 1 } }),
    );
    expect(wires()[0].combine).toBe('add');
  });
});
