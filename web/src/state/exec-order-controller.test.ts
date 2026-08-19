/**
 * The execution order is DERIVED state stored in the document, so every
 * controller mutation that touches the chain or the wires must refresh it
 * (AppController.reorderExec). These tests drive the real mutation paths with a
 * canvas entry present — the only situation where the order is non-trivial —
 * and pin the "omitted unless it differs from chain order" contract.
 *
 * A missed call site also trips the dev-only warnIfExecOrderStale tripwire in
 * postRecordHook; these tests fail loudly instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import type { FieldConnectInfo } from './controller';
import { sketchChain } from '../sketch-types';

const sk = () => appState.database.sketches['sk'] as any;

const field = (over: Partial<FieldConnectInfo> = {}): FieldConnectInfo => ({
  sketchId: 'sk', colIdx: 0, chainIdx: 0, fieldPath: 'brightness',
  isOutput: false, viewportY: 0, schemaDef: null, ...over,
});

/** Two linear effects plus one canvas node parked at the chain tail. */
function seed() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'video.bc', instance_key: 'l0' },
          { type: 'module', module_type: 'video.bc', instance_key: 'l1' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'cv',
            canvas: { x: 20, y: 40 } },
        ],
        wires: [],
        instances: {},
      },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

afterEach(() => {
  runInAction(() => {
    appState.database.sketches = {} as any;
    appState.local.selection = null;
    appState.local.multiSelection = [];
  });
});

describe('execOrder is maintained by the controller', () => {
  it('stays omitted while nothing crosses the partition', () => {
    seed();
    appController.addEffectToChain('sk', 0, 1, 'video.bc');
    expect(sk().execOrder).toBeUndefined();
  });

  it('connectWire hoists a canvas producer above its linear consumer', () => {
    seed();
    appController.connectWire(
      field({ chainIdx: 2, fieldPath: 'value', isOutput: true }),
      field({ chainIdx: 0, fieldPath: 'brightness' }));
    expect(sk().execOrder).toEqual(['cv', 'l0', 'l1']);
  });

  it('removeWire drops the order back to chain order — and deletes the key', () => {
    seed();
    appController.connectWire(
      field({ chainIdx: 2, fieldPath: 'value', isOutput: true }),
      field({ chainIdx: 0, fieldPath: 'brightness' }));
    const wireId = sk().wires[0].id;
    appController.removeWire('sk', wireId);
    expect(sk().execOrder).toBeUndefined();
  });

  it('removing the canvas effect also retires the order it forced', () => {
    seed();
    appController.connectWire(
      field({ chainIdx: 2, fieldPath: 'value', isOutput: true }),
      field({ chainIdx: 0, fieldPath: 'brightness' }));
    expect(sk().execOrder).toEqual(['cv', 'l0', 'l1']);
    appController.removeEffectFromChain('sk', 0, 2);
    expect(sk().execOrder).toBeUndefined();
  });

  it('inserting a linear effect keeps the canvas node ordered ahead of its dest', () => {
    seed();
    appController.connectWire(
      field({ chainIdx: 2, fieldPath: 'value', isOutput: true }),
      field({ chainIdx: 1, fieldPath: 'brightness' }));
    expect(sk().execOrder).toEqual(['l0', 'cv', 'l1']);
    appController.addEffectToChain('sk', 0, 0, 'video.bc');
    const inserted = sketchChain(sk())[0].instance_key;
    expect(sk().execOrder).toEqual([inserted, 'l0', 'cv', 'l1']);
  });

  it('undo restores the previous order along with the wire', () => {
    seed();
    appController.connectWire(
      field({ chainIdx: 2, fieldPath: 'value', isOutput: true }),
      field({ chainIdx: 0, fieldPath: 'brightness' }));
    expect(sk().execOrder).toEqual(['cv', 'l0', 'l1']);
    appController.history.undo();
    expect(sk().wires).toHaveLength(0);
    expect(sk().execOrder).toBeUndefined();
  });
});
