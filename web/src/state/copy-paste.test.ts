import { describe, it, expect, afterEach } from 'vitest';
import { runInAction } from 'mobx';
import { appState } from './app-state';
import { appController } from './controller';
import { sketchChain } from '../sketch-types';
import type { EffectClipboard } from './types';

// One effect in the stack, with a UI-only collapse flag we expect copy to strip.
function seed() {
  runInAction(() => {
    appState.database.sketches = {
      sk: {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'video.bc', instance_key: 'bc0' },
        ],
        instances: {
          bc0: {
            module_type: 'video.bc',
            state: { brightness: 0.7, __opacity__: 1, __ui_only__: { collapsed: true } },
          },
        },
      },
    } as any;
    appState.local.userSettings.selectedProjectId = 'sk';
  });
}

// Register an effect-card selectable the way column-group does: copy snapshots
// its instance, paste drops the clipboard AFTER it (chainIdx + 1).
function defineEffectSelectable(chainIdx: number, instanceKey: string) {
  appController.defineSelectable({
    path: `effect/sk/0/${chainIdx}`,
    label: instanceKey,
    copy: () => appController.snapshotEffect('sk', instanceKey),
    paste: (payload) => {
      if (payload.kind !== 'effect') return;
      appController.insertEffectFromClipboard('sk', 0, chainIdx + 1, payload);
    },
  });
}

// An insert-tab selectable: paste lands exactly at its slot.
function defineTabSelectable(insertIdx: number) {
  appController.defineSelectable({
    path: `tab/sk/0/${insertIdx}`,
    label: 'Insert Point',
    paste: (payload) => {
      if (payload.kind !== 'effect') return;
      appController.insertEffectFromClipboard('sk', 0, insertIdx, payload);
    },
  });
}

const moduleTypes = () =>
  sketchChain(appState.database.sketches.sk).map((e: any) => e.module_type);
const instanceKeys = () =>
  sketchChain(appState.database.sketches.sk).map((e: any) => e.instance_key);

afterEach(() => {
  runInAction(() => {
    appState.local.selection = null;
    appState.local.queuedSelectionPath = null;
    appState.local.clipboard = null;
    appState.database.sketches = {} as any;
    appState.local.userSettings.selectedProjectId = null;
  });
});

describe('effect copy / paste', () => {
  it('snapshotEffect captures type + state, stripping UI-only view state', () => {
    seed();
    const snap = appController.snapshotEffect('sk', 'bc0');
    expect(snap).not.toBeNull();
    expect(snap!.moduleType).toBe('video.bc');
    expect(snap!.state.brightness).toBe(0.7);
    expect(snap!.state.__opacity__).toBe(1);
    // Collapse flag must not ride along into the paste.
    expect(snap!.state.__ui_only__).toBeUndefined();
  });

  it('snapshotEffect returns null for a missing instance', () => {
    seed();
    expect(appController.snapshotEffect('sk', 'nope')).toBeNull();
  });

  it('copySelection fills the clipboard and toggles canCopy/canPaste', () => {
    seed();
    defineEffectSelectable(0, 'bc0');
    expect(appController.canCopy).toBe(false);
    appController.select('effect/sk/0/0');
    expect(appController.canCopy).toBe(true);
    expect(appController.canPaste).toBe(false);

    appController.copySelection();
    expect(appController.canPaste).toBe(true);
    expect(appState.local.clipboard?.moduleType).toBe('video.bc');
  });

  it('pastes AFTER the selected effect card with a fresh, independent instance', () => {
    seed();
    defineEffectSelectable(0, 'bc0');
    appController.select('effect/sk/0/0');
    appController.copySelection();
    appController.pasteClipboard();

    expect(moduleTypes()).toEqual(['video.bc', 'video.bc']);
    const keys = instanceKeys();
    expect(keys[1]).not.toBe('bc0'); // new instance_key
    // The clone owns a separate state object with the copied values.
    const clone = appState.database.sketches.sk.instances![keys[1]];
    expect(clone.state.brightness).toBe(0.7);
    clone.state.brightness = 0.1;
    expect(appState.database.sketches.sk.instances!.bc0.state.brightness).toBe(0.7);
    // The pasted card is auto-selected — queued until it renders + registers.
    expect(appState.local.selection?.path ?? appState.local.queuedSelectionPath)
      .toBe('effect/sk/0/1');
  });

  it('pastes AT the slot when an insert tab is selected', () => {
    seed();
    const payload: EffectClipboard = { kind: 'effect', moduleType: 'video.glow', state: { amount: 2 } };
    runInAction(() => { appState.local.clipboard = payload; });
    defineTabSelectable(0); // gap above the only card
    appController.select('tab/sk/0/0');

    appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.glow', 'video.bc']);
  });

  it('appends at the bottom of the active stack when nothing is selected', () => {
    seed();
    const payload: EffectClipboard = { kind: 'effect', moduleType: 'video.glow', state: {} };
    runInAction(() => { appState.local.clipboard = payload; });
    expect(appState.local.selection).toBeNull();

    appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc', 'video.glow']);
  });

  it('pasteClipboard is a no-op with an empty clipboard', () => {
    seed();
    appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc']);
  });
});
