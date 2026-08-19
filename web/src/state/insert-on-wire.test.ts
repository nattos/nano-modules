/**
 * Splicing a node into an existing wire (double-click a wire).
 *
 * The contract, mirroring insert-effect.test.ts's for a plain insertion: the
 * node AND the rewiring are ONE continuous edit — cancelling restores the
 * single original wire and removes the node with no history, committing leaves
 * exactly one "Add <type>" undo point. Plus the routing rules: which ports the
 * new node binds to, and which half of the split keeps the wire's shaping.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain } from '../sketch-types';

const sk = () => appState.database.sketches['sk'] as any;
const histLen = () => appController.history.history.length;

const SHAPER = {
  id: 'mod.shaper.curve', name: 'curve', params: [], io: [],
  schema: {
    input: { type: 'float', io: 5, magnitude: 'inherit' },
    output: { type: 'float', io: 2, magnitude: 'inherit' },
  },
};
const BLUR = {
  id: 'filter.blur', name: 'blur', params: [], io: [],
  schema: {
    tex_in: { type: 'texture', io: 1, order: 0 },
    tex_out: { type: 'texture', io: 2, order: 9 },
    radius: { type: 'float', io: 1 },
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

function seed(wire: any, plugins: any[] = [SHAPER, BLUR, LFO, BC], chain?: any[]) {
  runInAction(() => {
    appState.local.plugins = plugins as any;
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: chain ?? [
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo' },
          { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc' },
        ],
        wires: [wire],
        instances: {},
      },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

const floatWire = () => ({
  id: 'w0',
  src: { instanceKey: 'lfo', field: 'output' },
  dest: { instanceKey: 'bc', field: 'brightness' },
  combine: 'add', mixFactor: 0.5, magnitude: 'signed',
  mod: { scale: 0.25 },
});

/** An image chain: one effect's output texture feeding the next one's input. */
const textureChain = () => [
  { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'a' },
  { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'b' },
];
const textureWire = () => ({
  id: 'w0',
  src: { instanceKey: 'a', field: 'tex_out' },
  dest: { instanceKey: 'b', field: 'tex_in' },
});

beforeEach(() => { seed(floatWire()); });
afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.plugins = [];
    appState.local.selection = null;
  });
});

describe('splicing a node into a wire', () => {
  it('replaces the wire with exactly two, through the new node', () => {
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 10, y: 20 });
    expect(started).not.toBeNull();
    const key = started!.instanceKey;
    const wires = sk().wires;
    expect(wires).toHaveLength(2);
    expect(wires[0].src).toEqual({ instanceKey: 'lfo', field: 'output' });
    expect(wires[0].dest).toEqual({ instanceKey: key, field: 'input' });
    expect(wires[1].src).toEqual({ instanceKey: key, field: 'output' });
    expect(wires[1].dest).toEqual({ instanceKey: 'bc', field: 'brightness' });
    started!.edit.cancel();
  });

  it('lands the node on the canvas at the requested placement', () => {
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 42, y: 84 })!;
    const entry = sketchChain(sk()).at(-1)!;
    expect(entry.instance_key).toBe(started.instanceKey);
    expect(entry.canvas).toEqual({ x: 42, y: 84 });
    started.edit.cancel();
  });

  it('carries the wire s shaping onto the SECOND half and passes the first through', () => {
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 0, y: 0 })!;
    const [first, second] = sk().wires;
    // Pass-through: the value reaches the new node unscaled.
    expect(first.magnitude).toBe('absolute');
    expect(first.mod).toBeUndefined();
    // The tuned shaping still lands on the same dest, the same way.
    expect(second.mod).toEqual({ scale: 0.25 });
    expect(second.combine).toBe('add');
    expect(second.mixFactor).toBe(0.5);
    expect(second.magnitude).toBe('signed');
    started.edit.cancel();
  });

  it('routes a TEXTURE wire through texture ports', () => {
    seed(textureWire(), [SHAPER, BLUR, LFO, BC], textureChain());
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 0, y: 0 })!;
    const key = started.instanceKey;
    expect(sketchChain(sk()).at(-1)!.module_type).toBe('filter.blur');
    expect(sk().wires[0].dest).toEqual({ instanceKey: key, field: 'tex_in' });
    expect(sk().wires[1].src).toEqual({ instanceKey: key, field: 'tex_out' });
    started.edit.cancel();
  });

  it('refuses when no available module can carry the wire', () => {
    // Only a SOURCE is available: nothing has a float input to splice through.
    seed(floatWire(), [LFO]);
    expect(appController.beginInsertOnWire('sk', 'w0', { x: 0, y: 0 })).toBeNull();
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0].id).toBe('w0');
  });

  it('previews with no undo point and commits as exactly one', () => {
    const before = histLen();
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 0, y: 0 })!;
    expect(histLen()).toBe(before);
    started.edit.accept();
    expect(histLen()).toBe(before + 1);
  });

  it('cancel restores the single original wire and removes the node', () => {
    const before = histLen();
    const chainBefore = sketchChain(sk()).length;
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 0, y: 0 })!;
    started.edit.cancel();
    expect(histLen()).toBe(before);
    expect(sketchChain(sk())).toHaveLength(chainBefore);
    expect(sk().wires).toHaveLength(1);
    expect(sk().wires[0]).toEqual(floatWire());
  });

  it('re-pointing the type rewires onto the new module s ports', () => {
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 5, y: 5 })!;
    appController.updateInsertOnWire(
      started.edit, 'sk', 'w0', started.instanceKey, { x: 5, y: 5 },
      // The recipe re-runs wholesale, so the ids must be the same ones.
      [sk().wires[0].id, sk().wires[1].id], 'filter.blur');
    // filter.blur cannot carry a FLOAT wire, so the recipe declines and the
    // sketch stays as it was before this edit began.
    expect(sk().wires).toHaveLength(1);
    started.edit.cancel();
  });

  it('keeps the execution order fresh across the splice', () => {
    const started = appController.beginInsertOnWire('sk', 'w0', { x: 0, y: 0 })!;
    started.edit.accept();
    // lfo → new → bc: the spliced node runs between them.
    expect(sk().execOrder).toEqual(['lfo', started.instanceKey, 'bc']);
  });
});
