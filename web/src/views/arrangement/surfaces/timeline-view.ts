/**
 * RulerView — the zoom/pan/scrub model behind <arr-ruler>, so the SAME ruler
 * drives both the main arrangement timeline (warped, global store state) and the
 * clip-details editor (a straight, clip-local beat axis with its own zoom/pan).
 *
 * The ruler reads everything it needs through this interface; the two concrete
 * views (`mainTimelineView`, `ClipTimelineView`) supply the geometry + actions.
 */

import { makeAutoObservable } from 'mobx';
import { store } from '../state/store';
import { BeatGrid, WarpCurve, gridStepBeats } from '../model/beat-grid';
import { buildBeatGrid } from './grid-shared';

export interface RulerView {
  /** Live transform (beat ↔ x). Rebuilt per draw (cheap). */
  grid(): BeatGrid;
  /** Current zoom (px per beat) — also drives the bar/beat label stride. */
  readonly pxPerBeat: number;
  /** Left-edge scroll, in warped units (== beats for the straight clip view). */
  readonly scrollUnits: number;
  readonly beatsPerBar: number;
  /** Corner width (the track-header gutter); 0 when the ruler spans full width. */
  readonly headerWidth: number;
  /** Playhead, in this view's beat space; < 0 ⇒ off (hidden). */
  readonly positionBeat: number;
  /** Play-from / scrub marker, in this view's beat space. */
  readonly playFromBeat: number;
  /** Optional main-timeline chrome (null ⇒ not drawn). */
  readonly loop: { start: number; end: number } | null;
  readonly timeSel: { start: number; end: number } | null;

  /** Grid spacing (beats) — drives BOTH the drawn lines and `quantize`. */
  readonly snapStep: number;

  setZoom(pxPerBeat: number): void;
  setScrollUnits(units: number): void;
  zoomAnchored(factor: number, anchorX: number): void;
  scrollBy(beats: number): void;
  setPlayFrom(beat: number): void;
  /** Grid-quantize a beat to the view's snap grid. */
  quantize(beat: number): number;
  /** Drag-select a range [anchor,head] (head = the moving edge / play-from). */
  setSelection(anchorBeat: number, headBeat: number): void;
}

/** The main arrangement timeline: a thin forwarder to the global store state. */
export const mainTimelineView: RulerView = {
  grid: () => buildBeatGrid(),
  get pxPerBeat() { return store.pxPerBeat; },
  get scrollUnits() { return store.scrollUnits; },
  get beatsPerBar() { return store.composition.meta.timeSignature[0]; },
  get headerWidth() { return store.headerWidth; },
  get positionBeat() { return store.positionBeat; },
  get playFromBeat() { return store.playFromBeat; },
  get loop() { return store.loopEnabled ? { start: store.loopStartBeat, end: store.loopEndBeat } : null; },
  get timeSel() { return store.hasTimeSelection ? { start: store.timeSelStart!, end: store.timeSelEnd } : null; },
  get snapStep() { return store.snapStep; },
  setZoom: (px) => store.setZoom(px),
  setScrollUnits: (u) => store.setScrollUnits(u),
  zoomAnchored: (f, x) => store.zoomAnchored(f, x),
  scrollBy: (b) => store.scrollBy(b),
  setPlayFrom: (b) => store.setPlayFrom(b),
  quantize: (b) => store.quantize(b),
  setSelection: (a, h) => store.setTimeSelection(a, h),
};

/** Clip context the clip-local view maps the transport playhead through. */
export interface ClipViewContext {
  /** Arrangement beat where the clip starts. */
  startBeat: number;
  /** Clip arrangement length (beats). */
  lengthBeat: number;
  /** Editor span (loop-length or clip-length beats). */
  spanBeats: number;
  /** Loop timing ⇒ playhead wraps within `spanBeats`. */
  loopMode: boolean;
  beatsPerBar: number;
}

const CLIP_MIN_PPB = 4;
const CLIP_MAX_PPB = 600;

/**
 * A straight (un-warped), clip-local timeline: its own observable zoom/pan over
 * a 0..spanBeats range. Context (clip start/length/span) is read live from a
 * provider so the playhead tracks the transport without mutating state in render.
 */
export class ClipTimelineView implements RulerView {
  pxPerBeat = 32;
  scrollUnits = 0;
  /** Clip-LOCAL selection range (anchor + head, both clip-local). Kept SEPARATE
   *  from the global play-from so selecting a clip (which moves the global
   *  play-from) doesn't conjure a phantom selection band. Drives the same ruler
   *  band the main timeline draws + the envelope time-box gestures. */
  selAnchorBeat = 0;
  selHeadBeat = 0;
  /** Identity warp ⇒ unitsAt(beat) == beat (a straight grid). */
  private readonly curve = new WarpCurve([], 4096);

  constructor(private readonly ctx: () => ClipViewContext) {
    makeAutoObservable<this, 'ctx' | 'curve'>(this, { ctx: false, curve: false, grid: false });
  }

  private c(): ClipViewContext { return this.ctx(); }

  grid(): BeatGrid { return new BeatGrid(this.curve, this.pxPerBeat, this.scrollUnits); }

  get spanBeats(): number { return Math.max(0.25, this.c().spanBeats); }
  get beatsPerBar(): number { return this.c().beatsPerBar || 4; }
  get headerWidth(): number { return 0; }
  get loop(): null { return null; }
  /** The clip-local selected range (null when collapsed). */
  get timeSel(): { start: number; end: number } | null {
    if (Math.abs(this.selAnchorBeat - this.selHeadBeat) < 1e-6) return null;
    return { start: Math.min(this.selAnchorBeat, this.selHeadBeat), end: Math.max(this.selAnchorBeat, this.selHeadBeat) };
  }

  get positionBeat(): number {
    const c = this.c();
    const elapsed = store.positionBeat - c.startBeat;
    if (elapsed < -1e-6 || store.positionBeat >= c.startBeat + c.lengthBeat) return -1;
    return c.loopMode ? elapsed % this.spanBeats : elapsed;
  }
  get playFromBeat(): number { return store.playFromBeat - this.c().startBeat; }

  setZoom(px: number) {
    this.pxPerBeat = Math.max(CLIP_MIN_PPB, Math.min(CLIP_MAX_PPB, px));
    this.clampScroll();
  }
  setScrollUnits(u: number) {
    this.scrollUnits = u;
    this.clampScroll();
  }
  zoomAnchored(factor: number, anchorX: number) {
    const before = this.scrollUnits + anchorX / this.pxPerBeat;
    this.pxPerBeat = Math.max(CLIP_MIN_PPB, Math.min(CLIP_MAX_PPB, this.pxPerBeat * factor));
    this.setScrollUnits(before - anchorX / this.pxPerBeat);
  }
  scrollBy(beats: number) { this.setScrollUnits(this.scrollUnits + beats); }
  /** Fit the whole span into `widthPx` and reset the scroll (on clip change). */
  fitTo(widthPx: number) {
    this.pxPerBeat = Math.max(CLIP_MIN_PPB, Math.min(CLIP_MAX_PPB, widthPx / this.spanBeats));
    this.scrollUnits = 0;
  }
  setPlayFrom(beat: number) {
    // Scrub the transport into this clip (clip-local beat → arrangement beat) and
    // COLLAPSE the local selection (a plain click).
    const local = Math.max(0, Math.min(this.spanBeats, beat));
    store.setPlayFrom(this.c().startBeat + local);
    this.selAnchorBeat = local;
    this.selHeadBeat = local;
  }
  setSelection(anchorBeat: number, headBeat: number) {
    // Set the clip-local range and scrub the play-from to its head.
    const head = Math.max(0, Math.min(this.spanBeats, headBeat));
    store.setPlayFrom(this.c().startBeat + head);
    this.selAnchorBeat = Math.max(0, Math.min(this.spanBeats, anchorBeat));
    this.selHeadBeat = head;
  }
  /** Clip-local grid spacing (beats) — the same ladder the main grid uses, so the
   *  drawn lines and the snap points agree here too. */
  get snapStep(): number { return gridStepBeats(this.pxPerBeat, this.beatsPerBar); }

  /** Snap to the clip-local grid (the step the ruler draws). */
  quantize(beat: number): number {
    const step = this.snapStep;
    return Math.max(0, Math.round(beat / step) * step);
  }

  private clampScroll() {
    // Keep at least a sliver of content on-screen; never scroll before 0.
    const max = Math.max(0, this.spanBeats - 0.5);
    if (this.scrollUnits < 0) this.scrollUnits = 0;
    else if (this.scrollUnits > max) this.scrollUnits = max;
  }
}
