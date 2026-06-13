import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { FieldConnectInfo } from './controller';

function seedSketch() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        rails: [{ id: 'rail_s', name: 'Sketch Rail', dataType: 'float' }],
        columns: [
          {
            name: 'c0',
            rails: [{ id: 'rail_c', name: 'Col Rail', dataType: 'float' }],
            chain: [{ type: 'module', module_type: 'video.x', instance_key: 'i0' }],
          },
        ],
      },
    } as any;
  });
}

const field = (over: Partial<FieldConnectInfo> = {}): FieldConnectInfo => ({
  sketchId: 'sk', colIdx: 0, chainIdx: 0, fieldPath: 'brightness',
  isOutput: false, viewportY: 0, schemaDef: null, ...over,
});

const taps = () => (appState.database.sketches.sk.columns[0].chain[0] as any).taps ?? [];

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

describe('connectFieldToRail', () => {
  it('adds a read tap for an input field', () => {
    seedSketch();
    appController.connectFieldToRail(field(), 'rail_c');
    expect(taps()).toContainEqual({ railId: 'rail_c', fieldPath: 'brightness', direction: 'read' });
  });

  it('replaces an existing read tap on the same input field', () => {
    seedSketch();
    appController.connectFieldToRail(field(), 'rail_c');
    appController.connectFieldToRail(field(), 'rail_s');
    const reads = taps().filter((t: any) => t.fieldPath === 'brightness' && t.direction === 'read');
    expect(reads).toEqual([{ railId: 'rail_s', fieldPath: 'brightness', direction: 'read' }]);
  });

  it('adds a write tap for an output field', () => {
    seedSketch();
    appController.connectFieldToRail(field({ fieldPath: 'level', isOutput: true }), 'rail_c');
    expect(taps()).toContainEqual({ railId: 'rail_c', fieldPath: 'level', direction: 'write' });
  });
});

describe('renameRail', () => {
  it('renames a sketch-scoped rail', () => {
    seedSketch();
    appController.renameRail('sk', 'sketch', 'rail_s', 'Renamed S');
    expect(appState.database.sketches.sk.rails!.find(r => r.id === 'rail_s')!.name).toBe('Renamed S');
  });

  it('renames a column-scoped rail', () => {
    seedSketch();
    appController.renameRail('sk', 0, 'rail_c', 'Renamed C');
    expect(appState.database.sketches.sk.columns[0].rails!.find(r => r.id === 'rail_c')!.name).toBe('Renamed C');
  });
});

// Two-module column so writer/reader resolution has distinct endpoints.
function seedWireSketch() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        columns: [{
          name: 'c0',
          chain: [
            { type: 'module', module_type: 'data.lfo', instance_key: 'lfo' },
            { type: 'module', module_type: 'video.bc', instance_key: 'bc' },
          ],
        }],
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
