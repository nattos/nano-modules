/**
 * The math shapers' adjustable input count.
 *
 * Arity is a VALUE (`input_count`), not a schema shape — a schema is published
 * once per module type. So the count has to do three things the schema can't:
 * hide the inputs past it, drop the wires that were landing on them, and undo
 * as one step. These pin all three, plus the rule that resolves the hidden set
 * synchronously from the document so a card never reflows on load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { ideColumnAdapter } from './ide-column-adapter';
import { mathHiddenFields, mathInputCount, MATH_MAX_INPUTS } from './math-nodes';

const sk = () => appState.database.sketches['sk'] as any;

const ADD = {
  id: 'mod.shaper.add', key: 'mod.shaper.add', name: 'Add', version: '1.0.0', params: [], io: [],
  schema: {
    ...Object.fromEntries(Array.from({ length: MATH_MAX_INPUTS }, (_, i) =>
      [`input_${i + 1}`, { type: 'float', io: i === 0 ? 5 : 9, magnitude: 'unsigned', min: 0, max: 1 }])),
    input_count: { type: 'int', io: 9, min: 2, max: MATH_MAX_INPUTS, default: 2 },
    output: { type: 'float', io: 6, magnitude: 'unsigned' },
  },
};
const LFO = {
  id: 'mod.source.lfo', key: 'mod.source.lfo', name: 'lfo', version: '1.0.0', params: [], io: [],
  schema: { output: { type: 'float', io: 2, magnitude: 'signed' } },
};

/** lfo1..lfo4 each wired into one of add's inputs, with the count at 5. */
function seed(count = 5) {
  runInAction(() => {
    appState.local.plugins = [ADD, LFO] as any;
    appState.local.engine.hiddenFields = {};
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo1' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo2' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo3' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo4' },
          { type: 'module', module_type: 'mod.shaper.add', instance_key: 'add1' },
        ],
        wires: [
          { id: 'w1', src: { instanceKey: 'lfo1', field: 'output' }, dest: { instanceKey: 'add1', field: 'input_1' } },
          { id: 'w2', src: { instanceKey: 'lfo2', field: 'output' }, dest: { instanceKey: 'add1', field: 'input_2' } },
          { id: 'w3', src: { instanceKey: 'lfo3', field: 'output' }, dest: { instanceKey: 'add1', field: 'input_4' } },
          { id: 'w4', src: { instanceKey: 'lfo4', field: 'output' }, dest: { instanceKey: 'add1', field: 'input_5' } },
        ],
        instances: {
          add1: { module_type: 'mod.shaper.add', state: { input_count: count, input_5: 0.75 } },
        },
      },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

const wireIds = () => sk().wires.map((w: any) => w.id);

describe('mathHiddenFields', () => {
  it('hides every input past the count', () => {
    expect(mathHiddenFields({ input_count: 3 }))
      .toEqual(['input_count', 'input_4', 'input_5', 'input_6', 'input_7', 'input_8']);
    expect(mathHiddenFields({ input_count: MATH_MAX_INPUTS })).toEqual(['input_count']);
  });

  it('always hides input_count itself — it belongs in the gear panel', () => {
    expect(mathHiddenFields({ input_count: 2 })).toContain('input_count');
  });

  it('clamps a missing, bogus or out-of-range count to the schema range', () => {
    expect(mathInputCount(undefined)).toBe(2);
    expect(mathInputCount({})).toBe(2);
    expect(mathInputCount({ input_count: 99 })).toBe(MATH_MAX_INPUTS);
    expect(mathInputCount({ input_count: 0 })).toBe(2);
    expect(mathInputCount({ input_count: Number.NaN })).toBe(2);
  });
});

describe('the card resolves its input rows from the DOCUMENT', () => {
  it('hides the right inputs with no engine involvement at all', () => {
    seed(3);
    const p = ideColumnAdapter.data.getPlugin('mod.shaper.add', 'add1')!;
    expect(p.schema!.input_3.hidden).toBeFalsy();
    expect(p.schema!.input_4.hidden).toBe(true);
    expect(p.schema!.input_count.hidden).toBe(true);
  });

  it('gives two add nodes with different counts their own field sets', () => {
    seed(3);
    runInAction(() => {
      sk().instances.add2 = { module_type: 'mod.shaper.add', state: { input_count: 6 } };
    });
    const a = ideColumnAdapter.data.getPlugin('mod.shaper.add', 'add1')!;
    const b = ideColumnAdapter.data.getPlugin('mod.shaper.add', 'add2')!;
    expect(a.schema!.input_5.hidden).toBe(true);
    expect(b.schema!.input_5.hidden).toBeFalsy();
  });
});

describe('setEffectVisibilityParam', () => {
  beforeEach(() => seed(5));

  it('drops exactly the wires landing on inputs the new count hides', () => {
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', 3);
    // input_4 (w3) and input_5 (w4) are now hidden; input_1/input_2 survive.
    expect(wireIds()).toEqual(['w1', 'w2']);
    expect(sk().instances.add1.state.input_count).toBe(3);
  });

  it('leaves every wire alone when the count GROWS', () => {
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', MATH_MAX_INPUTS);
    expect(wireIds()).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('never touches wires bound for another instance', () => {
    runInAction(() => {
      sk().instances.add2 = { module_type: 'mod.shaper.add', state: { input_count: 8 } };
      sk().chain.push({ type: 'module', module_type: 'mod.shaper.add', instance_key: 'add2' });
      sk().wires.push({ id: 'other', src: { instanceKey: 'lfo1', field: 'output' },
        dest: { instanceKey: 'add2', field: 'input_7' } });
    });
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', 2);
    expect(wireIds()).toContain('other');
  });

  it('undoes the count AND the wires as a single step', () => {
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', 3);
    expect(wireIds()).toEqual(['w1', 'w2']);
    appController.undo();
    expect(sk().instances.add1.state.input_count).toBe(5);
    expect(wireIds()).toEqual(['w1', 'w2', 'w3', 'w4']);
  });

  it('keeps the stored VALUE of an input it hides, so shrink/grow round-trips', () => {
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', 2);
    expect(sk().instances.add1.state.input_5).toBe(0.75);
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', 5);
    expect(sk().instances.add1.state.input_5).toBe(0.75);
    // The wire, unlike the value, is really gone — growing back doesn't revive it.
    expect(wireIds()).toEqual(['w1', 'w2']);
  });

  it('refreshes the execution order after dropping wires', () => {
    appController.setEffectVisibilityParam('sk', 0, 4, 'input_count', 3);
    // Chain order already satisfies the remaining wires, so the key is omitted.
    expect(sk().execOrder).toBeUndefined();
  });
});
