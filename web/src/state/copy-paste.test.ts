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
// its instance, paste drops the clipboard AFTER it (chainIdx + 1). Note the
// controller's copySelection short-circuits effect selections through the
// GROUP snapshot before ever consulting `copy` — the closure here is the
// fallback path only.
function defineEffectSelectable(chainIdx: number, instanceKey: string) {
  appController.defineSelectable({
    path: `effect/sk/0/${chainIdx}`,
    label: instanceKey,
    copy: () => appController.snapshotEffect('sk', instanceKey),
    paste: (payload) => {
      if (payload.kind === 'effects') {
        appController.insertEffectsFromClipboard('sk', 0, chainIdx + 1, payload);
        return;
      }
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
    appState.local.multiSelection = [];
    appState.local.clipboard = null;
    appState.database.sketches = {} as any;
    appState.local.userSettings.selectedProjectId = null;
  });
});

/** The moduleType(s) a clipboard payload holds, kind-agnostic. */
const clipboardModuleTypes = () => {
  const p = appState.local.clipboard;
  if (!p) return [];
  return p.kind === 'effects' ? p.items.map(i => i.moduleType) : [p.moduleType];
};

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
    // A lone card copies as a group-of-one (the wire-carrying payload kind).
    expect(appState.local.clipboard?.kind).toBe('effects');
    expect(clipboardModuleTypes()).toEqual(['video.bc']);
  });

  it('pastes AFTER the selected effect card with a fresh, independent instance', async () => {
    seed();
    defineEffectSelectable(0, 'bc0');
    appController.select('effect/sk/0/0');
    appController.copySelection();
    await appController.pasteClipboard();

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

  it('single-card copy carries its MIDI mapping wires, relinked on paste', async () => {
    seed();
    runInAction(() => {
      (appState.database.sketches.sk as any).wires = [{
        id: 'w_midi',
        src: { instanceKey: 'midi:devA', field: 'b0/e05/turn' },
        dest: { instanceKey: 'bc0', field: 'brightness' },
        combine: 'add',
      }];
    });
    defineEffectSelectable(0, 'bc0');
    appController.select('effect/sk/0/0');
    appController.copySelection();
    const clip = appState.local.clipboard;
    expect(clip?.kind).toBe('effects');
    expect((clip as any).wires).toHaveLength(1);

    await appController.pasteClipboard();
    const keys = instanceKeys();
    expect(keys).toHaveLength(2);
    const wires = (appState.database.sketches.sk as any).wires;
    expect(wires).toHaveLength(2);
    // The pasted mapping: same app-level MIDI source, dest relinked onto the
    // fresh instance, fresh wire id.
    const pasted = wires.find((w: any) => w.id !== 'w_midi')!;
    expect(pasted.src).toEqual({ instanceKey: 'midi:devA', field: 'b0/e05/turn' });
    expect(pasted.dest).toEqual({ instanceKey: keys[1], field: 'brightness' });
    expect(pasted.combine).toBe('add');
  });

  it('pastes AT the slot when an insert tab is selected', async () => {
    seed();
    const payload: EffectClipboard = { kind: 'effect', moduleType: 'video.glow', state: { amount: 2 } };
    runInAction(() => { appState.local.clipboard = payload; });
    defineTabSelectable(0); // gap above the only card
    appController.select('tab/sk/0/0');

    await appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.glow', 'video.bc']);
  });

  it('appends at the bottom of the active stack when nothing is selected', async () => {
    seed();
    const payload: EffectClipboard = { kind: 'effect', moduleType: 'video.glow', state: {} };
    runInAction(() => { appState.local.clipboard = payload; });
    expect(appState.local.selection).toBeNull();

    await appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc', 'video.glow']);
  });

  it('pasteClipboard is a no-op with an empty clipboard', async () => {
    seed();
    await appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc']);
  });
});

describe('effect cut', () => {
  it('cutSelection copies then removes the selected effect as one undo point', () => {
    seed();
    defineEffectSelectable(0, 'bc0');
    appController.select('effect/sk/0/0');
    expect(appController.canCut).toBe(true);
    const undo0 = appController.history.history.length;

    appController.cutSelection();

    expect(moduleTypes()).toEqual([]);
    expect(clipboardModuleTypes()).toEqual(['video.bc']);
    expect(appController.history.history.length).toBe(undo0 + 1);
    expect(appState.local.selection).toBeNull();
  });

  it('canCut is false with nothing copyable selected', () => {
    seed();
    expect(appController.canCut).toBe(false);
  });

  it('cutSelection is a no-op with nothing selected', () => {
    seed();
    appController.cutSelection();
    expect(moduleTypes()).toEqual(['video.bc']);
  });
});

describe('OS clipboard interop', () => {
  const realClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: realClipboard, configurable: true });
  });

  it('copySelection mirrors the payload to the OS clipboard as JSON', () => {
    seed();
    defineEffectSelectable(0, 'bc0');
    appController.select('effect/sk/0/0');
    let written: string | null = null;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { written = t; return Promise.resolve(); } },
      configurable: true,
    });

    appController.copySelection();

    expect(written).not.toBeNull();
    const parsed = JSON.parse(written!);
    expect(parsed.kind).toBe('effects');
    expect(parsed.items.map((i: any) => i.moduleType)).toEqual(['video.bc']);
  });

  it('pasteClipboard prefers a valid effect JSON found on the OS clipboard', async () => {
    seed();
    const external = { kind: 'effect', moduleType: 'video.glow', state: { amount: 3 } };
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve(JSON.stringify(external)) },
      configurable: true,
    });
    // Stale in-app clipboard should be ignored in favor of the OS clipboard.
    runInAction(() => { appState.local.clipboard = { kind: 'effect', moduleType: 'video.bc', state: {} }; });

    await appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc', 'video.glow']);
  });

  it('pasteClipboard falls back to the in-app clipboard when the OS clipboard has non-JSON text', async () => {
    seed();
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.resolve('just some plain text, not JSON') },
      configurable: true,
    });
    runInAction(() => { appState.local.clipboard = { kind: 'effect', moduleType: 'video.glow', state: {} }; });

    await appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc', 'video.glow']);
  });

  it('pasteClipboard falls back to the in-app clipboard when OS clipboard access throws', async () => {
    seed();
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    runInAction(() => { appState.local.clipboard = { kind: 'effect', moduleType: 'video.glow', state: {} }; });

    await appController.pasteClipboard();
    expect(moduleTypes()).toEqual(['video.bc', 'video.glow']);
  });
});
