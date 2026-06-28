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
import { compositionLengthBeats } from '../model/composition';
import { RULER_HEIGHT } from './grid-shared';
import { mainTimelineView, ClipTimelineView, type RulerView } from './timeline-view';
import '../../../widgets/ui-icon';

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
      padding: 0 5px;
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
    /* Zoom −/+ float over the right edge of the ruler (no longer in the corner). */
    .zoomfloat {
      position: absolute;
      top: 50%;
      right: 6px;
      transform: translateY(-50%);
      display: flex;
      gap: var(--app-sp-2);
      z-index: 4;
    }
    .zoomfloat button {
      font-family: inherit;
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      width: 18px;
      height: 16px;
      padding: 0;
      cursor: pointer;
      line-height: 1;
      opacity: 0.85;
      display: flex;
      align-items: center;
      justify-content: center;
      --icon-size: 12px;
    }
    .zoomfloat button:hover {
      background: var(--app-tint-2);
      opacity: 1;
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
    // Track the raw loop range + enabled flag too: `v.loop` is null while disabled
    // (so it stops tracking start/end), but we still draw the markers then.
    void store.loopEnabled; void store.loopStartBeat; void store.loopEndBeat;
    void store.playing; // play state gates the playhead sweep bar
    void v.timeSel;
    void v.beatsPerBar;
    void v.headerWidth;
    return html`
      <div class="wrap">
        ${this.compact
          ? ''
          : html`<div class="corner" style="width:${v.headerWidth}px">
          <button
            class="addtrack"
            title="Group the selected tracks (or add a group with one empty track)"
            @click=${() => store.addGroup()}
          >
            + Group
          </button>
          <button
            class="addtrack"
            title="Add a return (value-only rail) channel"
            @click=${() => store.addReturn()}
          >
            + Return
          </button>
          <button
            class="addtrack"
            title="Add a track after the last selected track"
            @click=${() => store.addTrackAfterSelection()}
          >
            + Track
          </button>
          ${store.selectedSingleGroupId
            ? html`<button
                class="addtrack"
                title="Dissolve the group (its tracks move up a level)"
                @click=${() => store.ungroup(store.selectedSingleGroupId!)}
              >
                Ungroup
              </button>`
            : ''}
        </div>`}
        <div
          class="time"
          @pointerdown=${this.onDown}
          @pointermove=${this.onMove}
          @pointerup=${this.onUp}
          @pointercancel=${this.onUp}
          @dblclick=${this.onDblClick}
          @wheel=${this.onWheel}
        >
          <canvas></canvas>
          ${this.compact
            ? ''
            : html`<div class="zoomfloat">
                <button
                  title="Zoom out"
                  @pointerdown=${(e: Event) => e.stopPropagation()}
                  @dblclick=${(e: Event) => e.stopPropagation()}
                  @click=${() => this.zoomCenter(1 / 1.3)}
                ><ui-icon icon="la-search-minus"></ui-icon></button>
                <button
                  title="Zoom in"
                  @pointerdown=${(e: Event) => e.stopPropagation()}
                  @dblclick=${(e: Event) => e.stopPropagation()}
                  @click=${() => this.zoomCenter(1.3)}
                ><ui-icon icon="la-search-plus"></ui-icon></button>
              </div>`}
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

    // Loop markers (main timeline only — the compact editor ruler has no loop).
    // Drawn even when the loop is DISABLED, so you can see where it's parked: in that
    // case the markers use a dimmed colour and the brace bar BETWEEN them is omitted.
    if (!this.compact) {
      const on = store.loopEnabled;
      const x0 = grid.beatToX(store.loopStartBeat);
      const x1 = grid.beatToX(store.loopEndBeat);
      if (on) {
        // Shaded band across the full ruler height between the markers, with a
        // brighter brace bar at the top (enabled only).
        ctx.fillStyle = 'rgba(88,196,130,0.14)';
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.fillStyle = 'rgba(88,196,130,0.55)';
        ctx.fillRect(x0, 0, x1 - x0, 6);
      }
      ctx.fillStyle = on ? 'rgba(88,196,130,0.9)' : 'rgba(120,150,135,0.4)';
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

    // Play-from / insert marker (white triangle) — at the TOP, pointing down.
    const fx = grid.beatToX(v.playFromBeat);
    if (v.playFromBeat >= 0 && fx >= -6 && fx <= w + 6) {
      ctx.fillStyle = '#EAEAEA';
      ctx.beginPath();
      ctx.moveTo(fx - 4, 0);
      ctx.lineTo(fx + 4, 0);
      ctx.lineTo(fx, 7);
      ctx.closePath();
      ctx.fill();
    }

    // Playhead: the orange head triangle (always) — its vertical sweep bar only
    // shows WHILE PLAYING (matching the main timeline's orange line).
    const px = grid.beatToX(v.positionBeat);
    if (v.positionBeat >= 0 && px >= 0 && px <= w) {
      ctx.fillStyle = '#FF8C00';
      if (store.playing) ctx.fillRect(Math.round(px), 0, 2, h);
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
    // Navigation surface only — pointer interaction never moves the playhead/caret.
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
    // Navigation surface only — a click does NOT move the playhead/caret.
  };

  /**
   * Double-click: zoom + pan so the relevant content fills the view (small margin
   * each side). Arrangement context fits beat 0 → the furthest clip end across all
   * tracks; the clip-details (envelope) context fits the clip's local 0 → span.
   */
  private onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    const v = this.view;
    const w = this.timeEl?.clientWidth ?? 0;
    if (w <= 0) return;

    // Content beat range in this view's beat space.
    let rangeStart = 0;
    let rangeEnd: number;
    if (v instanceof ClipTimelineView) {
      // Clip-envelope context: fit the clip's local extents (0 .. span).
      rangeEnd = v.spanBeats;
    } else {
      // Arrangement context: 0 .. furthest clip end across ALL tracks.
      let maxEnd = 0;
      let hasClip = false;
      for (const t of store.composition.tracks) {
        for (const c of t.clips) {
          maxEnd = Math.max(maxEnd, c.startBeat + c.lengthBeat);
          hasClip = true;
        }
      }
      rangeEnd = hasClip ? maxEnd : compositionLengthBeats(store.composition);
      // Also frame the loop markers (always, regardless of loopEnabled).
      rangeEnd = Math.max(rangeEnd, store.loopEndBeat);
      rangeStart = Math.min(rangeStart, store.loopStartBeat);
      rangeStart = Math.max(0, rangeStart);
    }
    if (!(rangeEnd > rangeStart)) return;

    // Work in warped units so the fit is exact under the warp curve (units == beats
    // for the straight clip view). beatToX(beat) = (unitsAt(beat) - scroll) * ppb,
    // so placing `units` at the left edge means scrollUnits = units.
    const grid = v.grid();
    const u0 = grid.curve.unitsAt(rangeStart);
    const u1 = grid.curve.unitsAt(rangeEnd);
    const span = Math.max(0.25, u1 - u0);
    const margin = 0.05; // 5% breathing room each side
    v.setZoom(w / (span * (1 + 2 * margin)));
    v.setScrollUnits(u0 - margin * span);
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
