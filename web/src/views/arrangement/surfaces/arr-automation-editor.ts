/**
 * <arr-automation-editor> — the arrangement's editable automation curve.
 *
 * The arrangement counterpart of `<envelope-inspector>`: it wraps the SAME
 * shared `<envelope-graph>` Canvas editor, but binds it to a first-class
 * `AutomationLane` (`{x,y,bend}[]`) in the store rather than to a serialized
 * device field. Reusing `<envelope-graph>` means drag-a-node / double-click
 * add-remove / drag-a-segment-to-bend behave exactly as in the effect IDE, and
 * the drawn curve evaluates with the same eased math (`automation-eval` →
 * `envelope-math`, the lock-step twin of native `envelope.h`).
 *
 * Sync rule mirrors the inspector: a rAF loop pushes the lane's points into the
 * graph EXCEPT while the user is dragging (so an in-flight edit isn't clobbered
 * by undo/redo/playhead-driven re-renders). Writeback coalesces a whole drag
 * into ONE undo via a per-gesture session key; double-click add/remove is its
 * own one-shot undo.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import type { AutomationLane } from '../model/composition';
import { toEnvPoints } from '../engine/automation-eval';
import { buildBeatGrid } from './grid-shared';
import type { BeatGrid } from '../model/beat-grid';
// Registers <envelope-graph> (and the inspector); we only use the graph.
import { EnvelopeGraph } from '../../../editors/envelope-inspector';
import type { EnvPoint } from '../../../editors/envelope-math';

const DEFAULT_POINTS: EnvPoint[] = [{ x: 0, y: 0.5, ease: 0 }, { x: 1, y: 0.5, ease: 0 }];

@customElement('arr-automation-editor')
export class ArrAutomationEditor extends MobxLitElement {
  /** The lane to edit (read path; reactive). Undefined ⇒ seeded flat curve. */
  @property({ attribute: false }) lane: AutomationLane | undefined;
  /**
   * Resolve (creating on demand) the lane id to WRITE to. Called only on an
   * actual edit, never during render/sync, so creating a lane here is safe.
   */
  @property({ attribute: false }) ensureLaneId: (() => string) | null = null;
  /** Live signal position x∈[0,1] to draw as a cursor, or null. */
  @property({ attribute: false }) cursor: number | null = null;
  /**
   * Optional shared TIME grid (the clip panel's film strip): when set, the curve
   * maps its x∈[0,1] onto the same frame axis as the strip below it (zoom +
   * scroll), so the two share one grid. Omitted ⇒ default full-width [0,1].
   */
  @property({ attribute: false }) pxPerFrame: number | null = null;
  @property({ attribute: false }) scrollFrames = 0;
  @property({ attribute: false }) durationFrames = 0;
  /** When > 0, the editor's x∈[0,1] spans exactly this many BEATS, drawn with a
   *  real beat/bar grid (loop mode = source-loop beats, clip mode = clip beats).
   *  Takes precedence over the frame mapping. */
  @property({ attribute: false }) beats = 0;
  @property({ attribute: false }) beatsPerBar = 4;
  /**
   * When > 0, the editor maps x∈[0,1] onto the live MAIN-TIMELINE beat grid
   * (warped, shared zoom/pan), spanning this many beats from beat 0 — used by the
   * arr-grid track lanes so a track envelope edits on the real timeline. The
   * cursor follows the transport playhead. Takes precedence over `beats`.
   */
  @property({ attribute: false }) timelineSpan = 0;
  /** Show the playhead time/value cursor (track lanes hide it unless the caret is
   *  on this lane's track). */
  @property({ attribute: false }) cursorEnabled = true;
  /**
   * Optional EXTERNAL beat grid (e.g. the clip view's zoomable, straight
   * ClipTimelineView): x∈[0,1] maps over [0, `beats`] through `gridProvider()`,
   * recomputed each frame so the editor shares the ruler's zoom/pan. The cursor
   * is supplied via `cursor` (x∈[0,1]). Highest precedence.
   */
  @property({ attribute: false }) gridProvider: (() => BeatGrid) | null = null;
  /** Selected range in DATA-x [0,1] (the clip-local selection), shaded behind. */
  @property({ attribute: false }) selection: { x0: number; x1: number } | null = null;
  /** Enable the arrangement clip-editor gesture model (time-box-aware). */
  @property({ attribute: false }) timeboxGestures = false;
  /** Track-lane mode: off-curve clicks bubble to the grid (set the caret). */
  @property({ attribute: false }) bubbleOffCurve = false;
  /** Drag off the curve → a selection range in DATA-x (anchor, head). */
  @property({ attribute: false }) onSelect: ((anchorX: number, headX: number) => void) | null = null;

  private rafId = 0;
  /** Bumped per drag gesture so each drag coalesces into its own single undo. */
  private session = 0;
  /** Distinct one-shot (double-click) edits get their own undo entries. */
  private oneShot = 0;
  /** Lane id captured at gesture start (survives create-on-first-edit). */
  private activeLaneId: string | null = null;

  static styles = css`
    :host { display: block; }
    /* When sharing the film-strip grid, fill the panel area above the strip. */
    :host([gridded]) { height: 100%; }
    :host([gridded]) .hint { display: none; }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0);
      opacity: 0.7; padding: 4px 0 0; line-height: 1.4;
    }
  `;

  private get graph(): EnvelopeGraph | null {
    return this.renderRoot?.querySelector('envelope-graph') as EnvelopeGraph | null;
  }

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const g = this.graph;
      if (!g) return;
      // Push lane points into the graph EXCEPT while dragging (don't clobber).
      if (!g.interacting) g.points = this.lane ? toEnvPoints(this.lane.points) : DEFAULT_POINTS;
      g.cursor = this.cursor;
      g.selection = this.selection;
      g.timeboxGestures = this.timeboxGestures;
      g.bubbleOffCurve = this.bubbleOffCurve;
      g.onSelect = this.onSelect;
      if (this.gridProvider && this.beats > 0) {
        // External clip-local grid (zoom/pan via a ClipTimelineView): x∈[0,1] →
        // [0, beats] through the provided straight grid. Recomputed each frame.
        const span = this.beats;
        const grid = this.gridProvider();
        g.xMap = (dx) => grid.beatToX(dx * span);
        g.xUnmap = (px) => grid.xToBeat(px) / span;
        const bpb = this.beatsPerBar || 4;
        const lines: Array<{ x: number; bar: boolean }> = [];
        for (let b = 0; b <= Math.floor(span + 1e-6); b++) lines.push({ x: b / span, bar: b % bpb === 0 });
        g.gridLines = lines;
      } else if (this.timelineSpan > 0) {
        // Warped MAIN-TIMELINE axis: x∈[0,1] → [0, span] beats through the live
        // grid (shared zoom/pan). Recomputed each frame so zoom/pan track live.
        const span = this.timelineSpan;
        const grid = buildBeatGrid();
        g.xMap = (dx) => grid.beatToX(dx * span);
        g.xUnmap = (px) => grid.xToBeat(px) / span;
        const bpb = this.beatsPerBar || 4;
        const lines: Array<{ x: number; bar: boolean }> = [];
        for (let b = 0; b <= Math.floor(span + 1e-6); b++) lines.push({ x: b / span, bar: b % bpb === 0 });
        g.gridLines = lines;
        // The playhead time/value cursor only shows when the caret is on this
        // lane's track (otherwise it reads as a confusing line on every lane).
        const ph = store.positionBeat / span;
        g.cursor = this.cursorEnabled && ph >= 0 && ph <= 1 ? ph : null;
      } else if (this.beats > 0) {
        // Beat-based axis: x∈[0,1] spans `beats`, full-width, with a real
        // beat/bar grid. (Straight — clip-local time ignores the timeline warp.)
        g.xMap = null;
        g.xUnmap = null;
        const bpb = this.beatsPerBar || 4;
        const lines: Array<{ x: number; bar: boolean }> = [];
        for (let b = 0; b <= Math.floor(this.beats + 1e-6); b++) {
          lines.push({ x: b / this.beats, bar: b % bpb === 0 });
        }
        g.gridLines = lines;
      } else if (this.pxPerFrame != null && this.durationFrames > 0) {
        // Legacy: map the curve's x onto the shared film-strip frame axis.
        const ppf = this.pxPerFrame;
        const scroll = this.scrollFrames;
        const dur = this.durationFrames;
        g.xMap = (dx) => (dx * dur - scroll) * ppf;
        g.xUnmap = (px) => (scroll + px / ppf) / dur;
        g.gridLines = null;
      } else {
        g.xMap = null;
        g.xUnmap = null;
        g.gridLines = null;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private resolveLaneId(): string {
    if (this.activeLaneId) return this.activeLaneId;
    if (this.lane) return this.lane.id;
    return this.ensureLaneId?.() ?? '';
  }

  private onChange = (pts: EnvPoint[]) => {
    const laneId = this.resolveLaneId();
    if (!laneId) return;
    // Drag → one undo for the whole gesture; double-click → its own one-shot.
    const key = this.graph?.interacting
      ? `auto:${laneId}:${this.session}`
      : `auto:${laneId}:one:${this.oneShot++}`;
    store.setAutomationPoints(
      laneId,
      pts.map((p) => ({ x: p.x, y: p.y, bend: p.ease })),
      key,
    );
  };
  private onStart = () => {
    this.session++;
    this.activeLaneId = this.resolveLaneId(); // may create the lane now
  };
  private onEnd = () => { this.activeLaneId = null; };

  render() {
    // `points`/`cursor`/`xMap` are synced imperatively via rAF (so a drag isn't
    // clobbered by re-renders); here we just wire the element + callbacks.
    // Any "embedded in a time grid" mode → fill the host (the clip-panel area or
    // the track lane) instead of the standalone 132px default canvas.
    const gridded = this.pxPerFrame != null || this.timelineSpan > 0 || this.beats > 0 || this.gridProvider != null;
    if (gridded) this.setAttribute('gridded', '');
    else this.removeAttribute('gridded');
    return html`
      <envelope-graph
        ?fill=${gridded}
        .onChange=${this.onChange}
        .onInteractionStart=${this.onStart}
        .onInteractionEnd=${this.onEnd}></envelope-graph>
      ${gridded ? '' : html`<div class="hint">double-click to add / remove a node · drag a segment to bend its easing</div>`}
    `;
  }
}
