/**
 * Deleting a node HEALS the wire that ran through it.
 *
 * The inverse of insert-on-wire.test.ts: an effect with exactly one incoming
 * and one outgoing wire of matching data kind is bridged out of the way, so
 * removing a spliced-in shaper gives back the routing that existed before the
 * splice. Anything ambiguous (two inputs, mismatched kinds) falls back to the
 * old behaviour — the wires touching the removed instance just go.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';

const sk = () => appState.database.sketches['sk'] as any;

const SHAPER = {
  id: 'mod.shaper.curve', name: 'curve', params: [], io: [],
  schema: {
    input: { type: 'float', io: 5, magnitude: 'inherit' },
    output: { type: 'float', io: 2, magnitude: 'inherit' },
  },
};
const LFO = {
  id: 'mod.source.lfo', name: 'lfo', params: [], io: [],
  schema: { output: { type: 'float', io: 2, magnitude: 'signed' } },
};
const BC = {
  id: 'color.tone.brightness_contrast', name: 'bc', params: [], io: [],
  schema: {
    brightness: { type: 'float', io: 1 },
    tex_in: { type: 'texture', io: 1, order: 0 },
    tex_out: { type: 'texture', io: 2, order: 9 },
  },
};
/** Float in, image out — nothing that crosses it can be bridged. */
const RAMP = {
  id: 'gen.ramp', name: 'ramp', params: [], io: [],
  schema: {
    input: { type: 'float', io: 1 },
    tex_out: { type: 'texture', io: 2, order: 9 },
  },
};

const chainOf = (...specs: Array<[string, string]>) =>
  specs.map(([module_type, instance_key]) => ({ type: 'module', module_type, instance_key }));

function seed(chain: any[], wires: any[]) {
  runInAction(() => {
    appState.local.plugins = [SHAPER, LFO, BC, RAMP] as any;
    appState.database.sketches = {
      sk: { anchor: null, chain, wires, instances: {} },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

/** lfo → shaper → bc.brightness, the shape a wire splice leaves behind. */
function seedSpliced(destField = 'brightness') {
  seed(chainOf(['mod.source.lfo', 'lfo'], ['color.tone.brightness_contrast', 'bc'],
               ['mod.shaper.curve', 'sh']),
       [
         { id: 'w1', src: { instanceKey: 'lfo', field: 'output' },
           dest: { instanceKey: 'sh', field: 'input' }, magnitude: 'absolute' },
         { id: 'w2', src: { instanceKey: 'sh', field: 'output' },
           dest: { instanceKey: 'bc', field: destField },
           combine: 'add', mixFactor: 0.5, magnitude: 'signed', mod: { scale: 0.25 } },
       ]);
}

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.plugins = [];
    appState.local.multiSelection = [];
    appState.local.selection = null;
  });
});

describe('deleting a node heals the wire through it', () => {
  beforeEach(() => { seedSpliced(); });

  it('bridges the producer straight to the consumer', () => {
    appController.removeEffectFromChain('sk', 0, 2);
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0].src).toEqual({ instanceKey: 'lfo', field: 'output' });
    expect(sk().wires[0].dest).toEqual({ instanceKey: 'bc', field: 'brightness' });
  });

  it('keeps the OUTGOING wire s id and shaping — it still lands the same way', () => {
    appController.removeEffectFromChain('sk', 0, 2);
    const [w] = sk().wires;
    expect(w.id).toBe('w2');
    expect(w.mod).toEqual({ scale: 0.25 });
    expect(w.combine).toBe('add');
    expect(w.mixFactor).toBe(0.5);
    expect(w.magnitude).toBe('signed');
  });

  it('bridges onto a reserved card control too', () => {
    seedSpliced('__opacity__');
    appController.removeEffectFromChain('sk', 0, 2);
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0].dest).toEqual({ instanceKey: 'bc', field: '__opacity__' });
  });

  it('refreshes the execution order and undoes as one step', () => {
    appController.removeEffectFromChain('sk', 0, 2);
    expect(sk().execOrder).toBeUndefined();   // back to plain chain order
    appController.undo();
    expect(sk().wires).toHaveLength(2);
    expect(sk().wires[0].id).toBe('w1');
    expect(sk().wires[1].id).toBe('w2');
  });

  it('bridges a DEVICE source through, the same as a module one', () => {
    seed(chainOf(['color.tone.brightness_contrast', 'bc'], ['mod.shaper.curve', 'sh']),
         [
           { id: 'w1', src: { instanceKey: 'midi:dev1', field: 'cc1' },
             dest: { instanceKey: 'sh', field: 'input' } },
           { id: 'w2', src: { instanceKey: 'sh', field: 'output' },
             dest: { instanceKey: 'bc', field: 'brightness' } },
         ]);
    appController.removeEffectFromChain('sk', 0, 1);
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0].src).toEqual({ instanceKey: 'midi:dev1', field: 'cc1' });
  });
});

describe('deleting a node that cannot be healed', () => {
  it('drops the wires when two producers feed it', () => {
    seed(chainOf(['mod.source.lfo', 'lfo'], ['mod.source.lfo', 'lfo2'],
                 ['color.tone.brightness_contrast', 'bc'], ['mod.shaper.curve', 'sh']),
         [
           { id: 'w1', src: { instanceKey: 'lfo', field: 'output' },
             dest: { instanceKey: 'sh', field: 'input' } },
           { id: 'w1b', src: { instanceKey: 'lfo2', field: 'output' },
             dest: { instanceKey: 'sh', field: 'input' } },
           { id: 'w2', src: { instanceKey: 'sh', field: 'output' },
             dest: { instanceKey: 'bc', field: 'brightness' } },
         ]);
    appController.removeEffectFromChain('sk', 0, 3);
    expect(sk().wires).toHaveLength(0);
  });

  it('drops the wires when the two ends carry different kinds', () => {
    // float in, texture out: there is no wire that could join lfo to bc.tex_in.
    seed(chainOf(['mod.source.lfo', 'lfo'], ['color.tone.brightness_contrast', 'bc'],
                 ['gen.ramp', 'ramp']),
         [
           { id: 'w1', src: { instanceKey: 'lfo', field: 'output' },
             dest: { instanceKey: 'ramp', field: 'input' } },
           { id: 'w2', src: { instanceKey: 'ramp', field: 'tex_out' },
             dest: { instanceKey: 'bc', field: 'tex_in' } },
         ]);
    appController.removeEffectFromChain('sk', 0, 2);
    expect(sk().wires).toHaveLength(0);
  });

  it('bridges a TEXTURE pass-through', () => {
    seed(chainOf(['color.tone.brightness_contrast', 'a'],
                 ['color.tone.brightness_contrast', 'mid'],
                 ['color.tone.brightness_contrast', 'b']),
         [
           { id: 'w1', src: { instanceKey: 'a', field: 'tex_out' },
             dest: { instanceKey: 'mid', field: 'tex_in' } },
           { id: 'w2', src: { instanceKey: 'mid', field: 'tex_out' },
             dest: { instanceKey: 'b', field: 'tex_in' } },
         ]);
    appController.removeEffectFromChain('sk', 0, 1);
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0].src).toEqual({ instanceKey: 'a', field: 'tex_out' });
    expect(sk().wires[0].dest).toEqual({ instanceKey: 'b', field: 'tex_in' });
  });

  it('ignores a self-loop when counting the open ends', () => {
    seed(chainOf(['mod.source.lfo', 'lfo'], ['color.tone.brightness_contrast', 'bc'],
                 ['mod.shaper.curve', 'sh']),
         [
           { id: 'w1', src: { instanceKey: 'lfo', field: 'output' },
             dest: { instanceKey: 'sh', field: 'input' } },
           { id: 'wself', src: { instanceKey: 'sh', field: 'output' },
             dest: { instanceKey: 'sh', field: 'input' } },
           { id: 'w2', src: { instanceKey: 'sh', field: 'output' },
             dest: { instanceKey: 'bc', field: 'brightness' } },
         ]);
    appController.removeEffectFromChain('sk', 0, 2);
    expect(sk().wires.map((w: any) => w.id)).toEqual(['w2']);
    expect(sk().wires[0].src).toEqual({ instanceKey: 'lfo', field: 'output' });
  });
});

describe('deleting a RUN of nodes', () => {
  it('composes the bridges front-to-back', () => {
    seed(chainOf(['mod.source.lfo', 'lfo'], ['color.tone.brightness_contrast', 'bc'],
                 ['mod.shaper.curve', 's1'], ['mod.shaper.curve', 's2']),
         [
           { id: 'w1', src: { instanceKey: 'lfo', field: 'output' },
             dest: { instanceKey: 's1', field: 'input' } },
           { id: 'w2', src: { instanceKey: 's1', field: 'output' },
             dest: { instanceKey: 's2', field: 'input' } },
           { id: 'w3', src: { instanceKey: 's2', field: 'output' },
             dest: { instanceKey: 'bc', field: 'brightness' } },
         ]);
    appController.removeEffectsFromChain('sk', [2, 3]);
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0].id).toBe('w3');
    expect(sk().wires[0].src).toEqual({ instanceKey: 'lfo', field: 'output' });
    expect(sk().wires[0].dest).toEqual({ instanceKey: 'bc', field: 'brightness' });
  });
});
