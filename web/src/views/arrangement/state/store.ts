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
  SourceTransform,
  GroupInput,
  GroupInputMode,
  deviceIsSource,
  resolveSourceTransform,
  compositionLengthBeats,
  compositionFps as fnCompositionFps,
  exportSettings,
  exportResolution,
  exportFps as fnExportFps,
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
} from '../model/composition';
// The bundled demo composition — NOT booted (the app starts empty); loaded only
// on demand via `loadDemoComposition()` (a "Load demo" affordance + e2e fixtures).
import { makeFakeComposition } from '../model/fake-data';
import { DocHistory } from './history';
import { EFFECTS, defaultStateFor, catalogEffect } from '../engine/effect-catalog';
import type { CompositeNode } from '../engine/clip-sketch';
import { type WorkspaceBackend, type WorkspaceEntry, DirectoryBackend, mountViaPicker } from '../workspace/backend';
import { rememberWorkspace, restoreWorkspace, restoreWorkspaceSilent, rememberedWorkspaceLabel } from '../workspace/workspace-store';
import { saveLayout, loadLayout, type ArrLayout } from '../workspace/layout-store';
import { openMedia, resolveMedia } from '../workspace/media-store';
import { emptyComposition, makeMainBus, defaultClipLoop, MAIN_BUS_ID } from '../model/composition';

/** Per-nesting-level budget (px) for the group gutter: one vertical group line
 *  per depth lives here, and every opacity fader is offset by the full gutter so
 *  faders stay the same width regardless of nesting. */
export const GROUP_INDENT = 20;

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

/**
 * Mint a globally-unique id. UUID-based (not a per-session counter) so ids never
 * collide across reloads, copy/paste, or distinct sources — a counter resets to its
 * seed each page load while loaded projects keep last session's ids, which used to
 * make a new clip reuse an existing id (two clips → one decode pump → "the second
 * clip plays the wrong video"). The `<prefix>_` is just a human-readable tag.
 */
const genId = (): string => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for non-secure contexts / very old runtimes.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};
const uid = (p: string) => `${p}_${genId()}`;

/**
 * Mint fresh INNER ids on a just-cloned clip (deep copy with a new clip id) so a
 * duplicate/split/paste doesn't share device + automation-lane ids with its
 * source. Shared device ids collide on the composite instance key (instance
 * retype storm); shared lane ids route envelope edits to the wrong clip (laneIn
 * resolves globally) → the edit snaps back. Remaps in place + rewires the clip's
 * own wires + automation targets to the new device ids.
 */
function freshClipIds(clip: Clip): void {
  const devMap = new Map<string, string>();
  for (const d of clip.sketch.devices) {
    const fresh = uid('dev');
    devMap.set(d.id, fresh);
    d.id = fresh;
  }
  for (const w of clip.sketch.wires ?? []) {
    const s = devMap.get(w.src.instanceKey);
    if (s) w.src.instanceKey = s;
    const t = devMap.get(w.dest.instanceKey);
    if (t) w.dest.instanceKey = t;
  }
  for (const lane of clip.automation ?? []) {
    lane.id = uid('auto');
    const t = devMap.get(lane.targetDeviceId);
    if (t) lane.targetDeviceId = t;
  }
  // Rail taps (return-track modulation wires) reference clip-local devices and
  // carry a tap id that keys the wire selection path (`w:`/`r:` + id). A clone
  // that kept the source's device refs would modulate the ORIGINAL clip's
  // devices; a shared tap id would alias the source's wire in tapByWireId.
  for (const exp of clip.exports ?? []) {
    exp.id = uid('rail');
    const s = devMap.get(exp.sourceDeviceId);
    if (s) exp.sourceDeviceId = s;
  }
  for (const read of clip.reads ?? []) {
    read.id = uid('rail');
    const t = devMap.get(read.targetDeviceId);
    if (t) read.targetDeviceId = t;
  }
}

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
      freshClipIds(right);
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
      freshClipIds(right);
      right.startBeat = end;
      right.lengthBeat = ce - end;
      next.push(right);
    }
    // a clip wholly inside [start,end) contributes neither piece → removed
  }
  track.clips = next;
}

/**
 * Resolve clip overlaps on a track by MAINTAINING STARTS and trimming ENDS: each
 * clip's end is capped at the next clip's start. Used after a global length change
 * (BPM reflow lengthens one-shot clips) so the "clips never overlap" invariant holds
 * without moving any clip's start. A single left-to-right pass suffices — once clip
 * i ends at clip i+1's start it can't reach i+2 either.
 */
function resolveOverlapsKeepStarts(track: Track) {
  const clips = [...track.clips].sort((a, b) => a.startBeat - b.startBeat);
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i];
    const b = clips[i + 1];
    const gap = b.startBeat - a.startBeat;
    if (a.startBeat + a.lengthBeat > b.startBeat + 1e-6 && gap > 1e-6) {
      a.lengthBeat = gap; // trim a's end back to b's start (keep both starts)
    }
  }
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
  // Boot empty (one starter track over the main bus). A remembered workspace
  // re-opens over this on boot; the demo is opt-in via `loadDemoComposition()`.
  composition: Composition = emptyComposition();

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

  /**
   * Per-owner field selected for AUTOMATION (distinct from the global field
   * focus). Keyed by owner path (`clip/<trk>/<clip>` or `track/<trk>`) → the
   * device + field. A clip's selection drives its clip-view automation tab; a
   * track's selection drives the automation overlay on its timeline + the
   * header's pin affordance. Ephemeral (not persisted/undoable).
   */
  selectedAutoField: Record<string, { deviceId: string; field: string; label: string }> = {};
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
  /** Resizable BASE width of the header content (px) — persisted. The effective
   *  column width adds the group gutter on top (see `headerWidth`). */
  private headerBaseWidth = 184;
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
  loopEnabled = true;
  loopStartBeat = 0;
  loopEndBeat = 32;
  transportMode: 'precise' | 'live' = 'precise';

  /**
   * 2D edit caret (text-cursor model). The caret has a HEAD (current time =
   * `playFromBeat`, on `caretHeadTrackId`) and an ANCHOR (where the gesture /
   * selection started). The selected region is the rectangle anchor→head in BOTH
   * time and tracks. Zero time-width ⇒ a vertical "slice" caret (infinitely thin
   * in time, but spanning the anchor→head track range). The time box
   * (`timeSel*`) + play-from are DERIVED from these — see the getters below.
   *
   * Track ids `''` ⇒ a global vertical span (all plain tracks).
   */
  playFromBeat = 0; // caret HEAD beat — playback starts here
  caretAnchorBeat = 0; // caret ANCHOR beat
  caretAnchorTrackId = ''; // anchor track ('' = global span)
  caretHeadTrackId = ''; // head track ('' = global span)
  // Each track is a stack of ROWS: its clip row (laneId '') + one row per
  // automation lane. The caret addresses a row, so clicking / arrowing onto a
  // lane lands ON that lane (not the parent track), and a single-lane region
  // scopes envelope edits to that one lane.
  caretAnchorLaneId = ''; // '' = the anchor track's clip row
  caretHeadLaneId = ''; // '' = the head track's clip row

  /** Ephemeral clip clipboard (copy/cut → paste). Offsets are relative to the
   *  copy origin so paste lands at the caret. Not observed / undoable. */
  private clipClipboard: { items: Array<{ trackOffset: number; startBeat: number; clip: Clip }>; span: number } | null = null;
  /** Ephemeral automation clipboard: per-lane envelope slices (nodes relative to
   *  the region start) + their row offset from the caret head, for paste. */
  private autoClipboard: { lanes: Array<{ rowOffset: number; nodes: EnvelopePoint[] }>; span: number } | null = null;
  /** Which clipboard was filled last — paste applies THAT, regardless of the
   *  current mode (paste in the "wrong" mode still applies the data). */
  lastClipboardKind: 'clips' | 'auto' | null = null;

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
      | 'layoutReady' | 'layoutSaveTimer' | 'clipClipboard' | 'autoClipboard'
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
        // Ephemeral clip clipboard — no reactivity / undo needed.
        clipClipboard: false,
        autoClipboard: false,
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
    this.applyHistoryWithAutoSelect(() => this.history.undo());
  }
  redo() {
    this.applyHistoryWithAutoSelect(() => this.history.redo());
  }

  /** Snapshot every clip id + track id across the document. */
  private snapshotIds(): { clips: Map<string, string>; tracks: Set<string> } {
    const clips = new Map<string, string>(); // clipId → trackId
    const tracks = new Set<string>();
    for (const t of this.composition.tracks) {
      tracks.add(t.id);
      for (const c of t.clips) clips.set(c.id, t.id);
    }
    return { clips, tracks };
  }

  /**
   * Run an undo/redo and, if it created EXACTLY ONE new clip or track, select it
   * — so re-creating a thing (or redoing its creation) focuses it, the way the
   * original creating action did. Zero or multiple additions leave selection as-is.
   */
  private applyHistoryWithAutoSelect(apply: () => void) {
    const before = this.snapshotIds();
    apply();
    const after = this.snapshotIds();
    const newClips: Array<{ trackId: string; clipId: string }> = [];
    for (const [clipId, trackId] of after.clips) {
      if (!before.clips.has(clipId)) newClips.push({ trackId, clipId });
    }
    if (newClips.length === 1) {
      this.select(paths.clip(newClips[0].trackId, newClips[0].clipId));
      return;
    }
    const newTracks = [...after.tracks].filter((id) => !before.tracks.has(id));
    if (newClips.length === 0 && newTracks.length === 1) {
      this.select(paths.track(newTracks[0]));
    }
  }
  /** Begin/end a continuous pointer drag (clip move/resize): every record in
   *  between folds into ONE undo entry no matter how long the pointer dwells, so
   *  the gesture's base stays fixed for its whole duration. */
  beginGesture() {
    this.history.beginGesture();
  }
  endGesture() {
    this.history.endGesture();
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
    ArrangementStore.repairIds(comp); // heal duplicate clip + device + lane ids (legacy files)
    runInAction(() => {
      this.backend = backend;
      this.currentName = name;
      this.composition = comp;
      this.ensureMainBus(); // legacy / hand-made files may lack the master track
      this.normalizeTrackOrder(); // heal any non-contiguous group nesting from older files
      // Restore persisted loop markers (omitted on legacy files ⇒ keep defaults).
      if (comp.loop) {
        this.loopEnabled = comp.loop.enabled;
        this.loopStartBeat = comp.loop.startBeat;
        this.loopEndBeat = comp.loop.endBeat;
      }
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
      headerWidth: this.headerBaseWidth, // persist the resizable CONTENT width (gutter is derived)
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
        if (typeof l.headerWidth === 'number') this.headerBaseWidth = Math.max(120, Math.min(380, Math.round(l.headerWidth)));
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

  /**
   * Replace the working document with the bundled DEMO composition (the former
   * fake-data mockup — a populated arrangement to explore). Not booted; this is
   * an opt-in affordance (and the fixture e2e tests load to exercise rich state).
   * Behaves like an unsaved scratch doc: detaches from any open file so it can't
   * overwrite real work, and resets undo history.
   */
  loadDemoComposition() {
    const demo = makeFakeComposition();
    ArrangementStore.repairIds(demo);
    runInAction(() => {
      this.backend = null;
      this.currentName = null;
      this.persistenceEnabled = false;
      this.composition = demo;
      this.ensureMainBus();
      this.clearSelection();
    });
    this.history.reset();
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

  // ── Display names (the `#` token) ─────────────────────────────────────
  // A name containing `#` is a smart default: `#` is replaced AT DISPLAY TIME by
  // context, so the raw stored name (e.g. "Track #") stays a template and auto-
  // renumbers, while a user-typed name (no `#`) is shown verbatim.

  /** 1-based index of `track` among its OWN kind (groups skip the main bus). */
  trackNumber(track: Track): number {
    let n = 0;
    for (const t of this.composition.tracks) {
      if (t.kind !== track.kind) continue;
      if (t.kind === 'group' && this.isMainBus(t)) continue;
      n++;
      if (t.id === track.id) return n;
    }
    return n;
  }

  /** Track/group name with `#` → its index (raw name returned unchanged if no `#`). */
  trackDisplayName(track: Track): string {
    return track.name.includes('#') ? track.name.replace(/#/g, String(this.trackNumber(track))) : track.name;
  }

  /** What a clip's `#` resolves to: the video filename, else the first generator's
   *  name, else the first effect/modulator's name, else "Empty". */
  clipContextLabel(clip: Clip): string {
    if (clip.source?.url || clip.source?.label) {
      const label = clip.source.label || clip.source.url || '';
      // Strip any path + trailing query, keep the bare filename.
      const base = label.split(/[\\/]/).pop() ?? label;
      return base.split('?')[0] || 'Video';
    }
    const role = (d: Device) => catalogEffect(d.moduleType)?.role;
    const gen = clip.sketch.devices.find((d) => role(d) === 'generator' || deviceIsSource(d));
    if (gen) return gen.name || gen.moduleType;
    const fx = clip.sketch.devices.find((d) => role(d) === 'effect');
    if (fx) return fx.name || fx.moduleType;
    return 'Empty';
  }

  /** Clip name with `#` → its context label (raw name unchanged if no `#`). */
  clipDisplayName(clip: Clip): string {
    return clip.name.includes('#') ? clip.name.replace(/#/g, this.clipContextLabel(clip)) : clip.name;
  }

  clipByPath(path: string): { track: Track; clip: Clip } | undefined {
    const [kind, trackId, clipId] = path.split('/');
    if (kind !== 'clip') return undefined;
    const track = this.trackById(trackId);
    const clip = track?.clips.find((c) => c.id === clipId);
    if (track && clip) return { track, clip };
    return undefined;
  }

  /** The clip on `trackId` whose span contains `beat` (start ≤ beat < end). */
  clipAtBeat(trackId: string, beat: number): Clip | undefined {
    return this.trackById(trackId)?.clips.find(
      (c) => beat >= c.startBeat - 1e-6 && beat < c.startBeat + c.lengthBeat - 1e-6,
    );
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
      this.tapPopup = null;
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
        const full = compositionLengthBeats(this.composition);
        if (t && (t.kind === 'track' || t.kind === 'rail')) {
          // Selecting a track OR return/rail sets the time box (all beats × that
          // track) but must NOT yank the play-from marker / playhead — keep them put.
          this.setTimeSelection(0, full, [t.id], { movePlayhead: false });
        } else if (t && t.kind === 'group' && !this.isMainBus(t)) {
          // Selecting a GROUP selects the full time across ALL its contained tracks
          // — exactly like a vertical selection over the whole cluster. The caret
          // spans the group row → its last visible row; `caretTrackIds` expands the
          // group into its descendant tracks (even when collapsed).
          const last = this.lastVisibleInGroup(t.id) ?? t.id;
          this.setTimeSelection(0, full, [t.id, last], { movePlayhead: false });
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
      return !!t && (t.kind === 'track' || t.kind === 'rail');
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
      this.tapPopup = null;
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
      this.tapPopup = null;
      this.chainFocusPath = null;
      this.chainFieldKey = null;
    });
  }

  /**
   * Dismiss every transient wire/field option popup — the rail-wire popup
   * (timeline + dashboard, `tapPopup`/`selectedWireId`) AND the in-sketch
   * wire-mod panel (`chainFocusPath` === `wire/…`, drives column-group's
   * floating panel). Single entry point so "click away" is one rule everywhere,
   * driven off the selection subpath rather than per-popup ad-hoc state.
   */
  dismissPopups() {
    runInAction(() => {
      this.selectedWireId = null;
      this.tapPopup = null;
      if (this.chainFocusPath?.startsWith('wire/')) this.chainFocusPath = null;
    });
  }

  // ── Chain inspector focus (effect cards / fields) ──────────────────────
  /** Set the focused effect-card path (or null). Drives highlight + Delete. */
  setChainFocus(path: string | null) {
    runInAction(() => {
      this.chainFocusPath = path;
      // Focusing an in-sketch card/wire supersedes any open rail-wire popup.
      if (path) { this.selectedWireId = null; this.tapPopup = null; }
    });
  }
  /** Set the focused field key (or null). */
  setChainField(key: string | null) {
    runInAction(() => { this.chainFieldKey = key; });
  }

  // ── Per-owner automation-field selection ───────────────────────────────
  /** Devices of an owner (`clip/<trk>/<clip>` or `track/<trk>`). */
  private devicesForOwner(ownerKey: string): Device[] | undefined {
    if (ownerKey.startsWith('clip/')) {
      const [, trk, clip] = ownerKey.split('/');
      return this.trackById(trk)?.clips.find((c) => c.id === clip)?.sketch.devices;
    }
    if (ownerKey.startsWith('track/')) {
      return this.trackById(ownerKey.split('/')[1])?.sketch.devices;
    }
    return undefined;
  }
  private autoFieldLabel(ownerKey: string, deviceId: string, field: string): string {
    const dev = this.devicesForOwner(ownerKey)?.find((d) => d.id === deviceId);
    const name = dev ? (catalogEffect(dev.moduleType)?.name ?? dev.moduleType) : '?';
    return `${name} · ${field}`;
  }
  /** Select (or replace) the owner's automation field. */
  selectAutoField(ownerKey: string, deviceId: string, field: string) {
    runInAction(() => {
      const label = this.autoFieldLabel(ownerKey, deviceId, field);
      this.selectedAutoField = { ...this.selectedAutoField, [ownerKey]: { deviceId, field, label } };
      // Selecting a field dismisses any open wire popup (rail or in-sketch).
      this.selectedWireId = null;
      this.tapPopup = null;
      if (this.chainFocusPath?.startsWith('wire/')) this.chainFocusPath = null;
    });
  }
  clearAutoField(ownerKey: string) {
    runInAction(() => {
      if (!(ownerKey in this.selectedAutoField)) return;
      const next = { ...this.selectedAutoField };
      delete next[ownerKey];
      this.selectedAutoField = next;
    });
  }
  autoField(ownerKey: string): { deviceId: string; field: string; label: string } | null {
    return this.selectedAutoField[ownerKey] ?? null;
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
  /** Number of group-gutter columns = the deepest group nesting on screen (a
   *  group reserves its own column; a leaf only reserves its ancestors'). 0 when
   *  nothing is grouped, so a flat project gets no gutter at all. */
  get groupGutterColumns(): number {
    let max = 0;
    for (const t of this.composition.tracks) {
      if (this.isMainBus(t)) continue;
      const cols = this.trackDepth(t) + (t.kind === 'group' ? 1 : 0);
      if (cols > max) max = cols;
    }
    return max;
  }

  /** Width (px) of the left group gutter — the uniform left-offset for every fader. */
  get groupGutterWidth(): number {
    return this.groupGutterColumns * GROUP_INDENT;
  }

  /** Effective header-column width: resizable content + the group gutter. Every
   *  consumer (column width, timeline x-origin, ruler corner) reads this, so the
   *  whole column widens by the gutter and faders stay the same width. */
  get headerWidth(): number {
    return this.headerBaseWidth + this.groupGutterWidth;
  }

  setHeaderWidth(total: number) {
    // The drag handle sits at the column's right edge (= total). Resize the
    // CONTENT; the gutter is additive and not user-resizable.
    this.headerBaseWidth = Math.max(120, Math.min(380, Math.round(total - this.groupGutterWidth)));
    this.requestLayoutSave();
  }

  /** The ancestor-or-self group whose nesting line occupies gutter column `depth`
   *  for the row `trackId` — used to select a group by clicking its line. */
  ancestorGroupAtDepth(trackId: string, depth: number): string | null {
    let t = this.trackById(trackId);
    while (t && this.trackDepth(t) > depth) {
      t = t.parentId ? this.trackById(t.parentId) : undefined;
    }
    return t && t.kind === 'group' && !this.isMainBus(t) ? t.id : null;
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
  compositeLayersAtBeat(beat: number, ignoreSolo = false): CompositeLayer[] {
    const tracks = this.composition.tracks.filter((t) => t.kind === 'track');
    // Solo on ANY track or group restricts the mix to soloed lineages — unless the
    // caller (e.g. the exporter's "ignore solo") asks for the full mix.
    const anySolo = !ignoreSolo && this.composition.tracks.some((t) => t.soloed);
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
        // Track-level blend wins (edited in the track inspector); clip blend is a
        // fallback for clips that set their own.
        blendMode: t.blendMode ?? pick.blendMode ?? 0,
      });
    }
    // `tracks` is already top→bottom; paint in that order so each lower track
    // draws over the one above it (downward sum — bottom-most track on top).
    return layers;
  }

  /** Pick the single active clip on a track at `beat` (latest-started on overlap),
   *  or undefined. Skips empty + bypassed clips. */
  private pickActiveClip(track: Track, beat: number): Clip | undefined {
    let pick: Clip | undefined;
    for (const c of track.clips) {
      if (beat < c.startBeat || beat >= c.startBeat + c.lengthBeat) continue;
      if (!c.source?.url && c.sketch.devices.length === 0) continue; // empty clip
      if (!pick || c.startBeat >= pick.startBeat) pick = c; // latest-started wins
    }
    return !pick || pick.bypassed ? undefined : pick;
  }

  /**
   * The active composite as a TREE (the hierarchical counterpart to
   * {@link compositeLayersAtBeat}). Each group becomes a {@link CompositeNode}
   * whose children render into a sub-image (over the group's `input` base), the
   * group's own FX chain runs over that, and the result composites up — so group
   * effect chains + group opacity/blend act on the whole subtree as a unit. Leaf
   * opacity is the track's OWN level (NOT ancestor-multiplied); the recursion folds
   * in group opacity via each group's blend-up. Respects bypass + solo through the
   * hierarchy, and DROPS groups with no contributing descendants. Top → bottom
   * (downward sum); the main bus is excluded (it pins the bottom and isn't a content
   * group). `ignoreSolo` (the exporter) renders the full mix. */
  compositeTreeAtBeat(beat: number, ignoreSolo = false): CompositeNode[] {
    const anySolo = !ignoreSolo && this.composition.tracks.some((t) => t.soloed);
    const childrenOf = (parentId: string | null) =>
      this.composition.tracks.filter((t) => t.parentId === parentId);

    const build = (track: Track, ancestorSoloed: boolean): CompositeNode | null => {
      if (track.bypassed) return null; // bypassed track/group → drop the subtree
      const soloedHere = ancestorSoloed || !!track.soloed;
      if (track.kind === 'group') {
        if (this.isMainBus(track)) return null; // master bus isn't a content group
        const children: CompositeNode[] = [];
        for (const c of childrenOf(track.id)) {
          const n = build(c, soloedHere);
          if (n) children.push(n);
        }
        if (children.length === 0) return null; // nothing to composite → omit the group
        return {
          type: 'group',
          group: track,
          opacity: Math.max(0, Math.min(1, track.level ?? 1)),
          blendMode: track.blendMode ?? 0,
          input: track.groupInput ?? { mode: 'transparent' },
          children,
        };
      }
      if (track.kind !== 'track') return null; // rails aren't composite layers
      if (anySolo && !soloedHere) return null; // solo restricts to soloed lineages
      const clip = this.pickActiveClip(track, beat);
      if (!clip) return null;
      return {
        type: 'clip',
        clip,
        track,
        opacity: Math.max(0, Math.min(1, track.level ?? 1)),
        blendMode: track.blendMode ?? clip.blendMode ?? 0,
      };
    };

    const roots: CompositeNode[] = [];
    for (const t of childrenOf(null)) {
      const n = build(t, false);
      if (n) roots.push(n);
    }
    return roots;
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

  /** Video clips overlapping [beatStart, beatEnd) on non-bypassed tracks — the
   *  lookahead set the compositor pre-opens + pre-decodes (precache warming). */
  videoClipsInWindow(beatStart: number, beatEnd: number): Clip[] {
    const out: Clip[] = [];
    for (const t of this.composition.tracks) {
      if (t.kind !== 'track') continue;
      if (this.effectiveBypassed(t, this.ancestorsOf(t))) continue;
      for (const c of t.clips) {
        if (!c.source?.url) continue;
        if (c.startBeat < beatEnd && c.startBeat + c.lengthBeat > beatStart) out.push(c);
      }
    }
    return out;
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

  // ── 2D caret + derived time-region selection ──────────────────────────

  /** Tracks the caret indexes over (the vertical axis): plain tracks AND rail/return
   *  tracks, in render order. Rails carry no clips or automation lanes, so they each
   *  contribute exactly one caret row — but they DO participate in selection + the
   *  time box, matching how the grid hit-tests their rows. Groups stay excluded. */
  private get caretTrackOrder(): Track[] {
    // Groups are first-class caret rows too (so a click/drag on a group lane targets
    // the GROUP, not the track above — and group automation lanes have a home). The
    // master bus stays out. `caretTrackIds` expands group rows to their tracks.
    return this.displayTracks.filter(
      (t) => t.kind === 'track' || t.kind === 'rail' || (t.kind === 'group' && !this.isMainBus(t)),
    );
  }

  /** Lane shown AS the track's clip-row overlay (its selected-field lane, in
   *  automation mode) — that row edits this lane, so it isn't also a lane row. */
  overlayLaneId(trackId: string): string {
    if (!this.automationMode) return '';
    return this.selectedTrackLane(trackId)?.id ?? '';
  }

  /** The vertical ROW axis: each plain track's clip row, then its automation lane
   *  rows (in automation mode). In automation mode the clip row carries the
   *  track's overlay lane id (its selected-field lane), so clicking/arrowing it
   *  edits that automation; that lane is skipped from the lane rows below. */
  get caretRows(): Array<{ trackId: string; laneId: string }> {
    const rows: Array<{ trackId: string; laneId: string }> = [];
    for (const t of this.caretTrackOrder) {
      const overlay = this.overlayLaneId(t.id);
      rows.push({ trackId: t.id, laneId: overlay });
      if (this.automationMode) {
        for (const lane of t.automation) {
          if (lane.id === overlay) continue;
          rows.push({ trackId: t.id, laneId: lane.id });
        }
      }
    }
    return rows;
  }

  /** The rows the caret spans (anchor→head, inclusive). Empty ⇒ a GLOBAL span. */
  caretRowSpan(): Array<{ trackId: string; laneId: string }> {
    if (!this.caretAnchorTrackId && !this.caretHeadTrackId) return [];
    const rows = this.caretRows;
    const eq = (r: { trackId: string; laneId: string }, t: string, l: string) => r.trackId === t && r.laneId === l;
    const ai = rows.findIndex((r) => eq(r, this.caretAnchorTrackId, this.caretAnchorLaneId));
    const hi = rows.findIndex((r) => eq(r, this.caretHeadTrackId, this.caretHeadLaneId));
    if (ai < 0 && hi < 0) return [];
    if (ai < 0) return [rows[hi]];
    if (hi < 0) return [rows[ai]];
    return rows.slice(Math.min(ai, hi), Math.max(ai, hi) + 1);
  }

  /** The single lane the caret is scoped to (head + anchor on the SAME lane), or
   *  null ⇒ clip mode. Gates clip ops + scopes envelope-region edits. */
  get caretLaneId(): string | null {
    return this.caretHeadLaneId && this.caretHeadLaneId === this.caretAnchorLaneId ? this.caretHeadLaneId : null;
  }

  /** Automation-lane ids the caret span touches (for the lane cursor/highlight). */
  get caretLaneIds(): string[] {
    return this.caretRowSpan().filter((r) => r.laneId).map((r) => r.laneId);
  }

  /** Ordered plain-track ids the caret spans via CLIP rows (lanes contribute no
   *  clips). Empty anchor+head ⇒ a GLOBAL span (every plain track). */
  get caretTrackIds(): string[] {
    if (!this.caretAnchorTrackId && !this.caretHeadTrackId) return [];
    const raw: string[] = [];
    for (const r of this.caretRowSpan()) if (r.laneId === '' && !raw.includes(r.trackId)) raw.push(r.trackId);
    // A group row in the span stands in for ALL the tracks it contains (groups hold
    // no clips of their own; selecting one acts on everything inside, collapsed or
    // not). Expand groups to their descendant tracks in array order, dropping the
    // group ids themselves; plain tracks/rails pass through.
    const out: string[] = [];
    const push = (id: string) => { if (!out.includes(id)) out.push(id); };
    for (const id of raw) {
      const t = this.trackById(id);
      if (t && t.kind === 'group') {
        for (const d of this.composition.tracks) {
          if (d.kind === 'track' && this.isAncestorTrack(id, d.id)) push(d.id);
        }
      } else {
        push(id);
      }
    }
    return out;
  }

  /** A non-degenerate time box exists only when the caret has time width. */
  get hasTimeSelection(): boolean {
    return Math.abs(this.caretAnchorBeat - this.playFromBeat) > 1e-6;
  }
  get timeSelStart(): number | null {
    return this.hasTimeSelection ? Math.min(this.caretAnchorBeat, this.playFromBeat) : null;
  }
  get timeSelEnd(): number {
    return Math.max(this.caretAnchorBeat, this.playFromBeat);
  }
  get timeSelTrackIds(): string[] {
    return this.caretTrackIds;
  }

  /** Tracks the region applies to (empty span = every plain track). */
  private regionTracks(): Track[] {
    const scope = this.caretTrackIds;
    return this.composition.tracks.filter(
      (t) => t.kind === 'track' && (scope.length === 0 || scope.includes(t.id)),
    );
  }

  /**
   * Primary caret API: set the head (current time/track) + anchor. The time box
   * and play-from are derived. Track ids `''` ⇒ a global vertical span.
   */
  setCaret(opts: {
    anchorBeat: number; anchorTrackId: string; headBeat: number; headTrackId: string;
    anchorLaneId?: string; headLaneId?: string;
  }) {
    runInAction(() => {
      this.caretAnchorBeat = Math.max(0, opts.anchorBeat);
      this.caretAnchorTrackId = opts.anchorTrackId;
      this.caretHeadTrackId = opts.headTrackId;
      this.caretAnchorLaneId = opts.anchorLaneId ?? '';
      this.caretHeadLaneId = opts.headLaneId ?? '';
      this.playFromBeat = Math.max(0, opts.headBeat);
      if (!this.playing) this.positionBeat = this.playFromBeat;
    });
  }

  setTimeSelection(start: number, end: number, trackIds: string[] = [], opts?: { movePlayhead?: boolean }) {
    const movePlayhead = opts?.movePlayhead ?? true;
    runInAction(() => {
      this.caretAnchorTrackId = trackIds[0] ?? '';
      this.caretHeadTrackId = trackIds[trackIds.length - 1] ?? '';
      this.caretAnchorLaneId = '';
      this.caretHeadLaneId = ''; // clip-row selection
      if (movePlayhead) {
        // Map the [start,end] × trackIds box onto the caret (anchor=start, head=end).
        this.caretAnchorBeat = Math.max(0, Math.min(start, end));
        this.playFromBeat = Math.max(start, end);
        if (!this.playing) this.positionBeat = this.playFromBeat;
      } else {
        // Select the FULL region and move the caret (anchor at the far end, head/
        // play-from at the start) WITHOUT moving the visible playhead. Selecting a
        // track still selects all its time; only `positionBeat` is left untouched.
        this.caretAnchorBeat = Math.max(0, Math.max(start, end));
        this.playFromBeat = Math.max(0, Math.min(start, end));
        // (intentionally NOT touching this.positionBeat)
      }
    });
  }

  clearTimeSelection() {
    runInAction(() => {
      // Collapse the box to a caret at the head (keeps the head's track + lane).
      this.caretAnchorBeat = this.playFromBeat;
      this.caretAnchorTrackId = this.caretHeadTrackId;
      this.caretAnchorLaneId = this.caretHeadLaneId;
    });
  }

  // ── Caret keyboard navigation ──────────────────────────────────────────
  /** Select what's under the caret head: on a lane row nothing (the caret marks
   *  the lane); on a clip row a clip if present, else the track. */
  selectUnderCaret() {
    if (this.caretHeadLaneId) { this.clearSelection(); return; }
    const tid = this.caretHeadTrackId;
    if (!tid) { this.clearSelection(); return; }
    const clip = this.clipAtBeat(tid, this.playFromBeat);
    this.selectClipOnly(clip ? paths.clip(tid, clip.id) : paths.track(tid));
  }

  /** One grid step left/right from `from`: snaps off-grid positions to the grid
   *  in the move direction, else advances a full step. */
  private caretStepBeat(from: number, dir: -1 | 1): number {
    const s = this.snapStep;
    const snapped = Math.round(from / s) * s;
    if (dir > 0) return snapped > from + 1e-6 ? snapped : snapped + s;
    return snapped < from - 1e-6 ? snapped : Math.max(0, snapped - s);
  }

  /** Nearest clip start/end (event) across the caret's tracks, in `dir`. */
  private nextEventBeat(from: number, dir: -1 | 1): number {
    const events = new Set<number>();
    for (const t of this.regionTracks()) {
      for (const c of t.clips) { events.add(c.startBeat); events.add(c.startBeat + c.lengthBeat); }
    }
    const sorted = [...events].sort((a, b) => a - b);
    if (dir > 0) {
      for (const e of sorted) if (e > from + 1e-6) return e;
      return from;
    }
    for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i] < from - 1e-6) return sorted[i];
    return 0;
  }

  /**
   * Move the caret head horizontally. `extend` keeps the anchor (grow/shrink the
   * box like a Shift-drag); otherwise the caret collapses to a point and selects
   * what's under it. `toEvent` jumps to the next/prev clip edge.
   */
  caretMoveHorizontal(dir: -1 | 1, opts: { extend?: boolean; toEvent?: boolean } = {}) {
    const head = opts.toEvent
      ? this.nextEventBeat(this.playFromBeat, dir)
      : this.caretStepBeat(this.playFromBeat, dir);
    this.setCaret({
      anchorBeat: opts.extend ? this.caretAnchorBeat : head,
      anchorTrackId: opts.extend ? this.caretAnchorTrackId : this.caretHeadTrackId,
      anchorLaneId: opts.extend ? this.caretAnchorLaneId : this.caretHeadLaneId,
      headBeat: head,
      headTrackId: this.caretHeadTrackId,
      headLaneId: this.caretHeadLaneId,
    });
    if (opts.extend) this.selectClipsInCaret();
    else this.selectUnderCaret();
  }

  /** Move the caret head one ROW up/down (tracks AND their automation lanes).
   *  `extend` grows the vertical slice. */
  caretMoveVertical(dir: -1 | 1, extend = false) {
    const rows = this.caretRows;
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.trackId === this.caretHeadTrackId && r.laneId === this.caretHeadLaneId);
    if (i < 0) i = 0;
    const head = rows[Math.max(0, Math.min(rows.length - 1, i + dir))];
    this.setCaret({
      anchorBeat: extend ? this.caretAnchorBeat : this.playFromBeat,
      anchorTrackId: extend ? this.caretAnchorTrackId : head.trackId,
      anchorLaneId: extend ? this.caretAnchorLaneId : head.laneId,
      headBeat: this.playFromBeat,
      headTrackId: head.trackId,
      headLaneId: head.laneId,
    });
    if (extend) this.selectClipsInCaret();
    else this.selectUnderCaret();
  }

  /** Select every clip overlapping the current region (in scope tracks). */
  /**
   * Select the clips the caret intersects: within a time box, clips overlapping
   * [start,end); as a vertical slice, clips containing the head beat — on the
   * caret's track span either way. Empty span selects nothing.
   */
  selectClipsInCaret() {
    if (this.caretLaneId) { this.setSelection([]); return; } // on an automation lane → no clips
    const scopeIds = this.caretTrackIds;
    if (!scopeIds.length) { this.setSelection([]); return; }
    const box = this.hasTimeSelection;
    const start = box ? this.timeSelStart! : this.playFromBeat;
    const end = box ? this.timeSelEnd : this.playFromBeat;
    const found: string[] = [];
    for (const t of this.regionTracks()) {
      for (const c of t.clips) {
        const cEnd = c.startBeat + c.lengthBeat;
        const hit = box
          ? cEnd > start + 1e-6 && c.startBeat < end - 1e-6
          : c.startBeat <= start + 1e-6 && cEnd > start + 1e-6;
        if (hit) found.push(paths.clip(t.id, c.id));
      }
    }
    this.setSelection(found);
  }
  /** @deprecated use selectClipsInCaret. */
  selectClipsInRegion() {
    this.selectClipsInCaret();
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
    // NOTE: don't early-return on a zero delta. During a coalesced drag every
    // frame reverts to the gesture's base then re-applies; a zero-delta frame
    // (the clip dragged back to EXACTLY its start) must run so it returns to base
    // — bailing here would strand the clip one step out.
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

    // 3. The caret/box follows the moved content (live UI state).
    runInAction(() => {
      const movedScope = scopeIds.length ? scope.map(destFor) : [];
      this.caretAnchorBeat = Math.max(0, a + deltaBeat);
      this.playFromBeat = this.caretAnchorBeat + (b - a);
      this.caretAnchorTrackId = movedScope[0] ?? '';
      this.caretHeadTrackId = movedScope[movedScope.length - 1] ?? '';
    });
  }

  /**
   * Cmd-drag duplicate of a TIME BOX (possibly partial clip slices across several
   * tracks): COPY the in-box slices to the shifted location, leaving the originals
   * intact. Mirrors moveTimeBoxContent but (a) never removes the source clips and
   * (b) slices a deep copy so the source isn't even fragmented. Coalesced under one
   * key so a whole drag is ONE undo; the box/caret stay on the source.
   */
  copyTimeBoxContent(
    deltaBeat: number,
    trackDelta = 0,
    base?: { start: number; end: number; scope: string[] },
  ) {
    const a = base ? base.start : this.timeSelStart!;
    const b = base ? base.end : this.timeSelEnd;
    if (a == null || b <= a) return;
    const scopeIds = base ? base.scope : [...this.timeSelTrackIds];
    const plainIds = this.composition.tracks.filter((t) => t.kind === 'track').map((t) => t.id);
    const scope = scopeIds.length ? scopeIds : plainIds;
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
      'duplicate time selection',
      (d) => {
        const pieces: Array<{ destId: string; clip: Clip }> = [];
        for (const track of d.tracks) {
          if (!scope.includes(track.id)) continue;
          // Slice a DEEP COPY at the box edges so the source track is untouched.
          const tmp = { clips: JSON.parse(JSON.stringify(track.clips)) } as Track;
          splitClipsAt(tmp, a);
          splitClipsAt(tmp, b);
          const inBox = (c: Clip) => c.startBeat >= a - 1e-6 && c.startBeat < b - 1e-6;
          for (const c of tmp.clips.filter(inBox)) {
            const m: Clip = JSON.parse(JSON.stringify(c));
            m.id = uid('clip');
            freshClipIds(m);
            m.startBeat = Math.max(0, c.startBeat + deltaBeat);
            pieces.push({ destId: destFor(track.id), clip: m });
          }
        }
        for (const { destId, clip } of pieces) {
          const dt = d.tracks.find((t) => t.id === destId);
          if (!dt) continue;
          carveTrackSpan(dt, clip.id, clip.startBeat, clip.startBeat + clip.lengthBeat);
          dt.clips.push(clip);
        }
      },
      'copy-time-box',
    );
  }

  /**
   * Slide the caret + (when paused) the playhead by `deltaBeat` from a captured base,
   * so they keep their position relative to content dragged underneath them. Track ids
   * are left as-is (a clip drag's box-follow sets those). Used during clip-move drags.
   */
  slideCaret(base: { anchorBeat: number; headBeat: number; posBeat: number }, deltaBeat: number) {
    runInAction(() => {
      this.caretAnchorBeat = Math.max(0, base.anchorBeat + deltaBeat);
      this.playFromBeat = Math.max(0, base.headBeat + deltaBeat);
      if (!this.playing) this.positionBeat = Math.max(0, base.posBeat + deltaBeat);
    });
  }

  /**
   * Split at the caret: with a time box, split every in-scope clip at both edges;
   * with just the caret (a vertical slice), split at the head beat. Only the
   * caret's track span is affected (a slice spanning tracks 2–4 cuts only those).
   */
  splitAtCursor() {
    if (this.caretLaneId) return; // clip split doesn't apply on an automation lane
    const scope = this.regionTracks().map((t) => t.id);
    if (scope.length === 0) return;
    const edges = this.hasTimeSelection ? [this.timeSelStart!, this.timeSelEnd] : [this.playFromBeat];
    this.mutate('split', (d) => {
      for (const track of d.tracks) {
        if (!scope.includes(track.id)) continue;
        for (const edge of edges) splitClipsAt(track, edge);
      }
    });
  }
  /** @deprecated kept for callers — splits at the caret/region. */
  splitAtRegion() {
    this.splitAtCursor();
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
      // Collapse the caret to the cut point (box closes).
      this.caretAnchorBeat = start;
      this.playFromBeat = start;
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
    this.insertTimeSpan(this.timeSelStart!, this.timeSelEnd - this.timeSelStart!);
  }

  /** Insert `span` blank beats at `start` across every plain track (ripple). */
  insertTimeSpan(start: number, span: number) {
    if (span <= 1e-6) return;
    this.mutate('insert time', (d) => {
      for (const track of d.tracks) {
        if (track.kind !== 'track') continue;
        splitClipsAt(track, start);
        for (const c of track.clips) if (c.startBeat >= start - 1e-6) c.startBeat += span;
      }
    });
  }

  // ── Clip clipboard (copy / cut / paste, + time variants) ───────────────
  /** True when the clipboard has clips to paste. */
  get hasClipboard(): boolean {
    return !!this.clipClipboard && this.clipClipboard.items.length > 0;
  }

  /**
   * Copy the clips under the caret to the clipboard: a time box copies the
   * trimmed SLICES of overlapping clips; otherwise the whole selected clips.
   * Offsets are stored relative to the copy origin (top track, earliest beat).
   */
  copyClips(): boolean {
    const order = this.caretTrackOrder;
    const items: Array<{ trackOffset: number; startBeat: number; clip: Clip }> = [];
    let span = 0;
    if (this.hasTimeSelection) {
      const start = this.timeSelStart!;
      const end = this.timeSelEnd;
      span = end - start;
      const scope = this.regionTracks();
      const originIdx = scope.length ? order.findIndex((t) => t.id === scope[0].id) : 0;
      for (const t of scope) {
        const ti = order.findIndex((x) => x.id === t.id);
        for (const c of t.clips) {
          const s = Math.max(c.startBeat, start);
          const e = Math.min(c.startBeat + c.lengthBeat, end);
          if (e <= s + 1e-6) continue;
          const slice: Clip = JSON.parse(JSON.stringify(c));
          slice.startBeat = s;
          slice.lengthBeat = e - s;
          items.push({ trackOffset: ti - originIdx, startBeat: s - start, clip: slice });
        }
      }
    } else {
      const sel = [...this.selection]
        .map((p) => this.clipByPath(p))
        .filter((x): x is { track: Track; clip: Clip } => !!x);
      if (!sel.length) return false;
      const start = Math.min(...sel.map((x) => x.clip.startBeat));
      span = Math.max(...sel.map((x) => x.clip.startBeat + x.clip.lengthBeat)) - start;
      const idxs = sel.map((x) => order.findIndex((t) => t.id === x.track.id)).filter((i) => i >= 0);
      const originIdx = idxs.length ? Math.min(...idxs) : 0;
      for (const { track, clip } of sel) {
        const ti = order.findIndex((t) => t.id === track.id);
        items.push({ trackOffset: ti - originIdx, startBeat: clip.startBeat - start, clip: JSON.parse(JSON.stringify(clip)) });
      }
    }
    if (!items.length) return false;
    this.clipClipboard = { items, span };
    this.lastClipboardKind = 'clips';
    return true;
  }

  /** Paste the clipboard at the caret head (time + track), carving overlaps. */
  pasteClips() {
    const cb = this.clipClipboard;
    if (!cb) return;
    const order = this.caretTrackOrder;
    if (!order.length) return;
    const atBeat = this.playFromBeat;
    const headIdx = order.findIndex((t) => t.id === this.caretHeadTrackId);
    const atIdx = headIdx >= 0 ? headIdx : 0;
    const pasted: string[] = [];
    this.mutate('paste clips', (d) => {
      for (const item of cb.items) {
        const destTrack = order[atIdx + item.trackOffset];
        if (!destTrack) continue;
        const dt = d.tracks.find((t) => t.id === destTrack.id);
        if (!dt) continue;
        const clip: Clip = JSON.parse(JSON.stringify(item.clip));
        clip.id = uid('clip');
        freshClipIds(clip);
        clip.startBeat = Math.max(0, atBeat + item.startBeat);
        carveTrackSpan(dt, clip.id, clip.startBeat, clip.startBeat + clip.lengthBeat);
        dt.clips.push(clip);
        pasted.push(paths.clip(dt.id, clip.id));
      }
    });
    if (pasted.length) this.setSelection(pasted);
  }

  /** Copy, then remove the source (box → leave empty time; else delete clips). */
  cutClips() {
    if (!this.copyClips()) return;
    if (this.hasTimeSelection) this.clearTime();
    else this.deleteSelectedClips();
  }

  /** Insert blank time the length of the clipboard, then paste (ripple-paste). */
  pasteTime() {
    const cb = this.clipClipboard;
    if (!cb) return;
    this.insertTimeSpan(this.playFromBeat, cb.span);
    this.pasteClips();
  }

  /** Copy the slices/clips, then ripple-delete that time. */
  cutTime() {
    if (!this.copyClips()) return;
    this.deleteTime();
  }

  /** Insert a clone of `source` (fresh id) at its startBeat on `trackId`,
   *  carving overlaps. Used by Cmd-drag duplicate to restore the source clip. */
  insertClipClone(trackId: string, source: Clip) {
    this.mutate('duplicate clip', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t || t.kind !== 'track') return;
      const clip: Clip = JSON.parse(JSON.stringify(source));
      clip.id = uid('clip');
      freshClipIds(clip);
      carveTrackSpan(t, clip.id, clip.startBeat, clip.startBeat + clip.lengthBeat);
      t.clips.push(clip);
    });
  }

  /**
   * Cmd-drag duplicate of a SINGLE clip: drop a fresh clone of `source` at
   * (`destTrackId`, `beat`), leaving the original untouched. Driven per-frame
   * during the drag under one `coalesceKey`, so the whole gesture is ONE undo and
   * the copy tracks the cursor (the original never moves — a true copy).
   */
  insertClipCopyAt(source: Clip, destTrackId: string, beat: number, coalesceKey?: string) {
    this.mutate('duplicate clip', (d) => {
      const t = d.tracks.find((x) => x.id === destTrackId);
      if (!t || t.kind !== 'track') return;
      const clip: Clip = JSON.parse(JSON.stringify(source));
      clip.id = uid('clip');
      freshClipIds(clip);
      clip.startBeat = Math.max(0, beat);
      carveTrackSpan(t, clip.id, clip.startBeat, clip.startBeat + clip.lengthBeat);
      t.clips.push(clip);
    }, coalesceKey);
  }

  /** Solo the focused track, else the caret's head track. */
  soloShortcut() {
    const tid = this.primaryPath?.startsWith('track/')
      ? this.primaryPath.split('/')[1]
      : this.caretHeadTrackId;
    if (tid) this.toggleSolo(tid);
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
      // A horizontal scrub (ruler/transport) collapses any time box to a caret,
      // keeping the head's vertical track span.
      this.caretAnchorBeat = this.playFromBeat;
      if (!this.playing) this.positionBeat = this.playFromBeat;
    });
  }
  toggleLoop() {
    this.loopEnabled = !this.loopEnabled;
    this.persistLoop();
  }

  /**
   * Write the current loop markers into `composition.loop` and schedule a save.
   * Deliberately NOT routed through `mutate()`: loop is a transport preference,
   * not a document edit, so it must add NO undo/redo entry — but it IS persisted
   * with the file. `mobxSet` makes the (possibly fresh) key observable so it
   * survives `toJS`/serialization.
   */
  private persistLoop() {
    mobxSet(this.composition as object, 'loop', {
      enabled: this.loopEnabled,
      startBeat: this.loopStartBeat,
      endBeat: this.loopEndBeat,
    });
    this.requestSave();
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
          this.persistLoop();
          return;
        }
      }
      this.loopEnabled = !this.loopEnabled;
      this.persistLoop();
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
    this.mutate(
      'set BPM',
      (d) => {
        const old = d.meta.baseBPM;
        d.meta.baseBPM = v;
        if (old <= 0 || Math.abs(old - v) < 1e-9) return;
        // Ableton warp-off behaviour: a one-shot clip holds a FIXED real-seconds slice
        // of video, so its length in BEATS scales with tempo (more beats at higher BPM).
        // time/beat-sync clips keep their length (loop count / speed re-derive on read).
        // Coalescing reverts to base before re-running, so this stays absolute.
        const ratio = v / old;
        for (const t of d.tracks) {
          let reflowed = false;
          for (const c of t.clips) {
            if (c.kind === 'video' && c.loop?.mode === 'one-shot') {
              c.lengthBeat = Math.max(0.5, c.lengthBeat * ratio);
              reflowed = true;
            }
          }
          // Lengthening may overlap later clips: keep starts, trim ends.
          if (reflowed && ratio > 1) resolveOverlapsKeepStarts(t);
        }
      },
      'meta:bpm',
    );
  }
  setResolution(width: number, height: number) {
    this.mutate('set resolution', (d) => { d.meta.resolution = { width, height }; }, 'meta:res');
  }

  /** The composition's frame rate (composition setting; edited in Settings). */
  get compositionFps(): number { return fnCompositionFps(this.composition); }
  setCompositionFps(fps: number) {
    const v = Math.max(1, Math.min(240, Math.round(fps)));
    this.mutate('set fps', (d) => { d.meta.fps = v; }, 'meta:fps');
  }
  /** Effective EXPORT frame rate (the composition fps, or a custom override). */
  get exportFps(): number { return fnExportFps(this.composition); }

  /** Persisted export settings (resolution mode, quality, range), defaults filled. */
  get exportSettings(): ExportSettings { return exportSettings(this.composition); }
  /** Effective export pixel dimensions for the current resolution mode. */
  get exportResolution(): { width: number; height: number } { return exportResolution(this.composition); }
  /** Patch the persisted export settings (saved on the composition). */
  setExportSettings(patch: Partial<ExportSettings>) {
    this.mutate('export settings', (d) => {
      const cur = { ...DEFAULT_EXPORT_SETTINGS, ...(d.meta.export ?? {}) };
      d.meta.export = { ...cur, ...patch };
    }, 'meta:export');
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

  /** Delete a rail wire by id (`w:<id>` export / `r:<id>` read). Undoable. */
  deleteWire(wireId: string) {
    const kind = wireId[0];
    const id = wireId.slice(2);
    this.mutate('delete wire', (d) => {
      for (const t of d.tracks) {
        for (const c of t.clips) {
          if (kind === 'w') {
            c.exports = (c.exports ?? []).filter((x) => x.id !== id);
          } else if (kind === 'r') {
            c.reads = (c.reads ?? []).filter((x) => x.id !== id);
          }
        }
      }
    });
    if (this.selectedWireId === wireId) this.selectedWireId = null;
    if (this.tapPopup?.wireId === wireId) this.closeTapPopup();
  }

  /** Delete the currently-selected rail wire, if any. Returns true if it acted. */
  deleteSelectedWire(): boolean {
    if (!this.selectedWireId) return false;
    this.deleteWire(this.selectedWireId);
    return true;
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
      name: '#',
      startBeat: Math.max(0, startBeat),
      lengthBeat,
      kind: 'effect',
      sketch: { devices: [] },
      loop: defaultClipLoop(),
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
    media: { sourceKey: string; url: string; frameCount: number; fps?: number; label?: string; width?: number; height?: number },
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
        width: media.width,
        height: media.height,
      },
      loop: defaultClipLoop(media.fps ? media.frameCount / media.fps : undefined),
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

  /** Adjust a clip's source placement transform (anchor / scale / rotation / flip).
   *  `coalesceKey` groups a drag gesture into one undo entry (default: per clip). */
  setClipSourceTransform(
    trackId: string, clipId: string, patch: Partial<SourceTransform>, coalesceKey?: string,
  ) {
    this.mutate(
      'adjust source placement',
      (d) => {
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (!c?.source) return;
        c.source.transform = { ...resolveSourceTransform(c.source.transform), ...patch };
      },
      coalesceKey ?? `xform:${clipId}`,
    );
  }

  /**
   * Point an existing clip at a (possibly new) video source — used by the clip
   * inspector's drop zone. An effect/empty clip is CONVERTED to a video clip (a
   * `source.video.file` device is prepended); an existing video clip just swaps its
   * media (the pump re-opens on the sourceKey/url change). The clip's span is kept;
   * pass `lengthBeat` to also resize it (e.g. to the new media's duration).
   */
  setClipSource(
    trackId: string, clipId: string,
    media: { sourceKey: string; url: string; frameCount: number; fps?: number; label?: string; width?: number; height?: number },
    lengthBeat?: number,
  ) {
    this.mutate('set clip source', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      const c = t?.clips.find((x) => x.id === clipId);
      if (!t || !c) return;
      const label = media.label ?? c.name ?? 'Video';
      c.kind = 'video';
      // Preserve any existing scale mode + placement transform across a swap.
      c.source = {
        label,
        durationFrames: media.frameCount,
        sourceKey: media.sourceKey,
        url: media.url,
        fps: media.fps,
        width: media.width,
        height: media.height,
        scaleMode: c.source?.scaleMode,
        transform: c.source?.transform,
      };
      if (!c.sketch.devices.some((dv) => dv.moduleType === 'source.video.file')) {
        c.sketch.devices.unshift({
          id: uid('dev'), moduleType: 'source.video.file', name: label, capabilities: ['source'],
        });
      }
      if (lengthBeat && lengthBeat > 0) {
        c.lengthBeat = lengthBeat;
        carveTrackSpan(t, c.id, c.startBeat, c.startBeat + c.lengthBeat);
      }
    });
    this.select(paths.clip(trackId, clipId));
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
    // Rail / return endpoint: one side is a rail, the other a device field. An OUTPUT
    // field becomes a rail EXPORT (writes the rail); an INPUT field becomes a rail READ.
    const rail = a.railId ? a : b.railId ? b : null;
    if (rail) {
      const field = rail === a ? b : a;
      if (!field.railId) this.connectFieldToRail(field, rail.railId!);
      return;
    }
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

  /** Connect a clip device field to a return rail: an output field exports to the
   *  rail, an input field reads from it. Rail taps live on the clip (exports/reads),
   *  so this only applies to a clip sketch (`clip/<trk>/<clip>`). */
  private connectFieldToRail(field: FieldConnectInfo, railId: string) {
    if (!field.sketchId.startsWith('clip/')) return;
    const [, trackId, clipId] = field.sketchId.split('/');
    this.mutate('connect rail', (d) => {
      const clip = d.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId);
      const dev = clip?.sketch.devices[field.chainIdx];
      if (!clip || !dev) return;
      if (field.isOutput) {
        clip.exports = (clip.exports ?? []).filter(
          (e) => !(e.railId === railId && e.sourceDeviceId === dev.id && e.sourceField === field.fieldPath));
        clip.exports.push({
          id: uid('rail'), railId, sourceDeviceId: dev.id, sourceField: field.fieldPath,
          combine: 'add', magnitude: 'auto',
        });
      } else {
        // One read per destination field — replace any existing read into it.
        clip.reads = (clip.reads ?? []).filter(
          (r) => !(r.targetDeviceId === dev.id && r.targetField === field.fieldPath));
        clip.reads.push({
          id: uid('rail'), railId, targetDeviceId: dev.id, targetField: field.fieldPath,
          combine: 'add', magnitude: 'auto',
        });
      }
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
    const pick = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
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
    let start = Math.max(0, newStartBeat);
    let len = Math.max(0.5, newLengthBeat);
    this.mutate(
      'resize clip',
      (d) => {
        const t = d.tracks.find((t) => t.id === trackId);
        const c = t?.clips.find((x) => x.id === clipId);
        if (t && c) {
          const oldLen = c.lengthBeat;
          // The gesture re-runs this recipe from its base each tick, so c.startBeat /
          // c.loop.startSec here are the PRE-resize values — couplings below compute
          // absolute targets from them (never increment).
          const end0 = start + len; // the edge the drag is holding fixed
          this.applyResizeTiming(c, d.meta.baseBPM, start, end0, (s, l) => {
            start = s;
            len = l;
          });
          c.startBeat = start;
          c.lengthBeat = len;
          carveTrackSpan(t, clipId, start, start + len);
          // Pin automation to BEATS (clip mode): the editor span = clip length, so
          // rescale interior nodes by oldLen/newLen to hold their clip-beat. The
          // 0/1 endpoints stay (they track the clip boundaries). Nodes pushed past
          // the range are left (spec), not clamped.
          if (this.clipAutoTiming === 'clip' && oldLen > 1e-6 && Math.abs(oldLen - len) > 1e-6) {
            const k = oldLen / len;
            for (const lane of c.automation) {
              for (const pt of lane.points) {
                if (pt.x <= 1e-6 || pt.x >= 1 - 1e-6) continue; // keep pinned endpoints
                pt.x = pt.x * k;
              }
            }
          }
        }
      },
      `resize:${trackId}:${clipId}`,
    );
    // The COMMITTED edges after clamping (one-shot caps length so the end never runs
    // past the file; left-trim caps the start at frame 0) — callers drive the caret
    // from these so it stops with the clip rather than the raw pointer.
    return { start, len };
  }

  /**
   * Manual-resize timing coupling for video clips (no-op for other clips).
   *  - one-shot: LEFT-edge trim moves the slice start (`loop.startSec`) so the content
   *    stays pinned, capped at the source start (startSec ≥ 0 ⇒ the edge stops at
   *    frame 0); length is capped so the end-into-source never runs past the file.
   *  - time / beat-sync: LEFT-edge trim moves the play-start (`loop.playStartSec`),
   *    WRAPPED within the loop, so the LOOP boundaries stay fixed on the timeline (the
   *    brace startSec/endSec is untouched) without the drag ever creating a pre-roll. A
   *    pre-roll the user already set is expanded/contracted linearly instead of wrapped.
   * Linear in tempo (warp-ignored) — exact at neutral warp. `c` is the gesture-BASE
   * draft (startBeat / loop fields are pre-drag), so targets below are absolute.
   */
  private applyResizeTiming(
    c: Clip,
    bpm: number,
    start: number,
    end: number,
    emit: (start: number, len: number) => void,
  ) {
    const spb = 60 / Math.max(1, bpm);
    const oldStartBeat = c.startBeat;
    const dBeats = start - oldStartBeat;

    if (c.kind === 'video' && c.loop?.mode === 'one-shot') {
      const fps = c.source?.fps && c.source.fps > 0 ? c.source.fps : 30;
      const videoDurSec = c.source ? c.source.durationFrames / fps : Infinity;
      const speed = c.loop.speed ?? 1;
      const oldStartSec = c.loop.startSec ?? 0;
      let startSec = oldStartSec;
      if (Math.abs(dBeats) > 1e-6 && speed > 1e-6) {
        const raw = oldStartSec + dBeats * spb * speed;
        if (raw < 0) {
          start = Math.max(0, oldStartBeat - oldStartSec / (spb * speed));
          startSec = 0;
        } else {
          startSec = raw;
        }
      }
      let len = Math.max(0.5, end - start);
      if (Number.isFinite(videoDurSec) && speed > 1e-6) {
        const maxLen = (videoDurSec - startSec) / (speed * spb);
        len = Math.max(0.5, Math.min(len, maxLen));
      }
      c.loop.startSec = startSec;
      emit(start, len);
      return;
    }

    if (c.kind === 'video' && (c.loop?.mode === 'time' || c.loop?.mode === 'beat-sync') && Math.abs(dBeats) > 1e-6) {
      const loopStart = c.loop.startSec ?? 0;
      const fps = c.source?.fps && c.source.fps > 0 ? c.source.fps : 30;
      const loopEnd = c.loop.endSec ?? (c.source ? c.source.durationFrames / fps : loopStart);
      const loopLen = loopEnd - loopStart;
      // Source-seconds consumed per beat (how fast the playhead moves into the source).
      let perBeat: number;
      if (c.loop.mode === 'beat-sync') {
        const videoBeats = c.loop.syncUseBpm ? loopLen * ((c.loop.syncBpm ?? 120) / 60) : c.loop.syncBeats ?? 4;
        perBeat = videoBeats > 1e-9 ? loopLen / videoBeats : 0;
      } else {
        perBeat = (c.loop.speed ?? 1) * spb;
      }
      // Shift the play-start by the same amount the left edge moved → loops stay put.
      // `base` is the gesture-base value (constant for the whole drag), so the
      // pre-roll/no-pre-roll branch never flips mid-drag (no round-off flicker).
      const base = c.loop.playStartSec ?? loopStart;
      const linear = base + perBeat * dBeats;
      if (loopLen > 1e-9) {
        const wrap = (x: number) => loopStart + (((x - loopStart) % loopLen) + loopLen) % loopLen;
        if (base < loopStart - 1e-6) {
          // An existing (user-set) pre-roll: expand/contract it linearly so it's not
          // destroyed; if it contracts back into the loop, fold so we never overrun.
          c.loop.playStartSec = linear >= loopStart ? wrap(linear) : linear;
        } else {
          // No pre-roll: WRAP within the loop — keeps the loops anchored AND never
          // creates a pre-roll by dragging (those are user-configured only).
          c.loop.playStartSec = wrap(linear);
        }
      } else {
        c.loop.playStartSec = linear;
      }
    }
    emit(start, Math.max(0.5, end - start));
  }

  /** Patch a clip's play-mode timing (mode / slice seconds / speed / direction / …).
   *  Undoable; shallow-merges so a single field can change without clobbering the rest. */
  updateClipLoop(trackId: string, clipId: string, patch: Partial<ClipLoopConfig>) {
    // Coalesce key is scoped to the PATCHED fields so a slider scrub of one field
    // folds into one undo, but editing a different field is its own step (a shallow
    // patch isn't absolute, so coalescing across fields would clobber the others).
    const fields = Object.keys(patch).sort().join(',');
    this.mutate(
      'clip play mode',
      (d) => {
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (c) c.loop = { ...c.loop, ...patch };
      },
      `loop:${trackId}:${clipId}:${fields}`,
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
    return t.kind === 'group' && t.id === MAIN_BUS_ID;
  }

  /**
   * Insert a new empty track immediately after `afterTrackId` in the array (or
   * at the end when omitted). The main bus pins to the bottom via `displayTracks`
   * regardless of array position, so this never needs special bus handling.
   * Returns the new track id and selects it.
   */
  addTrack(afterTrackId?: string, parentId: string | null = null): string {
    const id = uid('trk');
    const track: Track = {
      id,
      name: 'Track #',
      kind: 'track',
      parentId,
      color: 'var(--app-cat-source)',
      level: 1, // start fully opaque (the mixer fader defaults undefined → 85%)
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
      d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks); // keep groups contiguous
    });
    this.select(paths.track(id));
    return id;
  }

  /** Last track in canonical order that sits inside `groupId` (its deepest/last child). */
  private lastDescendantId(groupId: string): string | null {
    let last: string | null = null;
    for (const t of this.composition.tracks) {
      if (!this.isMainBus(t) && this.isAncestorTrack(groupId, t.id)) last = t.id;
    }
    return last;
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
      // Rest at 0 — unsigned reads it as the floor (writers add up from it), signed as
      // the centre. A 0.5 default would centre the lane at rest AND clip on +add.
      baseCurve: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    };
    this.mutate('add return', (d) => {
      const busIdx = d.tracks.findIndex((t) => ArrangementStore.isMainBusTrack(t));
      const idx = busIdx >= 0 ? busIdx : d.tracks.length;
      d.tracks.splice(idx, 0, track);
      d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks);
    });
    this.select(paths.track(id));
    return id;
  }

  /**
   * "+ Group" affordance. With NO track selection, create a group containing one
   * fresh empty track. With tracks selected, create a group and move those tracks
   * (each with its whole subtree) into it. The group is placed immediately above
   * its children so the display nests correctly; rails/returns and the main bus
   * are never grouped. Returns the group id and selects it.
   */
  addGroup(): string {
    const groupId = uid('grp');
    const group: Track = {
      id: groupId,
      name: 'Group #',
      kind: 'group',
      parentId: null,
      color: 'var(--app-cat-composite)',
      level: 1,
      sketch: { devices: [] },
      automation: [],
      clips: [],
    };

    // Deliberately-focused, groupable tracks (not the bus, not rails). Reparent
    // only the OUTERMOST selected tracks — a selected subtree moves as a unit.
    const selected = new Set(
      this.selectedTrackIds.filter((id) => {
        const t = this.trackById(id);
        return !!t && !this.isMainBus(t) && t.kind !== 'rail';
      }),
    );
    const hasSelectedAncestor = (t: Track): boolean => {
      let pid = t.parentId;
      while (pid) {
        if (selected.has(pid)) return true;
        pid = this.trackById(pid)?.parentId ?? null;
      }
      return false;
    };
    const roots = new Set(
      [...selected].filter((id) => !hasSelectedAncestor(this.trackById(id)!)),
    );

    this.mutate('add group', (d) => {
      const isBusT = (t: Track) => t.kind === 'group' && t.parentId === null;

      if (roots.size === 0) {
        // Nothing selected → group + one empty child track, placed above the bus.
        const child: Track = {
          id: uid('trk'),
          name: 'Track #',
          kind: 'track',
          parentId: groupId,
          color: 'var(--app-cat-source)',
          level: 1,
          sketch: { devices: [] },
          automation: [],
          clips: [],
        };
        const busIdx = d.tracks.findIndex(isBusT);
        d.tracks.splice(busIdx >= 0 ? busIdx : d.tracks.length, 0, group, child);
        d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks);
        return;
      }

      // Move the selected subtrees under the group. A track is in the block if it
      // is a root or descends from one; the block keeps its current relative order.
      const byId = new Map(d.tracks.map((t) => [t.id, t] as const));
      const inBlock = (t: Track): boolean => {
        let cur: Track | undefined = t;
        while (cur) {
          if (roots.has(cur.id)) return true;
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
        return false;
      };
      const blockSet = new Set(d.tracks.filter((t) => !isBusT(t) && inBlock(t)).map((t) => t.id));
      // Anchor on the non-block track that precedes the block, so insertion is stable.
      const firstIdx = d.tracks.findIndex((t) => blockSet.has(t.id));
      const anchorId = firstIdx > 0 ? d.tracks[firstIdx - 1].id : null;

      for (const id of roots) { const t = byId.get(id); if (t) t.parentId = groupId; }
      const block = d.tracks.filter((t) => blockSet.has(t.id));
      d.tracks = d.tracks.filter((t) => !blockSet.has(t.id));

      let at = anchorId ? d.tracks.findIndex((t) => t.id === anchorId) + 1 : 0;
      const busIdx = d.tracks.findIndex(isBusT);
      if (busIdx >= 0 && at > busIdx) at = busIdx; // never below the bus
      d.tracks.splice(at, 0, group, ...block);
      d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks);
    });
    this.select(paths.track(groupId));
    return groupId;
  }

  /**
   * "+ Track" affordance. Inserts after the bottom-most shown-selected track — and
   * INSIDE its group when the selection is a group (→ its last child) or a track
   * within a group (→ a sibling right after it). With nothing selected, appends a
   * top-level track.
   */
  addTrackAfterSelection(): string {
    const shown = this.shownSelectedTrackIds;
    let anchor: Track | undefined;
    for (const t of this.displayTracks) {
      if (shown.has(t.id) && !this.isMainBus(t)) anchor = t;
    }
    if (!anchor) return this.addTrack();
    if (anchor.kind === 'group') {
      // A group selected → create inside it, as its last child.
      return this.addTrack(this.lastDescendantId(anchor.id) ?? anchor.id, anchor.id);
    }
    // A track selected → sibling right after it (inside its group when nested).
    return this.addTrack(anchor.id, anchor.parentId ?? null);
  }

  /** Delete the focused track(s) AND everything they contain — deleting a group
   *  removes its whole subtree (nested groups + tracks). Never the main bus. */
  deleteSelectedTracks() {
    const seeds = this.selectedTrackIds.filter((id) => {
      const t = this.trackById(id);
      return !!t && !this.isMainBus(t);
    });
    if (!seeds.length) return;
    const idSet = new Set<string>();
    const addSubtree = (id: string) => {
      if (idSet.has(id)) return;
      idSet.add(id);
      for (const t of this.composition.tracks) if (t.parentId === id) addSubtree(t.id);
    };
    for (const id of seeds) addSubtree(id);
    this.mutate('delete track', (d) => {
      d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks.filter((t) => !idSet.has(t.id)));
    });
    this.clearSelection();
    this.clearTimeSelection();
  }

  /** Dissolve a group: its direct children move up to the group's parent (keeping
   *  order), then the group is removed. Selects the freed children. */
  ungroup(groupId: string) {
    const g = this.trackById(groupId);
    if (!g || g.kind !== 'group' || this.isMainBus(g)) return;
    const freed = this.composition.tracks.filter((t) => t.parentId === groupId).map((t) => t.id);
    this.mutate('ungroup', (d) => {
      const grp = d.tracks.find((t) => t.id === groupId);
      if (!grp) return;
      const parent = grp.parentId ?? null;
      for (const t of d.tracks) if (t.parentId === groupId) t.parentId = parent;
      d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks.filter((t) => t.id !== groupId));
    });
    this.clearSelection();
    if (freed.length) {
      for (const id of freed) this.selection.add(paths.track(id));
      this.primaryPath = paths.track(freed[0]);
    }
  }

  /** The single focused non-bus GROUP, or null (drives the "Ungroup" affordance). */
  get selectedSingleGroupId(): string | null {
    const ids = this.selectedTrackIds;
    if (ids.length !== 1) return null;
    const t = this.trackById(ids[0]);
    return t && t.kind === 'group' && !this.isMainBus(t) ? t.id : null;
  }

  /** Last VISIBLE display row inside `groupId` (or the group itself when collapsed/empty). */
  lastVisibleInGroup(groupId: string): string | null {
    let last: string | null = null;
    for (const t of this.displayTracks) {
      if (t.id === groupId || this.isAncestorTrack(groupId, t.id)) last = t.id;
    }
    return last;
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
      d.tracks = ArrangementStore.canonicalTrackOrder([...nonbus, ...buses]);
    });
  }

  /**
   * Reorder tracks into canonical TREE order: each group is immediately followed
   * by its whole subtree (depth-first; siblings keep their current relative order),
   * with the main bus pinned last. This is the single invariant that keeps a group
   * and its tracks contiguous — and the array order IS the composite/display order
   * (audio-style downward sum: tracks composite down within a group, then the group
   * applies, then it composites into its parent).
   */
  private static canonicalTrackOrder(tracks: Track[]): Track[] {
    const isBus = (t: Track) => ArrangementStore.isMainBusTrack(t);
    const bus = tracks.filter(isBus);
    const rest = tracks.filter((t) => !isBus(t));
    const ids = new Set(rest.map((t) => t.id));
    const childrenOf = new Map<string | null, Track[]>();
    for (const t of rest) {
      const key = t.parentId && ids.has(t.parentId) ? t.parentId : null;
      const arr = childrenOf.get(key);
      if (arr) arr.push(t);
      else childrenOf.set(key, [t]);
    }
    const out: Track[] = [];
    const seen = new Set<string>();
    const visit = (key: string | null) => {
      for (const t of childrenOf.get(key) ?? []) {
        if (seen.has(t.id)) continue; // cycle guard
        seen.add(t.id);
        out.push(t);
        visit(t.id);
      }
    };
    visit(null);
    for (const t of rest) if (!seen.has(t.id)) out.push(t); // any cycle stragglers
    return [...out, ...bus];
  }

  /** Re-establish the canonical track order in place (after structural edits or on load). */
  normalizeTrackOrder() {
    this.composition.tracks = ArrangementStore.canonicalTrackOrder(this.composition.tracks);
  }

  /** True if `ancestorId` is an ancestor of the track `ofId` (via parentId). */
  private isAncestorTrack(ancestorId: string, ofId: string): boolean {
    let pid = this.trackById(ofId)?.parentId ?? null;
    while (pid) {
      if (pid === ancestorId) return true;
      pid = this.trackById(pid)?.parentId ?? null;
    }
    return false;
  }

  /**
   * Drag-drop a track to a new parent + sibling position. `parentId` null = top
   * level; `beforeId` null = append as the LAST child of the parent. The dragged
   * track keeps its own subtree, and the whole forest is re-contiguated. Rejects
   * dropping a group into its own subtree (no cycles) and never moves the bus.
   */
  moveTrackInto(trackId: string, parentId: string | null, beforeId: string | null) {
    const t = this.trackById(trackId);
    if (!t || this.isMainBus(t)) return;
    if (parentId === trackId) return;
    if (parentId && this.isAncestorTrack(trackId, parentId)) return; // into own subtree → cycle
    this.mutate('move track', (d) => {
      const moved = d.tracks.find((x) => x.id === trackId);
      if (!moved) return;
      moved.parentId = parentId;
      d.tracks = d.tracks.filter((x) => x.id !== trackId);
      let idx: number;
      if (beforeId) {
        idx = d.tracks.findIndex((x) => x.id === beforeId);
        if (idx < 0) idx = d.tracks.length;
      } else {
        const busIdx = d.tracks.findIndex((x) => ArrangementStore.isMainBusTrack(x));
        idx = busIdx >= 0 ? busIdx : d.tracks.length;
      }
      d.tracks.splice(idx, 0, moved);
      d.tracks = ArrangementStore.canonicalTrackOrder(d.tracks);
    }, `movetrack:${trackId}`);
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

  /** Set a track's composite blend mode (a BLEND_MODE_NAMES index). */
  setTrackBlendMode(trackId: string, mode: number) {
    this.mutate('set blend mode', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) t.blendMode = mode;
    });
  }

  /** A group's compositing input mode (what its children draw over). Omitted ⇒
   *  transparent. */
  groupInputMode(trackId: string): GroupInputMode {
    return this.trackById(trackId)?.groupInput?.mode ?? 'transparent';
  }
  groupInputColor(trackId: string): string {
    return this.trackById(trackId)?.groupInput?.color ?? '#000000';
  }
  /** Set a group's compositing input mode (+ custom color). */
  setGroupInput(trackId: string, mode: GroupInputMode, color?: string) {
    this.mutate('set group input', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t) return;
      const keepColor = t.groupInput?.color;
      const gi: GroupInput = { mode, ...(color !== undefined ? { color } : (keepColor ? { color: keepColor } : {})) };
      t.groupInput = gi;
    }, `groupInput:${trackId}`);
  }

  /** Set a return/rail track's signed (bipolar) vs unsigned mode. */
  setRailSigned(trackId: string, signed: boolean) {
    this.mutate('set return range', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) t.railSigned = signed;
    });
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

  /** A flat mid-level curve — the seed for a freshly created lane. `span` is the
   *  trailing endpoint x: 1 for a normalized clip lane, or the beat extent for a
   *  beat-domain track lane (so the flat line spans the visible timeline). */
  /**
   * Heal duplicate ids left by clip duplication (cmd-drag / paste / split deep-copy
   * a clip without minting fresh inner ids). Mutates `comp` in place:
   *  - DEVICE ids unique within each sketch — two devices sharing an id emit the
   *    same composite instance key → the executor retypes + recreates the instance
   *    every frame (1000s of "module initialized").
   *  - AUTOMATION LANE ids unique GLOBALLY — `laneIn` resolves a lane by id across
   *    the whole comp, so a duplicate lane id routes edits to the WRONG clip's lane
   *    → the edit never lands on the edited lane and the UI snaps back.
   */
  private static repairIds(comp: Composition): void {
    const healDevices = (devices: Array<{ id: string }> | undefined) => {
      if (!devices) return;
      const seen = new Set<string>();
      for (const d of devices) {
        if (seen.has(d.id)) d.id = uid('dev');
        seen.add(d.id);
      }
    };
    const seenLanes = new Set<string>();
    const healLanes = (lanes: Array<{ id: string }> | undefined) => {
      if (!lanes) return;
      for (const l of lanes) {
        if (seenLanes.has(l.id)) l.id = uid('auto');
        seenLanes.add(l.id);
      }
    };
    // CLIP ids unique GLOBALLY: a duplicate clip id (e.g. from the _uid-reset collision
    // above) makes two clips share a composite instance key + a single decode pump, so
    // the second clip plays the first's video. Remint + freshen the whole clip's
    // internal ids (it's effectively a duplicate).
    const seenClips = new Set<string>();
    for (const t of comp.tracks) {
      for (const c of t.clips ?? []) {
        if (seenClips.has(c.id)) {
          c.id = uid('clip');
          freshClipIds(c);
        }
        seenClips.add(c.id);
      }
    }
    for (const t of comp.tracks) {
      healDevices(t.sketch?.devices);
      healLanes(t.automation);
      // Returns rested at a centred 0.5 default that clipped on unsigned +add. Reset
      // the UNTOUCHED default to a 0 floor (base editing isn't prototyped, so a flat
      // 0.5 curve is always the old default, never an intentional user value).
      if (t.kind === 'rail' && (t.baseCurve?.length ?? 0) > 0
          && t.baseCurve!.every((p) => Math.abs(p.y - 0.5) < 1e-6)) {
        t.baseCurve = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
      }
      for (const c of t.clips) {
        healDevices(c.sketch?.devices);
        healLanes(c.automation);
        ArrangementStore.repairClipLoop(c);
      }
    }
  }

  /** Heal a clip's loop config to the play-mode model: fill any missing field, and
   *  best-effort-map an old-shaped `mode` ('loop'/'hold'/… → time/one-shot/…). Clips
   *  predating the play-mode rework have no `startSec`/`speed`/`direction`. */
  private static repairClipLoop(c: Clip): void {
    const raw = (c.loop ?? {}) as Partial<ClipLoopConfig> & { inFrame?: number; outFrame?: number };
    const videoDurSec =
      c.source && c.source.fps && c.source.fps > 0 ? c.source.durationFrames / c.source.fps : undefined;
    const base = defaultClipLoop(videoDurSec);
    const KNOWN = new Set<ClipLoopConfig['mode']>(['one-shot', 'time', 'beat-sync', 'random']);
    // Map legacy mode names; unknown/missing ⇒ the default 'time'.
    const legacy: Record<string, ClipLoopConfig['mode']> = {
      loop: 'time',
      'reverse-loop': 'time',
      pingpong: 'time',
      'random-jumps': 'random',
      hold: 'one-shot',
    };
    const rawMode = raw.mode as string | undefined;
    const mode = raw.mode && KNOWN.has(raw.mode) ? raw.mode : legacy[rawMode ?? ''] ?? base.mode;
    c.loop = {
      ...base,
      ...raw,
      mode,
      startSec: typeof raw.startSec === 'number' ? raw.startSec : base.startSec,
      speed: typeof raw.speed === 'number' ? raw.speed : base.speed,
      direction: raw.direction === 'reverse' ? 'reverse' : base.direction,
      pingpong: raw.pingpong ?? (rawMode === 'pingpong' ? true : undefined),
    };
  }

  private static defaultCurve(span = 1): EnvelopePoint[] {
    return [{ x: 0, y: 0.5, bend: 0 }, { x: span, y: 0.5, bend: 0 }];
  }
  /** Beat-domain seed for a TRACK lane — flat across the whole timeline. */
  private trackDefaultCurve(): EnvelopePoint[] {
    return ArrangementStore.defaultCurve(compositionLengthBeats(this.composition));
  }

  // ── Automation clipboard (envelope regions; data-x in [0,1]) ───────────
  get hasAutoClipboard(): boolean {
    return !!this.autoClipboard && this.autoClipboard.lanes.length > 0;
  }

  /** Mode-INDEPENDENT rows (always include every lane), so the automation
   *  clipboard can address lanes even in clip mode — paste applies the data
   *  without forcing a mode switch. */
  private autoRows(): Array<{ trackId: string; laneId: string }> {
    const rows: Array<{ trackId: string; laneId: string }> = [];
    for (const t of this.caretTrackOrder) {
      const overlay = this.selectedTrackLane(t.id)?.id ?? '';
      rows.push({ trackId: t.id, laneId: overlay });
      for (const lane of t.automation) if (lane.id !== overlay) rows.push({ trackId: t.id, laneId: lane.id });
    }
    return rows;
  }
  /** The caret span over autoRows (anchor→head). */
  private autoRowSpan(): Array<{ trackId: string; laneId: string }> {
    const rows = this.autoRows();
    const ai = rows.findIndex((r) => r.trackId === this.caretAnchorTrackId && r.laneId === this.caretAnchorLaneId);
    const hi = rows.findIndex((r) => r.trackId === this.caretHeadTrackId && r.laneId === this.caretHeadLaneId);
    if (ai < 0 && hi < 0) return [];
    if (ai < 0) return [rows[hi]];
    if (hi < 0) return [rows[ai]];
    return rows.slice(Math.min(ai, hi), Math.max(ai, hi) + 1);
  }

  /**
   * Copy the envelope SLICE [x0,x1] (data-x) from every lane the caret spans.
   * Nodes are stored relative to x0, with each lane's row offset from the head so
   * paste re-lands them. Returns false if there's no region or no lane.
   */
  copyAutomation(x0: number, x1: number): boolean {
    if (x1 <= x0 + 1e-6) return false;
    const rows = this.autoRows();
    const headIdx = rows.findIndex((r) => r.trackId === this.caretHeadTrackId && r.laneId === this.caretHeadLaneId);
    if (headIdx < 0) return false;
    const lanes: Array<{ rowOffset: number; nodes: EnvelopePoint[] }> = [];
    for (const r of this.autoRowSpan()) {
      if (!r.laneId) continue;
      const lane = ArrangementStore.laneIn(this.composition, r.laneId);
      if (!lane) continue;
      const idx = rows.findIndex((q) => q.trackId === r.trackId && q.laneId === r.laneId);
      const nodes = lane.points
        .filter((p) => p.x >= x0 - 1e-6 && p.x <= x1 + 1e-6)
        .map((p) => ({ x: p.x - x0, y: p.y, bend: p.bend ?? 0 }));
      lanes.push({ rowOffset: idx - headIdx, nodes });
    }
    if (!lanes.length) return false;
    this.autoClipboard = { lanes, span: x1 - x0 };
    this.lastClipboardKind = 'auto';
    return true;
  }

  /** Paste the clipboard at `xHead` (data-x), onto the lanes from the caret head
   *  row down (by row offset). Clears the paste window first (keeps 0/1 ends). */
  pasteAutomation(xHead: number) {
    const cb = this.autoClipboard;
    if (!cb) return;
    const rows = this.autoRows();
    const headIdx = rows.findIndex((r) => r.trackId === this.caretHeadTrackId && r.laneId === this.caretHeadLaneId);
    if (headIdx < 0) return;
    const x1 = xHead + cb.span;
    this.mutate('paste automation', (d) => {
      for (const item of cb.lanes) {
        const target = rows[headIdx + item.rowOffset];
        if (!target?.laneId) continue;
        const lane = ArrangementStore.laneIn(d, target.laneId);
        if (!lane) continue;
        const last = lane.points.length - 1;
        lane.points = lane.points.filter(
          (p, i) => i === 0 || i === last || p.x < xHead - 1e-6 || p.x > x1 + 1e-6,
        );
        for (const n of item.nodes) {
          const nx = xHead + n.x;
          if (nx < -1e-6) continue; // before the start → drop
          lane.points.push({ x: Math.max(0, nx), y: n.y, bend: n.bend ?? 0 });
        }
        lane.points.sort((a, b) => a.x - b.x);
        if (lane.points.length < 2) lane.points = ArrangementStore.defaultCurve();
      }
    });
  }

  /** Copy then remove the region from the caret's lanes (one undo). */
  cutAutomation(x0: number, x1: number) {
    if (!this.copyAutomation(x0, x1)) return;
    const laneIds = this.autoRowSpan().filter((r) => r.laneId).map((r) => r.laneId);
    this.mutate('cut automation', (d) => {
      for (const id of laneIds) {
        const lane = ArrangementStore.laneIn(d, id);
        if (!lane) continue;
        const last = lane.points.length - 1;
        lane.points = lane.points.filter(
          (p, i) => i === 0 || i === last || p.x < x0 - 1e-6 || p.x > x1 + 1e-6,
        );
        if (lane.points.length < 2) lane.points = ArrangementStore.defaultCurve();
      }
    });
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
        label: t.label, points: this.trackDefaultCurve(), expanded: true,
      });
    });
    return laneId;
  }

  // ── Lanes for the SELECTED automation field (per-owner selection) ──────
  /** Delete a lane's control points whose x ∈ [x0,x1] (in the lane's own units —
   *  beats for a track lane). Keeps the first + last node (the curve's outer
   *  bounds); falls back to a default if everything would be removed. */
  deleteAutoPointsInRange(laneId: string, x0: number, x1: number) {
    this.mutate('delete automation points', (d) => {
      const lane = ArrangementStore.laneIn(d, laneId); // track OR clip lanes
      if (!lane) return;
      const last = lane.points.length - 1;
      lane.points = lane.points.filter(
        (p, i) => i === 0 || i === last || p.x < x0 - 1e-6 || p.x > x1 + 1e-6,
      );
      if (lane.points.length < 2) lane.points = ArrangementStore.defaultCurve();
    });
  }

  /** The clip's selected-field automation lane, or undefined (no selection / no lane). */
  selectedClipLane(trackId: string, clipId: string): AutomationLane | undefined {
    const sel = this.autoField(paths.clip(trackId, clipId));
    if (!sel) return undefined;
    return this.trackById(trackId)?.clips.find((c) => c.id === clipId)?.automation
      .find((l) => l.targetDeviceId === sel.deviceId && l.targetField === sel.field);
  }
  /** Ensure a lane for the clip's selected field; '' if nothing is selected. */
  ensureSelectedClipLane(trackId: string, clipId: string): string {
    const sel = this.autoField(paths.clip(trackId, clipId));
    if (!sel) return '';
    const existing = this.selectedClipLane(trackId, clipId);
    if (existing) return existing.id;
    const laneId = uid('auto');
    this.mutate('add automation', (d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!c || c.automation.some((l) => l.targetDeviceId === sel.deviceId && l.targetField === sel.field)) return;
      c.automation.push({ id: laneId, targetDeviceId: sel.deviceId, targetField: sel.field, label: sel.label, points: ArrangementStore.defaultCurve(), expanded: true });
    });
    return laneId;
  }
  /** The track's selected-field automation lane, or undefined. */
  selectedTrackLane(trackId: string): AutomationLane | undefined {
    const sel = this.autoField(paths.track(trackId));
    if (!sel) return undefined;
    return this.trackById(trackId)?.automation.find((l) => l.targetDeviceId === sel.deviceId && l.targetField === sel.field);
  }
  /** Ensure a lane for the track's selected field; '' if nothing is selected. */
  ensureSelectedTrackLane(trackId: string): string {
    const sel = this.autoField(paths.track(trackId));
    if (!sel) return '';
    const existing = this.selectedTrackLane(trackId);
    if (existing) return existing.id;
    const laneId = uid('auto');
    this.mutate('add automation', (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t || t.automation.some((l) => l.targetDeviceId === sel.deviceId && l.targetField === sel.field)) return;
      t.automation.push({ id: laneId, targetDeviceId: sel.deviceId, targetField: sel.field, label: sel.label, points: this.trackDefaultCurve(), expanded: true });
    });
    return laneId;
  }
  /** "Pin" the track's selected field into a new automation lane (the sub-lane
   *  below the track), then clear the selection. */
  pinTrackAutomation(trackId: string): string | null {
    const ownerKey = paths.track(trackId);
    const sel = this.autoField(ownerKey);
    if (!sel) return null;
    const existing = this.selectedTrackLane(trackId);
    if (existing) { this.clearAutoField(ownerKey); return existing.id; }
    const laneId = uid('auto');
    this.mutate('pin automation', (d) => {
      const dt = d.tracks.find((t) => t.id === trackId);
      if (dt) dt.automation.push({ id: laneId, targetDeviceId: sel.deviceId, targetField: sel.field, label: sel.label, points: this.trackDefaultCurve(), expanded: true });
    });
    this.clearAutoField(ownerKey);
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

  /** True for the master/main-bus track that pins to the bottom. Identity is by
   *  the reserved id — a user-created top-level group is NOT the main bus. */
  isMainBus(track: Track): boolean {
    return track.kind === 'group' && track.id === MAIN_BUS_ID;
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
