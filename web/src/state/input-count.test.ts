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
import { mathHiddenFields, mathInputCount, MATH_MAX_INPUTS,
         sliceHiddenFields, sliceOutputCount, sliceSpreadValues,
         SLICE_MAX_OUTPUTS } from './math-nodes';

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

// ──────────────────────────────────────────────────────────────────────────
// mod.shaper.slice — the same count, governing whole LANES (window + curve +
// output). Two things are new here and neither is exercised above: the count
// hides an OUTPUT, so the wires it orphans leave the card rather than arrive
// at it; and a new count implies new window values, written in the same step.
// ──────────────────────────────────────────────────────────────────────────

const SLICE = {
  id: 'mod.shaper.slice', key: 'mod.shaper.slice', name: 'Slice', version: '1.0.0',
  params: [], io: [],
  schema: {
    input: { type: 'float', io: 5, magnitude: 'unsigned', min: 0, max: 1 },
    beyond: { type: 'int', io: 9, min: 0, max: 1, default: 0 },
    ...Object.fromEntries(Array.from({ length: SLICE_MAX_OUTPUTS }, (_, i) => [
      `start_${i + 1}`, { type: 'float', io: 9, raw: true, min: 0, max: 1 }])),
    ...Object.fromEntries(Array.from({ length: SLICE_MAX_OUTPUTS }, (_, i) => [
      `end_${i + 1}`, { type: 'float', io: 9, raw: true, min: 0, max: 1 }])),
    ...Object.fromEntries(Array.from({ length: SLICE_MAX_OUTPUTS }, (_, i) => [
      `curve_${i + 1}`, { type: 'string', io: 9, default: '[0,0,0,1,1,0]' }])),
    input_count: { type: 'int', io: 9, min: 2, max: SLICE_MAX_OUTPUTS, default: 2 },
    ...Object.fromEntries(Array.from({ length: SLICE_MAX_OUTPUTS }, (_, i) => [
      `out_${i + 1}`, { type: 'float', io: i === 0 ? 6 : 10, magnitude: 'unsigned', min: 0, max: 1 }])),
  },
};

/** A slice with `count` lanes, out_1 and out_5 each driving a downstream input. */
function seedSlice(count = 6) {
  runInAction(() => {
    appState.local.plugins = [SLICE, ADD, LFO] as any;
    appState.local.engine.hiddenFields = {};
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'mod.shaper.slice', instance_key: 'sl1' },
          { type: 'module', module_type: 'mod.shaper.add', instance_key: 'add1' },
        ],
        wires: [
          { id: 'lane1', src: { instanceKey: 'sl1', field: 'out_1' },
            dest: { instanceKey: 'add1', field: 'input_1' } },
          { id: 'lane5', src: { instanceKey: 'sl1', field: 'out_5' },
            dest: { instanceKey: 'add1', field: 'input_2' } },
        ],
        instances: {
          sl1: { module_type: 'mod.shaper.slice', state: { input_count: count, curve_5: '[0,1,0,1,0,0]' } },
          add1: { module_type: 'mod.shaper.add', state: { input_count: 2 } },
        },
      },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

describe('sliceHiddenFields', () => {
  it('hides a lane WHOLE — window, curve and output — past the count', () => {
    const hidden = sliceHiddenFields({ input_count: 3 });
    for (const f of ['start_4', 'end_4', 'curve_4', 'out_4', 'out_8']) {
      expect(hidden).toContain(f);
    }
    for (const f of ['start_3', 'end_3', 'curve_3', 'out_3', 'input']) {
      expect(hidden).not.toContain(f);
    }
    expect(hidden).toContain('input_count');
  });

  it('clamps a missing or bogus count like its siblings do', () => {
    expect(sliceOutputCount(undefined)).toBe(2);
    expect(sliceOutputCount({ input_count: 99 })).toBe(SLICE_MAX_OUTPUTS);
    expect(sliceOutputCount({ input_count: Number.NaN })).toBe(2);
  });

  it('drops the output pip too, not just the parameter rows', () => {
    seedSlice(3);
    const p = ideColumnAdapter.data.getPlugin('mod.shaper.slice', 'sl1')!;
    expect(p.schema!.out_3.hidden).toBeFalsy();
    expect(p.schema!.out_4.hidden).toBe(true);
  });
});

describe('sliceSpreadValues', () => {
  it('spreads the ACTIVE lanes evenly and leaves the rest alone', () => {
    expect(sliceSpreadValues(4)).toEqual({
      start_1: 0, end_1: 0.25, start_2: 0.25, end_2: 0.5,
      start_3: 0.5, end_3: 0.75, start_4: 0.75, end_4: 1,
    });
    // Lane 5's window survives a trip down to 4 and back up.
    expect(Object.keys(sliceSpreadValues(4))).not.toContain('start_5');
  });

  it('leaves no gap or overlap — each lane starts where the last ended', () => {
    const v = sliceSpreadValues(7);
    for (let i = 1; i < 7; i++) expect(v[`start_${i + 1}`]).toBeCloseTo(v[`end_${i}`], 12);
    expect(v.start_1).toBe(0);
    expect(v.end_7).toBe(1);
  });
});

describe('lowering the slice count', () => {
  beforeEach(() => seedSlice(6));

  it('drops a wire LEAVING a lane the new count hides', () => {
    // The math nodes only ever orphan wires arriving at a hidden input; a lane's
    // output is a source, and an arc from a pip that no longer renders is just
    // as orphaned.
    appController.setEffectVisibilityParam('sk', 0, 0, 'input_count', 3);
    expect(wireIds()).toEqual(['lane1']);
  });

  it('re-spreads the windows in the SAME undo step as the count', () => {
    appController.setEffectVisibilityParam('sk', 0, 0, 'input_count', 4,
                                           sliceSpreadValues(4));
    const st = () => sk().instances.sl1.state;
    expect(st().input_count).toBe(4);
    expect(st().end_1).toBe(0.25);
    expect(st().start_4).toBe(0.75);

    appController.undo();
    expect(st().input_count).toBe(6);
    expect(st().end_1).toBeUndefined();       // back to the schema default
    expect(wireIds()).toEqual(['lane1', 'lane5']);
  });

  it('keeps a hidden lane\'s curve, so shrink/grow round-trips', () => {
    appController.setEffectVisibilityParam('sk', 0, 0, 'input_count', 2);
    expect(sk().instances.sl1.state.curve_5).toBe('[0,1,0,1,0,0]');
    appController.setEffectVisibilityParam('sk', 0, 0, 'input_count', 6);
    expect(sk().instances.sl1.state.curve_5).toBe('[0,1,0,1,0,0]');
    expect(wireIds()).toEqual(['lane1']);     // the wire, unlike the curve, is gone
  });
});
