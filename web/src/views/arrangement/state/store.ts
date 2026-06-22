/**
 * Standalone arrangement store (Milestone 1: mockup).
 *
 * Owns its own state — it does NOT couple to the effect IDE's AppController.
 * Split mirrors the house pattern: a persisted `composition` (would be undo-able
 * later) and ephemeral `local` UI state. MobX is used for UI binding only;
 * mutations are explicit action methods (no reactions for business logic).
 */

import { makeAutoObservable, runInAction, toJS, set as mobxSet, remove as mobxRemove } from 'mobx';
import type { StateDiff } from '../../../engine-types';
import {
  Composition,
  Clip,
  Track,
  Device,
  ClipLoopConfig,
  RailExport,
  RailRead,
  deviceIsSource,
} from '../model/composition';
import { makeFakeComposition } from '../model/fake-data';
import { DocHistory } from './history';
import { EFFECTS, defaultStateFor, catalogEffect } from '../engine/effect-catalog';
import type { WorkspaceBackend } from '../workspace/backend';

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

export type RightTab = 'inspector' | 'settings' | 'export';

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

  constructor() {
    makeAutoObservable<
      ArrangementStore,
      'backend' | 'saveTimer' | 'persistenceEnabled' | 'lastSavedJson'
    >(
      this,
      {
        backend: false,
        saveTimer: false,
        persistenceEnabled: false,
        lastSavedJson: false,
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
      this.persistenceEnabled = true;
      this.lastSavedJson = JSON.stringify(toJS(comp));
      this.clearSelection();
    });
    this.history.reset();
  }

  /** Create a new arrangement file (seeded with `comp` or the current doc). */
  async createArrangement(backend: WorkspaceBackend, name: string, comp?: Composition) {
    await backend.create(name, comp ?? toJS(this.composition));
    await this.openArrangement(backend, name);
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
      this.activeRightTab = 'inspector';
      // Selecting a clip syncs the time region to the clip's extent.
      const found = this.clipByPath(path);
      if (found) {
        this.setTimeSelection(
          found.clip.startBeat,
          found.clip.startBeat + found.clip.lengthBeat,
          [found.track.id],
        );
      }
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
    });
  }

  // ── Right tab ─────────────────────────────────────────────────────────
  setRightTab(tab: RightTab) {
    this.activeRightTab = tab;
  }

  toggleAutomationMode() {
    this.automationMode = !this.automationMode;
  }

  toggleWiresMode() {
    this.wiresMode = !this.wiresMode;
    if (!this.wiresMode) this.tapPopup = null;
  }

  toggleClipView() {
    this.clipViewOpen = !this.clipViewOpen;
  }
  setClipViewMode(m: 'source' | 'automation') {
    this.clipViewMode = m;
  }
  setClipViewHeight(h: number) {
    this.clipViewHeight = Math.max(90, Math.min(520, h));
  }
  setClipAutoTiming(t: 'loop' | 'clip') {
    this.clipAutoTiming = t;
  }

  /** The single selected clip (for the clip view), or null. */
  get selectedClip(): { track: Track; clip: Clip } | null {
    if (!this.primaryPath) return null;
    return this.clipByPath(this.primaryPath) ?? null;
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
  /** Set the insert / "play from" marker (and move the playhead there). */
  setPlayFrom(beat: number) {
    runInAction(() => {
      this.playFromBeat = Math.max(0, beat);
      this.positionBeat = this.playFromBeat;
    });
  }
  toggleLoop() {
    this.loopEnabled = !this.loopEnabled;
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
      d.tracks.find((t) => t.id === trackId)?.clips.push(clip);
    });
    const path = paths.clip(trackId, clip.id);
    this.select(path);
    return path;
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

  /** Remove a clip device by id. */
  removeClipDevice(trackId: string, clipId: string, deviceId: string, coalesceKey?: string) {
    this.mutate('remove device', (d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
      if (!c) return;
      const i = c.sketch.devices.findIndex((x) => x.id === deviceId);
      if (i >= 0) c.sketch.devices.splice(i, 1);
    }, coalesceKey);
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
    }, coalesceKey);
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
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (c) c.startBeat = v;
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
        const c = d.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId);
        if (c) { c.startBeat = start; c.lengthBeat = len; }
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
