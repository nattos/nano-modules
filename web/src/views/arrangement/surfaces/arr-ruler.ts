/**
 * <arr-ruler> — Ableton-style scrub/zoom ruler.
 *
 * Renders the WARPED bar/beat grid (lines clump/spread, Innovation 1). The
 * famously-confusing zoom model: drag the ruler — horizontal pans, vertical
 * zooms (up = in, down = out), anchored under the cursor. A click sets the
 * playhead. The loop brace lives here.
 */

import { html, css } from 'lit';
import { customElement, query, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { RULER_HEIGHT } from './grid-shared';
import { mainTimelineView, type RulerView } from './timeline-view';

@customElement('arr-ruler')
export class ArrRuler extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      height: ${RULER_HEIGHT}px;
      background: var(--app-bg-color2);
      border-bottom: 1px solid var(--app-tint-3);
    }
    .wrap {
      position: relative;
      height: 100%;
      display: flex;
    }
    .corner {
      box-sizing: border-box;
      flex-shrink: 0;
      border-right: 1px solid var(--app-tint-3);
      display: flex;
      align-items: center;
      gap: var(--app-sp-2);
      padding: 0 var(--app-sp-3);
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
    }
    .corner button {
      font-family: inherit;
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      width: 18px;
      height: 16px;
      cursor: pointer;
      line-height: 1;
    }
    .corner button:hover {
      background: var(--app-tint-2);
    }
    .corner button.addtrack {
      width: auto;
      padding: 0 6px;
      color: var(--app-text-color1);
      white-space: nowrap;
      font-size: var(--app-fs-xs);
    }
    .time {
      position: relative;
      flex: 1;
      min-width: 0;
      cursor: ew-resize;
      touch-action: none;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
  `;

  /** Zoom/pan/scrub model. Defaults to the main (warped, global) timeline; the
   *  clip-details editor passes a clip-local ClipTimelineView. */
  @property({ attribute: false }) view: RulerView = mainTimelineView;
  /** Hide the main-timeline corner chrome (zoom buttons + Track/Return) so the
   *  ruler spans the full width — used by the clip-details editor. */
  @property({ type: Boolean }) compact = false;

  @query('canvas') private canvas!: HTMLCanvasElement;
  @query('.time') private timeEl!: HTMLDivElement;
  private ro?: ResizeObserver;
  private dragging = false;
  private moved = 0;
  private lastY = 0;
  /** Warped-units position grabbed at pointerdown — stays anchored all gesture. */
  private anchorUnits = 0;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.timeEl);
    this.draw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }
  updated() {
    this.draw();
  }

  render() {
    // Touch the view's observables so MobX re-renders → updated() redraws.
    const v = this.view;
    void v.pxPerBeat;
    void v.scrollUnits;
    void v.positionBeat;
    void v.playFromBeat;
    void v.loop;
    void v.timeSel;
    void v.beatsPerBar;
    void v.headerWidth;
    return html`
      <div class="wrap">
        ${this.compact
          ? ''
          : html`<div class="corner" style="width:${v.headerWidth}px">
          <button title="Zoom out" @click=${() => this.zoomCenter(1 / 1.3)}>−</button>
          <button title="Zoom in" @click=${() => this.zoomCenter(1.3)}>+</button>
          <button
            class="addtrack"
            title="Add a track after the last selected track"
            @click=${() => store.addTrackAfterSelection()}
          >
            + Track
          </button>
          <button
            class="addtrack"
            title="Add a return (value-only rail) channel"
            @click=${() => store.addReturn()}
          >
            + Return
          </button>
        </div>`}
        <div
          class="time"
          @pointerdown=${this.onDown}
          @pointermove=${this.onMove}
          @pointerup=${this.onUp}
          @pointercancel=${this.onUp}
          @wheel=${this.onWheel}
        >
          <canvas></canvas>
        </div>
      </div>
    `;
  }

  private draw() {
    const canvas = this.canvas;
    const el = this.timeEl;
    if (!canvas || !el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const v = this.view;
    const grid = v.grid();
    const beatsPerBar = v.beatsPerBar;

    // Loop brace (main timeline only).
    const loop = v.loop;
    if (loop) {
      const x0 = grid.beatToX(loop.start);
      const x1 = grid.beatToX(loop.end);
      ctx.fillStyle = 'rgba(65,105,225,0.18)';
      ctx.fillRect(x0, 0, x1 - x0, 6);
      ctx.fillStyle = 'rgba(65,105,225,0.8)';
      ctx.fillRect(x0, 0, 2, h);
      ctx.fillRect(x1 - 2, 0, 2, h);
    }

    // Beat/bar lines. Stride: only bar lines when zoomed out.
    const stride = v.pxPerBeat >= 13 ? 1 : beatsPerBar;
    const lines = grid.visibleBeatLines(w, beatsPerBar, stride);
    ctx.font =
      "9px 'JetBrains Mono','SF Mono',Menlo,monospace";
    ctx.textBaseline = 'bottom';
    for (const ln of lines) {
      if (ln.x < -40 || ln.x > w + 40) continue;
      ctx.strokeStyle = ln.isBar ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(Math.round(ln.x) + 0.5, ln.isBar ? 8 : 16);
      ctx.lineTo(Math.round(ln.x) + 0.5, h);
      ctx.stroke();
      if (ln.isBar) {
        const barNum = Math.floor(ln.beat / beatsPerBar) + 1;
        ctx.fillStyle = '#C8C8C8';
        ctx.fillText(String(barNum), Math.round(ln.x) + 3, h - 2);
      }
    }

    // Time-region selection highlight (main timeline only).
    const sel = v.timeSel;
    if (sel) {
      const rx0 = grid.beatToX(sel.start);
      const rx1 = grid.beatToX(sel.end);
      ctx.fillStyle = 'rgba(65,105,225,0.18)';
      ctx.fillRect(rx0, 0, rx1 - rx0, h);
      ctx.fillStyle = 'rgba(65,105,225,0.9)';
      ctx.fillRect(rx0, h - 3, rx1 - rx0, 3);
    }

    // Play-from / insert marker (hollow triangle).
    const fx = grid.beatToX(v.playFromBeat);
    if (v.playFromBeat >= 0 && fx >= -6 && fx <= w + 6) {
      ctx.fillStyle = '#EAEAEA';
      ctx.beginPath();
      ctx.moveTo(fx, h - 1);
      ctx.lineTo(fx - 4, h - 8);
      ctx.lineTo(fx + 4, h - 8);
      ctx.closePath();
      ctx.fill();
    }

    // Playhead.
    const px = grid.beatToX(v.positionBeat);
    if (v.positionBeat >= 0 && px >= 0 && px <= w) {
      ctx.fillStyle = '#FF8C00';
      ctx.fillRect(Math.round(px), 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(px - 4, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px + 0.5, 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  private localX(e: PointerEvent): number {
    return e.clientX - this.timeEl.getBoundingClientRect().left;
  }

  /** +/- buttons: zoom anchored at the center of the viewport. */
  private zoomCenter(factor: number) {
    const w = this.timeEl?.clientWidth ?? 0;
    this.view.zoomAnchored(factor, w / 2);
  }

  private onDown = (e: PointerEvent) => {
    this.dragging = true;
    this.moved = 0;
    this.lastY = e.clientY;
    const v = this.view;
    const grid = v.grid();
    // Scrub: move the cursor immediately on pointerdown (not just on click-up).
    v.setPlayFrom(v.quantize(grid.xToBeat(this.localX(e))));
    // Capture the content position under the cursor — it stays anchored there
    // for the whole gesture, so hitting the scroll endpoint never drifts.
    this.anchorUnits = v.scrollUnits + this.localX(e) / v.pxPerBeat;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const v = this.view;
    const dy = e.clientY - this.lastY;
    this.lastY = e.clientY;
    this.moved += Math.abs(e.movementX) + Math.abs(dy);

    // Vertical zoom first (changes pxPerBeat), then re-pin the anchor under the
    // current cursor X. One absolute computation per move → no drift.
    // Drag DOWN (dy > 0) zooms IN.
    if (dy) v.setZoom(v.pxPerBeat * Math.exp(dy * 0.006));
    v.setScrollUnits(this.anchorUnits - this.localX(e) / v.pxPerBeat);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // A click (negligible movement) sets the play-from marker.
    if (this.moved < 4) {
      const v = this.view;
      v.setPlayFrom(v.quantize(v.grid().xToBeat(this.localX(e))));
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const v = this.view;
    if (e.ctrlKey || e.metaKey) {
      const cursorX = e.clientX - this.timeEl.getBoundingClientRect().left;
      v.zoomAnchored(Math.exp(-e.deltaY * 0.002), cursorX);
    } else {
      v.scrollBy(e.deltaY / v.pxPerBeat);
    }
  };
}
