/**
 * <arr-seq-lane> — a compact SINGLE-LANE timeline host for a sequence clip's
 * interior, rendered in the clip-details panel.
 *
 * It reuses <arr-clip>/<arr-scene> verbatim (they reach their host through the
 * shadow root and take a `.gridProvider`), plus the store's ordinary clip ops —
 * which address interior sub-clips unchanged because the interior lane is a
 * real Track with a globally-unique id (state/lane-resolve.ts).
 *
 * Deliberately NOT <arr-grid>: a sequence has exactly ONE lane, so there is no
 * track column, no reordering, no cross-track drag, no automation rows and no
 * group gutter — roughly a tenth of the grid's machinery. It also keeps its own
 * clip-local axis (ClipTimelineView) and NEVER touches the global caret: that
 * caret addresses top-level rows, and an interior lane id in it would leave
 * caretRowSpan() empty, which reads as "global" and silently widens ⌘E/⌘J/
 * Delete to the whole document.
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import type { Clip, Track } from '../model/composition';
import type { BeatGrid } from '../model/beat-grid';
import { ClipTimelineView } from './timeline-view';
import './arr-clip';
import './arr-scene';

const ROW_H = 56;

@customElement('arr-seq-lane')
export class ArrSeqLane extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      height: 100%;
      overflow: hidden;
    }
    .scroll {
      position: relative;
      height: 100%;
      overflow: hidden;
      background: var(--app-bg-color1);
    }
    canvas.grid {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .lane {
      position: absolute;
      left: 0;
      right: 0;
      top: 8px;
      height: ${ROW_H}px;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--app-text-color3);
      font-size: 12px;
      pointer-events: none;
    }
  `;

  /** The SEQUENCE clip whose interior this lane edits. */
  @property({ attribute: false }) clip!: Clip;
  /** Clip-local zoom/pan axis — owned by <arr-clip-view> and shared with its ruler. */
  @property({ attribute: false }) view!: ClipTimelineView;

  @query('canvas.grid') private gridCanvas?: HTMLCanvasElement;
  private ro?: ResizeObserver;

  // ── Duck-typed lane-host contract (mirrors <arr-grid>'s) ─────────────────
  /** Marks this host as a NESTED lane — <arr-clip> routes panel-pinning here. */
  readonly isNestedLane = true;
  /** No track-header gutter inside the panel. */
  get laneHeaderWidth(): number { return 0; }
  /** The clip-local beat↔px transform (passed down to every child clip). */
  gridProvider = (): BeatGrid => this.view.grid();
  /** Snap through the clip-local grid, not the arrangement's. */
  quantize(beat: number, free = false): number {
    return free ? Math.max(0, beat) : this.view.quantize(beat);
  }
  /** Edge caret → the LOCAL selection axis. Never store.setCaret (see the header). */
  setEdgeCaret(beat: number): void {
    this.view.setSelection(beat, beat);
  }

  private lane(): Track | undefined { return this.clip?.sequence; }

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.drawGrid());
    this.ro.observe(this);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }
  updated() { this.drawGrid(); }

  /** Beat/bar lines + the interior playhead. A stripped port of arr-grid's
   *  backdrop: one row, no warp, no loop brace, no time box. */
  private drawGrid() {
    const canvas = this.gridCanvas;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const grid = this.view.grid();
    const bpb = this.view.beatsPerBar;
    // Same step as this view's snap grid, so the interior lane snaps to what it draws.
    for (const line of grid.visibleBeatLines(w, bpb, this.view.snapStep)) {
      ctx.strokeStyle = line.isBar ? 'var(--app-tint-3)' : 'var(--app-tint-2)';
      ctx.globalAlpha = line.isBar ? 0.55 : line.isBeat ? 0.25 : 0.14;
      ctx.beginPath();
      ctx.moveTo(Math.round(line.x) + 0.5, 0);
      ctx.lineTo(Math.round(line.x) + 0.5, h);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Interior playhead: ClipTimelineView already wraps it for a looping clip.
    const p = this.view.positionBeat;
    if (p >= 0) {
      const x = grid.beatToX(p);
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = 'var(--app-accent)';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
      }
    }
  }

  // ── Drag: move a sub-clip within the lane ────────────────────────────────
  // Much smaller than arr-grid's: one lane, so no track resolution, no
  // cross-track reparenting, no time-box lift.
  private drag: {
    clipId: string;
    grabBeat: number;
    origStart: number;
    moved: boolean;
    duplicate: boolean;
  } | null = null;

  beginClipMove(e: PointerEvent, _laneId: string, clip: Clip, _fromHeader: boolean) {
    const laneId = this.lane()?.id;
    if (!laneId) return;
    this.drag = {
      clipId: clip.id,
      grabBeat: this.beatAt(e.clientX),
      origStart: clip.startBeat,
      moved: false,
      duplicate: e.metaKey || e.ctrlKey,
    };
    store.beginGesture();
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp, { once: true });
  }

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    const laneId = this.lane()?.id;
    if (!d || !laneId) return;
    const delta = this.beatAt(e.clientX) - d.grabBeat;
    if (!d.moved && Math.abs(delta * this.view.pxPerBeat) < 4) return; // activation
    d.moved = true;
    const target = this.quantize(Math.max(0, d.origStart + delta), e.altKey);
    if (d.duplicate) {
      const src = store.clipIn(laneId, d.clipId);
      if (src) store.insertClipCopyAt(src, laneId, target, `seqdup:${d.clipId}`);
    } else {
      store.moveClip(laneId, d.clipId, target);
    }
  };

  private onUp = () => {
    window.removeEventListener('pointermove', this.onMove);
    this.drag = null;
    store.endGesture();
  };

  /** Body drag / plain click: LOCAL range select + focus, never the global caret. */
  beginRegionFromClient(e: PointerEvent, clickFocusPath?: string) {
    store.setLastSurface('clipview');
    const anchor = this.beatAt(e.clientX);
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      this.view.setSelection(anchor, this.beatAt(ev.clientX));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      if (!moved) {
        this.view.setSelection(anchor, anchor);
        if (clickFocusPath) store.selectClipOnly(clickFocusPath);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  /** Clip-local beat under a client X. */
  private beatAt(clientX: number): number {
    const rect = this.getBoundingClientRect();
    return this.view.grid().xToBeat(clientX - rect.left);
  }

  /** ⌘E inside the panel: split the interior at the local caret. */
  splitAtLocalCaret() {
    const laneId = this.lane()?.id;
    if (laneId) store.splitLaneAt(laneId, this.view.selHeadBeat);
  }

  private onLaneDown = (e: PointerEvent) => {
    // Clicking empty lane space: local range select, and drop the clip focus.
    if (e.target !== e.currentTarget) return;
    this.beginRegionFromClient(e);
  };

  render() {
    const lane = this.lane();
    if (!lane) return html`<div class="empty">Not a sequence clip.</div>`;
    void store.docRev; // re-render on any document edit
    const isScene = lane.kind === 'scene';
    return html`
      <div class="scroll">
        <canvas class="grid"></canvas>
        <div class="lane" @pointerdown=${this.onLaneDown}>
          ${repeat(lane.clips, (c) => c.id, (c) => isScene
            ? html`<arr-scene
                     .trackId=${lane.id} .clip=${c}
                     .gridProvider=${this.gridProvider}></arr-scene>`
            : html`<arr-clip
                     .trackId=${lane.id} .clip=${c}
                     .gridProvider=${this.gridProvider}></arr-clip>`)}
        </div>
        ${lane.clips.length === 0
          ? html`<div class="empty">Empty sequence — drop or paste clips here.</div>`
          : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'arr-seq-lane': ArrSeqLane;
  }
}
