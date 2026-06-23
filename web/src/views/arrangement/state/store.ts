/**
 * Standalone arrangement store (Milestone 1: mockup).
 *
 * Owns its own state — it does NOT couple to the effect IDE's AppController.
 * Split mirrors the house pattern: a persisted `composition` (would be undo-able
 * later) and ephemeral `local` UI state. MobX is used for UI binding only;
 * mutations are explicit action methods (no reactions for business logic).
 */

import { makeAutoObservable, runInAction, toJS, set as mobxSet, remove as mobxRemove } from 'mobx';
import type { StateDiff, PluginInfo } from '../../../engine-types';
import type { FieldConnectInfo } from '../../../sketch-types';
import {
  Composition,
  Clip,
  Track,
  Device,
  ClipSketch,
  ClipLoopConfig,
  RailExport,
  RailRead,
  AutomationLane,
  EnvelopePoint,
  ScaleMode,
  deviceIsSource,
  compositionLengthBeats,
} from '../model/composition';
import { makeFakeComposition } from '../model/fake-data';
import { DocHistory } from './history';
import { EFFECTS, defaultStateFor, catalogEffect } from '../engine/effect-catalog';
import { type WorkspaceBackend, type WorkspaceEntry, DirectoryBackend, mountViaPicker } from '../workspace/backend';
import { rememberWorkspace, restoreWorkspace, restoreWorkspaceSilent, rememberedWorkspaceLabel } from '../workspace/workspace-store';
import { saveLayout, loadLayout, type ArrLayout } from '../workspace/layout-store';
import { openMedia, resolveMedia } from '../workspace/media-store';
import { emptyComposition, makeMainBus } from '../model/composition';

export type SelectableKind =
  | 'track'
  | 'clip'
  | 'rail'
  | 'automation'
  | 'composition';

export interface Selection {
  kind: SelectableKind;
  /** Stable path key, unique across the composition. */
  path: string;
}

export type RightTab = 'inspector' | 'workspace' | 'settings' | 'export';

/** A resolved composite layer (the monitor draws these bottom→top). */
export interface CompositeLayer {
  track: Track;
  clip: Clip;
  /** `engine` = rendered effect chain; `media` = decoded video frames. */
  kind: 'engine' | 'media';
  /** Effective opacity (own × ancestor-group `level`s), 0..1. */
  opacity: number;
  /** Composite blend mode for a source clip (0 = Normal/over). */
  blendMode: number;
}

/** Path builders — stable keys used for selection + DOM data attributes. */
export const paths = {
  track: (trackId: string) => `track/${trackId}`,
  clip: (trackId: string, clipId: string) => `clip/${trackId}/${clipId}`,
  rail: (railId: string) => `rail/${railId}`,
  automation: (laneId: string) => `automation/${laneId}`,
  composition: () => `composition`,
};

let _uid = 1000;
const uid = (p: string) => `${p}_${(_uid++).toString(36)}`;

/**
 * Split every clip in a track that straddles `beat` into two. Operates on a
 * draft `Track` inside a history recipe (clips are drafts; the JSON clone
 * yields a plain right-hand clip). Shared by all the time-region ops.
 */
function splitClipsAt(track: Track, beat: number) {
  const next: Clip[] = [];
  for (const clip of track.clips) {
    const end = clip.startBeat + clip.lengthBeat;
    if (beat > clip.startBeat + 1e-6 && beat < end - 1e-6) {
      const right: Clip = JSON.parse(JSON.stringify(clip));
      right.id = uid('clip');
      right.startBeat = beat;
      right.lengthBeat = end - beat;
      clip.lengthBeat = beat - clip.startBeat;
      next.push(clip, right);
    } else {
      next.push(clip);
    }
  }
  track.clips = next;
}

/**
 * Carve the span `[start,end)` out of every clip on `track` EXCEPT `exceptId`:
 * clips fully inside are removed, overlapping clips are trimmed (and split into
 * left+right pieces when the span lands in their middle). Used so a moved/resized
 * clip is mutually exclusive with the rest of its lane (the overlapped section is
 * deleted). Operates on a draft `Track` inside a history recipe.
 */
function carveTrackSpan(track: Track, exceptId: string, start: number, end: number) {
  if (end <= start + 1e-6) return;
  const next: Clip[] = [];
  for (const c of track.clips) {
    if (c.id === exceptId) { next.push(c); continue; }
    const cs = c.startBeat;
    const ce = c.startBeat + c.lengthBeat;
    if (ce <= start + 1e-6 || cs >= end - 1e-6) { next.push(c); continue; } // disjoint
    if (cs < start - 1e-6) {
      // keep the left piece (reuse the original clip id)
      c.lengthBeat = start - cs;
      next.push(c);
    }
    if (ce > end + 1e-6) {
      const right: Clip = JSON.parse(JSON.stringify(c));
      right.id = uid('clip');
      right.startBeat = end;
      right.lengthBeat = ce - end;
      next.push(right);
    }
    // a clip wholly inside [start,end) contributes neither piece → removed
  }
  track.clips = next;
}

/** Resolve a column-group sketchId (`clip/<trk>/<clip>` | `track/<trk>`) to its
 *  ClipSketch within a draft composition. */
function draftSketch(d: Composition, sketchId: string): ClipSketch | undefined {
  if (sketchId.startsWith('clip/')) {
    const [, trackId, clipId] = sketchId.split('/');
    return d.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)?.sketch;
  }
  if (sketchId.startsWith('track/')) {
    return d.tracks.find((t) => t.id === sketchId.split('/')[1])?.sketch;
  }
  return undefined;
}

/**
 * Move `arr[from]` so it lands at insertion index `to` (the index in the
 * pre-removal array), adjusting for the removal shift. In-place.
 */
function moveInArray<T>(arr: T[], from: number, to: number) {
  if (from < 0 || from >= arr.length || from === to) return;
  const [item] = arr.splice(from, 1);
  const dest = to > from ? to - 1 : to;
  arr.splice(Math.max(0, Math.min(dest, arr.length)), 0, item);
}

export class ArrangementStore {
  // ── Persisted document ────────────────────────────────────────────────
  composition: Composition = makeFakeComposition();

  // ── Persistence + undo (non-observable infra) ─────────────────────────
  /** Undo/redo over `composition`; all document writes go through `mutate`. */
  private history!: DocHistory<Composition>;
  /** The mounted workspace this arrangement saves to, if any. */
  private backend: WorkspaceBackend | null = null;
  /** Active arrangement file name within the workspace. */
  currentName: string | null = null;
  /** Human label of the mounted workspace folder (observable, for the UI). */
  workspaceLabel: string | null = null;
  /** Arrangement files in the mounted workspace (observable, for the Files tab). */
  workspaceEntries: WorkspaceEntry[] = [];
  private persistenceEnabled = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedJson = '';

  // ── Ephemeral UI state ────────────────────────────────────────────────
  /** Multi-select: set of selectable paths. */
  selection = new Set<string>();
  /** The "primary"/last-clicked selection (drives the inspector). */
  primaryPath: string | null = null;
  /** Currently highlighted rail wire (writer/reader), if any. */
  selectedWireId: string | null = null;
  /**
   * Unified focus for the chain inspector: the selected effect-card path
   * (`effect/<sketchId>/<colIdx>/<chainIdx>`) and field key, shared by every
   * <column-group> adapter so highlight, Delete, and click-away all agree.
   */
  chainFocusPath: string | null = null;
  chainFieldKey: string | null = null;
  /** Tap-config popup anchored to a wire pip (mock of the sketch tap card). */
  tapPopup: {
    wireId: string;
    x: number;
    y: number;
    label: string;
  } | null = null;
  /** When set, a clip the inspector should scroll a sub-target into view. */
  scrollTarget: { clipPath: string; field?: string; trace?: boolean } | null = null;

  activeRightTab: RightTab = 'inspector';

  /** Right inspector panel width (px) — drag-resizable, persisted. */
  sidePanelWidth = 320;
  /** Track-header column width (px) — drag-resizable, persisted (HEADER_WIDTH default). */
  headerWidth = 184;
  /** Output-monitor stage height (px) — drag-resizable, persisted. The composite
   *  is contain-fit into it (resizing the panel width changes aspect, not this). */
  monitorHeight = 180;

  /** Bottom clip-view panel. */
  clipViewOpen = false;
  clipViewHeight = 230;
  clipViewMode: 'source' | 'automation' = 'source';
  /** Automation timing: tied to the source loop, or the clip's arrangement length. */
  clipAutoTiming: 'loop' | 'clip' = 'loop';

  /** Global automation-edit mode: reveals every track's automation lanes. */
  automationMode = false;
  /** Global wires mode: reveals the rail modulation wires. */
  wiresMode = true;

  // Viewport (warped-units horizontal transform lives in beat-grid.ts).
  pxPerBeat = 22;
  scrollUnits = 0;

  // Transport
  playing = false;
  positionBeat = 0;
  /** Insert / "play from" marker — playback starts here; click to set. */
  playFromBeat = 0;
  loopEnabled = true;
  loopStartBeat = 0;
  loopEndBeat = 32;
  transportMode: 'precise' | 'live' = 'precise';

  /**
   * Selected time region (beats). Drives insert/delete time and split. `null`
   * start means no region. Empty `trackIds` = all tracks (global time).
   */
  timeSelStart: number | null = null;
  timeSelEnd = 0;
  timeSelTrackIds: string[] = [];

  // ── Engine telemetry (ephemeral; mirrors appState.local.engine) ────────
  /**
   * Per-frame wire-modulation telemetry from the live engine, keyed by engine
   * instance key (`clip_<clipId>_<deviceId>`, see `clipInstanceKey`) → field →
   * `{value,min,max,neutral}`. Sliders read it (via the column adapter) to draw
   * live modulation bands. Not persisted, not undoable.
   */
  modulationData: Record<string, Record<string, { value: number; min: number; max: number; neutral: number }>> = {};

  /**
   * Per-frame published instance state (effect/source OUTPUTS + broadcasts) from
   * the live engine, keyed by engine instance key (`clip_<clipId>_<deviceId>`).
   * Output trace spark-charts read it (via the adapter) to animate. Mirrors
   * `appState.local.engine.pluginStates`. Not persisted, not undoable.
   */
  pluginStates: Record<string, Record<string, unknown>> = {};

  /**
   * Per-device traced texture thumbnails (ImageBitmap), keyed by trace id (the
   * output-trace-card's traceId). Output texture monitors read these via the
   * arrangement TraceSource. `traceGeneration` bumps each frame so the monitors'
   * autoruns re-draw. Not persisted.
   */
  tracedFrames: Record<string, ImageBitmap> = {};
  traceGeneration = 0;

  /**
   * Real plugin schemas discovered by the engine (keyed by effect id, e.g.
   * `color.hsl`). The inspector prefers these over the catalog's float-only
   * synthesis so editors are complete (color / bool / enum / vec, exact ranges).
   * Populated async as bundles warm up; reading it in render re-renders editors
   * when a schema lands. Not persisted, not undoable.
   */
  enginePlugins: Record<string, PluginInfo> = {};

  constructor() {
    makeAutoObservable<
      ArrangementStore,
      'backend' | 'saveTimer' | 'persistenceEnabled' | 'lastSavedJson' | 'tracedFrames'
      | 'layoutReady' | 'layoutSaveTimer'
    >(
      this,
      {
        backend: false,
        saveTimer: false,
        persistenceEnabled: false,
        lastSavedJson: false,
        // Bitmaps aren't deep-observed; reactivity rides `traceGeneration`.
        tracedFrames: false,
        layoutReady: false,
        layoutSaveTimer: false,
      },
      { autoBind: true },
    );
    // `history` is assigned after makeAutoObservable so it stays a plain
    // (non-observable) ref; its own internal stacks are observable.
    this.history = new DocHistory<Composition>(() => this.composition);
    this.history.postRecordHook = () => this.requestSave();
  }

  // ── Document mutation + undo ──────────────────────────────────────────
  /** The single funnel for every write to `composition` (recorded + saved). */
  private mutate(
    description: string,
    recipe: (d: Composition) => void,
    coalesceKey?: string,
  ) {
    this.history.record(description, recipe, coalesceKey);
  }

  undo() {
    this.history.undo();
  }
  redo() {
    this.history.redo();
  }
  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }

  // ── Workspace persistence ─────────────────────────────────────────────
  /** Load an existing arrangement file from a mounted workspace. */
  async openArrangement(backend: WorkspaceBackend, name: string) {
    const comp = await backend.read(name);
    runInAction(() => {
      this.backend = backend;
      this.currentName = name;
      this.composition = comp;
      this.ensureMainBus(); // legacy / hand-made files may lack the master track
      this.persistenceEnabled = true;
      this.lastSavedJson = JSON.stringify(toJS(this.composition));
      this.clearSelection();
    });
    this.history.reset();
    this.requestLayoutSave(); // remember this as the last-opened file
    void this.relinkMedia();  // re-resolve video sources (blob URLs die on reload)
  }

  /**
   * Re-resolve every video clip's `source.url` from its persisted media handle —
   * the stored blob URL is dead after a reload. Library-relative handles relink
   * via the library grant; direct handles via their stored handle. Best-effort:
   * silent when the permission persists, otherwise skipped (clip falls back to
   * the procedural reel until relinked from a user gesture).
   */
  /** sourceKey → library-relative path (only for media stored under a library). */
  mediaRelPaths: Record<string, string> = {};
  /** sourceKey → true when the media file couldn't be resolved (moved / deleted /
   *  permission revoked) at the last relink. Surfaced in the inspector + timeline. */
  mediaMissing: Record<string, boolean> = {};

  /** True when a clip's media source couldn't be resolved at the last relink. */
  sourceMissing(sourceKey?: string): boolean {
    return !!sourceKey && this.mediaMissing[sourceKey] === true;
  }

  async relinkMedia() {
    const keys = new Set<string>();
    for (const t of this.composition.tracks)
      for (const c of t.clips) if (c.source?.sourceKey) keys.add(c.source.sourceKey);
    for (const key of keys) {
      // Record the library-relative path (IDB read only, no permission) so the
      // inspector can show it even if the file itself can't be resolved yet.
      const rec = await resolveMedia(key);
      if (rec?.ref?.kind === 'lib' && Array.isArray(rec.ref.path)) {
        const rel = rec.ref.path.join('/');
        runInAction(() => { this.mediaRelPaths[key] = rel; });
      }
      let file: File | null = null;
      try { file = await openMedia(key); } catch { file = null; }
      runInAction(() => { this.mediaMissing[key] = !file; });
      if (!file) continue;
      const url = URL.createObjectURL(file);
      runInAction(() => {
        for (const t of this.composition.tracks)
          for (const c of t.clips) if (c.source?.sourceKey === key) c.source.url = url;
      });
    }
  }

  /** Guarantee the master/main-bus track exists (it's the one mandatory track and
   *  is never deletable/reorderable — only its absence makes it "disappear"). */
  private ensureMainBus() {
    if (this.composition.tracks.some((t) => this.isMainBus(t))) return;
    this.composition.tracks.push(makeMainBus());
  }

  /** Create a new arrangement file (seeded with `comp` or the current doc). */
  async createArrangement(backend: WorkspaceBackend, name: string, comp?: Composition) {
    await backend.create(name, comp ?? toJS(this.composition));
    await this.openArrangement(backend, name);
  }

  // ── Workspace layout persistence (user settings, not the document) ──────
  /** Last-opened file name, restored from settings before the workspace mounts. */
  preferredFile: string | null = null;
  private layoutReady = false;
  private layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;

  private serializeLayout(): ArrLayout {
    return {
      activeRightTab: this.activeRightTab,
      clipViewOpen: this.clipViewOpen,
      clipViewHeight: this.clipViewHeight,
      sidePanelWidth: this.sidePanelWidth,
      headerWidth: this.headerWidth,
      monitorHeight: this.monitorHeight,
      wiresMode: this.wiresMode,
      automationMode: this.automationMode,
      lastFile: this.currentName,
    };
  }

  /** Load + apply the saved layout (panels/tabs/modes) and remember the last file
   *  so the upcoming workspace mount can re-open it. Call once on boot. */
  async restoreLayout() {
    const l = await loadLayout();
    if (l) {
      runInAction(() => {
        if (l.activeRightTab) this.activeRightTab = l.activeRightTab as RightTab;
        if (typeof l.clipViewOpen === 'boolean') this.clipViewOpen = l.clipViewOpen;
        if (typeof l.clipViewHeight === 'number') this.setClipViewHeight(l.clipViewHeight);
        if (typeof l.sidePanelWidth === 'number') this.setSidePanelWidth(l.sidePanelWidth);
        if (typeof l.headerWidth === 'number') this.setHeaderWidth(l.headerWidth);
        if (typeof l.monitorHeight === 'number') this.setMonitorHeight(l.monitorHeight);
        if (typeof l.wiresMode === 'boolean') this.wiresMode = l.wiresMode;
        if (typeof l.automationMode === 'boolean') this.automationMode = l.automationMode;
        this.preferredFile = l.lastFile ?? null;
      });
    }
    this.layoutReady = true; // enable saves only AFTER restore (no clobber)
  }

  /** Debounced layout autosave (panels/tabs/modes/last file). */
  requestLayoutSave(debounceMs = 400) {
    if (!this.layoutReady) return;
    if (this.layoutSaveTimer) clearTimeout(this.layoutSaveTimer);
    this.layoutSaveTimer = setTimeout(() => {
      this.layoutSaveTimer = null;
      void saveLayout(this.serializeLayout());
    }, debounceMs);
  }

  /** Debounced autosave; a no-op until a workspace is bound. */
  private requestSave(debounceMs = 400) {
    if (!this.persistenceEnabled || !this.backend || !this.currentName) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, debounceMs);
  }

  /** Flush the current document to disk now (dedup'd against last save). */
  async saveNow() {
    if (!this.backend || !this.currentName) return;
    const json = JSON.stringify(toJS(this.composition));
    if (json === this.lastSavedJson) return;
    await this.backend.write(this.currentName, this.composition);
    this.lastSavedJson = json;
  }

  get hasWorkspace(): boolean {
    return this.backend !== null;
  }

  /**
   * Mount a workspace folder: bind the backend, list its files, and open the
   * first arrangement (or seed an "untitled" from the current doc if empty).
   * A picked on-disk folder is remembered so it can be re-opened after reload.
   */
  async mountWorkspace(backend: WorkspaceBackend) {
    runInAction(() => {
      this.backend = backend;
      this.workspaceLabel = backend.label;
      this.persistenceEnabled = false; // off until an arrangement is open
    });
    if (backend instanceof DirectoryBackend) {
      void rememberWorkspace(backend.dir, backend.label);
    }
    await this.refreshWorkspaceList();
    const entries = this.workspaceEntries;
    if (entries.length) {
      const want = this.currentName ?? this.preferredFile;
      const keep = want ? entries.find((e) => e.name === want) : undefined;
      await this.openArrangement(backend, (keep ?? entries[0]).name);
    } else {
      // Empty folder → seed it with what's on screen so nothing is lost.
      await this.createArrangement(backend, 'untitled', toJS(this.composition));
      await this.refreshWorkspaceList();
    }
  }

  /**
   * On boot: re-open the remembered folder. If permission is already held
   * (browsers increasingly persist it) it mounts silently; otherwise the
   * permission prompt is deferred to the first user gesture — `requestPermission`
   * only prompts inside one — and the folder mounts as soon as it's granted.
   */
  async autoMountRememberedWorkspace() {
    const silent = await restoreWorkspaceSilent();
    if (silent) {
      await this.mountWorkspace(silent);
      return;
    }
    // Nothing silently resolvable — if something IS remembered, defer the
    // permission prompt to the first user gesture and re-open then.
    if ((await rememberedWorkspaceLabel()) == null) return;
    let done = false;
    const onGesture = () => {
      if (done) return;
      done = true;
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      void restoreWorkspace().then((b) => { if (b) void this.mountWorkspace(b); });
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  /** Prompt for a folder (needs a user gesture) and mount it as the workspace. */
  async mountFolderViaPicker() {
    await this.mountWorkspace(await mountViaPicker());
  }

  /**
   * Re-open the previously-mounted folder (re-granting permission via the
   * calling gesture). Returns false if none was remembered / permission denied.
   */
  async reopenLastWorkspace(): Promise<boolean> {
    const backend = await restoreWorkspace();
    if (!backend) return false;
    await this.mountWorkspace(backend);
    return true;
  }

  /** Re-list the mounted workspace's arrangement files. */
  async refreshWorkspaceList() {
    if (!this.backend) return;
    const entries = await this.backend.list();
    runInAction(() => { this.workspaceEntries = entries; });
  }

  /** Open one workspace file (from the Files tab). */
  async openEntry(name: string) {
    if (!this.backend || name === this.currentName) return;
    await this.openArrangement(this.backend, name);
  }

  /** Create a fresh empty arrangement in the mounted workspace and open it. */
  async newArrangement(name: string) {
    if (!this.backend) return;
    await this.createArrangement(this.backend, name, emptyComposition());
    await this.refreshWorkspaceList();
  }

  /** Rename a workspace file (within its directory). `newBase` is the bare name. */
  async renameEntry(name: string, newBase: string) {
    if (!this.backend) return;
    const trimmed = newBase.trim();
    if (!trimmed || trimmed.includes('/')) return;
    const slash = name.lastIndexOf('/');
    const dir = slash >= 0 ? name.slice(0, slash) : '';
    const newName = dir ? `${dir}/${trimmed}` : trimmed;
    if (newName === name) return;
    await this.backend.rename(name, newName);
    if (this.currentName === name) {
      runInAction(() => { this.currentName = newName; });
    }
    await this.refreshWorkspaceList();
  }

  /** Delete a workspace file; if it was open, fall back to another (or blank). */
  async deleteEntry(name: string) {
    if (!this.backend) return;
    await this.backend.remove(name);
    await this.refreshWorkspaceList();
    if (this.currentName !== name) return;
    const next = this.workspaceEntries[0];
    if (next) {
      await this.openArrangement(this.backend, next.name);
    } else {
      runInAction(() => {
        this.currentName = null;
        this.composition = emptyComposition();
        this.persistenceEnabled = false;
        this.clearSelection();
      });
      this.history.reset();
    }
  }

  // ── Engine telemetry ──────────────────────────────────────────────────
  /**
   * Apply a wire-modulation telemetry diff from the engine into
   * `modulationData` (granular set/remove so animated frames don't re-wrap the
   * whole map). Mirrors `LocalController.applyModulationDataDiff`.
   */
  applyModulationDataDiff(diff: StateDiff) {
    if (!diff) return;
    const changedKeys = Object.keys(diff.changed);
    if (changedKeys.length === 0 && diff.removed.length === 0) return;
    runInAction(() => {
      const md = this.modulationData;
      for (const k of diff.removed) mobxRemove(md as object, k);
      for (const k of changedKeys) mobxSet(md as object, k, diff.changed[k]);
    });
  }

  /**
   * Apply a published-instance-state diff from the engine into `pluginStates`
   * (granular set/remove). Mirrors `LocalController.applyPluginStatesDiff`.
   */
  applyPluginStatesDiff(diff: StateDiff) {
    if (!diff) return;
    const changedKeys = Object.keys(diff.changed);
    if (changedKeys.length === 0 && diff.removed.length === 0) return;
    runInAction(() => {
      const ps = this.pluginStates;
      for (const k of diff.removed) mobxRemove(ps as object, k);
      for (const k of changedKeys) mobxSet(ps as object, k, diff.changed[k]);
    });
  }

  /** Replace the per-device traced textures (closes the previous frame's). */
  setTracedFrames(frames: Record<string, ImageBitmap>) {
    runInAction(() => {
      for (const k in this.tracedFrames) this.tracedFrames[k]?.close();
      this.tracedFrames = frames;
      this.traceGeneration++;
    });
  }

  /** Mirror the engine's discovered plugin schemas (keyed by effect id). */
  setEnginePlugins(plugins: PluginInfo[]) {
    if (!plugins.length) return;
    runInAction(() => {
      for (const p of plugins) mobxSet(this.enginePlugins as object, p.id, p);
    });
  }

  /** Real engine schema for an effect id, if it's been discovered yet. */
  enginePlugin(effectId: string): PluginInfo | undefined {
    return this.enginePlugins[effectId];
  }

  // ── Lookups ─────────────────────────────────────────────────────────
  trackById(id: string): Track | undefined {
    return this.composition.tracks.find((t) => t.id === id);
  }

  clipByPath(path: string): { track: Track; clip: Clip } | undefined {
    const [kind, trackId, clipId] = path.split('/');
    if (kind !== 'clip') return undefined;
    const track = this.trackById(trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (track && clip) return { track, clip };
    return undefined;
  }

  // ── Selection ───────────────────────────────────────────────────────
  isSelected(path: string): boolean {
    return this.selection.has(path);
  }

  select(path: string) {
    runInAction(() => {
      this.selection = new Set([path]);
      this.primaryPath = path;
      this.selectedWireId = null;
      // A new top-level selection resets any chain card/field focus.
      this.chainFocusPath = null;
      this.chainFieldKey = null;
      this.activeRightTab = 'inspector';
      // Selecting a clip syncs the time region to the clip's extent;
      // selecting a track selects a time box spanning the whole track.
      const found = this.clipByPath(path);
      if (found) {
        this.setTimeSelection(
          found.clip.startBeat,
          found.clip.startBeat + found.clip.lengthBeat,
          [found.track.id],
        );
      } else if (path.startsWith('track/')) {
        const t = this.trackById(path.split('/')[1]);
        if (t && t.kind === 'track') {
          this.setTimeSelection(0, compositionLengthBeats(this.composition), [t.id]);
        } else {
          this.clearTimeSelection();
        }
      }
    });
  }

  /** Track ids the UI should render as selected: focused OR within the time box. */
  isTrackShownSelected(trackId: string): boolean {
    if (this.isSelected(paths.track(trackId))) return true;
    if (!this.hasTimeSelection) return false;
    const scope = this.timeSelTrackIds;
    if (scope.length === 0) {
      const t = this.trackById(trackId);
      return !!t && t.kind === 'track';
    }
    return scope.includes(trackId);
  }

  /** All tracks rendered as selected (focused + time-box covered). */
  get shownSelectedTrackIds(): Set<string> {
    const out = new Set<string>();
    for (const t of this.composition.tracks) {
      if (this.isTrackShownSelected(t.id)) out.add(t.id);
    }
    return out;
  }

  /** Focused track ids (track paths in the selection set). */
  get selectedTrackIds(): string[] {
    return [...this.selection]
      .filter((p) => p.startsWith('track/'))
      .map((p) => p.split('/')[1]);
  }

  /**
   * Select a clip WITHOUT touching the time region — clicking a clip body picks
   * the clip but doesn't grab a time box (only the clip header does that).
   */
  selectClipOnly(path: string) {
    runInAction(() => {
      this.selection = new Set([path]);
      this.primaryPath = path;
      this.selectedWireId = null;
      this.chainFocusPath = null;
      this.chainFieldKey = null;
      this.activeRightTab = 'inspector';
    });
  }

  toggleSelect(path: string) {
    runInAction(() => {
      const next = new Set(this.selection);
      if (next.has(path)) {
        next.delete(path);
        if (this.primaryPath === path) {
          this.primaryPath = next.size ? [...next][next.size - 1] : null;
        }
      } else {
        next.add(path);
        this.primaryPath = path;
      }
      this.selection = next;
      this.activeRightTab = 'inspector';
    });
  }

  setSelection(pathsToSelect: string[]) {
    runInAction(() => {
      this.selection = new Set(pathsToSelect);
      this.primaryPath = pathsToSelect.length
        ? pathsToSelect[pathsToSelect.length - 1]
        : null;
    });
  }

  clearSelection() {
    runInAction(() => {
      this.selection = new Set();
      this.primaryPath = null;
      this.selectedWireId = null;
      this.chainFocusPath = null;
      this.chainFieldKey = null;
    });
  }

  // ── Chain inspector focus (effect cards / fields) ──────────────────────
  /** Set the focused effect-card path (or null). Drives highlight + Delete. */
  setChainFocus(path: string | null) {
    runInAction(() => { this.chainFocusPath = path; });
  }
  /** Set the focused field key (or null). */
  setChainField(key: string | null) {
    runInAction(() => { this.chainFieldKey = key; });
  }
  /** Clear just the chain card/field focus (e.g. clicking the rack background). */
  clearChainFocus() {
    runInAction(() => { this.chainFocusPath = null; this.chainFieldKey = null; });
  }

  /** True when a deletable chain item (effect card or wire) is focused. */
  get hasChainFocus(): boolean {
    return !!this.chainFocusPath && (this.chainFocusPath.startsWith('effect/') || this.chainFocusPath.startsWith('wire/'));
  }

  /** Delete the focused effect card or wire. */
  deleteChainFocus() {
    const path = this.chainFocusPath;
    if (path?.startsWith('wire/')) {
      // wire / <sketchId...> / <wireId>
      const rest = path.slice('wire/'.length).split('/');
      const wireId = rest.pop()!;
      this.removeSketchWire(rest.join('/'), wireId);
      this.clearChainFocus();
      return;
    }
    if (!path || !path.startsWith('effect/')) return;
    // effect / <sketchId...> / <colIdx> / <chainIdx>  — sketchId itself has slashes.
    const rest = path.slice('effect/'.length);
    const parts = rest.split('/');
    const chainIdx = Number(parts.pop());
    parts.pop(); // colIdx (always 0 here)
    const sketchId = parts.join('/');
    if (!Number.isFinite(chainIdx)) return;
    if (sketchId.startsWith('clip/')) {
      const [, trackId, clipId] = sketchId.split('/');
      const dev = this.trackById(trackId)?.clips.find((c) => c.id === clipId)?.sketch.devices[chainIdx];
      if (dev) this.removeClipDevice(trackId, clipId, dev.id);
    } else if (sketchId.startsWith('track/')) {
      const trackId = sketchId.split('/')[1];
      const dev = this.trackById(trackId)?.sketch.devices[chainIdx];
      if (dev) this.removeTrackDevice(trackId, dev.id);
    }
    this.clearChainFocus();
  }

  // ── Right tab ─────────────────────────────────────────────────────────
  setRightTab(tab: RightTab) {
    this.activeRightTab = tab;
    this.requestLayoutSave();
  }

  toggleAutomationMode() {
    this.automationMode = !this.automationMode;
    this.requestLayoutSave();
  }

  toggleWiresMode() {
    this.wiresMode = !this.wiresMode;
    if (!this.wiresMode) this.tapPopup = null;
    this.requestLayoutSave();
  }

  toggleClipView() {
    this.clipViewOpen = !this.clipViewOpen;
    this.requestLayoutSave();
  }
  setClipViewMode(m: 'source' | 'automation') {
    this.clipViewMode = m;
  }
  setClipViewHeight(h: number) {
    this.clipViewHeight = Math.max(90, Math.min(520, h));
    this.requestLayoutSave();
  }
  setSidePanelWidth(w: number) {
    this.sidePanelWidth = Math.max(220, Math.min(680, Math.round(w)));
    this.requestLayoutSave();
  }
  setHeaderWidth(w: number) {
    this.headerWidth = Math.max(120, Math.min(380, Math.round(w)));
    this.requestLayoutSave();
  }
  setMonitorHeight(h: number) {
    this.monitorHeight = Math.max(90, Math.min(520, Math.round(h)));
    this.requestLayoutSave();
  }
  setClipAutoTiming(t: 'loop' | 'clip') {
    this.clipAutoTiming = t;
  }

  /** The single selected clip (for the clip view), or null. */
  get selectedClip(): { track: Track; clip: Clip } | null {
    if (!this.primaryPath) return null;
    return this.clipByPath(this.primaryPath) ?? null;
  }

  // ── Timeline compositing ──────────────────────────────────────────────
  /** Ancestor groups of a track, nearest-first (via parentId). */
  private ancestorsOf(track: Track): Track[] {
    const out: Track[] = [];
    let pid = track.parentId;
    while (pid) {
      const p = this.trackById(pid);
      if (!p) break;
      out.push(p);
      pid = p.parentId;
    }
    return out;
  }
  /** Bypassed if the track OR any ancestor group is bypassed. */
  private effectiveBypassed(track: Track, anc: Track[]): boolean {
    return !!track.bypassed || anc.some((a) => a.bypassed);
  }
  /** Composite opacity = product of own + ancestor `level`s (default 1). */
  private effectiveOpacity(track: Track, anc: Track[]): number {
    let o = track.level ?? 1;
    for (const a of anc) o *= a.level ?? 1;
    return Math.max(0, Math.min(1, o));
  }

  /**
   * All renderable clips active at `beat`, in composite DRAW order. The mix sums
   * DOWNWARD (Ableton-style: the main bus pins to the bottom) — the TOP track is
   * the background and each lower track draws over it, so the BOTTOM-most track
   * wins. Returned in paint order (top track first → bottom track last). One clip
   * per track (on overlap the latest-started wins). Every layer is `engine`:
   * effect chains AND video clips render through the GPU composite (a video clip's
   * `source.video.file` entry outputs the host-injected decoded frame). Carries
   * effective `opacity` + blend mode, and respects bypass + solo propagated
   * through the group hierarchy. Empty clips (no devices, no media) are skipped.
   */
  compositeLayersAtBeat(beat: number): CompositeLayer[] {
    const tracks = this.composition.tracks.filter((t) => t.kind === 'track');
    // Solo on ANY track or group restricts the mix to soloed lineages.
    const anySolo = this.composition.tracks.some((t) => t.soloed);
    const layers: CompositeLayer[] = [];
    for (const t of tracks) {
      const anc = this.ancestorsOf(t);
      if (this.effectiveBypassed(t, anc)) continue;
      if (anySolo && !(t.soloed || anc.some((a) => a.soloed))) continue;
      let pick: Clip | undefined;
      for (const c of t.clips) {
        if (beat < c.startBeat || beat >= c.startBeat + c.lengthBeat) continue;
        if (!c.source?.url && c.sketch.devices.length === 0) continue; // empty clip
        if (!pick || c.startBeat >= pick.startBeat) pick = c; // latest-started wins
      }
      if (!pick || pick.bypassed) continue;
      layers.push({
        track: t,
        clip: pick,
        kind: 'engine',
        opacity: this.effectiveOpacity(t, anc),
        blendMode: pick.blendMode ?? 0,
      });
    }
    // `tracks` is already top→bottom; paint in that order so each lower track
    // draws over the one above it (downward sum — bottom-most track on top).
    return layers;
  }

  /** The active composite layers (the bridge folds these into one chain). */
  compositeClipsAtBeat(beat: number): Array<{ track: Track; clip: Clip }> {
    return this.compositeLayersAtBeat(beat).map(({ track, clip }) => ({ track, clip }));
  }

  /** Active video clips at `beat` (with the device the decode pump feeds). */
  activeVideoClipsAtBeat(beat: number): Array<{ track: Track; clip: Clip }> {
    return this.compositeLayersAtBeat(beat)
      .filter((l) => !!l.clip.source?.url)
      .map(({ track, clip }) => ({ track, clip }));
  }

  // ── Viewport ──────────────────────────────────────────────────────────
  setZoom(pxPerBeat: number) {
    this.pxPerBeat = Math.max(4, Math.min(200, pxPerBeat));
  }

  zoomBy(factor: number) {
    this.setZoom(this.pxPerBeat * factor);
  }

  /**
   * Zoom while keeping the warped-unit position under `anchorLocalX` (px from
   * the lane origin) fixed on screen. Used by +/- (center anchor) and ctrl-wheel
   * (cursor anchor).
   */
  zoomAnchored(factor: number, anchorLocalX: number) {
    const unitAtAnchor = this.scrollUnits + anchorLocalX / this.pxPerBeat;
    this.setZoom(this.pxPerBeat * factor);
    this.setScrollUnits(unitAtAnchor - anchorLocalX / this.pxPerBeat);
  }

  setScrollUnits(units: number) {
    this.scrollUnits = Math.max(0, units);
  }

  scrollBy(deltaUnits: number) {
    this.setScrollUnits(this.scrollUnits + deltaUnits);
  }

  // ── Grid quantization ─────────────────────────────────────────────────

  /** Adaptive snap step (beats): finer when zoomed in, coarser when out. */
  get snapStep(): number {
    const target = 22; // aim for ~22px between snap points
    const raw = target / this.pxPerBeat;
    for (const step of [0.25, 0.5, 1, 2, 4, 8, 16]) {
      if (step >= raw) return step;
    }
    return 16;
  }

  /** Quantize a beat to the snap grid; `free` (modifier held) bypasses it. */
  quantize(beat: number, free = false): number {
    if (free) return Math.max(0, beat);
    const s = this.snapStep;
    return Math.max(0, Math.round(beat / s) * s);
  }

  // ── Time-region selection ─────────────────────────────────────────────

  get hasTimeSelection(): boolean {
    return this.timeSelStart !== null && this.timeSelEnd > this.timeSelStart;
  }

  /** Tracks the region applies to (empty scope = every non-group track). */
  private regionTracks(): Track[] {
    const scope = this.timeSelTrackIds;
    return this.composition.tracks.filter(
      (t) => t.kind === 'track' && (scope.length === 0 || scope.includes(t.id)),
    );
  }

  setTimeSelection(start: number, end: number, trackIds: string[] = []) {
    runInAction(() => {
      this.timeSelStart = Math.max(0, Math.min(start, end));
      this.timeSelEnd = Math.max(start, end);
      this.timeSelTrackIds = trackIds;
    });
  }

  clearTimeSelection() {
    runInAction(() => {
      this.timeSelStart = null;
      this.timeSelTrackIds = [];
    });
  }

  /** Select every clip overlapping the current region (in scope tracks). */
  selectClipsInRegion() {
    if (!this.hasTimeSelection) return;
    const start = this.timeSelStart!;
    const end = this.timeSelEnd;
    const found: string[] = [];
    for (const t of this.regionTracks()) {
      for (const c of t.clips) {
        const cEnd = c.startBeat + c.lengthBeat;
        if (cEnd > start + 1e-6 && c.startBeat < end - 1e-6) {
          found.push(paths.clip(t.id, c.id));
        }
      }
    }
    this.setSelection(found);
  }

  /** True if the time box exists, covers this clip's track, and overlaps it. */
  timeBoxCoversClip(trackId: string, clipId: string): boolean {
    if (!this.hasTimeSelection) return false;
    const found = this.clipByPath(paths.clip(trackId, clipId));
    if (!found) return false;
    const scope = this.timeSelTrackIds;
    const inScope = scope.length === 0 ? found.track.kind === 'track' : scope.includes(trackId);
    if (!inScope) return false;
    const c = found.clip;
    return (
      c.startBeat < this.timeSelEnd - 1e-6 &&
      c.startBeat + c.lengthBeat > this.timeSelStart! + 1e-6
    );
  }

  /**
   * Shift the CONTENT inside the time box by `deltaBeat` (X) and `trackDelta`
   * tracks (Y) across the region's scope: split every scope clip at both box
   * edges, then move the in-box pieces (carving their destinations so they stay
   * mutually exclusive) — including ONTO OTHER TRACKS. The box selection itself
   * follows the move. `deltaBeat`/`trackDelta` are absolute from the gesture
   * start; pass the gesture's `base` box so coalesced frames don't drift (the
   * box follows, so reading the live box each frame would compound). Mirrors
   * Ableton's time-selection move. Coalesced → one undo per drag.
   */
  moveTimeBoxContent(
    deltaBeat: number,
    trackDelta = 0,
    base?: { start: number; end: number; scope: string[] },
  ) {
    const a = base ? base.start : this.timeSelStart!;
    const b = base ? base.end : this.timeSelEnd;
    if (a == null || b <= a) return;
    if (deltaBeat === 0 && trackDelta === 0) return;
    const scopeIds = base ? base.scope : [...this.timeSelTrackIds];

    const plainIds = this.composition.tracks.filter((t) => t.kind === 'track').map((t) => t.id);
    const scope = scopeIds.length ? scopeIds : plainIds;
    // Clamp the track shift so the whole scope stays within the plain tracks.
    let td = trackDelta;
    const idxs = scope.map((id) => plainIds.indexOf(id)).filter((i) => i >= 0);
    if (idxs.length) {
      const lo = Math.min(...idxs), hi = Math.max(...idxs);
      td = Math.max(-lo, Math.min(plainIds.length - 1 - hi, trackDelta));
    }
    const destFor = (id: string): string => {
      const i = plainIds.indexOf(id);
      return i < 0 ? id : plainIds[Math.max(0, Math.min(plainIds.length - 1, i + td))];
    };

    this.mutate(
      'move time selection',
      (d) => {
        // 1. Lift every in-box piece off its source track (split at the edges).
        const pieces: Array<{ destId: string; clip: Clip }> = [];
        for (const track of d.tracks) {
          if (!scope.includes(track.id)) continue;
          splitClipsAt(track, a);
          splitClipsAt(track, b);
          const inBox = (c: Clip) => c.startBeat >= a - 1e-6 && c.startBeat < b - 1e-6;
          for (const c of track.clips.filter(inBox)) {
            const m: Clip = JSON.parse(JSON.stringify(c));
            m.startBeat = Math.max(0, c.startBeat + deltaBeat);
            pieces.push({ destId: destFor(track.id), clip: m });
          }
          track.clips = track.clips.filter((c) => !inBox(c));
        }
        // 2. Drop them onto their destination tracks, carving what they cover.
        for (const { destId, clip } of pieces) {
          const dt = d.tracks.find((t) => t.id === destId);
          if (!dt) continue;
          carveTrackSpan(dt, '__none__', clip.startBeat, clip.startBeat + clip.lengthBeat);
          dt.clips.push(clip);
        }
      },
      'move-time-box',
    );

    // 3. The box selection follows the moved content (live UI state).
    runInAction(() => {
      this.timeSelStart = Math.max(0, a + deltaBeat);
      this.timeSelEnd = this.timeSelStart + (b - a);
      this.timeSelTrackIds = scopeIds.length ? scope.map(destFor) : [];
    });
  }

  /** Split every clip in scope at both region edges (Ableton split). */
  splitAtRegion() {
    if (!this.hasTimeSelection) return;
    const edges = [this.timeSelStart!, this.timeSelEnd];
    const scope = this.regionTracks().map((t) => t.id);
    this.mutate('split', (d) => {
      for (const track of d.tracks) {
        if (!scope.includes(track.id)) continue;
        for (const edge of edges) splitClipsAt(track, edge);
      }
    });
  }

  /** Remove the region's span; later clips shift left, spanning clips trim. */
  deleteTime() {
    if (!this.hasTimeSelection) return;
    const start = this.timeSelStart!;
    const end = this.timeSelEnd;
    const span = end - start;
    const scope = this.regionTracks().map((t) => t.id);
    this.mutate('delete time', (d) => {
      for (const track of d.tracks) {
        if (!scope.includes(track.id)) continue;
        // First split at both edges so trims are clean.
        splitClipsAt(track, start);
        splitClipsAt(track, end);
        track.clips = track.clips.filter(
          (c) => !(c.startBeat >= start - 1e-6 && c.startBeat < end - 1e-6),
        );
        for (const c of track.clips) {
          if (c.startBeat >= end - 1e-6) c.startBeat -= span;
        }
      }
    });
    runInAction(() => {
      this.timeSelEnd = start;
      this.timeSelStart = start;
    });
  }

  /**
   * Delete (clear) the region's content: split clips at the edges and remove the
   * center, leaving EMPTY time (no ripple). This is the plain "Delete" / ⌫.
   */
  clearTime() {
    if (!this.hasTimeSelection) return;
    const start = this.timeSelStart!;
    const end = this.timeSelEnd;
    const scope = this.regionTracks().map((t) => t.id);
    this.mutate('clear time', (d) => {
      for (const track of d.tracks) {
        if (!scope.includes(track.id)) continue;
        splitClipsAt(track, start);
        splitClipsAt(track, end);
        track.clips = track.clips.filter(
          (c) => !(c.startBeat >= start - 1e-6 && c.startBeat < end - 1e-6),
        );
      }
    });
  }

  /** Insert blank time of the region's length at its start; later clips shift right. */
  insertTime() {
    if (!this.hasTimeSelection) return;
    const start = this.timeSelStart!;
    const span = this.timeSelEnd - start;
    const scope = this.regionTracks().map((t) => t.id);
    this.mutate('insert time', (d) => {
      for (const track of d.tracks) {
        if (!scope.includes(track.id)) continue;
        splitClipsAt(track, start);
        for (const c of track.clips) {
          if (c.startBeat >= start - 1e-6) c.startBeat += span;
        }
      }
    });
  }

  // ── Transport ─────────────────────────────────────────────────────────
  togglePlay() {
    runInAction(() => {
      // Starting playback resumes from the insert marker.
      if (!this.playing) this.positionBeat = this.playFromBeat;
      this.playing = !this.playing;
    });
  }
  stop() {
    runInAction(() => {
      this.playing = false;
      this.positionBeat = this.playFromBeat;
    });
  }
  setPosition(beat: number) {
    this.positionBeat = Math.max(0, beat);
  }
  /**
   * Set the insert / "play from" marker. The marker always follows the cursor
   * (click/drag, any transport state). When PAUSED the playhead follows it too
   * (scrubbing); while PLAYING the playhead keeps running and only the marker
   * moves — so clicking the timeline mid-playback re-arms where the next play
   * starts without interrupting playback.
   */
  setPlayFrom(beat: number) {
    runInAction(() => {
      this.playFromBeat = Math.max(0, beat);
      if (!this.playing) this.positionBeat = this.playFromBeat;
    });
  }
  toggleLoop() {
    this.loopEnabled = !this.loopEnabled;
  }

  /**
   * Cmd/Ctrl+L (or L): if a time box is set whose range differs from the loop
   * markers, snap the loop to the box and enable it; otherwise just toggle the
   * loop on/off.
   */
  toggleLoopOrSetToTimeBox() {
    runInAction(() => {
      if (this.hasTimeSelection && this.timeSelStart != null) {
        const a = this.timeSelStart, b = this.timeSelEnd;
        const sameRange = Math.abs(this.loopStartBeat - a) < 1e-6 && Math.abs(this.loopEndBeat - b) < 1e-6;
        if (b > a && !sameRange) {
          this.loopStartBeat = a;
          this.loopEndBeat = b;
          this.loopEnabled = true;
          return;
        }
      }
      this.loopEnabled = !this.loopEnabled;
    });
  }

  /** Option+Space: jump the playhead to the play-from marker and play at once. */
  rewindAndPlay() {
    runInAction(() => {
      this.positionBeat = this.playFromBeat;
      this.playing = true;
    });
  }

  /** Toggle one clip's bypass (skipped in the composite). */
  toggleClipBypass(trackId: string, clipId: string) {
    this.mutate('toggle clip bypass', (d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
      if (c) c.bypassed = !c.bypassed;
    });
  }

  /** Toggle bypass on all selected clips. */
  toggleSelectedClipsBypass() {
    const clipPaths = [...this.selection].filter((p) => p.startsWith('clip/'));
    if (!clipPaths.length) return;
    this.mutate('toggle clip bypass', (d) => {
      for (const p of clipPaths) {
        const [, trackId, clipId] = p.split('/');
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (c) c.bypassed = !c.bypassed;
      }
    });
  }

  /** Toggle the focused effect card's bypass (__bypass__). Returns false if no
   *  effect card is focused (so the caller can fall back to clip bypass). */
  toggleChainFocusBypass(): boolean {
    const path = this.chainFocusPath;
    if (!path?.startsWith('effect/')) return false;
    const rest = path.slice('effect/'.length).split('/');
    const chainIdx = Number(rest.pop());
    rest.pop(); // colIdx
    const sketchId = rest.join('/');
    if (!Number.isFinite(chainIdx)) return false;
    if (sketchId.startsWith('clip/')) {
      const [, trackId, clipId] = sketchId.split('/');
      const dev = this.trackById(trackId)?.clips.find((c) => c.id === clipId)?.sketch.devices[chainIdx];
      if (!dev) return false;
      this.setClipDeviceField(trackId, clipId, dev.id, '__bypass__', dev.state?.__bypass__ !== true);
      return true;
    }
    if (sketchId.startsWith('track/')) {
      const trackId = sketchId.split('/')[1];
      const dev = this.trackById(trackId)?.sketch.devices[chainIdx];
      if (!dev) return false;
      this.setTrackDeviceField(trackId, dev.id, '__bypass__', dev.state?.__bypass__ !== true);
      return true;
    }
    return false;
  }

  /** "0" shortcut: bypass the focused effect card if one is focused, else a
   *  selected track, else the selected clips. */
  toggleBypassShortcut() {
    if (this.toggleChainFocusBypass()) return;
    if (this.primaryPath?.startsWith('track/')) {
      const t = this.trackById(this.primaryPath.split('/')[1]);
      if (t && !this.isMainBus(t)) { this.toggleBypass(t.id); return; }
    }
    this.toggleSelectedClipsBypass();
  }
  setTransportMode(mode: 'precise' | 'live') {
    this.transportMode = mode;
  }
  setBpm(bpm: number) {
    const v = Math.max(20, Math.min(300, bpm));
    this.mutate('set BPM', (d) => { d.meta.baseBPM = v; }, 'meta:bpm');
  }
  setResolution(width: number, height: number) {
    this.mutate('set resolution', (d) => { d.meta.resolution = { width, height }; }, 'meta:res');
  }

  // ── Composite background (per composition; default = opaque black) ──────
  get backgroundMode(): 'black' | 'transparent' | 'custom' {
    return this.composition.meta.background?.mode ?? 'black';
  }
  get backgroundColor(): string {
    return this.composition.meta.background?.color ?? '#000000';
  }
  setBackground(mode: 'black' | 'transparent' | 'custom', color?: string) {
    this.mutate('set background', (d) => {
      d.meta.background = { mode, ...(color !== undefined ? { color } : (d.meta.background?.color ? { color: d.meta.background.color } : {})) };
    }, 'meta:bg');
  }

  // ── Clip mutations ────────────────────────────────────────────────────

  // ── Rails ─────────────────────────────────────────────────────────────

  railTrackFor(railId: string): Track | undefined {
    return this.composition.tracks.find(
      (t) => t.kind === 'rail' && t.railId === railId,
    );
  }

  /** Clips (with their track + export) that WRITE to a rail. */
  railWriters(railId: string): Array<{ track: Track; clip: Clip; exp: RailExport }> {
    const out: Array<{ track: Track; clip: Clip; exp: RailExport }> = [];
    for (const t of this.composition.tracks) {
      for (const c of t.clips) {
        for (const exp of c.exports) {
          if (exp.railId === railId) out.push({ track: t, clip: c, exp });
        }
      }
    }
    return out;
  }

  get mainBusTrack(): Track | undefined {
    return this.composition.tracks.find((t) => this.isMainBus(t));
  }

  /** Clips that warp the beat grid (one or more warp bindings). */
  warpWriters(): Array<{ track: Track; clip: Clip }> {
    const out: Array<{ track: Track; clip: Clip }> = [];
    for (const t of this.composition.tracks) {
      for (const c of t.clips) {
        if (c.warps.length) out.push({ track: t, clip: c });
      }
    }
    return out;
  }

  /** Clips (with their track + read) that READ from a rail. */
  railReaders(railId: string): Array<{ track: Track; clip: Clip; read: RailRead }> {
    const out: Array<{ track: Track; clip: Clip; read: RailRead }> = [];
    for (const t of this.composition.tracks) {
      for (const c of t.clips) {
        for (const read of c.reads ?? []) {
          if (read.railId === railId) out.push({ track: t, clip: c, read });
        }
      }
    }
    return out;
  }

  /** Click a wire → select its clip (and scroll a sub-target into view). */
  selectWire(wireId: string, clipPath: string, target?: { field?: string; trace?: boolean }) {
    runInAction(() => {
      this.select(clipPath);
      this.selectedWireId = wireId;
      this.scrollTarget = { clipPath, ...target };
    });
  }

  consumeScrollTarget() {
    const t = this.scrollTarget;
    this.scrollTarget = null;
    return t;
  }

  openTapPopup(p: { wireId: string; x: number; y: number; label: string }) {
    this.tapPopup = p;
  }
  closeTapPopup() {
    this.tapPopup = null;
  }

  /** Find a rail export/read tap object by wire id (`w:<id>` / `r:<id>`). */
  tapByWireId(wireId: string): RailExport | RailRead | undefined {
    const [kind, id] = [wireId[0], wireId.slice(2)];
    for (const t of this.composition.tracks) {
      for (const c of t.clips) {
        if (kind === 'w') {
          const e = c.exports.find((x) => x.id === id);
          if (e) return e;
        } else {
          const r = (c.reads ?? []).find((x) => x.id === id);
          if (r) return r;
        }
      }
    }
    return undefined;
  }

  /** Double-click on an empty lane → create an empty effect-only clip. */
  createEmptyClip(trackId: string, startBeat: number, lengthBeat = 8): string | null {
    const track = this.trackById(trackId);
    if (!track || track.kind !== 'track') return null;
    const clip: Clip = {
      id: uid('clip'),
      name: 'New Clip',
      startBeat: Math.max(0, startBeat),
      lengthBeat,
      kind: 'effect',
      sketch: { devices: [] },
      loop: { mode: 'hold' } as ClipLoopConfig,
      automation: [],
      exports: [],
      warps: [],
    };
    this.mutate('create clip', (d) => {
      d.tracks.find((t) => t.id === trackId)?.clips.push(clip);
    });
    const path = paths.clip(trackId, clip.id);
    this.select(path);
    return path;
  }

  /** Create a video clip backed by real on-disk media (Component D). */
  addVideoClip(
    trackId: string,
    startBeat: number,
    media: { sourceKey: string; url: string; frameCount: number; fps?: number; label?: string },
    lengthBeat = 8,
  ): string | null {
    const track = this.trackById(trackId);
    if (!track || track.kind !== 'track') return null;
    const label = media.label ?? 'Video';
    const clip: Clip = {
      id: uid('clip'),
      name: label,
      startBeat: Math.max(0, startBeat),
      lengthBeat,
      kind: 'video',
      sketch: {
        devices: [
          { id: uid('dev'), moduleType: 'source.video.file', name: label, capabilities: ['source'] },
        ],
      },
      source: {
        label,
        durationFrames: media.frameCount,
        sourceKey: media.sourceKey,
        url: media.url,
        fps: media.fps,
      },
      loop: { mode: 'loop' } as ClipLoopConfig,
      automation: [],
      exports: [],
      warps: [],
    };
    this.mutate('add video clip', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t) return;
      // Clips may not overlap: overwrite whatever sits under the dropped clip
      // (same as a clip dragged in from another track).
      carveTrackSpan(t, clip.id, clip.startBeat, clip.startBeat + clip.lengthBeat);
      t.clips.push(clip);
    });
    const path = paths.clip(trackId, clip.id);
    this.select(path);
    return path;
  }

  /** Set how a video/image clip's frame scales into the output canvas. */
  setClipScaleMode(trackId: string, clipId: string, mode: ScaleMode) {
    this.mutate(
      'set scale mode',
      (d) => {
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (c?.source) c.source.scaleMode = mode;
      },
      `scale:${clipId}`,
    );
  }

  /** Build + add a real device of a kind (used by the inspector chain). */
  addClipDevice(trackId: string, clipId: string, kind: 'source' | 'effect') {
    this.addDeviceToClip(trackId, clipId, this.makeDevice(kind));
  }

  /** Add a SPECIFIC real catalog effect to a clip (precise palette / tests). */
  addClipDeviceType(trackId: string, clipId: string, moduleType: string) {
    const cat = catalogEffect(moduleType);
    if (!cat) return;
    this.addDeviceToClip(trackId, clipId, {
      id: uid('dev'),
      moduleType: cat.type,
      name: cat.name,
      capabilities: cat.role === 'generator' ? ['generator'] : ['time_independent'],
      state: defaultStateFor(cat.type),
    });
  }

  // ── Clip device chain edits (drive the real <column-group> inspector) ──
  /** Assign a partial snapshot onto a clip device (type retype / undo-revert). */
  replaceClipDevice(
    trackId: string, clipId: string, deviceId: string,
    snap: Partial<Device>, coalesceKey?: string,
  ) {
    this.mutate('change device', (d) => {
      const dev = d.tracks.find((t) => t.id === trackId)
        ?.clips.find((c) => c.id === clipId)
        ?.sketch.devices.find((x) => x.id === deviceId);
      if (dev) Object.assign(dev, JSON.parse(JSON.stringify(snap)));
    }, coalesceKey);
  }

  /** Change a clip device's effect type (resets its state to the type defaults). */
  setClipDeviceType(
    trackId: string, clipId: string, deviceId: string,
    moduleType: string, coalesceKey?: string,
  ) {
    const cat = catalogEffect(moduleType);
    if (!cat) return;
    this.replaceClipDevice(trackId, clipId, deviceId, {
      moduleType: cat.type,
      name: cat.name,
      capabilities: cat.role === 'generator' ? ['generator'] : ['time_independent'],
      state: defaultStateFor(cat.type),
    }, coalesceKey);
  }

  /** Insert a catalog effect at a chain index; returns the new device id (or null). */
  insertClipDeviceAt(
    trackId: string, clipId: string, index: number,
    moduleType: string, coalesceKey?: string,
  ): string | null {
    const cat = catalogEffect(moduleType);
    if (!cat) return null;
    const id = uid('dev');
    this.mutate('insert device', (d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!c) return;
      const dev: Device = {
        id,
        moduleType: cat.type,
        name: cat.name,
        capabilities: cat.role === 'generator' ? ['generator'] : ['time_independent'],
        state: defaultStateFor(cat.type),
      };
      const i = Math.max(0, Math.min(index, c.sketch.devices.length));
      c.sketch.devices.splice(i, 0, dev);
      if (deviceIsSource(dev) && c.kind === 'effect') {
        c.kind = 'video';
        c.source = c.source ?? { label: dev.name, durationFrames: 300 };
      }
    }, coalesceKey);
    return id;
  }

  /** Remove a clip device by id. Also drops any wires touching it. */
  removeClipDevice(trackId: string, clipId: string, deviceId: string, coalesceKey?: string) {
    this.mutate('remove device', (d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!c) return;
      const i = c.sketch.devices.findIndex((x) => x.id === deviceId);
      if (i >= 0) c.sketch.devices.splice(i, 1);
      if (c.sketch.wires) {
        c.sketch.wires = c.sketch.wires.filter(
          (w) => w.src.instanceKey !== deviceId && w.dest.instanceKey !== deviceId);
      }
    }, coalesceKey);
  }

  /** Reorder: move the clip device at `from` to insertion index `to`. */
  moveClipDevice(trackId: string, clipId: string, from: number, to: number) {
    this.mutate('reorder device', (d) => {
      const devs = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId)?.sketch.devices;
      if (devs) moveInArray(devs, from, to);
    });
  }

  // ── Track device chain edits (track-level sketch; same shape as clip ones) ──
  setTrackDeviceField(trackId: string, deviceId: string, key: string, value: unknown) {
    this.mutate('set param', (d) => {
      const dev = d.tracks.find((t) => t.id === trackId)?.sketch.devices.find((x) => x.id === deviceId);
      if (dev) dev.state = { ...(dev.state ?? {}), [key]: value };
    }, `param:${deviceId}:${key}`);
  }

  replaceTrackDevice(trackId: string, deviceId: string, snap: Partial<Device>, coalesceKey?: string) {
    this.mutate('change device', (d) => {
      const dev = d.tracks.find((t) => t.id === trackId)?.sketch.devices.find((x) => x.id === deviceId);
      if (dev) Object.assign(dev, JSON.parse(JSON.stringify(snap)));
    }, coalesceKey);
  }

  setTrackDeviceType(trackId: string, deviceId: string, moduleType: string, coalesceKey?: string) {
    const cat = catalogEffect(moduleType);
    if (!cat) return;
    this.replaceTrackDevice(trackId, deviceId, {
      moduleType: cat.type, name: cat.name,
      capabilities: cat.role === 'generator' ? ['generator'] : ['time_independent'],
      state: defaultStateFor(cat.type),
    }, coalesceKey);
  }

  insertTrackDeviceAt(trackId: string, index: number, moduleType: string, coalesceKey?: string): string | null {
    const cat = catalogEffect(moduleType);
    if (!cat) return null;
    const id = uid('dev');
    this.mutate('insert device', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t) return;
      const dev: Device = {
        id, moduleType: cat.type, name: cat.name,
        capabilities: cat.role === 'generator' ? ['generator'] : ['time_independent'],
        state: defaultStateFor(cat.type),
      };
      const i = Math.max(0, Math.min(index, t.sketch.devices.length));
      t.sketch.devices.splice(i, 0, dev);
    }, coalesceKey);
    return id;
  }

  removeTrackDevice(trackId: string, deviceId: string, coalesceKey?: string) {
    this.mutate('remove device', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t) return;
      const i = t.sketch.devices.findIndex((x) => x.id === deviceId);
      if (i >= 0) t.sketch.devices.splice(i, 1);
      if (t.sketch.wires) {
        t.sketch.wires = t.sketch.wires.filter(
          (w) => w.src.instanceKey !== deviceId && w.dest.instanceKey !== deviceId);
      }
    }, coalesceKey);
  }

  /** Reorder: move the track device at `from` to insertion index `to`. */
  moveTrackDevice(trackId: string, from: number, to: number) {
    this.mutate('reorder device', (d) => {
      const devs = d.tracks.find((x) => x.id === trackId)?.sketch.devices;
      if (devs) moveInArray(devs, from, to);
    });
  }

  // ── Intra-sketch modulation wires (shared by clip + track chains) ───────
  /**
   * Connect two fields into a modulation wire. Mirrors the IDE's connectWire:
   * resolves writer (output) vs reader (input) — by explicit direction, else by
   * vertical position — and replaces any existing wire into the same dest field.
   * Cross-sketch (rail/return) wiring is punted for now: `a` and `b` must share a
   * sketch.
   */
  connectSketchWire(a: FieldConnectInfo, b: FieldConnectInfo) {
    if (a.sketchId !== b.sketchId) return;
    if (a.colIdx === b.colIdx && a.chainIdx === b.chainIdx && a.fieldPath === b.fieldPath) return;
    const writer = a.isOutput !== b.isOutput
      ? (a.isOutput ? a : b)
      : (a.viewportY <= b.viewportY ? a : b);
    const reader = writer === a ? b : a;
    const id = uid('wire');
    this.mutate('connect wire', (d) => {
      const sk = draftSketch(d, writer.sketchId);
      if (!sk) return;
      const srcDev = sk.devices[writer.chainIdx];
      const destDev = sk.devices[reader.chainIdx];
      if (!srcDev || !destDev) return;
      sk.wires = (sk.wires ?? []).filter(
        (w) => !(w.dest.instanceKey === destDev.id && w.dest.field === reader.fieldPath));
      sk.wires.push({
        id,
        src: { instanceKey: srcDev.id, field: writer.fieldPath },
        dest: { instanceKey: destDev.id, field: reader.fieldPath },
        combine: 'add',
      });
    });
  }

  removeSketchWire(sketchId: string, wireId: string) {
    this.mutate('remove wire', (d) => {
      const sk = draftSketch(d, sketchId);
      if (sk?.wires) sk.wires = sk.wires.filter((w) => w.id !== wireId);
    });
  }

  updateSketchWire(sketchId: string, wireId: string, patch: Record<string, unknown>, coalesceKey?: string) {
    this.mutate('update wire', (d) => {
      const w = draftSketch(d, sketchId)?.wires?.find((x) => x.id === wireId);
      if (w) Object.assign(w, JSON.parse(JSON.stringify(patch)));
    }, coalesceKey);
  }

  /** Wires in a sketch (for the column-group adapter / overlay). */
  sketchWires(sketchId: string) {
    if (sketchId.startsWith('clip/')) {
      const [, trackId, clipId] = sketchId.split('/');
      return this.trackById(trackId)?.clips.find((c) => c.id === clipId)?.sketch.wires ?? [];
    }
    if (sketchId.startsWith('track/')) {
      return this.trackById(sketchId.split('/')[1])?.sketch.wires ?? [];
    }
    return [];
  }

  /** Set one field on a clip device's param state (a real param edit). */
  setClipDeviceField(trackId: string, clipId: string, deviceId: string, key: string, value: unknown) {
    this.mutate(
      'set param',
      (d) => {
        const dev = d.tracks
          .find((t) => t.id === trackId)
          ?.clips.find((x) => x.id === clipId)
          ?.sketch.devices.find((x) => x.id === deviceId);
        if (dev) dev.state = { ...(dev.state ?? {}), [key]: value };
      },
      `param:${deviceId}:${key}`,
    );
  }

  /** Rename a clip (inline edit). No-op if unchanged. */
  renameClip(trackId: string, clipId: string, name: string) {
    const next = name.trim();
    this.mutate(
      'rename clip',
      (d) => {
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (c && next.length > 0) c.name = next;
      },
      `rename:clip:${clipId}`,
    );
  }

  /** Rename a track (inline edit). No-op if unchanged. */
  renameTrack(trackId: string, name: string) {
    const next = name.trim();
    this.mutate(
      'rename track',
      (d) => {
        const t = d.tracks.find((x) => x.id === trackId);
        if (t && next.length > 0) t.name = next;
      },
      `rename:track:${trackId}`,
    );
  }

  addTrackDevice(trackId: string, _kind: 'source' | 'effect') {
    const t = this.trackById(trackId);
    if (!t) return;
    const dev = this.makeDevice('effect');
    this.mutate('add device', (d) => {
      d.tracks.find((x) => x.id === trackId)?.sketch.devices.push(dev);
    });
  }

  private makeDevice(kind: 'source' | 'effect'): Device {
    if (kind === 'source') {
      // A real generator (renders on its own as the chain's first entry).
      return {
        id: uid('dev'),
        moduleType: 'source.solid_color',
        name: 'Solid Color',
        capabilities: ['generator'],
        state: {},
      };
    }
    // Rotate through the real effect catalog.
    const pick = EFFECTS[(_uid >>> 0) % EFFECTS.length];
    return {
      id: uid('dev'),
      moduleType: pick.type,
      name: pick.name,
      capabilities: ['time_independent'],
      state: defaultStateFor(pick.type),
    };
  }

  /** Add a device to a clip; a source/generator promotes it to a video clip. */
  addDeviceToClip(trackId: string, clipId: string, device: Device) {
    const track = this.trackById(trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (!clip) return;
    this.mutate('add device', (d) => {
      const c = d.tracks.find((x) => x.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!c) return;
      c.sketch.devices.push(device);
      if (deviceIsSource(device) && c.kind === 'effect') {
        c.kind = 'video';
        c.source = c.source ?? { label: device.name, durationFrames: 300 };
      }
    });
  }

  moveClip(trackId: string, clipId: string, newStartBeat: number) {
    const v = Math.max(0, newStartBeat);
    this.mutate(
      'move clip',
      (d) => {
        const t = d.tracks.find((t) => t.id === trackId);
        const c = t?.clips.find((x) => x.id === clipId);
        if (t && c) {
          c.startBeat = v;
          carveTrackSpan(t, clipId, v, v + c.lengthBeat);
        }
      },
      `move:${trackId}:${clipId}`,
    );
  }

  resizeClip(
    trackId: string,
    clipId: string,
    newStartBeat: number,
    newLengthBeat: number,
  ) {
    const start = Math.max(0, newStartBeat);
    const len = Math.max(0.5, newLengthBeat);
    this.mutate(
      'resize clip',
      (d) => {
        const t = d.tracks.find((t) => t.id === trackId);
        const c = t?.clips.find((x) => x.id === clipId);
        if (t && c) {
          c.startBeat = start;
          c.lengthBeat = len;
          carveTrackSpan(t, clipId, start, start + len);
        }
      },
      `resize:${trackId}:${clipId}`,
    );
  }

  deleteSelectedClips() {
    const sel = [...this.selection];
    this.mutate('delete clips', (d) => {
      for (const path of sel) {
        const [kind, trackId, clipId] = path.split('/');
        if (kind !== 'clip') continue;
        const t = d.tracks.find((x) => x.id === trackId);
        if (t) t.clips = t.clips.filter((c) => c.id !== clipId);
      }
    });
    this.clearSelection();
  }

  // ── Track structure: add / delete / reorder ───────────────────────────
  private static isMainBusTrack(t: Track): boolean {
    return t.kind === 'group' && t.parentId === null;
  }

  /**
   * Insert a new empty track immediately after `afterTrackId` in the array (or
   * at the end when omitted). The main bus pins to the bottom via `displayTracks`
   * regardless of array position, so this never needs special bus handling.
   * Returns the new track id and selects it.
   */
  addTrack(afterTrackId?: string): string {
    const id = uid('trk');
    const track: Track = {
      id,
      name: 'New Track',
      kind: 'track',
      parentId: null,
      color: 'var(--app-cat-source)',
      sketch: { devices: [] },
      automation: [],
      clips: [],
    };
    this.mutate('add track', (d) => {
      let idx = d.tracks.length;
      if (afterTrackId) {
        const ai = d.tracks.findIndex((t) => t.id === afterTrackId);
        if (ai >= 0) idx = ai + 1;
      }
      d.tracks.splice(idx, 0, track);
    });
    this.select(paths.track(id));
    return id;
  }

  /** "+ Return" affordance: a value-only (rail) return channel. Inserted before
   *  the main bus so the bus stays bottom-most. */
  addReturn(): string {
    const id = uid('trk');
    const track: Track = {
      id,
      name: 'Return',
      kind: 'rail',
      parentId: null,
      color: 'var(--app-cat-mod)',
      sketch: { devices: [] },
      automation: [],
      clips: [],
      railId: uid('rail'),
      baseCurve: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
    };
    this.mutate('add return', (d) => {
      const busIdx = d.tracks.findIndex((t) => ArrangementStore.isMainBusTrack(t));
      const idx = busIdx >= 0 ? busIdx : d.tracks.length;
      d.tracks.splice(idx, 0, track);
    });
    this.select(paths.track(id));
    return id;
  }

  /** "+ Track" affordance: insert after the last (bottom-most) shown-selected track. */
  addTrackAfterSelection(): string {
    const shown = this.shownSelectedTrackIds;
    let after: string | undefined;
    for (const t of this.displayTracks) {
      if (shown.has(t.id) && !this.isMainBus(t)) after = t.id;
    }
    return this.addTrack(after);
  }

  /** Delete the focused track(s); never the main bus. Children reparent upward. */
  deleteSelectedTracks() {
    const ids = this.selectedTrackIds.filter((id) => {
      const t = this.trackById(id);
      return !!t && !this.isMainBus(t);
    });
    if (!ids.length) return;
    const idSet = new Set(ids);
    this.mutate('delete track', (d) => {
      const resolveParent = (pid: string | null): string | null => {
        let cur = pid;
        while (cur && idSet.has(cur)) {
          cur = d.tracks.find((x) => x.id === cur)?.parentId ?? null;
        }
        return cur;
      };
      for (const t of d.tracks) {
        if (t.parentId && idSet.has(t.parentId)) t.parentId = resolveParent(t.parentId);
      }
      d.tracks = d.tracks.filter((t) => !idSet.has(t.id));
    });
    this.clearSelection();
    this.clearTimeSelection();
  }

  /** True if a track may be dragged to reorder (everything but the main bus). */
  canReorderTrack(trackId: string): boolean {
    const t = this.trackById(trackId);
    return !!t && !this.isMainBus(t);
  }

  /**
   * Reorder `trackId` to sit immediately before `beforeTrackId` (or at the end of
   * the non-bus tracks when null). Operates on the underlying array among non-bus
   * tracks so display order AND composite draw order stay consistent; the main bus
   * is always kept last. The bus itself can't be moved.
   */
  moveTrack(trackId: string, beforeTrackId: string | null) {
    const t = this.trackById(trackId);
    if (!t || this.isMainBus(t)) return;
    if (beforeTrackId === trackId) return;
    this.mutate('reorder tracks', (d) => {
      const buses = d.tracks.filter((x) => ArrangementStore.isMainBusTrack(x));
      const nonbus = d.tracks.filter((x) => !ArrangementStore.isMainBusTrack(x));
      const from = nonbus.findIndex((x) => x.id === trackId);
      if (from < 0) return;
      const [moved] = nonbus.splice(from, 1);
      let to = beforeTrackId ? nonbus.findIndex((x) => x.id === beforeTrackId) : nonbus.length;
      if (to < 0) to = nonbus.length;
      nonbus.splice(to, 0, moved);
      d.tracks = [...nonbus, ...buses];
    });
  }

  /**
   * Move a clip to another (eligible) track at `newStartBeat`. An ineligible
   * destination (group/rail/main bus) keeps the clip on its source track. Same
   * coalesce key as a within-track move so a whole drag gesture is one undo.
   */
  moveClipToTrack(fromTrackId: string, clipId: string, toTrackId: string, newStartBeat: number) {
    const v = Math.max(0, newStartBeat);
    const dest = this.trackById(toTrackId);
    const realDest = dest && dest.kind === 'track' ? toTrackId : fromTrackId;
    this.mutate(
      'move clip',
      (d) => {
        const from = d.tracks.find((t) => t.id === fromTrackId);
        const to = d.tracks.find((t) => t.id === realDest);
        if (!from || !to) return;
        if (from === to) {
          const c = from.clips.find((x) => x.id === clipId);
          if (c) {
            c.startBeat = v;
            carveTrackSpan(to, clipId, v, v + c.lengthBeat);
          }
          return;
        }
        const i = from.clips.findIndex((c) => c.id === clipId);
        if (i < 0) return;
        const [clip] = from.clips.splice(i, 1);
        clip.startBeat = v;
        to.clips.push(clip);
        carveTrackSpan(to, clipId, v, v + clip.lengthBeat);
      },
      `move:${clipId}`,
    );
  }

  /** True if clips may be dropped onto this track (plain playable tracks only). */
  isClipEligibleTrack(trackId: string): boolean {
    return this.trackById(trackId)?.kind === 'track';
  }

  // ── Track / group / automation toggles ────────────────────────────────
  toggleGroupCollapse(trackId: string) {
    this.mutate('toggle collapse', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) t.collapsed = !t.collapsed;
    });
  }

  toggleSolo(trackId: string) {
    this.mutate('toggle solo', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) t.soloed = !t.soloed;
    });
  }

  toggleBypass(trackId: string) {
    this.mutate('toggle bypass', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) t.bypassed = !t.bypassed;
    });
  }

  setTrackLevel(trackId: string, level: number) {
    const v = Math.max(0, Math.min(1, level));
    this.mutate(
      'set level',
      (d) => {
        const t = d.tracks.find((x) => x.id === trackId);
        if (t) t.level = v;
      },
      `level:${trackId}`,
    );
  }

  /** Select every clip whose path is in `clipPaths` (marquee result). */
  selectClips(clipPaths: string[], additive: boolean) {
    runInAction(() => {
      const next = additive ? new Set(this.selection) : new Set<string>();
      for (const p of clipPaths) next.add(p);
      this.selection = next;
      this.primaryPath = clipPaths.length
        ? clipPaths[clipPaths.length - 1]
        : this.primaryPath;
    });
  }

  toggleAutomationExpand(trackId: string, laneId: string) {
    this.mutate('toggle lane', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      const lane =
        t?.automation.find((l) => l.id === laneId) ??
        t?.clips.flatMap((c) => c.automation).find((l) => l.id === laneId);
      if (lane) lane.expanded = !lane.expanded;
    });
  }

  // ── Automation point editing ──────────────────────────────────────────
  /** Locate a lane by id across track-level AND clip-level automation. */
  private static laneIn(d: Composition, laneId: string): AutomationLane | undefined {
    for (const t of d.tracks) {
      const tl = t.automation.find((l) => l.id === laneId);
      if (tl) return tl;
      for (const c of t.clips) {
        const cl = c.automation.find((l) => l.id === laneId);
        if (cl) return cl;
      }
    }
    return undefined;
  }

  /** Read a lane by id (live composition), or undefined. */
  automationLane(laneId: string): AutomationLane | undefined {
    return ArrangementStore.laneIn(this.composition, laneId);
  }

  /**
   * Replace a lane's points (normalizing to `{x,y,bend}`). Pass a stable
   * `coalesceKey` for the duration of a drag so the whole gesture is ONE undo.
   */
  setAutomationPoints(laneId: string, points: EnvelopePoint[], coalesceKey?: string) {
    this.mutate(
      'edit automation',
      (d) => {
        const lane = ArrangementStore.laneIn(d, laneId);
        if (lane) lane.points = points.map((p) => ({ x: p.x, y: p.y, bend: p.bend ?? 0 }));
      },
      coalesceKey,
    );
  }

  /** A flat mid-level curve — the seed for a freshly created lane. */
  private static defaultCurve(): EnvelopePoint[] {
    return [{ x: 0, y: 0.5, bend: 0 }, { x: 1, y: 0.5, bend: 0 }];
  }

  /** Label/target for a new lane from a sketch's first catalog device field. */
  private autoTargetFor(devices: Device[] | undefined): { deviceId: string; field: string; label: string } {
    const dev = devices?.[0];
    const cat = dev ? catalogEffect(dev.moduleType) : undefined;
    const field = cat?.fields[0];
    return {
      deviceId: dev?.id ?? '',
      field: field?.key ?? 'value',
      label: field ? `${cat!.name} · ${field.label}` : 'Automation',
    };
  }

  /** Ensure the clip has an automation lane; returns its id (existing or new). */
  ensureClipAutomationLane(trackId: string, clipId: string): string {
    const clip = this.clipByPath(paths.clip(trackId, clipId))?.clip;
    const existing = clip?.automation[0];
    if (existing) return existing.id;
    const laneId = uid('auto');
    const t = this.autoTargetFor(clip?.sketch.devices);
    this.mutate('add automation', (d) => {
      const c = d.tracks.find((x) => x.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!c || c.automation.length) return;
      c.automation.push({
        id: laneId, targetDeviceId: t.deviceId, targetField: t.field,
        label: t.label, points: ArrangementStore.defaultCurve(), expanded: true,
      });
    });
    return laneId;
  }

  /** Ensure the track has an automation lane; returns its id (existing or new). */
  ensureTrackAutomationLane(trackId: string): string {
    const track = this.trackById(trackId);
    const existing = track?.automation[0];
    if (existing) return existing.id;
    const laneId = uid('auto');
    const t = this.autoTargetFor(track?.sketch.devices);
    this.mutate('add automation', (d) => {
      const dt = d.tracks.find((x) => x.id === trackId);
      if (!dt || dt.automation.length) return;
      dt.automation.push({
        id: laneId, targetDeviceId: t.deviceId, targetField: t.field,
        label: t.label, points: ArrangementStore.defaultCurve(), expanded: true,
      });
    });
    return laneId;
  }

  /** Flip all of a track's automation lanes open/closed together. */
  toggleTrackAutomation(trackId: string) {
    const t = this.trackById(trackId);
    if (!t || t.automation.length === 0) return;
    const anyClosed = t.automation.some((l) => !l.expanded);
    this.mutate('toggle automation', (d) => {
      const dt = d.tracks.find((x) => x.id === trackId);
      if (dt) for (const l of dt.automation) l.expanded = anyClosed;
    });
  }

  /** Depth of a track in the group hierarchy (for header indent). */
  trackDepth(track: Track): number {
    let depth = 0;
    let parentId = track.parentId;
    while (parentId) {
      const parent = this.trackById(parentId);
      if (!parent) break;
      depth++;
      parentId = parent.parentId;
    }
    return depth;
  }

  /** Tracks visible given collapsed groups (a collapsed group hides children). */
  get visibleTracks(): Track[] {
    const collapsed = new Set(
      this.composition.tracks.filter((t) => t.collapsed).map((t) => t.id),
    );
    return this.composition.tracks.filter((t) => {
      let parentId = t.parentId;
      while (parentId) {
        if (collapsed.has(parentId)) return false;
        parentId = this.trackById(parentId)?.parentId ?? null;
      }
      return true;
    });
  }

  /** True for the master/main-bus track that pins to the bottom. */
  isMainBus(track: Track): boolean {
    return track.kind === 'group' && track.parentId === null;
  }

  /** Render order: normal tracks first, main-bus group(s) pinned to bottom. */
  get displayTracks(): Track[] {
    const vis = this.visibleTracks;
    const normal = vis.filter((t) => !this.isMainBus(t));
    const buses = vis.filter((t) => this.isMainBus(t));
    return [...normal, ...buses];
  }
}

export const store = new ArrangementStore();
