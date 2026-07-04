/**
 * App controller — single entry point for all state mutations.
 *
 * Separates:
 * - Database mutations (through historyManager.record → undo/redo-able)
 * - Local state changes (direct MobX runInAction → ephemeral)
 * - Engine commands (forwarded to worker via EngineProxy)
 */

import { runInAction, toJS, set as mobxSet, remove as mobxRemove } from 'mobx';
import { appState } from './app-state';
import { HistoryManager, LongEdit } from './history';
import { traceController } from './trace-controller';
import type { DatabaseState, PluginInfo, AvailableEffect, Selectable, UserSettings, ClipboardPayload, EffectClipboard, EffectsClipboard, BarrelInstanceInfo } from './types';
import {
  effectPath, parseEffectPath, buildEffectsPayload, remapEffectsPayload, isEffectsClipboard,
  type EffectPathParts,
} from './effects-payload';
import type { EngineProxy } from '../engine-proxy';
import type { EngineState, EffectInfo, TracePoint, ParamValue } from '../engine-types';
import type { Sketch, Wire, UiOnlyState, InstanceState, FieldConnectInfo } from '../sketch-types';
import { normalizeSketchChains, sketchChain, ensureChain, UI_ONLY_KEY, DASHBOARD_MODULE_TYPE, SKETCH_OUTPUT_MODULE_TYPE } from '../sketch-types';
// Relocated to sketch-types (decouples <column-group> from this module); re-exported here for back-compat.
export { DASHBOARD_MODULE_TYPE, SKETCH_OUTPUT_MODULE_TYPE } from '../sketch-types';
export type { FieldConnectInfo } from '../sketch-types';
import { parseVersion } from '../version';
import {
  isDefaultProjectId,
  isUserProjectId,
  isPersistableProjectId,
  effectIdFromDefaultProjectId,
  defaultProjectIdForEffect,
  synthesizeDefaultProject,
} from './default-projects';
import { saveUserSettings } from './user-settings';
import { saveProject, deleteProject as idbDeleteProject } from './project-store';
import {
  savePlaygroundInstance,
  deletePlaygroundInstance as idbDeletePlaygroundInstance,
  type PlaygroundInstanceRecord,
} from './playground-store';
import { PLAYGROUND_ID_PREFIX } from './types';
import { instanceKeyFromThumbTraceId, isSidechannelThumbTraceId } from '../resolume-mode';
import { SketchInputManager } from './sketch-input-manager';

/** Selectable path for a wire. Selecting it shows the dest (reader) field's
 *  inspector — the field whose value the wire modulates. */
export function wireSelectablePath(sketchId: string, wireId: string): string {
  return `wire/${sketchId}/${wireId}`;
}

/** The executor-handled virtual knob-bank effect (no WASM module). */
/** Fixed knob count — create more dashboards if you need more knobs. */
export const DASHBOARD_KNOB_COUNT = 8;

/** Fixed output-trace count (mirrors N_OUT in native/wasm_modules/sketch_output). */
export const SKETCH_OUTPUT_TRACE_COUNT = 8;

export class AppController {
  public readonly history: HistoryManager;
  private engine: EngineProxy | null = null;

  /**
   * Set of sketch IDs the engine currently knows about. Used to detect
   * deletions on each sync — anything previously synced but no longer
   * present (or excluded by `engineSketchFilter`) gets a `deleteSketch`
   * command so the engine can drop its cached state.
   */
  private engineSyncedSketchIds = new Set<string>();

  /**
   * Optional filter limiting which sketches get pushed to the engine.
   * The IDE entry sets this to "only the currently selected project" so
   * other user/template sketches sit dormant in `appState.database` for
   * the explorer UI but never run on the GPU. When `null`, all sketches
   * sync (resolume's behavior).
   */
  private engineSketchFilter: ((sketchId: string) => boolean) | null = null;

  // -- Barrel-mode push: when a remote NanoBarrel sketch is mirrored
  //    into the editor, mutations to that sketch get serialised back
  //    over the bridge. Stored as a (sketchId, pusher) pair so the
  //    push is gated on "this is the barrel-tracked sketch" — other
  //    local sketches (if any) keep their normal IDB persistence
  //    behaviour without spuriously pushing to the bridge.
  //
  //    `lastPushedBarrelJson` is the last JSON we either pushed OR
  //    received. The post-record hook compares against it to skip
  //    redundant pushes and — critically — `setBarrelSketch` seeds it
  //    so a snapshot we just received from the bridge doesn't echo
  //    straight back. --
  private barrelSketchId: string | null = null;
  private barrelPusher: ((sketch: Sketch) => void) | null = null;
  private lastPushedBarrelJson: string | null = null;
  // In barrel mode the bridge — not the engine worker — owns the trace
  // pipeline. resolume-app installs a pusher that translates the trace
  // controller's flush into a /preview_requests JSON patch. The
  // controller stays the single hub: texture-monitors register the
  // same way in both modes.
  private barrelPreviewPusher: ((tracePoints: TracePoint[]) => void) | null = null;
  // Invoked when the user (or default-selection logic) picks a different
  // barrel instance. resolume-app registers this to (re)wire the WS
  // subscriptions/pushers for the newly selected key. Not a MobX reaction
  // — selection is an explicit action, so we call the handler from it.
  private barrelSelectHandler: ((key: string) => void) | null = null;

  // -- Persistence scheduling (no MobX reactions; fired explicitly by
  //    every method that mutates the relevant slice) --

  private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private projectsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Last serialized form of each `user:` project that has been written to
   * IndexedDB. Used to avoid redundant writes and to detect deletions.
   */
  private projectsLastSavedJson = new Map<string, string>();
  /** Disabled during boot so loading from IDB doesn't immediately re-save. */
  private persistenceEnabled = false;

  // -- Playground (local shared-server environment) --

  /** True when this session is the `?playground` resolume surface. */
  private playgroundMode = false;
  private playgroundSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** `flushPlaygroundSave` change/deletion detection (projects-flush twin). */
  private playgroundLastSavedJson = new Map<string, string>();
  /**
   * User-facing labels of playground instances, keyed by `pg:` sketch id.
   * Deliberately NOT pruned on delete: instance creation/deletion is
   * undoable (the sketch lives in the database), so a label must survive
   * for undo to bring the instance back whole.
   */
  private playgroundLabels = new Map<string, string>();

  /**
   * Owns the off-screen video element / image lifecycle that drives the
   * active sketch's `texture_input`. Survives UI re-mounts (tab switches),
   * persists drops to IndexedDB, and restores them when a project is
   * reselected.
   */
  private inputManager = new SketchInputManager(
    (sketchId, bitmap) => this.engine?.setSketchInput(sketchId, bitmap),
  );

  /**
   * Plain (non-observable) registry of all mounted selectables.
   * Lives outside MobX so mutations during render don't trigger reactions.
   */
  private readonly selectableRegistry = new Map<string, Selectable>();

  constructor() {
    this.history = new HistoryManager(appState);
    // In-draft hook: any time the database is mutated (direct or via a
    // long edit preview/accept) and the active sketch is still flagged
    // as a template, promote it. Lives in the same Immer transaction as
    // the user's edit so the promotion is atomic with the change.
    this.history.inDraftHook = (draft) => {
      const sel = appState.local.userSettings.selectedProjectId;
      if (sel && draft.sketches[sel]?.isTemplate) {
        draft.sketches[sel].isTemplate = false;
      }
    };
    // Post-record hook: every committed mutation (including long-edit
    // accepts and undo/redo) syncs to the engine and schedules a save.
    // Without this, slider drags (which use long edits) never fire the
    // IndexedDB save.
    this.history.postRecordHook = () => {
      this.syncSketchesToEngine();
      this.requestProjectsSave();
      this.requestPlaygroundSave();
      this.maybePushBarrelSketch();
      // Instance create/delete can also arrive via undo/redo, which
      // bypasses the explicit CRUD methods — keep the list mirrored.
      if (this.playgroundMode) this.refreshPlaygroundInstanceList();
    };
    // Long-edit preview hook: fires during slider drags (begin / update /
    // cancel-revert), separately from commit-time concerns. We push the
    // in-progress state to the remote bridge so a connected NanoBarrel
    // (and any second observer subscribed via WS) sees the slider sweep
    // live. We deliberately *don't* sync to the engine here (it gets its
    // own per-update call via `engine.setParam` in the long-edit driver)
    // or schedule an IndexedDB write (commits handle that).
    this.history.longEditHook = () => {
      this.maybePushBarrelSketch();
    };
    // Wire the trace controller. In local mode, push to the worker so
    // it can capture pixels. In barrel mode the worker is idle; the
    // installed barrelPreviewPusher pushes a /preview_requests JSON
    // patch to the bridge so the native barrel can capture the matching
    // textures and stream them back as binary WS frames.
    traceController.onFlush = (tracePoints) => {
      if (appState.local.barrelMode) {
        this.barrelPreviewPusher?.(tracePoints);
      } else {
        this.setTracePoints(tracePoints);
      }
    };
  }

  setEngine(engine: EngineProxy) {
    this.engine = engine;
  }

  // ========================================================================
  // Database mutations (undo/redo-able)
  // ========================================================================

  /**
   * Generic mutation bottleneck. All sketch changes go through here. The
   * in-draft / post-record hooks installed in the constructor handle
   * isTemplate promotion, engine sync, and save scheduling — `mutate` is
   * just sugar over `history.record` now.
   */
  mutate(description: string, recipe: (draft: DatabaseState) => void) {
    this.history.record(description, recipe);
  }

  /**
   * Initial instance state for a plugin, seeded from its typed schema
   * defaults. The legacy `params` list is numeric-only — it coerces string
   * defaults to 0 and drops vector (float2/3/4, color) fields entirely — so a
   * source.text.plain node would come up with `text: 0` and no color. Reading the raw
   * schema `default` preserves strings (`"Text"`), numbers (`64`), bools, and
   * vectors as arrays (`[1,1,1,1]`), matching what the inspector widgets and
   * the native patch readers (patchString / patchVec4) expect. Falls back to
   * the params list for any field the schema didn't carry (or schema-less
   * plugins).
   */
  private defaultStateForPlugin(plugin: PluginInfo): Record<string, any> {
    const state: Record<string, any> = {};
    const schema = (plugin.schema ?? {}) as Record<string, any>;
    // PURE OUTPUT fields (io & Output, NOT also an input) are live-published by
    // the running effect, not authored. Seeding them into instance state at the
    // schema default (0) bakes a stale 0 that shadows the engine's published
    // value in the field binding — the output trace would read 0.0 forever. Skip
    // them in BOTH loops. A field that is BOTH input and output (a relay, e.g. a
    // util.dashboard knob_i, io = in|out) IS authored — seed it like any input.
    const outputs = new Set<string>();
    for (const [name, field] of Object.entries(schema)) {
      const io = field?.io ?? 0;
      if ((io & 2) !== 0 && (io & 1) === 0) outputs.add(name);
    }
    for (const [name, field] of Object.entries(schema)) {
      if (field?.type === 'texture') continue;            // wiring, not state
      if (outputs.has(name)) continue;                    // live output, not state
      if (field?.default !== undefined) state[name] = field.default;
    }
    for (const p of plugin.params) {
      if (outputs.has(p.name)) continue;
      if (!(p.name in state)) state[p.name] = p.defaultValue;
    }
    return state;
  }

  /**
   * Initial instance state for a module by type — seeded from the plugin
   * schema's field defaults. (util.dashboard is now a real schema-backed
   * effect, so its knob_0..knob_N fields seed from the schema like any other.)
   */
  private initialStateForModule(moduleType: string): Record<string, any> {
    const plugin = appState.local.plugins.find(p => p.id === moduleType);
    return plugin ? this.defaultStateForPlugin(plugin) : {};
  }

  /**
   * The {module, effect} version pair to stamp on a freshly-created instance,
   * read from the live plugin metadata (the effect's state::init version and its
   * bundle's module version). Unknown plugins record 0.0.0 so the slot is always
   * present. Recorded for later compat checks; no migration logic yet.
   */
  private versionForModule(moduleType: string): InstanceState['version'] {
    const plugin = appState.local.plugins.find(p => p.id === moduleType);
    return {
      module: parseVersion(plugin?.moduleVersion),
      effect: parseVersion(plugin?.version),
    };
  }

  addEffectToChain(sketchId: string, colIdx: number, insertIdx: number, moduleType: string) {
    const instanceKey = `virtual_${shortName(moduleType)}@${Date.now()}`;

    const defaultState = this.initialStateForModule(moduleType);
    const version = this.versionForModule(moduleType);

    this.mutate(`Add ${shortName(moduleType)}`, draft => {
      const sketch = draft.sketches[sketchId];
      if (!sketch) return;
      ensureChain(sketch).splice(insertIdx, 0, {
        type: 'module',
        module_type: moduleType,
        instance_key: instanceKey,
      });
      // Create instance state in the sketch
      sketch.instances = sketch.instances ?? {};
      sketch.instances[instanceKey] = { module_type: moduleType, state: defaultState, version };
    });
  }

  /** Change the module type of an existing effect in a chain. */
  changeEffectType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    this.mutate(`Change to ${shortName(newModuleType)}`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const entry = sketchChain(sk)[chainIdx];
      if (!entry || entry.type !== 'module') return;
      entry.module_type = newModuleType;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) { inst.module_type = newModuleType; inst.state = this.initialStateForModule(newModuleType); }
    });
    // Tell the engine worker to swap the instance directly
    this.engine?.changeInstanceType(sketchId, colIdx, chainIdx, newModuleType);
  }

  /** Recipe for changing an effect type (shared by long edit methods). */
  private changeTypeRecipe(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const entry = sketchChain(sk)[chainIdx];
      if (!entry || entry.type !== 'module') return;
      entry.module_type = newModuleType;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) { inst.module_type = newModuleType; inst.state = this.initialStateForModule(newModuleType); }
    };
  }

  /**
   * Begin a continuous (long) edit for changing effect type.
   * Updates are previewed live without creating undo points.
   */
  beginChangeEffectType(sketchId: string, colIdx: number, chainIdx: number, newModuleType: string): LongEdit {
    const edit = this.history.beginLongEdit(
      `Change to ${shortName(newModuleType)}`,
      this.changeTypeRecipe(sketchId, colIdx, chainIdx, newModuleType),
    );
    this.engine?.changeInstanceType(sketchId, colIdx, chainIdx, newModuleType);
    return edit;
  }

  /** Update a continuous effect type change (preview only, no undo point). */
  updateChangeEffectType(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number, newModuleType: string) {
    edit.update(this.changeTypeRecipe(sketchId, colIdx, chainIdx, newModuleType));
    this.engine?.changeInstanceType(sketchId, colIdx, chainIdx, newModuleType);
  }

  /**
   * Cancel a continuous effect type change — reverts the preview to the
   * effect's original type and re-pushes that to the engine. (The preview
   * drove the engine live via `changeInstanceType`; reverting the observable
   * isn't enough, the engine has to be told to swap back.)
   */
  cancelChangeEffectType(edit: LongEdit) {
    edit.cancel();
    this.syncSketchesToEngine();
  }

  /** Recipe for inserting a new effect (shared by the insert long edit). */
  private insertEffectRecipe(sketchId: string, insertIdx: number, moduleType: string, instanceKey: string) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      ensureChain(sk).splice(insertIdx, 0, {
        type: 'module',
        module_type: moduleType,
        instance_key: instanceKey,
      });
      sk.instances = sk.instances ?? {};
      sk.instances[instanceKey] = { module_type: moduleType, state: this.initialStateForModule(moduleType), version: this.versionForModule(moduleType) };
    };
  }

  /**
   * Begin inserting a new effect as a *continuous* edit. The placeholder is
   * previewed live (engine renders it), but only becomes a real undo point on
   * `accept()`; `cancelInsertEffect()` removes it entirely and leaves no
   * history. This makes the whole "insert, then pick a type" flow a single
   * undoable action that vanishes cleanly if the user backs out.
   * `colIdx` is accepted for call-site symmetry; the chain is per-sketch.
   */
  beginInsertEffect(sketchId: string, _colIdx: number, insertIdx: number, moduleType: string): { edit: LongEdit; instanceKey: string } {
    const instanceKey = `virtual_${shortName(moduleType)}@${Date.now()}`;
    const edit = this.history.beginLongEdit(
      `Add ${shortName(moduleType)}`,
      this.insertEffectRecipe(sketchId, insertIdx, moduleType, instanceKey),
    );
    this.syncSketchesToEngine();
    return { edit, instanceKey };
  }

  /** Update the previewed type of an in-progress effect insertion (no undo point). */
  updateInsertEffect(edit: LongEdit, sketchId: string, _colIdx: number, insertIdx: number, instanceKey: string, newModuleType: string) {
    edit._setDescription(`Add ${shortName(newModuleType)}`);
    edit.update(this.insertEffectRecipe(sketchId, insertIdx, newModuleType, instanceKey));
    this.syncSketchesToEngine();
  }

  /** Cancel an in-progress insertion — removes the placeholder, no undo point. */
  cancelInsertEffect(edit: LongEdit) {
    edit.cancel();
    this.syncSketchesToEngine();
  }

  removeEffectFromChain(sketchId: string, colIdx: number, chainIdx: number) {
    this.mutate('Remove effect', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const chain = ensureChain(sk);
      const entry = chain[chainIdx];
      if (entry?.type === 'module') {
        const key = entry.instance_key;
        chain.splice(chainIdx, 1);
        // Clean up instance state
        if (sk.instances) {
          delete sk.instances[key];
        }
        // Drop any wires that referenced this instance. Otherwise they dangle:
        // the executor silently skips a wire whose endpoint has no live source,
        // so a later same-type effect (which gets a NEW instance_key) never
        // re-attaches, and the orphaned wire looks like a broken connection.
        if (sk.wires) {
          sk.wires = sk.wires.filter(
            w => w.src.instanceKey !== key && w.dest.instanceKey !== key);
        }
      }
    });
  }

  /**
   * Remove several chain entries as ONE undo point (multi-select delete / cut).
   * Same per-entry cleanup as `removeEffectFromChain` — instance state and any
   * wire touching a removed instance go too (a wire INTERNAL to the removed
   * group matches both filters harmlessly).
   */
  removeEffectsFromChain(sketchId: string, chainIdxs: number[]) {
    if (chainIdxs.length === 0) return;
    // Descending so earlier splices don't shift the later indices.
    const idxs = [...new Set(chainIdxs)].sort((a, b) => b - a);
    this.mutate(`Remove ${idxs.length} effects`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const chain = ensureChain(sk);
      const removedKeys = new Set<string>();
      for (const chainIdx of idxs) {
        const entry = chain[chainIdx];
        if (entry?.type !== 'module') continue;
        removedKeys.add(entry.instance_key);
        chain.splice(chainIdx, 1);
        if (sk.instances) delete sk.instances[entry.instance_key];
      }
      if (sk.wires && removedKeys.size > 0) {
        sk.wires = sk.wires.filter(
          w => !removedKeys.has(w.src.instanceKey) && !removedKeys.has(w.dest.instanceKey));
      }
    });
  }

  /**
   * Delete the whole multi-selection (2+ cards) as one undo point. Returns
   * false when there's no group to act on — callers fall through to their
   * single-card delete path.
   */
  removeMultiSelectedEffects(): boolean {
    const group = this.multiSelectedEffectParts();
    if (!group) return false;
    this.select(null);
    this.removeEffectsFromChain(group.sketchId, group.parts.map(p => p.chainIdx));
    return true;
  }

  /**
   * The multi-selection resolved to parsed paths, when it's an actionable
   * GROUP: 2+ effect paths, all in one sketch. Null otherwise (empty or
   * single-card selections use the ordinary single paths).
   */
  private multiSelectedEffectParts(): { sketchId: string; parts: EffectPathParts[] } | null {
    const paths = appState.local.multiSelection;
    if (paths.length < 2) return null;
    const parts = paths.map(parseEffectPath).filter((p): p is EffectPathParts => !!p);
    if (parts.length < 2) return null;
    const sketchId = parts[0].sketchId;
    if (!parts.every(p => p.sketchId === sketchId)) return null;
    return { sketchId, parts };
  }

  // ============================== Copy / Paste =============================
  // Tied to the Selectable system: a selectable may expose `copy`/`paste`
  // handlers (see types.ts). The toolbar buttons and Cmd/Ctrl+C/V call the two
  // public entry points below; the effect-specific snapshot/insert helpers do
  // the actual chain surgery and are also invoked by the selectables' handlers.

  /** Build a clipboard payload from an effect instance, or null if it's gone.
   *  Used by an effect card's `Selectable.copy`. Keyed by instance_key (stable
   *  across reorders), and strips UI-only view state so the paste lands clean. */
  snapshotEffect(sketchId: string, instanceKey: string): EffectClipboard | null {
    const sk = appState.database.sketches[sketchId];
    const inst = sk?.instances?.[instanceKey];
    const entry = sk
      ? sketchChain(sk).find(e => e.type === 'module' && e.instance_key === instanceKey)
      : undefined;
    if (!inst || !entry || entry.type !== 'module') return null;
    const state = toJS(inst.state) as Record<string, any>;
    delete state[UI_ONLY_KEY];
    return {
      kind: 'effect',
      moduleType: inst.module_type,
      state,
      fieldOptions: entry.fieldOptions ? (toJS(entry.fieldOptions) as any) : undefined,
    };
  }

  /** Multi-card counterpart of `snapshotEffect`: capture a group of instances
   *  (chain-ordered) plus the wires internal to the group. */
  snapshotEffects(sketchId: string, instanceKeys: string[]): EffectsClipboard | null {
    const sk = appState.database.sketches[sketchId];
    if (!sk) return null;
    return buildEffectsPayload(toJS(sk), instanceKeys);
  }

  /** Insert a clipboard effect as a NEW instance at `insertIdx`, then select it.
   *  Used by the effect-card / insert-tab `Selectable.paste` and the bottom-of-
   *  stack fallback. A fresh instance_key keeps it independent of the original. */
  insertEffectFromClipboard(sketchId: string, colIdx: number, insertIdx: number, payload: EffectClipboard) {
    const instanceKey = `virtual_${shortName(payload.moduleType)}@${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const state = JSON.parse(JSON.stringify(payload.state));
    const fieldOptions = payload.fieldOptions
      ? JSON.parse(JSON.stringify(payload.fieldOptions))
      : undefined;
    this.mutate(`Paste ${shortName(payload.moduleType)}`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      ensureChain(sk).splice(insertIdx, 0, {
        type: 'module',
        module_type: payload.moduleType,
        instance_key: instanceKey,
        ...(fieldOptions ? { fieldOptions } : {}),
      });
      sk.instances = sk.instances ?? {};
      sk.instances[instanceKey] = { module_type: payload.moduleType, state, version: this.versionForModule(payload.moduleType) };
    });
    // Select the freshly pasted card (queues if it hasn't rendered yet).
    this.select(`effect/${sketchId}/${colIdx}/${insertIdx}`);
  }

  /**
   * Insert a multi-card clipboard group as a contiguous block at `insertIdx`
   * (one undo point), then select the block. Every card gets a fresh
   * instance_key and the group's internal wires are remapped onto those keys
   * with fresh wire ids — the pasted block modulates itself exactly like the
   * original did, while staying fully independent of it (and of any prior
   * paste of the same payload).
   */
  insertEffectsFromClipboard(sketchId: string, colIdx: number, insertIdx: number, payload: EffectsClipboard) {
    const { items, wires } = remapEffectsPayload(
      payload,
      // Same collision guard as the single paste: rapid inserts share a
      // millisecond, so Date.now() alone isn't unique — add a random suffix.
      (moduleType) =>
        `virtual_${shortName(moduleType)}@${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      () => `wire_${Date.now().toString(36)}_${this.nextWireId++}`,
    );
    if (items.length === 0) return;
    this.mutate(`Paste ${items.length} effects`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const chain = ensureChain(sk);
      sk.instances = sk.instances ?? {};
      items.forEach((item, i) => {
        chain.splice(insertIdx + i, 0, {
          type: 'module',
          module_type: item.moduleType,
          instance_key: item.newKey,
          ...(item.fieldOptions ? { fieldOptions: item.fieldOptions } : {}),
        });
        sk.instances![item.newKey] = {
          module_type: item.moduleType,
          state: item.state,
          version: this.versionForModule(item.moduleType),
        };
      });
      if (wires.length > 0) {
        sk.wires = sk.wires ?? [];
        sk.wires.push(...wires);
      }
    });
    // Select the pasted block: first card primary (queues until rendered),
    // whole block in the multi-selection.
    this.select(effectPath(sketchId, colIdx, insertIdx));
    runInAction(() => {
      appState.local.multiSelection =
        items.map((_, i) => effectPath(sketchId, colIdx, insertIdx + i));
    });
  }

  /**
   * Copy the current selection to the clipboard, if it's copyable. Re-resolves
   * the live selectable by path so re-registered (fresh-closure) cards win.
   * Also mirrors the payload to the OS clipboard as pretty-printed JSON, so it
   * can be pasted into a text editor (or shared/versioned as a plain file) —
   * see `pasteClipboard`'s matching read-back. Best-effort: a browser denying
   * clipboard-write (no secure context, no permission) never blocks the
   * in-app copy, which always succeeds independent of the OS clipboard.
   */
  copySelection() {
    // A 2+ card multi-selection copies as a GROUP (with its internal wires) —
    // straight off the resolved paths, no per-card Selectable involved.
    const group = this.multiSelectedEffectParts();
    if (group) {
      const sk = appState.database.sketches[group.sketchId];
      const chain = sk ? sketchChain(sk) : [];
      const keys = group.parts
        .map(p => chain[p.chainIdx])
        .filter(e => e?.type === 'module')
        .map(e => (e as { instance_key: string }).instance_key);
      const payload = this.snapshotEffects(group.sketchId, keys);
      if (!payload) return;
      runInAction(() => { appState.local.clipboard = payload; });
      void navigator.clipboard?.writeText?.(JSON.stringify(payload, null, 2)).catch(() => {});
      return;
    }
    const path = appState.local.selection?.path;
    const sel = path ? (this.selectableRegistry.get(path) ?? appState.local.selection) : null;
    const payload = sel?.copy?.();
    if (!payload) return;
    runInAction(() => { appState.local.clipboard = payload; });
    void navigator.clipboard?.writeText?.(JSON.stringify(payload, null, 2)).catch(() => {});
  }

  /**
   * Cut the current selection: copy it (including to the OS clipboard, see
   * `copySelection`), then remove it from its chain as one undo point. A
   * no-op when nothing copyable is selected.
   */
  cutSelection() {
    // Multi-selection: copy the group, then remove it as one undo point.
    const group = this.multiSelectedEffectParts();
    if (group) {
      // Clear first so a stale payload from an earlier copy can't make the
      // "was it copyable?" check pass and delete cards that never got copied.
      runInAction(() => { appState.local.clipboard = null; });
      this.copySelection();
      if (!appState.local.clipboard) return; // nothing was actually copyable
      this.removeMultiSelectedEffects();
      return;
    }
    const path = appState.local.selection?.path;
    if (!path) return;
    this.copySelection();
    if (!appState.local.clipboard) return; // nothing was actually copyable
    const parts = parseEffectPath(path);
    if (!parts) return;
    this.select(null);
    this.removeEffectFromChain(parts.sketchId, parts.colIdx, parts.chainIdx);
  }

  /**
   * Resolve the payload to paste: prefer the OS clipboard's text (lets you
   * paste effect JSON copied — or hand-edited — outside the app, in a text
   * editor or from another machine); fall back to the in-app clipboard when
   * the OS clipboard is empty, unreadable (no permission / insecure context),
   * or doesn't hold a recognizable effect JSON.
   */
  private async resolveClipboardPayload(): Promise<ClipboardPayload | null> {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.kind === 'effect' && typeof parsed.moduleType === 'string'
          && parsed.state && typeof parsed.state === 'object') {
          return parsed as EffectClipboard;
        }
        if (isEffectsClipboard(parsed)) return parsed;
      }
    } catch {
      // Not JSON, no clipboard-read permission, or no OS clipboard access —
      // fall through to the in-app clipboard below.
    }
    return appState.local.clipboard;
  }

  /** Paste the clipboard. Routes to the selected selectable's `paste` (effect →
   *  after itself; tab → at its slot); with nothing pasteable selected, appends
   *  at the bottom of the active project's stack. */
  async pasteClipboard() {
    const payload = await this.resolveClipboardPayload();
    if (!payload) return;
    const path = appState.local.selection?.path;
    const sel = path ? this.selectableRegistry.get(path) : undefined;
    if (sel?.paste) { sel.paste(payload); return; }
    const sketchId = this.activeEditSketchId();
    const sk = sketchId ? appState.database.sketches[sketchId] : undefined;
    if (!sketchId || !sk) return;
    if (payload.kind === 'effects') {
      this.insertEffectsFromClipboard(sketchId, 0, sketchChain(sk).length, payload);
      return;
    }
    this.insertEffectFromClipboard(sketchId, 0, sketchChain(sk).length, payload);
  }

  /** True when the current selection can be copied (drives the Copy button). */
  get canCopy(): boolean {
    return appState.local.multiSelection.length >= 2
      || !!appState.local.selection?.copy;
  }

  /** True when the current selection can be cut — same requirement as copy,
   *  since cut is copy + remove-from-chain. */
  get canCut(): boolean {
    return this.canCopy;
  }

  /** True when there's an in-app clipboard payload to paste (drives the Paste
   *  button). This can't see the OS clipboard synchronously — `pasteClipboard`
   *  itself always also tries that, even when this is false. */
  get canPaste(): boolean {
    return !!appState.local.clipboard;
  }

  /**
   * Toggle an effect card's collapsed (UI-only) view state, stored in the
   * instance's `__ui_only__` subtree (see UI_ONLY_KEY). Bypasses undo history —
   * this is view state, not document content, so Cmd+Z shouldn't expand a card
   * instead of reverting a real edit — but is persisted so it survives reloads.
   * Creates a minimal instance entry if one doesn't exist yet (never clobbers
   * existing param state).
   */
  toggleEffectCollapsed(sketchId: string, instanceKey: string) {
    runInAction(() => {
      const sk = appState.database.sketches[sketchId];
      if (!sk) return;
      sk.instances = sk.instances ?? {};
      let inst = sk.instances[instanceKey];
      if (!inst) {
        const entry = sketchChain(sk).find(
          e => e.type === 'module' && e.instance_key === instanceKey);
        if (!entry || entry.type !== 'module') return;
        inst = sk.instances[instanceKey] = { module_type: entry.module_type, state: {} };
      }
      const ui = (inst.state[UI_ONLY_KEY] ?? {}) as UiOnlyState;
      ui.collapsed = !ui.collapsed;
      inst.state[UI_ONLY_KEY] = ui;
    });
    this.requestProjectsSave();
  }

  setEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue) {
    // Find the instance key for this chain entry
    const sketch = appState.database.sketches[sketchId];
    const entry = (sketch ? sketchChain(sketch)[chainIdx] : undefined);
    if (!entry || entry.type !== 'module') return;

    this.mutate(`Set param ${paramKey}`, draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[entry.instance_key];
      if (inst) {
        inst.state[paramKey] = value;
      }
    });
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
  }

  /** Recipe for setting a param value (shared by continuous edit methods). */
  private setParamRecipe(sketchId: string, instanceKey: string, paramKey: string, value: ParamValue) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      sk.instances = sk.instances ?? {};
      const inst = sk.instances[instanceKey];
      if (inst) { inst.state[paramKey] = value; }
    };
  }

  /** Begin a continuous param edit (slider drag). No undo points during drag. */
  beginSetEffectParam(sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue): LongEdit {
    const sketch = appState.database.sketches[sketchId];
    const entry = (sketch ? sketchChain(sketch)[chainIdx] : undefined);
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    const edit = this.history.beginLongEdit(
      `Set ${paramKey}`,
      this.setParamRecipe(sketchId, instanceKey, paramKey, value),
    );
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
    return edit;
  }

  /** Update a continuous param edit (slider drag in progress). */
  updateSetEffectParam(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number, paramKey: string, value: ParamValue) {
    const sketch = appState.database.sketches[sketchId];
    const entry = (sketch ? sketchChain(sketch)[chainIdx] : undefined);
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    edit.update(this.setParamRecipe(sketchId, instanceKey, paramKey, value));
    this.engine?.setParam(sketchId, colIdx, chainIdx, paramKey, value);
  }

  // Recipe that writes SEVERAL params in one draft pass — for widgets (an XY
  // pad) that drive multiple fields as a single edit. The history manager has
  // only one active long edit, so two concurrent single-field continuous edits
  // would cancel each other; this keeps them in one.
  private setParamsRecipe(sketchId: string, instanceKey: string, values: Record<string, ParamValue>) {
    return (draft: DatabaseState) => {
      const inst = draft.sketches[sketchId]?.instances?.[instanceKey];
      if (inst) { for (const k in values) inst.state[k] = values[k]; }
    };
  }

  /** Begin a continuous edit over multiple params as one undo/long-edit. */
  beginSetEffectParams(sketchId: string, colIdx: number, chainIdx: number, values: Record<string, ParamValue>): LongEdit {
    const sketch = appState.database.sketches[sketchId];
    const entry = (sketch ? sketchChain(sketch)[chainIdx] : undefined);
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    const edit = this.history.beginLongEdit('Set params', this.setParamsRecipe(sketchId, instanceKey, values));
    for (const k in values) this.engine?.setParam(sketchId, colIdx, chainIdx, k, values[k]);
    return edit;
  }

  /** Update a multi-param continuous edit (XY-pad drag in progress). */
  updateSetEffectParams(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number, values: Record<string, ParamValue>) {
    const sketch = appState.database.sketches[sketchId];
    const entry = (sketch ? sketchChain(sketch)[chainIdx] : undefined);
    const instanceKey = (entry && entry.type === 'module') ? entry.instance_key : '';
    edit.update(this.setParamsRecipe(sketchId, instanceKey, values));
    for (const k in values) this.engine?.setParam(sketchId, colIdx, chainIdx, k, values[k]);
  }

  // --- util.dashboard knobs (state.knob_i — real schema-backed effect) ---

  /** Recipe that writes one knob value into a dashboard instance's `knob_i` field. */
  private dashboardKnobRecipe(sketchId: string, instanceKey: string, idx: number, value: number) {
    return (draft: DatabaseState) => {
      const inst = draft.sketches[sketchId]?.instances?.[instanceKey];
      if (!inst) return;
      inst.state[`knob_${idx}`] = value;
    };
  }

  /** Set a dashboard knob (one undo point). */
  setDashboardKnob(sketchId: string, instanceKey: string, idx: number, value: number) {
    this.mutate('Set knob', this.dashboardKnobRecipe(sketchId, instanceKey, idx, value));
  }

  // --- Help text ("?" mode) — per-instance, per-slot markdown overrides ---

  /**
   * Merge a partial help override (scope and/or sketch-local markdown text) into
   * an instance's `help[slotPath]`. The GLOBAL override lives in IndexedDB
   * (field-docs-store), not here — this only touches the sketch-local layer +
   * the per-slot scope selection. One undo point per call.
   */
  setInstanceHelp(sketchId: string, instanceKey: string, slotPath: string,
                  patch: { scope?: 'global' | 'local'; text?: string }) {
    this.mutate('Edit help text', (draft: DatabaseState) => {
      const inst = draft.sketches[sketchId]?.instances?.[instanceKey];
      if (!inst) return;
      inst.help ??= {};
      const cur = (inst.help[slotPath] ??= {});
      if (patch.scope !== undefined) cur.scope = patch.scope;
      if (patch.text !== undefined) cur.text = patch.text;
    });
  }

  /** Begin a continuous knob edit (drag). Pushes live so wired consumers update. */
  beginSetDashboardKnob(sketchId: string, instanceKey: string, idx: number, value: number): LongEdit {
    const edit = this.history.beginLongEdit('Set knob', this.dashboardKnobRecipe(sketchId, instanceKey, idx, value));
    this.pushSketchLive(sketchId);
    return edit;
  }

  /** Update a continuous knob edit (drag in progress). */
  updateSetDashboardKnob(edit: LongEdit, sketchId: string, instanceKey: string, idx: number, value: number) {
    edit.update(this.dashboardKnobRecipe(sketchId, instanceKey, idx, value));
    this.pushSketchLive(sketchId);
  }

  // Undo/redo restructure the chain under the multi-selection's index-based
  // paths; a stale group would make the next group-delete remove whatever
  // NOW sits at those indices. Dissolve it (primary selection re-resolves by
  // path on its own and is a lone card at worst).
  undo() {
    runInAction(() => { appState.local.multiSelection = []; });
    this.history.undo();
  }
  redo() {
    runInAction(() => { appState.local.multiSelection = []; });
    this.history.redo();
  }

  // ========================================================================
  // Local state changes (ephemeral, no undo)
  // ========================================================================

  setActiveTab(tab: 'organize' | 'edit') {
    runInAction(() => { appState.local.activeTab = tab; });
    this.setUserSetting('activeTab', tab);   // remember across reloads
  }

  /**
   * Update one user-setting field. Goes through `runInAction` only — never
   * recorded in undo history (splitter drags etc. must not pollute the stack).
   *
   * Schedules a debounced save to IndexedDB. This is the single chokepoint
   * for user-settings mutations; other controller methods that touch
   * settings should call it rather than mutate `userSettings` directly.
   */
  setUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    runInAction(() => { appState.local.userSettings[key] = value; });
    this.requestUserSettingsSave();
    // Tab-driven engine sync: only the Debug Info tab needs the
    // worker to broadcast stats/console-logs. Toggle explicitly here
    // (per the project rule that engine sync flows from the action,
    // not a MobX reaction).
    if (key === 'ideLeftTab') {
      this.engine?.setDebugMode(value === 'debug_info');
      // Reset the UI buffer when leaving the tab so a re-open starts
      // clean instead of showing stale entries from earlier in the
      // session.
      if (value !== 'debug_info') this.clearDebugConsoleLog();
    }
  }

  /**
   * Boot-time replacement of user settings (e.g. after IndexedDB load).
   * Bypasses history — these are not undo/redo-able.
   */
  loadInitialUserSettings(settings: UserSettings) {
    runInAction(() => {
      appState.local.userSettings = settings;
      // Mirror the persisted resolume session into the live ephemeral state
      // the sketch-app reads (active tab + the sketch open in the edit tab).
      // The Create tab is gone; coerce a legacy persisted 'create' to the
      // Instances tab (its closest successor — where sketches now begin).
      appState.local.activeTab =
        settings.activeTab === 'create' ? 'organize' : (settings.activeTab ?? 'edit');
      appState.local.editingSketchId = settings.editingSketchId ?? null;
    });
    // No save here — this IS the load. Persistence stays disabled until
    // boot finishes calling `enablePersistence()`.
  }

  /**
   * Boot-time merge of sketches loaded from IndexedDB into the database.
   * Bypasses history — loading is not an undo-able action. Seeds the
   * "last saved" snapshot so the next mutation doesn't redundantly save
   * the loaded state, then runs a one-shot migration to convert any
   * legacy `user:<uuid>` entries (from the prior data model) into the new
   * `default:<effectId>` form.
   */
  loadInitialSketches(sketches: Record<string, Sketch>) {
    runInAction(() => {
      for (const [id, sk] of Object.entries(sketches)) {
        // Strip any legacy explicit texture_input / texture_output
        // chain entries — they're implicit in the current model and
        // would crash downstream iteration if left in.
        const normalized = normalizeSketchChains(sk);
        appState.database.sketches[id] = normalized;
        if (isPersistableProjectId(id) && !normalized.isTemplate) {
          this.projectsLastSavedJson.set(id, JSON.stringify(normalized));
        }
      }
    });
    this.migrateLegacyUserProjects();
    this.syncSketchesToEngine();
  }

  /**
   * Called by `boot()` once initial-load is complete. After this, mutations
   * actually fire IndexedDB saves; before, they're suppressed so loading
   * doesn't echo straight back to disk.
   *
   * We always schedule both saves: the migration in `loadInitialSketches`
   * may have changed in-memory state (renamed user: → default:, dropped
   * stale templates) that needs to be flushed.
   */
  enablePersistence() {
    this.persistenceEnabled = true;
    this.requestUserSettingsSave();
    this.requestProjectsSave();
    this.requestPlaygroundSave();
    void this.inputManager.setActiveSketch(appState.local.userSettings.selectedProjectId);
  }

  /**
   * One-shot migration from the previous "materialized template" model:
   *   - `user:<uuid>` with `isTemplate: true` → drop (legacy stub).
   *   - `user:<uuid>` (edited) → rename to `default:<effectId>` derived
   *     from its first module entry, so re-clicking the default brings
   *     back the user's edits exactly like a brand-new save would.
   *
   * If the new id is already in use, the legacy entry is left in place;
   * the user can clean it up via the User Projects list.
   */
  private migrateLegacyUserProjects() {
    runInAction(() => {
      const userIds = Object.keys(appState.database.sketches)
        .filter(id => isUserProjectId(id));
      for (const id of userIds) {
        const sk = appState.database.sketches[id];
        if (!sk) continue;
        if (sk.isTemplate) {
          delete appState.database.sketches[id];
          if (appState.local.userSettings.selectedProjectId === id) {
            appState.local.userSettings.selectedProjectId = null;
          }
          continue;
        }
        const moduleEntry = sketchChain(sk).find(e => e.type === 'module');
        if (moduleEntry?.type !== 'module') continue;
        const newId = defaultProjectIdForEffect(moduleEntry.module_type);
        if (appState.database.sketches[newId]) continue;
        appState.database.sketches[newId] = sk;
        delete appState.database.sketches[id];
        if (appState.local.userSettings.selectedProjectId === id) {
          appState.local.userSettings.selectedProjectId = newId;
        }
      }
    });
  }

  // ---- Debounced save scheduling (called explicitly, not via reactions) ----

  private requestUserSettingsSave(debounceMs = 300) {
    if (!this.persistenceEnabled) return;
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null;
      saveUserSettings(toJS(appState.local.userSettings)).catch(err => {
        console.warn('[user-settings] save failed', err);
      });
    }, debounceMs);
  }

  private requestProjectsSave(debounceMs = 300) {
    if (!this.persistenceEnabled) return;
    if (this.projectsSaveTimer) clearTimeout(this.projectsSaveTimer);
    this.projectsSaveTimer = setTimeout(() => {
      this.projectsSaveTimer = null;
      this.flushProjectsSave().catch(err => {
        console.warn('[project-store] flush failed', err);
      });
    }, debounceMs);
  }

  private async flushProjectsSave() {
    const sketches = appState.database.sketches;
    // Save anything keyed `default:` or `user:`, except still-pristine
    // (`isTemplate: true`) sketches — those are virtual entries from a
    // browse-only click. The first edit clears `isTemplate` (see
    // `mutate`), at which point the project becomes persistable.
    const liveIds = new Set<string>();
    for (const id of Object.keys(sketches)) {
      if (!isPersistableProjectId(id)) continue;
      if (sketches[id]?.isTemplate) continue;
      liveIds.add(id);
    }
    for (const id of liveIds) {
      const json = JSON.stringify(toJS(sketches[id]));
      if (this.projectsLastSavedJson.get(id) === json) continue;
      try {
        await saveProject(id, sketches[id]);
        this.projectsLastSavedJson.set(id, json);
      } catch (err) {
        console.warn('[project-store] save failed', id, err);
      }
    }
    for (const id of Array.from(this.projectsLastSavedJson.keys())) {
      if (!liveIds.has(id)) {
        try {
          await idbDeleteProject(id);
          this.projectsLastSavedJson.delete(id);
        } catch (err) {
          console.warn('[project-store] delete failed', id, err);
        }
      }
    }
  }

  private requestPlaygroundSave(debounceMs = 300) {
    if (!this.persistenceEnabled || !this.playgroundMode) return;
    if (this.playgroundSaveTimer) clearTimeout(this.playgroundSaveTimer);
    this.playgroundSaveTimer = setTimeout(() => {
      this.playgroundSaveTimer = null;
      this.flushPlaygroundSave().catch(err => {
        console.warn('[playground-store] flush failed', err);
      });
    }, debounceMs);
  }

  /**
   * Playground twin of `flushProjectsSave`, over the `pg:` id space and the
   * separate `playgroundInstances` store: write changed instances, delete
   * ones that vanished from the database (instance deletion, or undo of a
   * create). The two flushes can never touch each other's records — the id
   * spaces are disjoint by construction.
   */
  private async flushPlaygroundSave() {
    const sketches = appState.database.sketches;
    const liveIds = new Set(Object.keys(sketches).filter(
      id => id.startsWith(PLAYGROUND_ID_PREFIX)));
    for (const id of liveIds) {
      const json = JSON.stringify(toJS(sketches[id]));
      if (this.playgroundLastSavedJson.get(id) === json) continue;
      try {
        await savePlaygroundInstance(id, this.playgroundLabels.get(id) ?? id, sketches[id]);
        this.playgroundLastSavedJson.set(id, json);
      } catch (err) {
        console.warn('[playground-store] save failed', id, err);
      }
    }
    for (const id of Array.from(this.playgroundLastSavedJson.keys())) {
      if (!liveIds.has(id)) {
        try {
          await idbDeletePlaygroundInstance(id);
          this.playgroundLastSavedJson.delete(id);
        } catch (err) {
          console.warn('[playground-store] delete failed', id, err);
        }
      }
    }
  }

  /** Store discovered effects from a loaded WASM module. */
  setAvailableEffects(effects: EffectInfo[]) {
    runInAction(() => {
      const existing = appState.local.availableEffects;
      for (const e of effects) {
        if (!existing.some(x => x.id === e.id)) {
          existing.push({ id: e.id, name: e.name, description: e.description, category: e.category, keywords: e.keywords, bundle: e.bundle, icon: e.icon, thumbnail: e.thumbnail });
        }
      }
      // util.dashboard is a real, schema-backed core-bundle effect, but the UI
      // gives it a bespoke knob-row card instead of the generic inspector — tag
      // its registry entry with kind:'dashboard' so column-group renders the
      // custom body. (No-op until core.wasm has loaded and registered it.)
      const dash = existing.find(x => x.id === DASHBOARD_MODULE_TYPE);
      if (dash) dash.kind = 'dashboard';
      // util.sketch_output is the inverse: the UI renders its 8 fields as output
      // traces that wires write INTO (no authored knobs). column-group
      // special-cases it by module_type; the kind tag is informational.
      const so = existing.find(x => x.id === SKETCH_OUTPUT_MODULE_TYPE);
      if (so) so.kind = 'sketch_output';
    });
    // If a default project was selected before its effect was discovered
    // (typical at boot — settings load completes before WASM does), retry
    // materialization now that the effect list has grown. selectProject
    // also re-runs `syncSketchesToEngine`, flushing any sketches that
    // were waiting for effects to land.
    const sel = appState.local.userSettings.selectedProjectId;
    if (sel && isDefaultProjectId(sel)) {
      this.selectProject(sel);
      return;
    }
    // Otherwise (selection is a `user:` id, or null), still flush — the
    // sketches loaded from IndexedDB at boot have been waiting for the
    // first effects to arrive before we'd push them to the engine.
    this.syncSketchesToEngine();
  }

  /**
   * Select a project for the IDE.
   *
   * Default projects use stable `default:<effectId>` ids. If the entry
   * doesn't exist in `database.sketches` yet (first time this default is
   * being opened in this session), it's synthesized fresh and inserted
   * with `isTemplate: true`. The first real edit clears `isTemplate` (see
   * `mutate`) which makes the autosave start persisting it. Re-selecting
   * the same default later — including across reloads — picks up exactly
   * the user's saved edits because the id is stable.
   */
  selectProject(id: string | null) {
    if (!id) {
      this.setUserSetting('selectedProjectId', null);
      this.syncSketchesToEngine();
      void this.inputManager.setActiveSketch(null);
      return;
    }
    if (isDefaultProjectId(id) && !appState.database.sketches[id]) {
      const effectId = effectIdFromDefaultProjectId(id);
      const sketch = synthesizeDefaultProject(effectId, appState.local.availableEffects);
      if (!sketch) {
        // Effects haven't been discovered yet — store the selection so
        // `setAvailableEffects` can retry once the bundle loads.
        this.setUserSetting('selectedProjectId', id);
        return;
      }
      runInAction(() => {
        appState.database.sketches[id] = { ...sketch, isTemplate: true };
      });
    }
    this.setUserSetting('selectedProjectId', id);
    this.syncSketchesToEngine();
    // Save is a no-op for still-pristine sketches; first edit promotes
    // them and triggers a real save.
    this.requestProjectsSave();
    void this.inputManager.setActiveSketch(id);
  }

  /**
   * Delete a saved project (default or user). Goes through history so
   * undo restores the sketch; the autosave picks up the deletion on the
   * next debounce. Templates aren't typically deleted this way (they're
   * not user-visible) but the function tolerates them.
   */
  deleteProject(id: string) {
    if (!isPersistableProjectId(id)) return;
    this.mutate(`Delete project`, draft => {
      delete draft.sketches[id];
    });
    void this.inputManager.clear(id);
    if (appState.local.userSettings.selectedProjectId === id) {
      this.setUserSetting('selectedProjectId', null);
      this.syncSketchesToEngine();
      void this.inputManager.setActiveSketch(null);
    }
  }

  /** Sync state from the engine worker. Updates plugins and adopts new remote sketches. */
  syncFromRemoteState(engineState: EngineState) {
    // Snapshot the previous plugin set so we can detect "we just learned
    // a schema we didn't have before" and re-sync any sketch that was
    // pushed to the engine without that knowledge.
    //
    // Why this matters: setAvailableEffects fires from the worker's
    // `effectsDiscovered` post (synchronous on bundle-load completion),
    // and that's when sketches first get pushed to the engine. But
    // PLUGIN SCHEMAS (which are what augmentSketchWithImplicitConnections
    // needs to wire up implicit struct-rail connections) arrive a frame
    // later via this `state` broadcast. Without a re-sync here, the
    // engine ends up holding an un-augmented sketch — every motion-vector
    // consumer like motion.blur sits in pass-through fallback
    // until something else triggers a sync (param release does, because
    // its postRecordHook calls syncSketchesToEngine). Symptom on a fresh
    // page reload: nothing renders until you release a slider.
    const oldPluginIds = new Set(appState.local.plugins.map(p => p.id));
    const newPluginIds = new Set(engineState.plugins.map(p => p.id));
    let pluginsChanged = oldPluginIds.size !== newPluginIds.size;
    if (!pluginsChanged) {
      for (const id of newPluginIds) {
        if (!oldPluginIds.has(id)) { pluginsChanged = true; break; }
      }
    }

    runInAction(() => { appState.local.plugins = engineState.plugins; });

    for (const [id, sketch] of Object.entries(engineState.sketches)) {
      if (!(id in appState.database.sketches)) {
        this.mutate(`Remote sketch ${id}`, draft => {
          draft.sketches[id] = sketch;
        });
      } else {
        const local = JSON.stringify(appState.database.sketches[id]);
        const remote = JSON.stringify(sketch);
        if (local !== remote) {
          console.warn(`[conflict] Sketch ${id} differs between local and remote. Local wins for now.`);
        }
      }
    }

    if (pluginsChanged) {
      // Re-push sketches now that we have schemas to drive implicit
      // connection wiring. Idempotent on the engine side — it just
      // overwrites its sketches map — but the augmented form will
      // differ from whatever was pushed before plugins arrived.
      this.syncSketchesToEngine();
      // Schemas just arrived → back-fill any instance whose state was
      // left empty because the schema wasn't yet known when the user
      // dropped the effect. This is the common path in barrel mode,
      // where no effect plugins get registered until they're first
      // used (and the user's first drop is the first use). The
      // resulting mutation pushes proper defaults back to the barrel.
      this.backfillEmptyInstanceStates();
    }
  }

  /**
   * Walk every sketch's instance map; for any instance whose `state`
   * is `{}` and whose plugin schema is now known, populate defaults
   * from `plugin.params`. Coalesces into one `mutate(...)` so undo
   * sees a single "discover defaults" step (and the barrel push fires
   * exactly once with the post-discovery sketch).
   */
  private backfillEmptyInstanceStates() {
    const pluginsById = new Map<string, PluginInfo>();
    for (const p of appState.local.plugins) {
      if (p.params && p.params.length > 0) pluginsById.set(p.id, p);
    }
    if (pluginsById.size === 0) return;

    type Job = { sketchId: string; instanceKey: string; defaults: Record<string, any> };
    const jobs: Job[] = [];
    for (const [sketchId, sketch] of Object.entries(appState.database.sketches)) {
      const instances = sketch?.instances;
      if (!instances) continue;
      for (const [instKey, inst] of Object.entries(instances)) {
        if (!inst || typeof inst !== 'object') continue;
        const state = (inst as any).state;
        if (state && typeof state === 'object' && Object.keys(state).length > 0) continue;
        const moduleType = (inst as any).module_type;
        if (typeof moduleType !== 'string') continue;
        const plugin = pluginsById.get(moduleType);
        if (!plugin) continue;
        const defaults = this.defaultStateForPlugin(plugin);
        if (Object.keys(defaults).length === 0) continue;
        jobs.push({ sketchId, instanceKey: instKey, defaults });
      }
    }
    if (jobs.length === 0) return;

    this.mutate('Discover plugin defaults', draft => {
      for (const job of jobs) {
        const sk = draft.sketches[job.sketchId];
        if (!sk?.instances?.[job.instanceKey]) continue;
        sk.instances[job.instanceKey].state = job.defaults;
      }
    });
  }

  // --- Tapping mode & field selection ---

  setTappingMode(on: boolean) {
    runInAction(() => {
      appState.local.tappingMode = on;
    });
    // Leaving taps mode clears a field/rail selection (but not an effect one).
    if (!on) {
      const p = appState.local.selection?.path;
      if (p && (p.startsWith('field/') || p.startsWith('rail/'))) this.select(null);
    }
  }

  /** Toggle "?" help mode (inline effect help text + section help). */
  setHelpMode(on: boolean) {
    runInAction(() => {
      appState.local.helpMode = on;
    });
  }

  /**
   * Select a field by its key `<sketchId>/<col>/<chain>/<fieldPath>`. Routed
   * through the unified `Selectable` registry as a `field/…` path so field,
   * rail, and effect selection are mutually exclusive (one at a time) and a
   * background-click `select(null)` deselects fields too.
   */
  selectField(key: string | null) {
    this.select(key ? `field/${key}` : null);
  }

  /** The selected field key (without the `field/` prefix), or null. */
  selectedFieldKey(): string | null {
    const p = appState.local.selection?.path;
    return p && p.startsWith('field/') ? p.slice('field/'.length) : null;
  }

  // --- Selection / Inspector ---

  /**
   * Register a selectable element. If this path was queued for selection
   * (user clicked before the component rendered), the selection activates.
   * Call this from component render/updated methods.
   */
  defineSelectable(selectable: Selectable) {
    // Plain Map — not observable, safe to mutate during render.
    this.selectableRegistry.set(selectable.path, selectable);

    // Promote queued selection (fires once, not every render).
    if (appState.local.queuedSelectionPath === selectable.path) {
      runInAction(() => {
        appState.local.selection = selectable;
        appState.local.queuedSelectionPath = null;
      });
    }
  }

  /** Unregister a selectable (component disconnected). */
  undefineSelectable(path: string) {
    this.selectableRegistry.delete(path);
  }

  /** Select a path. If the selectable is registered, activates immediately. Otherwise queues.
   *  Plain (non-modified) selection: the multi-selection collapses to just this
   *  path (when it's an effect card — the group anchor) or clears entirely. */
  select(path: string | null) {
    runInAction(() => {
      appState.local.multiSelection = path && parseEffectPath(path) ? [path] : [];
      if (path === null) {
        appState.local.selection = null;
        appState.local.queuedSelectionPath = null;
        return;
      }
      const selectable = this.selectableRegistry.get(path);
      if (selectable) {
        appState.local.selection = selectable;
        appState.local.queuedSelectionPath = null;
      } else {
        appState.local.queuedSelectionPath = path;
        appState.local.selection = null;
      }
    });
  }

  /** Set the primary selection WITHOUT collapsing the multi-selection (the
   *  group-selection gestures below re-point the inspector as they grow). */
  private selectPrimaryKeepGroup(path: string) {
    runInAction(() => {
      const selectable = this.selectableRegistry.get(path);
      if (selectable) {
        appState.local.selection = selectable;
        appState.local.queuedSelectionPath = null;
      } else {
        appState.local.queuedSelectionPath = path;
        appState.local.selection = null;
      }
    });
  }

  /** Chain-order (ascending chainIdx) for multi-selection paths — keeps copy
   *  order deterministic and range math simple. */
  private static byChainIdx(a: string, b: string): number {
    return (parseEffectPath(a)?.chainIdx ?? 0) - (parseEffectPath(b)?.chainIdx ?? 0);
  }

  /**
   * Cmd/ctrl-click an effect card: toggle its membership in the
   * multi-selection. Adding makes it the primary (the inspector follows the
   * last-touched card); removing the primary hands primary to another member.
   * A card from a DIFFERENT sketch than the current group falls back to a
   * plain select — groups never span sketches.
   */
  toggleSelectEffect(path: string) {
    const parts = parseEffectPath(path);
    if (!parts) { this.select(path); return; }
    const current = appState.local.multiSelection;
    const currentSketch = current[0] ? parseEffectPath(current[0])?.sketchId : undefined;
    if (currentSketch !== undefined && currentSketch !== parts.sketchId) {
      this.select(path);
      return;
    }
    if (current.includes(path)) {
      const remaining = current.filter(p => p !== path);
      runInAction(() => { appState.local.multiSelection = remaining; });
      if (appState.local.selection?.path === path
        || appState.local.queuedSelectionPath === path) {
        if (remaining.length > 0) this.selectPrimaryKeepGroup(remaining[remaining.length - 1]);
        else this.select(null);
      }
    } else {
      runInAction(() => {
        appState.local.multiSelection =
          [...current, path].sort(AppController.byChainIdx);
      });
      this.selectPrimaryKeepGroup(path);
    }
  }

  /**
   * Shift-click an effect card: select the contiguous chain range between the
   * current primary selection (the anchor, which stays primary) and this card.
   * Without an effect-card anchor in the same sketch it degrades to a plain
   * select.
   */
  rangeSelectEffect(path: string) {
    const parts = parseEffectPath(path);
    const anchorPath = appState.local.selection?.path ?? appState.local.queuedSelectionPath;
    const anchor = anchorPath ? parseEffectPath(anchorPath) : null;
    if (!parts || !anchor || anchor.sketchId !== parts.sketchId
      || anchor.colIdx !== parts.colIdx) {
      this.select(path);
      return;
    }
    const lo = Math.min(anchor.chainIdx, parts.chainIdx);
    const hi = Math.max(anchor.chainIdx, parts.chainIdx);
    const sk = appState.database.sketches[parts.sketchId];
    const chain = sk ? sketchChain(sk) : [];
    const paths: string[] = [];
    for (let i = lo; i <= hi; i++) {
      if (chain[i]?.type === 'module') paths.push(effectPath(parts.sketchId, parts.colIdx, i));
    }
    runInAction(() => { appState.local.multiSelection = paths; });
  }

  /**
   * Cmd+A: multi-select every effect card in the sketch being edited. Primary
   * lands on the first card (so the inspector shows something sensible).
   * Returns false when there's no active sketch or it has no cards — callers
   * then leave the event to the browser.
   */
  selectAllEffects(): boolean {
    const sketchId = this.activeEditSketchId();
    const sk = sketchId ? appState.database.sketches[sketchId] : undefined;
    if (!sketchId || !sk) return false;
    const paths: string[] = [];
    sketchChain(sk).forEach((entry, i) => {
      if (entry.type === 'module') paths.push(effectPath(sketchId, 0, i));
    });
    if (paths.length === 0) return false;
    runInAction(() => { appState.local.multiSelection = paths; });
    this.selectPrimaryKeepGroup(paths[0]);
    return true;
  }

  /** True when `path` is part of the multi-selection (card highlight). */
  isMultiSelected(path: string): boolean {
    return appState.local.multiSelection.includes(path);
  }

  /**
   * The sketch the edit surface is showing: the resolume shell's edited sketch
   * when it resolves, else the effect IDE's selected project. Checked against
   * the loaded sketches because the two shells share the persisted user
   * settings — each sees the OTHER's (unloadable) id in the foreign slot.
   */
  private activeEditSketchId(): string | null {
    for (const id of [appState.local.editingSketchId,
                      appState.local.userSettings.selectedProjectId]) {
      if (id && appState.database.sketches[id]) return id;
    }
    return null;
  }

  /** Look up a selectable by path (for reading fresh renderInspectorContent). */
  getSelectable(path: string): Selectable | undefined {
    return this.selectableRegistry.get(path);
  }

  /** Check if a path is currently selected. */
  isSelected(path: string): boolean {
    return appState.local.selection?.path === path;
  }

  // --- Wire CRUD (single-stack model; replaces field→field taps) ---

  private nextWireId = 0;

  /**
   * Connect two fields with a `Wire` (the new model). Writer = the output-bit
   * field, or — if both are same-direction — the one higher in the stack;
   * reader = the other. Endpoints are stored by `instance_key` + field so the
   * wire survives reordering. Causality (same-frame vs 1-frame-delayed) is
   * inferred from stack position by the executor — no flag stored here.
   *
   * Any existing wire targeting the same dest field is replaced (last
   * connection wins). Declaring `sketch.wires` (even empty) opts the sketch into
   * wire mode (struct auto-connect etc.); we always ensure the array exists.
   */
  connectWire(a: FieldConnectInfo, b: FieldConnectInfo) {
    if (a.sketchId !== b.sketchId) return;
    if (a.colIdx === b.colIdx && a.chainIdx === b.chainIdx && a.fieldPath === b.fieldPath) return;

    let writer: FieldConnectInfo;
    let reader: FieldConnectInfo;
    if (a.isOutput !== b.isOutput) {
      writer = a.isOutput ? a : b;
      reader = a.isOutput ? b : a;
    } else {
      writer = a.viewportY <= b.viewportY ? a : b;
      reader = a.viewportY <= b.viewportY ? b : a;
    }

    const sketchId = writer.sketchId;
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;
    const writerEntry = sketchChain(sketch)[writer.chainIdx];
    const readerEntry = sketchChain(sketch)[reader.chainIdx];
    if (writerEntry?.type !== 'module' || readerEntry?.type !== 'module') return;
    const srcKey = writerEntry.instance_key;
    const destKey = readerEntry.instance_key;
    if (!srcKey || !destKey) return;

    // Collision-proof id: the per-session counter alone resets to 0 on reload,
    // so a fresh wire could reuse `wire_0` already held by a persisted wire —
    // colliding ids make selection highlight BOTH and the mod binding edit the
    // wrong (first-matching) wire. Pair the counter with the wall clock so ids
    // stay unique across reloads.
    const id = `wire_${Date.now().toString(36)}_${this.nextWireId++}`;
    this.mutate('Connect wire', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      sk.wires = sk.wires ?? [];
      // Replace any existing wire into the same dest field (last wins).
      sk.wires = sk.wires.filter(
        w => !(w.dest.instanceKey === destKey && w.dest.field === reader.fieldPath));
      sk.wires.push({
        id,
        src: { instanceKey: srcKey, field: writer.fieldPath },
        dest: { instanceKey: destKey, field: reader.fieldPath },
        // Default scalar wires to `add` — gentle, it rides on top of the dest's
        // current value instead of overwriting it. (Ignored for texture rails.)
        // `unset` still means `replace` everywhere else, so auto-connect and the
        // dashboard mute heuristic are unaffected; we set it explicitly here.
        combine: 'add',
      });
    });
  }

  /** Remove a wire by id. */
  removeWire(sketchId: string, wireId: string) {
    // Drop the selection if it's this wire.
    if (appState.local.selection?.path === wireSelectablePath(sketchId, wireId)) {
      this.select(null);
    }
    this.selectableRegistry.delete(wireSelectablePath(sketchId, wireId));
    this.mutate('Remove wire', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk?.wires) return;
      sk.wires = sk.wires.filter(w => w.id !== wireId);
    });
  }

  // --- Wire modulation (scalar wires: value remap + combine mode) ---

  /** Recipe that shallow-merges a patch onto a wire's top-level fields
   *  (`mod` / `combine` / `mixFactor`). Callers build the full `mod` sub-tree
   *  in the patch, so a shallow assign replaces it wholesale. */
  private wirePatchRecipe(sketchId: string, wireId: string, patch: Partial<Wire>) {
    return (draft: DatabaseState) => {
      const w = draft.sketches[sketchId]?.wires?.find(w => w.id === wireId);
      if (!w) return;
      Object.assign(w, patch);
    };
  }

  /** Patch a wire's modulation (one undo point). */
  updateWire(sketchId: string, wireId: string, patch: Partial<Wire>) {
    this.mutate('Edit wire', this.wirePatchRecipe(sketchId, wireId, patch));
  }

  /** Begin a continuous wire-mod edit (slider drag). No undo points during drag. */
  beginUpdateWire(sketchId: string, wireId: string, patch: Partial<Wire>): LongEdit {
    const edit = this.history.beginLongEdit('Edit wire', this.wirePatchRecipe(sketchId, wireId, patch));
    this.pushSketchLive(sketchId);
    return edit;
  }

  /** Update a continuous wire-mod edit (drag in progress). */
  updateUpdateWire(edit: LongEdit, sketchId: string, wireId: string, patch: Partial<Wire>) {
    edit.update(this.wirePatchRecipe(sketchId, wireId, patch));
    this.pushSketchLive(sketchId);
  }

  /**
   * Push one sketch's current (possibly long-edit-previewed) state to the
   * engine for LIVE render feedback during a drag. The `longEditHook`
   * deliberately skips engine sync during previews — device-param drags
   * compensate with their own per-update `engine.setParam`; wire-mod edits
   * live in `sketch.wires`, which has no targeted command, so we re-push the
   * single edited sketch (same path `syncSketchesToEngine` uses on commit).
   */
  private pushSketchLive(sketchId: string) {
    if (!this.engine || appState.local.availableEffects.length === 0) return;
    if (this.engineSketchFilter && !this.engineSketchFilter(sketchId)) return;
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;
    this.engine.updateSketch(sketchId, JSON.parse(JSON.stringify(toJS(sketch))));
  }

  // --- Field options (engine-level per-parameter options) ---

  private fieldSmoothingRecipe(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string,
                               patch: Partial<import('../sketch-types').ParamSmoothing>) {
    return (draft: DatabaseState) => {
      const sk = draft.sketches[sketchId];
      const entry = sk ? sketchChain(sk)[chainIdx] : undefined;
      if (entry?.type !== 'module') return;
      entry.fieldOptions ??= {};
      const fo = (entry.fieldOptions[fieldPath] ??= {});
      fo.smoothing = { enabled: false, duration: 0.2, ...fo.smoothing, ...patch };
    };
  }

  /**
   * Merge a partial smoothing config into a field's engine-level options.
   * Creates the `fieldOptions[fieldPath].smoothing` sub-tree on demand.
   */
  setFieldSmoothing(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string,
                    patch: Partial<import('../sketch-types').ParamSmoothing>) {
    this.mutate('Edit smoothing', this.fieldSmoothingRecipe(sketchId, colIdx, chainIdx, fieldPath, patch));
  }

  /** Begin a continuous smoothing edit (slider drag). No undo points during the drag. */
  beginSetFieldSmoothing(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string,
                         patch: Partial<import('../sketch-types').ParamSmoothing>): LongEdit {
    const edit = this.history.beginLongEdit(
      'Edit smoothing', this.fieldSmoothingRecipe(sketchId, colIdx, chainIdx, fieldPath, patch));
    this.syncSketchesToEngine();
    return edit;
  }

  /** Update a continuous smoothing edit (drag in progress). */
  updateSetFieldSmoothing(edit: LongEdit, sketchId: string, colIdx: number, chainIdx: number,
                          fieldPath: string, patch: Partial<import('../sketch-types').ParamSmoothing>) {
    edit.update(this.fieldSmoothingRecipe(sketchId, colIdx, chainIdx, fieldPath, patch));
    this.syncSketchesToEngine();
  }

  setBarrelMode(on: boolean) {
    // Both modes share the same Instances/Edit tab shell now, so the
    // persisted activeTab is honored as-is (no per-mode tab coercion).
    runInAction(() => { appState.local.barrelMode = on; });
  }

  /** Entered by resolume-app when booting the `?playground` surface. */
  setPlaygroundMode(on: boolean) {
    this.playgroundMode = on;
  }

  /** Shared-server WebSocket health (wired from WsBridgeClient callbacks). */
  setBarrelConnectionState(state: 'connecting' | 'open' | 'closed') {
    if (appState.local.barrelConnection === state) return;
    runInAction(() => { appState.local.barrelConnection = state; });
  }

  /** Playground probe found a live shared server on the barrel port. */
  setBarrelDetected(on: boolean) {
    if (appState.local.barrelDetected === on) return;
    runInAction(() => { appState.local.barrelDetected = on; });
  }

  /** Adopt sidechannel-bus channel metadata (worker push in playground/ide,
   *  /global/sidechannels observation in barrel mode). Change-gated upstream. */
  setSidechannels(channels: Record<string, import('../engine-types').SidechannelInfo>) {
    runInAction(() => { appState.local.engine.sidechannels = channels ?? {}; });
  }

  /** Select a sidechannel card on the Instances tab (its inspector shows in
   *  the right panel), or clear with null. */
  selectSidechannel(channel: string | null) {
    runInAction(() => { appState.local.selectedSidechannel = channel; });
  }

  /** Set a sidechannel's display-name override template ("#" expands to the
   *  default label; blank/"#" reverts to it). Persisted in user settings. */
  setSidechannelDisplayName(channel: string, template: string) {
    const names = { ...appState.local.userSettings.sidechannelNames };
    const trimmed = template.trim();
    if (!trimmed || trimmed === '#') delete names[channel];
    else names[channel] = template;
    this.setUserSetting('sidechannelNames', names);
  }

  // ========================================================================
  // Playground instances (fake barrel instances, local shared-server env)
  // ========================================================================

  /**
   * Boot-time load of the playground's instances from their own IndexedDB
   * store. Bypasses history (loading is not undoable), seeds the last-saved
   * snapshots so the flush doesn't echo the load back to disk, then surfaces
   * the instances through the shared barrel-instances list (whose select
   * flow also repairs a stale persisted selection/editing id).
   */
  loadInitialPlaygroundInstances(records: PlaygroundInstanceRecord[]) {
    runInAction(() => {
      for (const r of records) {
        appState.database.sketches[r.id] = normalizeSketchChains(r.sketch);
        this.playgroundLabels.set(r.id, r.label || r.id);
      }
      // A persisted editingSketchId from another mode/session (or a deleted
      // instance) must not linger — the select flow below re-points it at a
      // live instance, but only if it changes the selection; clear first.
      const editing = appState.local.editingSketchId;
      if (editing && !appState.database.sketches[editing]) {
        appState.local.editingSketchId = null;
      }
    });
    for (const r of records) {
      this.playgroundLastSavedJson.set(
        r.id, JSON.stringify(toJS(appState.database.sketches[r.id])));
    }
    this.refreshPlaygroundInstanceList();
    this.syncSketchesToEngine();
  }

  /**
   * Create a fresh playground instance: an EMPTY sketch (the same shape a
   * fresh NanoBarrel publishes) — the edit tab's insert palette populates
   * it, exactly like barrel mode. Returns the new instance id.
   */
  createPlaygroundInstance(): string {
    const id = PLAYGROUND_ID_PREFIX + crypto.randomUUID();
    // Lowest "Instance N" label not used by a LIVE instance (a deleted
    // instance frees its label; its map entry only serves undo-restore).
    const used = new Set(Object.keys(appState.database.sketches)
      .filter(k => k.startsWith(PLAYGROUND_ID_PREFIX))
      .map(k => this.playgroundLabels.get(k)));
    let n = 1;
    while (used.has(`Instance ${n}`)) n++;
    this.playgroundLabels.set(id, `Instance ${n}`);

    this.mutate('Create playground instance', draft => {
      draft.sketches[id] = { anchor: null, chain: [], wires: [], instances: {} };
    });
    this.refreshPlaygroundInstanceList();
    // Open the new instance for editing. The list refresh may already have
    // auto-selected it (first-ever instance) — don't fire the handler twice.
    if (appState.local.selectedBarrelKey !== id) this.selectBarrelInstance(id);
    return id;
  }

  /** Delete a playground instance (undo restores it, label included). */
  deletePlaygroundInstanceById(id: string) {
    if (!id.startsWith(PLAYGROUND_ID_PREFIX)) return;
    this.mutate('Delete playground instance', draft => {
      delete draft.sketches[id];
    });
    if (appState.local.editingSketchId === id) this.editSketch(null);
    // postRecordHook already refreshed the list (which repairs the
    // selection) and scheduled the persistence flush (which deletes the
    // IDB record on the next debounce).
  }

  /**
   * Mirror the `pg:` sketches into the shared barrel-instances list — the
   * Instances tab and the selection flow are mode-agnostic on purpose (the
   * playground IS a fake shared server).
   */
  private refreshPlaygroundInstanceList() {
    const list: BarrelInstanceInfo[] = Object.keys(appState.database.sketches)
      .filter(id => id.startsWith(PLAYGROUND_ID_PREFIX))
      .map(id => ({
        key: id,
        id: 'playground',
        label: this.playgroundLabels.get(id) ?? id,
      }));
    this.setBarrelInstances(list);
  }

  /**
   * Register the closure that (re)wires the WS bridge for a selected
   * barrel instance. resolume-app owns the transport; the controller owns
   * selection state — so selection calls back into resolume-app here.
   */
  setBarrelSelectHandler(fn: ((key: string) => void) | null) {
    this.barrelSelectHandler = fn;
  }

  getSelectedBarrelKey(): string | null {
    return appState.local.selectedBarrelKey;
  }

  /**
   * Adopt the live instance list enumerated from the shared server's
   * `/global/plugins`. Preserves the current selection if it's still
   * present; otherwise selects the last-used (localStorage) instance if
   * live, else the first — and (re)wires it via the select handler.
   */
  setBarrelInstances(list: BarrelInstanceInfo[]) {
    runInAction(() => { appState.local.barrelInstances = list; });
    const has = (k: string | null) => !!k && list.some(i => i.key === k);
    if (has(appState.local.selectedBarrelKey)) return;  // keep current

    let next: string | null = null;
    try {
      const saved = localStorage.getItem(this.selectedKeyStorageKey());
      if (has(saved)) next = saved;
    } catch { /* ignore */ }
    if (!next && list.length > 0) next = list[0].key;

    if (next) this.selectBarrelInstance(next);
    else runInAction(() => { appState.local.selectedBarrelKey = null; });
  }

  /** Pick the barrel instance to edit; persists + rewires the bridge. */
  selectBarrelInstance(key: string) {
    runInAction(() => { appState.local.selectedBarrelKey = key; });
    try { localStorage.setItem(this.selectedKeyStorageKey(), key); } catch { /* ignore */ }
    this.barrelSelectHandler?.(key);
  }

  /** Last-selected-instance memory is scoped per mode — a playground
   *  session must not clobber (or adopt) the live barrel selection. */
  private selectedKeyStorageKey(): string {
    return this.playgroundMode ? 'playground.selectedKey' : 'barrel.selectedKey';
  }

  /**
   * Adopt a plugin list published by the remote barrel through the WS
   * bridge. Bypasses the engine worker entirely — in barrel mode the
   * worker never instantiates effects, so its schemas would otherwise
   * never reach the inspector or the augmenter.
   *
   * Each entry already carries an `id` and a raw `schema` fields object;
   * `params` and `io` are derived here from the schema (mirroring the
   * same derivation `wasm-host.ts` runs when a wasm effect registers
   * locally), so callers don't have to think about that shape.
   *
   * Also surfaces the same list as `availableEffects` so the column
   * picker has something to show — the per-column "Drop effect" UI
   * queries it.
   */
  setBarrelPlugins(remotePlugins: Array<{ id: string; key?: string; version?: string; schema?: Record<string, any> }>) {
    const plugins: PluginInfo[] = remotePlugins.map(rp => {
      const schema = rp.schema ?? {};
      const params: PluginInfo['params'] = [];
      const io: PluginInfo['io'] = [];
      let paramIdx = 0;
      for (const [name, fieldRaw] of Object.entries(schema)) {
        const field = fieldRaw as any;
        const ioFlags = field?.io ?? 0;
        if (field?.type === 'texture') {
          const dir = (ioFlags & 1) ? 0 : 1;       // 0=input, 1=output
          const role = (ioFlags & 4) ? 0 : 1;       // 0=primary, 1=secondary
          io.push({ index: io.length, name, kind: dir, role });
        } else if (field?.type === 'object' || field?.type === 'array'
                || field?.type === 'float2' || field?.type === 'float3'
                || field?.type === 'float4') {
          if (ioFlags & 2) {
            const role = (ioFlags & 4) ? 0 : 1;
            io.push({ index: io.length, name, kind: 2, role });
          }
        } else {
          let type = 10;                            // Standard
          if (field?.type === 'bool') type = 0;
          else if (field?.type === 'event') type = 1;
          else if (field?.type === 'int') type = 13;
          else if (field?.type === 'string') type = 100;
          let defaultValue = 0;
          const fd = field?.default;
          if (typeof fd === 'number') defaultValue = fd;
          else if (typeof fd === 'boolean') defaultValue = fd ? 1 : 0;
          params.push({
            index: paramIdx++, name, type, defaultValue,
            min: typeof field?.min === 'number' ? field.min : 0,
            max: typeof field?.max === 'number' ? field.max : 1,
          });
          if (ioFlags & 2) {
            const role = (ioFlags & 4) ? 0 : 1;
            io.push({ index: io.length, name, kind: 2, role });
          }
        }
      }
      return {
        key: rp.key ?? rp.id,
        id: rp.id,
        version: rp.version ?? '0.0.0',
        moduleVersion: (rp as any).moduleVersion ?? '0.0.0',
        params, io, schema,
        // Forwarded by the barrel host when present; harmless [] otherwise.
        capabilities: Array.isArray((rp as any).capabilities) ? (rp as any).capabilities : [],
      };
    });

    const availableEffects: AvailableEffect[] = plugins.map(p => ({
      id: p.id,
      name: shortName(p.id),
      description: '',
      category: '',
      keywords: [],
    }));

    runInAction(() => {
      appState.local.plugins = plugins;
      appState.local.availableEffects = availableEffects;
    });
    if (availableEffects.length === 0) {
      console.warn('[barrel] connected instance published no effect schemas — ' +
        'the NanoBarrel loaded 0 wasm effects (stale/empty Contents/Resources/wasm). ' +
        'Rebuild the bundle (native/wasm_modules/build_all.sh) and redeploy it.');
    }

    // Any sketch instances whose state landed before the schemas arrived
    // (typical in barrel mode where the WS snapshot races schema and
    // sketch arrival) now get their defaults filled in. The resulting
    // mutation pushes the upgraded sketch back to the barrel.
    this.backfillEmptyInstanceStates();
  }

  /**
   * Direct write into the sketches database without going through
   * `mutate()`. Used by the barrel sync to mirror remote state — no
   * undo entry, no IndexedDB persistence (the remote bridge owns it).
   * `sketch` is intentionally loose-typed (any) because the remote
   * blob may not yet conform to the Sketch shape during early bring-up.
   *
   * Also seeds `lastPushedBarrelJson` so the immediately-following
   * `postRecordHook` invocations (if any) don't observe a diff and
   * push the snapshot we just received straight back to the bridge.
   */
  setBarrelSketch(id: string, sketch: any) {
    runInAction(() => {
      appState.database.sketches[id] = sketch;
    });
    if (this.barrelSketchId === id) {
      try { this.lastPushedBarrelJson = JSON.stringify(sketch); }
      catch { this.lastPushedBarrelJson = null; }
    }
    // The remote may have handed us instances with `state: {}` left over
    // from before the plugin schemas were known (eg the user dropped an
    // effect in barrel mode before the warmup landed). Run the backfill
    // unconditionally — it's a no-op when plugins aren't yet registered
    // OR when every instance already has populated state, and when it
    // does have work, the resulting mutation push upgrades the persisted
    // bridge blob in place.
    this.backfillEmptyInstanceStates();
  }

  /**
   * Wire (or rewire) the editor → barrel push path. Every subsequent
   * mutation of the named sketch produces a single JSON-patch send via
   * `pusher`, debounced only by an identity check on the serialized
   * sketch (no time-based debounce — the remote bridge already has its
   * own 200 ms regen window before the value reaches the FILE param).
   *
   * Pass `null` (or call `clearBarrelPusher()`) to detach when the
   * bridge disconnects.
   */
  setBarrelPusher(sketchId: string, pusher: (sketch: Sketch) => void) {
    this.barrelSketchId = sketchId;
    this.barrelPusher = pusher;
    // Seed the high-water mark to whatever's currently in the database
    // so we don't immediately push a snapshot the bridge just sent us.
    const sketch = appState.database.sketches[sketchId];
    if (sketch) {
      try { this.lastPushedBarrelJson = JSON.stringify(toJS(sketch)); }
      catch { this.lastPushedBarrelJson = null; }
    } else {
      this.lastPushedBarrelJson = null;
    }
  }

  clearBarrelPusher() {
    this.barrelSketchId = null;
    this.barrelPusher = null;
    this.lastPushedBarrelJson = null;
  }

  /**
   * Install (or clear with null) the barrel-mode preview pusher.
   * resolume-app uses this to relay trace-controller flush events into
   * a /preview_requests JSON patch on the bridge. Called after the
   * WsBridgeClient connects so the closure captures a live client.
   *
   * Triggers an immediate flush so the bridge picks up any registrations
   * that landed before the pusher was wired (texture-monitors connected
   * during the barrel handshake).
   */
  setBarrelPreviewPusher(pusher: ((tracePoints: TracePoint[]) => void) | null) {
    this.barrelPreviewPusher = pusher;
    // Force a flush so any texture-monitors that mounted before the WS
    // connected get a fresh request landing on the bridge.
    if (pusher) traceController.requestFlush();
  }

  /**
   * Decode + ingest a binary WS frame from the shared barrel server.
   * NBPV v2 layout (one server multiplexes many instances → the plugin
   * key is in the header so we can route to the selected instance):
   *
   *   bytes 0-3:  magic "NBPV"
   *   byte 4:     version (2)
   *   byte 5:     pixel format (1 = RGBA8)
   *   bytes 6-7:  u16 key length
   *   bytes 8-9:  u16 traceId length
   *   bytes 10-11: u16 width
   *   bytes 12-13: u16 height
   *   bytes 14 ..: key (UTF-8), then traceId (UTF-8), then RGBA8 pixels
   *
   * Frames whose key is neither the selected instance's nor an instance
   * thumbnail's are dropped (another client's preview traffic). On success
   * the decoded ImageBitmap lands at
   * `appState.local.engine.tracedFrames[traceId]`, which existing
   * texture-monitor autoruns already redraw from. Malformed frames are
   * dropped silently.
   */
  async ingestBarrelPreviewFrame(buf: ArrayBuffer) {
    if (buf.byteLength < 14) return;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 0x4E || dv.getUint8(1) !== 0x42 ||  // 'N' 'B'
        dv.getUint8(2) !== 0x50 || dv.getUint8(3) !== 0x56) {  // 'P' 'V'
      return;
    }
    if (dv.getUint8(4) !== 2) return;        // unknown version (clean break: v2 only)
    if (dv.getUint8(5) !== 1) return;        // unknown pixel format
    const keyLen = dv.getUint16(6, true);
    const idLen  = dv.getUint16(8, true);
    const width  = dv.getUint16(10, true);
    const height = dv.getUint16(12, true);
    const keyEnd = 14 + keyLen;
    const headerEnd = keyEnd + idLen;
    const pixelBytes = width * height * 4;
    if (buf.byteLength < headerEnd + pixelBytes) return;
    const key = new TextDecoder().decode(new Uint8Array(buf, 14, keyLen));
    const traceId = new TextDecoder().decode(new Uint8Array(buf, keyEnd, idLen));
    // Route: accept the edited instance's frames (edit preview, chain-entry
    // monitors), any instance's own Instances-tab thumbnail (its trace id
    // embeds the key), and sidechannel thumbnails (keyed by whichever
    // instance WRITES the channel). Everything else is another client's
    // preview traffic.
    if (key !== appState.local.selectedBarrelKey &&
        instanceKeyFromThumbTraceId(traceId) !== key &&
        !isSidechannelThumbTraceId(traceId)) return;
    // ImageData requires its backing Uint8ClampedArray to span its own
    // buffer (byteOffset 0, full length). A subview over the incoming
    // ArrayBuffer would be cheaper but breaks the spec — so we copy
    // into a fresh tightly-owned buffer. At low-res (128×72×4 = 36 kB)
    // this is single-digit microseconds.
    const owned = new Uint8ClampedArray(pixelBytes);
    owned.set(new Uint8Array(buf, headerEnd, pixelBytes));
    let bitmap: ImageBitmap;
    try {
      const imageData = new ImageData(owned, width, height);
      bitmap = await createImageBitmap(imageData);
    } catch {
      return;
    }
    runInAction(() => {
      const prev = appState.local.engine.tracedFrames[traceId];
      // ImageBitmap is a one-shot resource — drop the old one if any
      // before swapping so the GPU-backed buffer can be freed.
      try { prev?.close(); } catch { /* ignore */ }
      appState.local.engine.tracedFrames = {
        ...appState.local.engine.tracedFrames,
        [traceId]: bitmap,
      };
      appState.local.engine.frameGeneration++;
    });
  }

  private maybePushBarrelSketch() {
    const id = this.barrelSketchId;
    const pusher = this.barrelPusher;
    if (!id || !pusher) return;
    const sketch = appState.database.sketches[id];
    if (!sketch) return;
    const plain = toJS(sketch);
    let json: string;
    try { json = JSON.stringify(plain); }
    catch { return; }
    if (json === this.lastPushedBarrelJson) return;
    this.lastPushedBarrelJson = json;
    try { pusher(plain as Sketch); }
    catch (err) { console.warn('[barrel] pusher failed:', err); }
  }

  editSketch(id: string | null) {
    runInAction(() => { appState.local.editingSketchId = id; });
    // Remember the open sketch across reloads, and re-scope execution: the
    // resolume engine filter runs only `editingSketchId`, so changing it must
    // re-sync. (No-op persistence/save until boot enables it.)
    this.setUserSetting('editingSketchId', id);
    this.syncSketchesToEngine();
    // The `edit_preview` monitor trace is owned by edit-tab, which registers it
    // reactively (final output, or the selected texture) for its whole lifetime
    // — keeping it alive across selection changes so the monitor never blanks on
    // deselect. See edit-tab's `previewTargetDisposer`.
  }

  setEngineFps(fps: number) {
    runInAction(() => { appState.local.engine.fps = fps; });
  }

  /**
   * Estimated GPU busy-time (ms) for the latest frame. Rounded to 0.1 ms and
   * skipped when unchanged so the observable — and the headroom readout that
   * reads it — only updates when the displayed value would, keeping the frame
   * loop off the main thread's mobx/lit path.
   */
  setEngineGpuTime(ms: number) {
    const rounded = Math.round(ms * 10) / 10;
    if (appState.local.engine.gpuTimeMs === rounded) return;
    runInAction(() => { appState.local.engine.gpuTimeMs = rounded; });
  }

  setEngineError(error: string | null) {
    runInAction(() => { appState.local.engine.error = error; });
  }

  /**
   * Apply a per-frame sketch_state delta from the engine. Only the keys
   * the worker reported as changed/removed are touched (via mobx
   * set/remove), so unchanged instances keep their observable identity and
   * don't trigger spurious re-renders — and an empty diff is a no-op. The
   * whole-object replacement this used to do re-wrapped the entire state
   * into fresh deep observables every frame (the trace's mobx hot spot).
   */
  applySketchStateDiff(diff: import('../engine-types').StateDiff) {
    if (!diff) return;
    const changedKeys = Object.keys(diff.changed);
    if (changedKeys.length === 0 && diff.removed.length === 0) return;
    runInAction(() => {
      const ss = appState.local.engine.sketchState;
      for (const k of diff.removed) mobxRemove(ss as object, k);
      for (const k of changedKeys) mobxSet(ss as object, k, diff.changed[k]);
    });
  }

  applyPluginStatesDiff(diff: import('../engine-types').StateDiff) {
    if (!diff) return;
    const changedKeys = Object.keys(diff.changed);
    if (changedKeys.length === 0 && diff.removed.length === 0) return;
    runInAction(() => {
      const ps = appState.local.engine.pluginStates;
      for (const k of diff.removed) mobxRemove(ps as object, k);
      for (const k of changedKeys) mobxSet(ps as object, k, diff.changed[k]);
    });
  }

  applyModulationDataDiff(diff: import('../engine-types').StateDiff) {
    if (!diff) return;
    const changedKeys = Object.keys(diff.changed);
    if (changedKeys.length === 0 && diff.removed.length === 0) return;
    runInAction(() => {
      const md = appState.local.engine.modulationData;
      for (const k of diff.removed) mobxRemove(md as object, k);
      for (const k of changedKeys) mobxSet(md as object, k, diff.changed[k]);
    });
  }

  setTracedFrames(frames: Record<string, ImageBitmap>) {
    runInAction(() => {
      // Close old bitmaps
      for (const old of Object.values(appState.local.engine.tracedFrames)) {
        old?.close();
      }
      appState.local.engine.tracedFrames = frames;
      appState.local.engine.frameGeneration++;
    });
  }

  setDebugStats(stats: import('../engine-types').DebugStats) {
    runInAction(() => { appState.local.engine.debugStats = stats; });
  }

  /**
   * Append a frame's worth of console-log entries from the worker
   * and trim to the UI-side cap. Capped here independently of the
   * worker buffer so an off-tab session that re-enables debug mode
   * doesn't get a wall of stale entries.
   */
  appendDebugConsoleLog(entries: import('../engine-types').DebugConsoleEntry[]) {
    if (entries.length === 0) return;
    runInAction(() => {
      const buf = appState.local.engine.debugConsoleLog;
      const merged = buf.concat(entries);
      const CAP = 500;
      appState.local.engine.debugConsoleLog =
        merged.length > CAP ? merged.slice(merged.length - CAP) : merged;
    });
  }

  clearDebugConsoleLog() {
    runInAction(() => { appState.local.engine.debugConsoleLog = []; });
  }

  // ========================================================================
  // Engine sync
  // ========================================================================

  /**
   * Load a WASM module and discover its available effects.
   * Does NOT create any instances — call instantiateEffect() for that.
   */
  loadModule(moduleType: string) {
    this.engine?.loadModule(moduleType);
  }

  /**
   * Instantiate a specific effect into the unassigned bucket sketch.
   * The effect's WASM module must already be loaded via loadModule().
   */
  instantiateEffect(effectId: string) {
    this.engine?.instantiateEffect(effectId);
  }

  setTracePoints(tracePoints: TracePoint[]) {
    this.engine?.setTracePoints(tracePoints);
  }

  /** Pause/resume the engine. Stored in user settings so it persists. The IDE's
   *  UI-only video preview mirrors the same state so it freezes too. */
  setPaused(paused: boolean) {
    this.setUserSetting('paused', paused);
    this.engine?.setPaused(paused);
    this.inputManager.setPaused(paused);
  }

  /** Advance by a single frame (used while paused). Step the UI-driven video
   *  preview first so its new frame reaches the worker before the engine's step
   *  command — worker messages are processed in order. */
  async stepFrame() {
    await this.inputManager.stepFrame();
    this.engine?.stepFrame();
  }

  /** Inject a frame source for a sketch's `texture_input`. Pass null to clear. */
  setSketchInput(sketchId: string, bitmap: ImageBitmap | null) {
    this.engine?.setSketchInput(sketchId, bitmap);
  }

  /**
   * Texture-drop-zone calls this on a fresh drop. Persists the file to
   * IndexedDB and starts the appropriate frame source for the active
   * sketch (one-shot for images, continuous pump for videos).
   */
  handleSketchInputDrop(sketchId: string, file: File): Promise<void> {
    return this.inputManager.handleDrop(sketchId, file);
  }

  /**
   * Trigger a WASM module reload (from the dev-time HMR plugin). The worker
   * waits for the in-flight frame to complete, then re-fetches and
   * re-instantiates affected effects.
   */
  reloadWasm(wasmUrl: string) {
    this.engine?.reloadWasm(wasmUrl);
  }

  private syncSketchesToEngine() {
    if (!this.engine) return;
    // Don't push sketches until at least one effect bundle has registered.
    // Boot ordering: settings + projects load before `loadModule` even
    // starts; pushing a sketch with `module_type: "source.solid_color"`
    // before the WASM module is loaded would cause the engine to error
    // every frame trying to render it. Once `setAvailableEffects` fires,
    // it calls back into here to flush any waiting sketches.
    if (appState.local.availableEffects.length === 0) return;

    const nowSynced = new Set<string>();
    for (const [id, sketch] of Object.entries(appState.database.sketches)) {
      if (this.engineSketchFilter && !this.engineSketchFilter(id)) continue;
      nowSynced.add(id);
      // Plain deep clone (no MobX proxies → safe for postMessage). Struct
      // connections are resolved by the executor's struct auto-connect; no
      // implicit rail/tap augmentation is needed.
      const augmented = JSON.parse(JSON.stringify(toJS(sketch)));
      this.engine.updateSketch(id, augmented);
    }
    // Anything previously synced but no longer eligible (deleted or filtered
    // out) — tell the engine to drop it so it stops trying to render.
    for (const id of this.engineSyncedSketchIds) {
      if (!nowSynced.has(id)) {
        this.engine.deleteSketch(id);
      }
    }
    this.engineSyncedSketchIds = nowSynced;
  }

  /**
   * Install (or clear) the engine sketch filter. Calling this triggers an
   * immediate re-sync so newly-eligible sketches get pushed and
   * newly-ineligible ones get deleted.
   *
   * The IDE entry uses this to keep the engine focused on the active project.
   */
  setEngineSketchFilter(filter: ((sketchId: string) => boolean) | null) {
    this.engineSketchFilter = filter;
    this.syncSketchesToEngine();
  }
}

function shortName(moduleId: string): string {
  return moduleId.split('.').pop() ?? moduleId;
}

export const appController = new AppController();
