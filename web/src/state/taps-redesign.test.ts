import { describe, it, expect, afterEach, vi } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { FieldConnectInfo } from './controller';

const field = (over: Partial<FieldConnectInfo> = {}): FieldConnectInfo => ({
  sketchId: 'sk', colIdx: 0, chainIdx: 0, fieldPath: 'brightness',
  isOutput: false, viewportY: 0, schemaDef: null, ...over,
});

afterEach(() => {
  runInAction(() => {
    appState.local.selection = null;
    appState.local.queuedSelectionPath = null;
    appState.local.tappingMode = false;
    appState.database.sketches = {} as any;
  });
});

describe('selection unification', () => {
  it('selectField routes through the Selectable registry with a field/ path', () => {
    appController.defineSelectable({ path: 'field/sk/0/0/brightness', label: 'brightness' });
    appController.selectField('sk/0/0/brightness');
    expect(appState.local.selection?.path).toBe('field/sk/0/0/brightness');
    expect(appController.selectedFieldKey()).toBe('sk/0/0/brightness');
  });

  it('selectedFieldKey is null when an effect (not a field) is selected', () => {
    appController.defineSelectable({ path: 'effect/sk/0/0', label: 'fx' });
    appController.select('effect/sk/0/0');
    expect(appController.selectedFieldKey()).toBeNull();
  });

  it('leaving taps mode clears a field selection but keeps an effect selection', () => {
    appController.defineSelectable({ path: 'field/sk/0/0/brightness', label: 'b' });
    appController.selectField('sk/0/0/brightness');
    appController.setTappingMode(false);
    expect(appState.local.selection).toBeNull();

    appController.defineSelectable({ path: 'effect/sk/0/0', label: 'fx' });
    appController.select('effect/sk/0/0');
    appController.setTappingMode(false);
    expect(appState.local.selection?.path).toBe('effect/sk/0/0');
  });
});

// Two-module chain so writer/reader resolution has distinct endpoints.
function seedWireSketch() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'data.lfo', instance_key: 'lfo' },
          { type: 'module', module_type: 'video.bc', instance_key: 'bc' },
        ],
      },
    } as any;
  });
}
const wires = () => (appState.database.sketches.sk.wires ?? []) as any[];

describe('connectWire', () => {
  it('creates a wire from the output field (src) to the input field (dest)', () => {
    seedWireSketch();
    appController.connectWire(
      field({ chainIdx: 0, fieldPath: 'output', isOutput: true }),   // lfo.output
      field({ chainIdx: 1, fieldPath: 'brightness', isOutput: false }), // bc.brightness
    );
    expect(wires()).toHaveLength(1);
    expect(wires()[0]).toMatchObject({
      src: { instanceKey: 'lfo', field: 'output' },
      dest: { instanceKey: 'bc', field: 'brightness' },
    });
  });

  it('resolves writer/reader by stack position when both are same-direction', () => {
    seedWireSketch();
    // Neither flagged output: the higher one (lower viewportY) is the writer.
    appController.connectWire(
      field({ chainIdx: 1, fieldPath: 'brightness', viewportY: 200 }),
      field({ chainIdx: 0, fieldPath: 'output', viewportY: 100 }),
    );
    expect(wires()[0]).toMatchObject({
      src: { instanceKey: 'lfo', field: 'output' },
      dest: { instanceKey: 'bc', field: 'brightness' },
    });
  });

  it('replaces an existing wire into the same dest field (last wins)', () => {
    seedWireSketch();
    appController.connectWire(
      field({ chainIdx: 0, fieldPath: 'output', isOutput: true }),
      field({ chainIdx: 1, fieldPath: 'brightness' }),
    );
    appController.connectWire(
      field({ chainIdx: 0, fieldPath: 'level', isOutput: true }),
      field({ chainIdx: 1, fieldPath: 'brightness' }),
    );
    expect(wires()).toHaveLength(1);
    expect(wires()[0].src.field).toBe('level');
  });

  it('removeWire drops the wire by id', () => {
    seedWireSketch();
    appController.connectWire(
      field({ chainIdx: 0, fieldPath: 'output', isOutput: true }),
      field({ chainIdx: 1, fieldPath: 'brightness' }),
    );
    appController.removeWire('sk', wires()[0].id);
    expect(wires()).toHaveLength(0);
  });
});

describe('updateWire (scalar wire modulation)', () => {
  const connect = () => {
    seedWireSketch();
    appController.connectWire(
      field({ chainIdx: 0, fieldPath: 'output', isOutput: true }),
      field({ chainIdx: 1, fieldPath: 'brightness' }),
    );
    return wires()[0].id as string;
  };

  it('patches scale into mod, leaving src/dest untouched', () => {
    const id = connect();
    appController.updateWire('sk', id, { mod: { scale: 2 } });
    expect(wires()[0].mod).toEqual({ scale: 2 });
    expect(wires()[0].src).toMatchObject({ instanceKey: 'lfo', field: 'output' });
  });

  it('sets combine + mixFactor as top-level fields', () => {
    const id = connect();
    appController.updateWire('sk', id, { combine: 'mix' });
    appController.updateWire('sk', id, { mixFactor: 0.25 });
    expect(wires()[0].combine).toBe('mix');
    expect(wires()[0].mixFactor).toBe(0.25);
  });

  it('a later patch replaces mod wholesale (callers pre-merge the sub-tree)', () => {
    const id = connect();
    appController.updateWire('sk', id, { mod: { scale: 3, remap: { inMin: 0, inMax: 1, outMin: 0, outMax: 2 } } });
    // Simulate the binding rebuilding the full mod from the current value.
    const cur = wires()[0].mod;
    appController.updateWire('sk', id, { mod: { ...cur, remap: { ...cur.remap, outMax: 5 } } });
    expect(wires()[0].mod.scale).toBe(3);
    expect(wires()[0].mod.remap.outMax).toBe(5);
    expect(wires()[0].mod.remap.inMax).toBe(1);
  });

  it('is a no-op for an unknown wire id', () => {
    connect();
    expect(() => appController.updateWire('sk', 'nope', { mod: { scale: 9 } })).not.toThrow();
    expect(wires()[0].mod).toBeUndefined();
  });

  // Mirror exactly what column-group's wireModBinding does during a slider drag:
  // beginContinuousEdit → update(s) → accept, with patchFor reading the live wire.
  it('continuous edit: preview tracks live and accept is a single undo point', () => {
    const id = connect();
    const scale = () => wires()[0].mod?.scale;
    const patchFor = (v: number) => {
      const mod = wires()[0].mod ?? {};
      return { mod: { ...mod, scale: v } };
    };

    const edit = appController.beginUpdateWire('sk', id, patchFor(1.5));
    expect(scale()).toBe(1.5);                 // begin preview applied to observable
    appController.updateUpdateWire(edit, 'sk', id, patchFor(2.0));
    expect(scale()).toBe(2.0);                 // mid-drag preview tracks
    appController.updateUpdateWire(edit, 'sk', id, patchFor(3.0));
    expect(scale()).toBe(3.0);
    edit.accept();
    expect(scale()).toBe(3.0);                 // committed value

    appController.undo();
    expect(scale()).toBeUndefined();           // ONE undo reverts the whole drag
  });

  it('continuous edit: cancel reverts the preview entirely', () => {
    const id = connect();
    const scale = () => wires()[0].mod?.scale;
    const patchFor = (v: number) => ({ mod: { ...(wires()[0].mod ?? {}), scale: v } });

    const edit = appController.beginUpdateWire('sk', id, patchFor(2.5));
    expect(scale()).toBe(2.5);
    edit.cancel();
    expect(scale()).toBeUndefined();           // back to pre-drag state
  });

  // The longEditHook deliberately skips engine sync during a drag, so a wire-mod
  // long edit must push the previewed sketch to the engine itself — otherwise the
  // rendered output only updates on release (the "continuous edits don't work" bug).
  it('continuous edit pushes the previewed sketch to the engine for live feedback', () => {
    const id = connect();
    const updateSketch = vi.fn();
    appController.setEngine({ updateSketch } as any);
    runInAction(() => { appState.local.availableEffects = [{ id: 'data.lfo' } as any]; });

    const patchFor = (v: number) => ({ mod: { ...(wires()[0].mod ?? {}), scale: v } });
    const edit = appController.beginUpdateWire('sk', id, patchFor(1.5));
    appController.updateUpdateWire(edit, 'sk', id, patchFor(2.5));
    edit.accept();

    // begin + update each push live; the pushed sketch carries the previewed mod.
    expect(updateSketch).toHaveBeenCalled();
    const [pushedId, pushedSketch] = updateSketch.mock.calls.at(-1)!;
    expect(pushedId).toBe('sk');
    expect(pushedSketch.wires[0].mod.scale).toBe(2.5);

    appController.setEngine(undefined as any);
    runInAction(() => { appState.local.availableEffects = []; });
  });
});
