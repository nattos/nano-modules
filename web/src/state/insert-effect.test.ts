/**
 * Insertion-as-continuous-edit semantics (see controller.beginInsertEffect).
 *
 * The whole "insert a placeholder, then pick a type" flow must behave as ONE
 * undoable action:
 *   - committing leaves exactly one "Add <type>" undo point
 *   - cancelling (or backing out empty) removes the placeholder and leaves NO
 *     history behind
 * These are the guarantees the column-group smart-input flow relies on.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain } from '../sketch-types';

function seedEmpty() {
  runInAction(() => {
    appState.database.sketches = {
      sk: { anchor: null, chain: [], wires: [], instances: {} },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

const chain = () => sketchChain(appState.database.sketches['sk'] as any);
const histLen = () => appController.history.history.length;

afterEach(() => {
  runInAction(() => { appState.database.sketches = {} as any; });
});

describe('effect insertion as a single continuous edit', () => {
  it('previews live without adding an undo point, commits as exactly one', () => {
    seedEmpty();
    const before = histLen();

    const { edit, instanceKey } = appController.beginInsertEffect(
      'sk', 0, 0, 'color.tone.brightness_contrast');

    // Placeholder is live in the chain, but not yet in history.
    expect(chain().length).toBe(1);
    expect((chain()[0] as any).module_type).toBe('color.tone.brightness_contrast');
    expect((chain()[0] as any).instance_key).toBe(instanceKey);
    expect(histLen()).toBe(before);

    // Previewing a different type swaps in place — same instance key, no history.
    appController.updateInsertEffect(edit, 'sk', 0, 0, instanceKey, 'composite.blend');
    expect((chain()[0] as any).module_type).toBe('composite.blend');
    expect((chain()[0] as any).instance_key).toBe(instanceKey);
    expect(histLen()).toBe(before);

    // Commit → exactly one undo point, label reflects the final type.
    edit.accept();
    expect(histLen()).toBe(before + 1);
    expect(appController.history.history[before].description).toBe('Add blend');
    expect((chain()[0] as any).module_type).toBe('composite.blend');

    // And it undoes in one step.
    appController.history.undo();
    expect(chain().length).toBe(0);
    expect(histLen()).toBe(before);
  });

  it('cancel removes the placeholder and leaves no history', () => {
    seedEmpty();
    const before = histLen();

    const { edit } = appController.beginInsertEffect('sk', 0, 0, 'color.tone.brightness_contrast');
    expect(chain().length).toBe(1);

    appController.cancelInsertEffect(edit);

    expect(chain().length).toBe(0);
    expect(histLen()).toBe(before);
    expect(appState.database.sketches['sk'].instances).toEqual({});
  });

  it('cancel after previewing several types still leaves a clean chain', () => {
    seedEmpty();
    const before = histLen();

    const { edit, instanceKey } = appController.beginInsertEffect('sk', 0, 0, 'color.tone.brightness_contrast');
    appController.updateInsertEffect(edit, 'sk', 0, 0, instanceKey, 'composite.blend');
    appController.updateInsertEffect(edit, 'sk', 0, 0, instanceKey, 'filter.blur.gaussian');
    expect(chain().length).toBe(1);

    appController.cancelInsertEffect(edit);
    expect(chain().length).toBe(0);
    expect(histLen()).toBe(before);
  });

  it('inserts at the requested index among existing effects', () => {
    seedEmpty();
    runInAction(() => {
      const sk = appState.database.sketches['sk'] as any;
      sk.chain = [
        { type: 'module', module_type: 'color.invert', instance_key: 'a' },
        { type: 'module', module_type: 'color.invert', instance_key: 'b' },
      ];
    });

    const { edit, instanceKey } = appController.beginInsertEffect('sk', 0, 1, 'color.tone.brightness_contrast');
    edit.accept();

    expect(chain().map((e: any) => e.instance_key)).toEqual(['a', instanceKey, 'b']);
  });
});
