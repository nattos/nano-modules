/**
 * <arr-grid> — the arrangement: left track headers + right lanes with the
 * warped grid drawn behind clips. The main-bus group is pinned to the bottom
 * (Ableton-style). Double-clicking an empty lane creates an empty effect-only
 * clip; dragging empty space marquee-selects; a plain click sets the play-from
 * marker. Automation lanes show when the global Automation mode is on.
 *
 * Horizontal navigation is entirely via the warped beat transform (zoom +
 * scrollUnits in the store); only vertical scrolling is native.
 */

import { html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store, paths, GROUP_INDENT } from '../state/store';
import {
  buildBeatGrid,
  ROW_HEIGHT,
  AUTO_LANE_HEIGHT,
} from './grid-shared';
import { Track, Clip, AutomationLane, derivedWarpSegments, compositionLengthBeats } from '../model/composition';
import { warpDeviationAt } from '../model/beat-grid';
import { setAnchor, AnchorKeys } from './anchor-registry';
import '../../../widgets/editable-label';
import './arr-clip';
import './arr-mixer-strip';
import './arr-rail-lane';
import './arr-automation-editor';
import '../../../widgets/ui-icon';

@customElement('arr-grid')
export class ArrGrid extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      overflow: hidden;
      position: relative;
    }
    .scroll {
      position: relative;
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      /* Belt-and-suspenders against the browser swipe-back gesture (the JS
         axis-lock in onWheel is the primary guard). */
      overscroll-behavior-x: none;
    }
    /* Drag handle to resize the track-header column. */
    .header-resize {
      position: absolute;
      top: 0;
      bottom: 0;
      left: var(--arr-hw, 184px);
      width: 7px;
      margin-left: -3px;
      cursor: ew-resize;
      z-index: 6;
    }
    .header-resize:hover {
      background: var(--app-hi-color2);
      opacity: 0.4;
    }
    .grid-canvas {
      position: absolute;
      top: 0;
      left: var(--arr-hw, 184px);
      pointer-events: none;
      z-index: 0;
    }
    /* Playhead + time-region composite ABOVE clips. */
    .grid-canvas-top {
      position: absolute;
      top: 0;
      left: var(--arr-hw, 184px);
      pointer-events: none;
      z-index: 4;
    }
    .rows {
      position: relative;
      z-index: 1;
    }
    .row {
      display: flex;
      height: ${ROW_HEIGHT}px;
      /* border-box so the 1px divider is INSIDE the row height — else each row
         renders ROW_HEIGHT+1 and the marquee / row hit-test drift 1px per row. */
      box-sizing: border-box;
      border-bottom: 1px solid var(--app-tint-2);
    }
    .row.auto {
      height: ${AUTO_LANE_HEIGHT}px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--app-tint-2);
    }
    .row.bus {
      border-top: 2px solid var(--app-tint-4);
    }
    .header {
      width: var(--arr-hw, 184px);
      position: relative; /* group lines are absolutely positioned within */
      flex-shrink: 0;
      box-sizing: border-box;
      border-right: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: var(--app-sp-2) 0; /* horizontal indent is per-row (own depth / gutter) */
      cursor: pointer;
      overflow: visible; /* let the group bar bleed 1px over the row border to connect */
    }
    /* Per-depth vertical group lines, one column (GROUP_INDENT) each, drawn in the
       left gutter behind the content (which is indented past them). */
    .gline {
      position: absolute;
      top: 0;
      bottom: 0;
      width: ${GROUP_INDENT}px;
      cursor: pointer;
      z-index: 1;
    }
    /* One continuous bar per group: each row's segment spans the full row height so
       adjacent segments connect; the group's first/last rows inset the ends. Hairline
       by default (like a border); width grows on hover (whole group) and selection. */
    .gline::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: -1px; /* bleed over the 1px row border so segments connect */
      left: 50%;
      width: 1px;
      transform: translateX(-50%);
      background: var(--gline, var(--app-tint-4));
      opacity: 0.5;
    }
    .gline.start::before {
      top: 3px;
    }
    .gline.end::before {
      bottom: 3px; /* the last row insets the end (no border to bridge below it) */
    }
    /* Hover lights up EVERY segment of the group (driven by hoveredGroupId). */
    .gline.hover::before {
      width: 2px;
      opacity: 0.85;
    }
    /* Selected group: a clearly thicker, full-strength bar. */
    .gline.on::before {
      width: 3px;
      opacity: 1;
    }
    .header.selected {
      box-shadow: inset 2px 0 0 var(--app-hi-color2);
    }
    .h-top {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding-right: var(--app-sp-3);
    }
    .h-bottom {
      padding-right: var(--app-sp-3);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tname {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .sb {
      flex-shrink: 0;
      width: 16px;
      height: 14px;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      background: var(--app-bg-color1);
      color: var(--app-text-color2);
      font-size: 8px;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .sb.solo.on {
      border-color: var(--app-warn);
      color: var(--app-warn);
      background: rgba(214, 161, 60, 0.15);
    }
    .sb.bypass.on {
      border-color: var(--app-error);
      color: var(--app-error);
      background: rgba(224, 108, 108, 0.12);
    }
    .h-bottom {
      display: flex;
      align-items: center;
      gap: 5px;
      overflow: hidden;
    }
    .h-bottom arr-mixer-strip {
      flex: 1;
      min-width: 0;
    }
    /* Automation-mode header: selected field label + pin button. */
    .auto-pick {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--app-cat-mod);
      font-size: var(--app-fs-xs);
    }
    .auto-pick .apf {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sb.pin {
      --icon-size: 11px;
      color: var(--app-cat-mod);
      border-color: var(--app-cat-mod);
    }
    .sb.pin:hover { background: rgba(120, 110, 200, 0.18); }
    .fxcount {
      font-size: 8px;
      color: var(--app-text-color2);
      white-space: nowrap;
      flex-shrink: 0;
      opacity: 0.8;
    }
    .railico {
      --icon-size: 11px;
      color: var(--app-cat-mod);
      flex-shrink: 0;
    }
    .rtag {
      font-size: 8px;
      padding: 0 4px;
      border-radius: 2px;
      border: 1px solid var(--app-cat-mod);
      color: var(--app-cat-mod);
      flex-shrink: 0;
    }
    .railrange {
      font-size: 8px;
      color: var(--app-text-color2);
      font-variant-numeric: tabular-nums;
    }
    .lane.rail {
      background: rgba(70, 194, 194, 0.03);
    }
    .row.beatwarp {
      border-top: 1px solid var(--app-tint-3);
    }
    .lane.beatwarp-lane {
      position: relative;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      background: rgba(160, 124, 224, 0.05);
    }
    .lane.beatwarp-lane svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .dchip {
      font-size: 8px;
      padding: 0 4px;
      border-radius: 2px;
      background: var(--app-tint-2);
      color: var(--app-text-color2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lane {
      position: relative;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    /* Selected track-field automation envelope, drawn over the clips. */
    /* Editable automation overlay over a track's clip row (covers the clips so
       the row edits automation, not clips). */
    .track-auto-edit {
      position: absolute;
      inset: 0;
      z-index: 3;
      pointer-events: auto;
    }
    .track-auto-edit arr-automation-editor {
      display: block;
      width: 100%;
      height: 100%;
    }
    .lane.bypassed {
      opacity: 0.4;
    }
    .lane.soloed {
      background: rgba(214, 161, 60, 0.05);
    }
    .lane.group {
      background: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 7px,
        var(--app-tint-1) 7px,
        var(--app-tint-1) 8px
      );
    }
    .auto-header {
      width: var(--arr-hw, 184px);
      position: relative; /* group lines absolutely positioned within */
      flex-shrink: 0;
      box-sizing: border-box;
      border-right: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
      display: flex;
      overflow: visible; /* let the group bar bleed over the row border to connect */
    }
    /* The auto lane belongs to its track, so it carries the track's group lines;
       the label indents only to the track's OWN depth (as far left as possible). */
    .auto-header-label {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      padding: 2px var(--app-sp-3) 2px 0;
      display: flex;
      align-items: center;
      font-size: var(--app-fs-xs);
      color: var(--app-cat-mod);
      gap: 4px;
      --icon-size: 10px;
      overflow: hidden;
    }
    .auto-header-label span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .auto-lane {
      position: relative;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .auto-lane svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .empty-hint {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      opacity: 0.5;
      pointer-events: none;
    }
    .timebar {
      position: absolute;
      bottom: 8px;
      top: auto;
      left: calc(var(--arr-hw, 184px) + 8px);
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 5px;
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      background: rgba(20, 22, 28, 0.94);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
    .timebar .trange {
      font-size: var(--app-fs-xs);
      color: var(--app-hi-color2);
      font-variant-numeric: tabular-nums;
      padding: 0 4px;
    }
    .timebar button {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 2px 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      --icon-size: 10px;
    }
    .timebar button:hover {
      background: var(--app-tint-2);
    }
    .header.dragsrc {
      opacity: 0.5;
    }
    /* Insertion indicator while reordering track headers. */
    .reorder-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--app-hi-color2);
      box-shadow: 0 0 4px var(--app-hi-color2);
      z-index: 6;
      pointer-events: none;
    }
    /* Clip cross-track drop target highlight. */
    .lane.dropok {
      box-shadow: inset 0 0 0 1px var(--app-hi-color2);
      background: rgba(65, 105, 225, 0.06);
    }
  `;

  /** Drop target while dragging a track header: which sibling to land before
   *  (null = last child of `parentId`) and which group to land in (null = top). */
  @state() private reorderDrop: { beforeId: string | null; parentId: string | null } | null = null;
  @state() private reorderActive = false;
  /** Group whose vertical bar is being hovered — highlights ALL of its segments. */
  @state() private hoveredGroupId: string | null = null;
  /** Lane highlighted as the destination of a cross-track clip drag. */
  @state() private clipDropTrackId: string | null = null;

  @query('.scroll') private scrollEl!: HTMLDivElement;
  @query('.grid-canvas') private canvas!: HTMLCanvasElement;
  @query('.grid-canvas-top') private canvasTop!: HTMLCanvasElement;
  private ro?: ResizeObserver;
  /** Per-gesture wheel ENGAGE latch: once a gesture shows a real horizontal
   *  component we own it (pan BOTH axes + kill swipe-back) for its duration; a
   *  purely-vertical gesture stays native. See onWheel. */
  private wheelEngaged = false;
  private wheelIdleTimer = 0;
  /** Scroll viewport height (px) — drives the trailing scroll-past pad; updated by
   *  the ResizeObserver so the pad grows/shrinks with the panel. */
  @state() private viewportH = 0;
  /** Last-seen automation mode + a pending scroll anchor, so toggling automation
   *  keeps a track pinned in the viewport (captured pre-relayout, restored after). */
  private autoModeSeen = false;
  private pendingAnchor: { ids: string[]; offset: number } | null = null;

  firstUpdated() {
    this.ro = new ResizeObserver(() => { if (this.scrollEl) this.viewportH = this.scrollEl.clientHeight; this.draw(); });
    this.ro.observe(this.scrollEl);
    this.viewportH = this.scrollEl.clientHeight;
    this.scrollEl.addEventListener('wheel', this.onWheel, { passive: false });
    this.draw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }
  /** Before a re-render: if automation mode is flipping, capture a scroll anchor
   *  from the CURRENT (pre-relayout) DOM so we can re-pin it after the lanes
   *  appear/disappear. */
  willUpdate() {
    const mode = store.automationMode;
    if (this.hasUpdated && mode !== this.autoModeSeen) {
      this.pendingAnchor = this.captureScrollAnchor();
    }
    this.autoModeSeen = mode;
  }

  updated() {
    // Drive the (drag-resizable) track-header column width through a CSS var the
    // styles read (var(--arr-hw)); the canvas geometry reads store.headerWidth.
    this.style.setProperty('--arr-hw', `${store.headerWidth}px`);
    this.restoreScrollAnchor(); // re-pin a track across an automation-mode toggle
    this.draw();
    // Wire anchors for the main bus lane and (when shown) the beat-warp lane.
    setAnchor(AnchorKeys.mainbus(), this.renderRoot.querySelector('.lane.group'));
    setAnchor(AnchorKeys.beatwarp(), this.renderRoot.querySelector('.beatwarp-lane'));
    const tgt = store.consumeScrollTarget();
    if (tgt) this.scrollClipIntoView(tgt);
  }

  /** A track row's vertical position relative to the scroll viewport top (px). */
  private rowRectVp(id: string, vpTop: number): { top: number; bottom: number; mid: number } | null {
    const el = this.renderRoot.querySelector(`.row[data-track-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top - vpTop, bottom: r.bottom - vpTop, mid: (r.top + r.bottom) / 2 - vpTop };
  }

  /** Choose tracks to anchor on + their average midpoint (viewport offset, px):
   *  the SELECTED tracks currently in view, else the FIRST track fully in view. */
  private captureScrollAnchor(): { ids: string[]; offset: number } | null {
    const scroll = this.scrollEl;
    if (!scroll) return null;
    const vpTop = scroll.getBoundingClientRect().top;
    const vpH = scroll.clientHeight;
    const inView = (r: { top: number; bottom: number }) => r.bottom > 0 && r.top < vpH;

    const sel = store.selectedTrackIds
      .map((id) => ({ id, r: this.rowRectVp(id, vpTop) }))
      .filter((x): x is { id: string; r: { top: number; bottom: number; mid: number } } => !!x.r && inView(x.r));

    let picked = sel;
    if (!picked.length) {
      for (const t of store.displayTracks) {
        const r = this.rowRectVp(t.id, vpTop);
        if (r && r.top >= -0.5 && r.bottom <= vpH + 0.5) { picked = [{ id: t.id, r }]; break; }
      }
    }
    if (!picked.length) return null;
    const offset = picked.reduce((a, p) => a + p.r.mid, 0) / picked.length;
    return { ids: picked.map((p) => p.id), offset };
  }

  /** After the relayout: nudge scrollTop so the captured anchor's average midpoint
   *  sits at the same viewport offset it had before the toggle. */
  private restoreScrollAnchor() {
    const a = this.pendingAnchor;
    if (!a) return;
    this.pendingAnchor = null;
    const scroll = this.scrollEl;
    if (!scroll) return;
    const vpTop = scroll.getBoundingClientRect().top;
    const mids = a.ids.map((id) => this.rowRectVp(id, vpTop)?.mid).filter((v): v is number => v != null);
    if (!mids.length) return;
    const newOffset = mids.reduce((x, y) => x + y, 0) / mids.length;
    scroll.scrollTop += newOffset - a.offset;
  }

  private renderBeatWarpRow() {
    const grid = buildBeatGrid();
    const segs = derivedWarpSegments(store.composition);
    const w = this.scrollEl ? this.scrollEl.clientWidth - store.headerWidth : 600;
    const h = ROW_HEIGHT;
    const pts: string[] = [];
    for (let x = 0; x <= w; x += 4) {
      const dev = warpDeviationAt(segs, grid.xToBeat(x));
      pts.push(`${x},${(h / 2 - dev * (h * 0.4)).toFixed(1)}`);
    }
    return html`
      <div class="row beatwarp">
        <div class="header">
          <span class="caret"></span>
          <span class="dot" style="background:var(--app-cat-warp)"></span>
          <span class="tname">Beat Warp</span>
          <span class="rtag" style="border-color:var(--app-cat-warp);color:var(--app-cat-warp)">warp</span>
        </div>
        <div class="lane beatwarp-lane">
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            <line x1="0" y1=${h / 2} x2=${w} y2=${h / 2} stroke="rgba(255,255,255,0.1)" />
            <polyline points=${pts.join(' ')} fill="none" stroke="var(--app-cat-warp)" stroke-width="1.5" />
          </svg>
        </div>
      </div>
    `;
  }

  private scrollClipIntoView(tgt: { clipPath: string }) {
    const el = Array.from(this.renderRoot.querySelectorAll('arr-clip')).find(
      (e: any) => e.clip && `clip/${e.trackId}/${e.clip.id}` === tgt.clipPath,
    ) as any;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    const grid = buildBeatGrid();
    const x = grid.beatToX(el.clip.startBeat);
    const laneW = this.scrollEl.clientWidth - store.headerWidth;
    if (x < 0 || x > laneW - 60) {
      store.setScrollUnits(Math.max(0, grid.curve.unitsAt(el.clip.startBeat) - 2));
    }
  }

  private contentHeight(tracks: Track[]): number {
    let h = 0;
    for (const t of tracks) {
      h += ROW_HEIGHT;
      if (store.automationMode) h += t.automation.length * AUTO_LANE_HEIGHT;
    }
    if (store.automationMode) h += ROW_HEIGHT; // beat-warp row
    return h;
  }

  render() {
    void store.pxPerBeat;
    void store.scrollUnits;
    void store.positionBeat;
    void store.playFromBeat;
    void store.automationMode;
    void store.timeSelStart;
    void store.timeSelEnd;
    void store.timeSelTrackIds.length;
    void store.selectedWireId;
    void store.selection.size;
    void store.headerWidth; // re-render (→ updated() resets --arr-hw) on resize

    const tracks = store.displayTracks;
    const totalH = this.contentHeight(tracks);

    return html`
      <div class="scroll" @pointerdown=${this.onScrollDown}>
        <canvas class="grid-canvas" style="height:${totalH}px"></canvas>
        <div class="rows">
          ${tracks.map((t) => this.renderTrack(t))}
          ${store.automationMode ? this.renderBeatWarpRow() : ''}
          ${this.reorderActive ? this.renderReorderLine() : ''}
          <!-- Trailing space so the timeline scrolls DOWN past the main bus (bring
               the bottom-most lanes up to the top of the viewport). -->
          <div class="rows-pad" style="height:${Math.max(120, this.viewportH - ROW_HEIGHT)}px"></div>
        </div>
        <canvas class="grid-canvas-top" style="height:${totalH}px"></canvas>
      </div>
      <div class="header-resize" @pointerdown=${this.onHeaderResize}></div>
      ${this.renderTimeToolbar()}
    `;
  }

  private onHeaderResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement;
    const left = this.getBoundingClientRect().left;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => store.setHeaderWidth(ev.clientX - left);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  private renderTimeToolbar() {
    // Always visible, pinned to the bottom of the timeline (above the clip
    // panel when open). With no time selection it shows the play-from cursor.
    if (!store.hasTimeSelection) {
      const nScope = store.caretTrackIds.length;
      const slice = nScope === 0 ? 'all tracks' : `${nScope} track${nScope === 1 ? '' : 's'}`;
      return html`
        <div class="timebar">
          <span class="trange">▸ play from ${store.playFromBeat.toFixed(2)}b · ${slice}</span>
          <button @click=${() => store.splitAtCursor()} title="Split clips at the cursor">
            <ui-icon icon="la-cut"></ui-icon> Split
          </button>
        </div>
      `;
    }
    const a = store.timeSelStart!;
    const b = store.timeSelEnd;
    const nScope = store.timeSelTrackIds.length;
    const scope = nScope === 0 ? 'all tracks' : `${nScope} track${nScope === 1 ? '' : 's'}`;
    return html`
      <div class="timebar">
        <span class="trange">
          ${a.toFixed(2)}–${b.toFixed(2)} · ${(b - a).toFixed(2)}b · ${scope}
        </span>
        <button @click=${() => store.splitAtRegion()} title="Split clips at region edges">
          <ui-icon icon="la-cut"></ui-icon> Split
        </button>
        <button @click=${() => store.clearTime()} title="Delete (leave empty time)">
          <ui-icon icon="la-eraser"></ui-icon> Delete
        </button>
        <button @click=${() => store.insertTime()} title="Insert blank time (ripple)">
          <ui-icon icon="la-arrows-alt-h"></ui-icon> Insert Time
        </button>
        <button @click=${() => store.deleteTime()} title="Delete time (ripple)">
          <ui-icon icon="la-backspace"></ui-icon> Delete Time
        </button>
        <button @click=${() => store.clearTimeSelection()} title="Clear region">
          <ui-icon icon="la-times"></ui-icon>
        </button>
      </div>
    `;
  }

  private renderTrack(track: Track) {
    const isGroup = track.kind === 'group';
    const isBus = store.isMainBus(track);
    const isRail = track.kind === 'rail';
    const selected = store.isTrackShownSelected(track.id);
    const dragSrc = this.reorderActive && this.draggedTrackId === track.id;
    const accent = track.color ?? 'var(--app-cat-control)';
    // Indentation: the OPACITY FADER aligns to the global max group depth (so all
    // faders share a width); EVERYTHING ELSE (name row, and the selected-automation
    // label) indents only to THIS track's own depth — as far left as it can go.
    const ownDepth = isBus ? 0 : store.trackDepth(track);
    // A group draws its OWN vertical bar in its column, so its content sits one
    // indent deeper (past that bar); leaves/rails indent to their own depth.
    const contentDepth = ownDepth + (isGroup && !isBus ? 1 : 0);
    const ownIndent = contentDepth * GROUP_INDENT;
    const autoSel = store.automationMode && !isBus && !isRail && !!store.autoField(`track/${track.id}`);
    const bottomIndent = autoSel ? ownIndent : store.groupGutterWidth;
    // Touch the clips array structure SYNCHRONOUSLY so the MobX reaction tracks
    // add/remove/move/undo — the repeat() directive below evaluates its template
    // lazily (during commit), which is outside the reaction's tracking window.
    for (const c of track.clips) void c.id;

    return html`
      <div class="row ${isBus ? 'bus' : ''}" data-track-id=${track.id}>
        <div
          class="header ${isGroup ? 'group' : ''} ${selected ? 'selected' : ''} ${dragSrc ? 'dragsrc' : ''}"
          @pointerdown=${(e: PointerEvent) => this.onHeaderDown(e, track)}
          @dblclick=${(e: MouseEvent) => this.onHeaderDblClick(e, track)}
        >
          ${this.renderGroupLines(track, isBus)}
          <div class="h-top" style="padding-left: calc(var(--app-sp-3) + ${ownIndent}px)">
            ${isRail
              ? html`<ui-icon class="railico" icon="la-exchange-alt"></ui-icon>`
              : ''}
            <span class="dot" style="background:${accent}"></span>
            ${isBus || isRail
              ? html`<span class="tname">${isBus ? '▸ ' + track.name : store.trackDisplayName(track)}</span>`
              : html`<editable-label
                  class="tname"
                  .value=${track.name}
                  .displayValue=${store.trackDisplayName(track)}
                  placeholder="Untitled track"
                  @commit=${(e: CustomEvent) => store.renameTrack(track.id, e.detail)}
                ></editable-label>`}
            ${isRail
              ? html`<span class="rtag">return</span>`
              : html`
                  <button
                    class="sb solo ${track.soloed ? 'on' : ''}"
                    title="Solo"
                    @pointerdown=${(e: Event) => { e.stopPropagation(); store.toggleSolo(track.id); }}
                  >S</button>
                  <button
                    class="sb bypass ${track.bypassed ? 'on' : ''}"
                    title="Bypass / activator"
                    @pointerdown=${(e: Event) => { e.stopPropagation(); store.toggleBypass(track.id); }}
                  >B</button>
                `}
          </div>
          <div class="h-bottom" style="padding-left: calc(var(--app-sp-3) + ${bottomIndent}px)">
            ${this.renderHeaderBottom(track, isRail, isBus)}
          </div>
        </div>
        ${isRail
          ? html`<div class="lane rail">
              <arr-rail-lane .trackId=${track.id}></arr-rail-lane>
            </div>`
          : html`<div
              class="lane ${isGroup ? 'group' : ''} ${track.bypassed ? 'bypassed' : ''} ${track.soloed ? 'soloed' : ''} ${this.clipDropTrackId === track.id ? 'dropok' : ''}"
              @dblclick=${(e: MouseEvent) => this.onLaneDblClick(e, track)}
            >
              ${isGroup
                ? html`<span class="empty-hint">${isBus ? 'main bus — all tracks sum here' : 'group — child tracks sum here'}</span>`
                : track.clips.length === 0
                  ? html`<span class="empty-hint">double-click to add a clip · drag to select</span>`
                  : ''}
              ${repeat(
                track.clips,
                (clip) => clip.id, // keyed: element identity tracks clip identity
                (clip) => html`<arr-clip
                  .trackId=${track.id}
                  .clip=${clip}
                  .accent=${accent}
                ></arr-clip>`,
              )}
              ${this.renderTrackAutoOverlay(track)}
            </div>`}
      </div>
      ${store.automationMode
        ? track.automation
            .filter((lane) => lane.id !== store.overlayLaneId(track.id)) // overlay = clip row
            .map((lane) => this.renderAutoLane(track, lane))
        : ''}
    `;
  }

  /** The left group-gutter content for one row: one clickable vertical line per
   *  nesting level this row belongs to (ancestor groups, plus its own column if it
   *  IS a group). Consecutive rows in the same group share a column → the lines
   *  read as a continuous bracket down the cluster. The main bus reserves the
   *  gutter (so faders stay aligned) but draws no line. Clicking a line selects
   *  that group. */
  private renderGroupLines(track: Track, isBus: boolean, withEnds = true) {
    const cols = store.groupGutterColumns;
    if (cols === 0 || isBus) return '';
    const depth = store.trackDepth(track);
    const isGroup = track.kind === 'group';
    const out = [];
    for (let c = 0; c < cols; c++) {
      // Ancestor line (c < depth) or this group's own line (c === depth).
      if (!(c < depth || (c === depth && isGroup))) continue;
      const gid = store.ancestorGroupAtDepth(track.id, c);
      if (!gid) continue;
      const g = store.trackById(gid);
      const accent = g?.color ?? 'var(--app-tint-4)';
      // A continuous bar per group: inset its very top (the group header row) and
      // very bottom (its last visible row) so it reads as a single bracket.
      const isStart = withEnds && track.id === gid;
      const isEnd = withEnds && store.lastVisibleInGroup(gid) === track.id;
      const cls = [
        'gline',
        isStart ? 'start' : '',
        isEnd ? 'end' : '',
        store.isTrackShownSelected(gid) ? 'on' : '',
        this.hoveredGroupId === gid ? 'hover' : '',
      ].filter(Boolean).join(' ');
      out.push(html`<div
        class=${cls}
        style="left:${c * GROUP_INDENT}px; --gline: ${accent}"
        title=${g ? `${g.name} — click selects, double-click collapses` : ''}
        @pointerenter=${() => { this.hoveredGroupId = gid; }}
        @pointerleave=${() => { if (this.hoveredGroupId === gid) this.hoveredGroupId = null; }}
        @pointerdown=${(e: Event) => { e.stopPropagation(); store.select(paths.track(gid)); }}
        @dblclick=${(e: Event) => { e.stopPropagation(); store.toggleGroupCollapse(gid); }}
      ></div>`);
    }
    return out;
  }

  /** Track header bottom row: in automation mode with a selected field, show the
   *  param label + a Pin button (which moves it into a dedicated lane); otherwise
   *  the mixer strip. */
  private renderHeaderBottom(track: Track, isRail: boolean, isBus: boolean) {
    if (isRail) return '';
    const sel = store.automationMode && !isBus ? store.autoField(`track/${track.id}`) : null;
    if (sel) {
      return html`<div class="auto-pick" title=${sel.label}>
        <ui-icon icon="la-bezier-curve"></ui-icon>
        <span class="apf">${sel.label}</span>
        <button
          class="sb pin"
          title="Pin to a new automation lane"
          @pointerdown=${(e: Event) => { e.stopPropagation(); store.pinTrackAutomation(track.id); }}
        ><ui-icon icon="la-thumbtack"></ui-icon></button>
      </div>`;
    }
    return html`<arr-mixer-strip .trackId=${track.id}></arr-mixer-strip>`;
  }

  /**
   * The track's clip-row automation overlay (automation mode only): an EDITABLE
   * envelope for the track's selected field — the same editor the lanes use. It
   * covers the clips (pointer-events on) so the row edits automation, not clips;
   * with no field selected it's an empty grid. Off-curve drags bubble to the grid
   * (which scopes the caret to this field's lane).
   */
  private renderTrackAutoOverlay(track: Track) {
    if (!store.automationMode) return '';
    const sel = store.autoField(`track/${track.id}`);
    const lane = sel ? store.selectedTrackLane(track.id) : undefined;
    const laneId = lane?.id;
    return html`<div class="track-auto-edit">
      <arr-automation-editor
        gridded
        .lane=${lane}
        .ensureLaneId=${() => store.ensureSelectedTrackLane(track.id)}
        .timelineSpan=${compositionLengthBeats(store.composition)}
        .beatsPerBar=${store.composition.meta.timeSignature?.[0] ?? 4}
        .hideCurve=${!sel}
        .timeboxGestures=${true}
        .bubbleOffCurve=${true}
        .cursorEnabled=${!!laneId && store.caretLaneIds.includes(laneId)}
        .selection=${laneId && store.caretLaneId === laneId && store.hasTimeSelection
          ? { x0: store.timeSelStart!, x1: store.timeSelEnd }
          : null}
      ></arr-automation-editor>
    </div>`;
  }

  private renderAutoLane(track: Track, lane: AutomationLane) {
    // EDITABLE: the same shared <arr-automation-editor> the clip view uses, here
    // mapped onto the live MAIN-TIMELINE beat grid (warp + zoom/pan + playhead).
    return html`
      <div class="row auto">
        <div class="auto-header">
          ${this.renderGroupLines(track, store.isMainBus(track), false)}
          <div
            class="auto-header-label"
            style="padding-left: calc(var(--app-sp-3) + ${(store.isMainBus(track) ? 0 : store.trackDepth(track)) * GROUP_INDENT}px)"
          >
            <ui-icon icon="la-bezier-curve"></ui-icon><span>${lane.label}</span>
          </div>
        </div>
        <div class="auto-lane">
          <arr-automation-editor
            gridded
            .lane=${lane}
            .ensureLaneId=${() => lane.id}
            .timelineSpan=${compositionLengthBeats(store.composition)}
            .beatsPerBar=${store.composition.meta.timeSignature?.[0] ?? 4}
            .cursorEnabled=${store.caretLaneIds.includes(lane.id)}
            .bubbleOffCurve=${true}
            .timeboxGestures=${true}
            .selection=${store.caretLaneId === lane.id && store.hasTimeSelection
              ? { x0: store.timeSelStart!, x1: store.timeSelEnd }
              : null}
          ></arr-automation-editor>
        </div>
      </div>
    `;
  }

  /** Size a lane-area canvas to the content; returns ctx + dims, or null. */
  private prep(canvas: HTMLCanvasElement | undefined) {
    const scroll = this.scrollEl;
    if (!canvas || !scroll) return null;
    const w = scroll.clientWidth - store.headerWidth;
    const h = Math.max(this.contentHeight(store.displayTracks), scroll.clientHeight);
    if (w <= 0 || h <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  private draw() {
    this.drawBack();
    this.drawTop();
  }

  /** Behind clips: warped grid lines + loop shading. */
  private drawBack() {
    const p = this.prep(this.canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const grid = buildBeatGrid();
    const beatsPerBar = store.composition.meta.timeSignature[0];

    if (store.loopEnabled) {
      const x0 = grid.beatToX(store.loopStartBeat);
      const x1 = grid.beatToX(store.loopEndBeat);
      ctx.fillStyle = 'rgba(65,105,225,0.05)';
      ctx.fillRect(x0, 0, x1 - x0, h);
    }

    const stride = store.pxPerBeat >= 13 ? 1 : beatsPerBar;
    for (const ln of grid.visibleBeatLines(w, beatsPerBar, stride)) {
      if (ln.x < 0 || ln.x > w) continue;
      ctx.strokeStyle = ln.isBar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(Math.round(ln.x) + 0.5, 0);
      ctx.lineTo(Math.round(ln.x) + 0.5, h);
      ctx.stroke();
    }
  }

  /** Above clips: time-region box, play-from marker, and playhead. */
  private drawTop() {
    const p = this.prep(this.canvasTop);
    if (!p) return;
    const { ctx, w, h } = p;
    const grid = buildBeatGrid();

    // Time-region selection. Global scope (empty trackIds) fills the full
    // height with no top/bottom edges; a track-range scope draws a bounded
    // rectangle (all four edges) spanning exactly the selected tracks. A LANE
    // region is drawn by the lane editor itself (a band over the curve).
    if (store.hasTimeSelection && !store.caretLaneId) {
      const rx0 = grid.beatToX(store.timeSelStart!);
      const rx1 = grid.beatToX(store.timeSelEnd);
      // The box spans exactly the caret's ROW span (tracks AND lanes), so a
      // partial-lane or multi-lane selection is bounded — not the whole height
      // and not just the clip-row tracks.
      const [yTop, yBottom] = this.caretSpanY(h);
      const bounded = store.caretRowSpan().length > 0;
      ctx.fillStyle = 'rgba(65,105,225,0.16)';
      ctx.fillRect(rx0, yTop, rx1 - rx0, yBottom - yTop);
      ctx.fillStyle = 'rgba(65,105,225,0.85)';
      ctx.fillRect(Math.round(rx0), yTop, 1, yBottom - yTop);
      ctx.fillRect(Math.round(rx1), yTop, 1, yBottom - yTop);
      if (bounded) {
        ctx.fillRect(rx0, Math.round(yTop), rx1 - rx0, 1);
        ctx.fillRect(rx0, Math.round(yBottom) - 1, rx1 - rx0, 1);
      }
    }

    // The 2D caret: an I-beam spanning its vertical track slice + an orange
    // inverted triangle at the top (the head). When PAUSED this is all that's
    // drawn — no sweeping orange line (it would just sit under the triangle).
    const fx = grid.beatToX(store.playFromBeat);
    if (fx >= -2 && fx <= w + 2) {
      const [yTop, yBottom] = this.caretSpanY(h);
      ctx.fillStyle = 'rgba(234,234,234,0.5)';
      ctx.fillRect(Math.round(fx), yTop, 1, yBottom - yTop);
      ctx.fillStyle = 'rgba(255,140,0,0.95)';
      ctx.beginPath();
      ctx.moveTo(fx - 4, 0);
      ctx.lineTo(fx + 5, 0);
      ctx.lineTo(fx + 0.5, 6);
      ctx.closePath();
      ctx.fill();
    }
    // Playhead: the bright orange sweeping line, only WHILE PLAYING.
    if (store.playing) {
      const px = grid.beatToX(store.positionBeat);
      if (px >= 0 && px <= w) {
        ctx.fillStyle = 'rgba(255,140,0,0.95)';
        ctx.fillRect(Math.round(px), 0, 1.5, h);
      }
    }
  }

  /** Vertical pixel span [top,bottom] of the caret's track slice; full height
   *  for a global span. */
  private caretSpanY(h: number): [number, number] {
    const span = store.caretRowSpan();
    if (!span.length) return [0, h]; // global
    const layout = this.rowLayout();
    let yTop = Infinity;
    let yBottom = 0;
    for (const s of span) {
      const r = layout.find((q) => q.trackId === s.trackId && q.laneId === s.laneId);
      if (r) { yTop = Math.min(yTop, r.top); yBottom = Math.max(yBottom, r.bottom); }
    }
    return isFinite(yTop) ? [yTop, yBottom] : [0, h];
  }

  // ── Interaction ───────────────────────────────────────────────────────
  private draggedTrackId: string | null = null;
  private headerDrag: { y0: number; trackId: string } | null = null;

  private onHeaderDown(e: PointerEvent, track: Track) {
    // Select immediately (a plain click just selects).
    if (e.shiftKey) store.toggleSelect(paths.track(track.id));
    else store.select(paths.track(track.id));
    // Arm a reorder drag — but not from an inline rename field or a control,
    // and never for the main bus (pinned).
    if (!store.canReorderTrack(track.id)) return;
    if (e.target instanceof Element && e.target.closest('editable-label, button')) return;
    this.headerDrag = { y0: e.clientY, trackId: track.id };
    window.addEventListener('pointermove', this.onHeaderMove);
    window.addEventListener('pointerup', this.onHeaderUp);
  }

  /** Double-click a group header to expand/collapse it (no chevron). Renaming uses
   *  dbl-click on the name, so ignore events from the editable label / controls. */
  private onHeaderDblClick(e: MouseEvent, track: Track) {
    if (e.target instanceof Element && e.target.closest('editable-label, button, .gline')) return;
    if (track.kind === 'group' && !store.isMainBus(track)) store.toggleGroupCollapse(track.id);
  }

  private onHeaderMove = (e: PointerEvent) => {
    const d = this.headerDrag;
    if (!d) return;
    if (!this.reorderActive) {
      if (Math.abs(e.clientY - d.y0) < 5) return;
      this.reorderActive = true;
      this.draggedTrackId = d.trackId;
    }
    this.reorderDrop = this.computeDrop(e.clientY);
  };

  private onHeaderUp = () => {
    window.removeEventListener('pointermove', this.onHeaderMove);
    window.removeEventListener('pointerup', this.onHeaderUp);
    const d = this.headerDrag;
    this.headerDrag = null;
    if (this.reorderActive && d && this.reorderDrop) {
      store.moveTrackInto(d.trackId, this.reorderDrop.parentId, this.reorderDrop.beforeId);
    }
    this.reorderActive = false;
    this.draggedTrackId = null;
    this.reorderDrop = null;
  };

  /** Depth of a display row (the bus counts as depth 0). */
  private rowDepth(t: Track): number {
    return store.isMainBus(t) ? 0 : store.trackDepth(t);
  }

  /**
   * Resolve a header drag at `clientY` to a drop: which group to land in (parentId)
   * and which sibling to land before (beforeId; null = append as the parent's last
   * child). Upper half of a row drops before it; lower half drops after — into an
   * expanded group, or, at a group's bottom edge, popping out a level per the
   * vertical position (your "into the group as last track" vs "below the group").
   */
  private computeDrop(clientY: number): { beforeId: string | null; parentId: string | null } {
    const rect = this.scrollEl.getBoundingClientRect();
    const contentY = clientY - rect.top + this.scrollEl.scrollTop;
    const layout = this.trackRowLayout();
    const rows = store.displayTracks;

    let h = -1;
    for (let i = 0; i < rows.length; i++) {
      if (contentY < layout[i].bottom) { h = i; break; }
    }
    if (h < 0) {
      const bus = rows.find((r) => store.isMainBus(r));
      return { beforeId: bus ? bus.id : null, parentId: null }; // below all → top-level end
    }
    const hovered = rows[h];
    if (store.isMainBus(hovered)) return { beforeId: hovered.id, parentId: null };

    const top = layout[h].top, bot = layout[h].bottom;
    const rel = (contentY - top) / Math.max(1, bot - top);
    const dHover = this.rowDepth(hovered);

    if (rel < 0.5) {
      // Upper half → land before `hovered`, as its sibling.
      return { beforeId: hovered.id, parentId: hovered.parentId ?? null };
    }
    // Lower half → land after `hovered`.
    if (hovered.kind === 'group') {
      // Into the group, as its first child.
      const next = rows[h + 1];
      return { beforeId: next && !store.isMainBus(next) ? next.id : null, parentId: hovered.id };
    }
    const next = rows[h + 1];
    const nextDepth = next && !store.isMainBus(next) ? this.rowDepth(next) : -1;
    if (next && !store.isMainBus(next) && nextDepth >= dHover) {
      // Continuation at the same-or-deeper level → simple sibling insert before next.
      return { beforeId: next.id, parentId: next.parentId ?? null };
    }
    // Group-bottom boundary: `hovered` is the last descendant of one or more groups.
    // Offer each enclosing level; pick by how far down the lower half we are
    // (nearer 0.5 → stay in the innermost group; nearer 1 → pop further out).
    const parents: (string | null)[] = [];
    let cur: string | null = hovered.parentId ?? null;
    let curDepth = dHover - 1;
    while (curDepth >= nextDepth) {
      parents.push(cur);
      if (cur == null) break;
      cur = store.trackById(cur)?.parentId ?? null;
      curDepth--;
    }
    if (parents.length === 0) parents.push(hovered.parentId ?? null);
    const t = Math.min(0.999, Math.max(0, (rel - 0.5) / 0.5));
    const band = Math.min(parents.length - 1, Math.floor(t * parents.length));
    return { beforeId: null, parentId: parents[band] };
  }

  /** True if display row `id` is the group `ancestorId` or sits inside it. */
  private rowWithin(id: string, ancestorId: string): boolean {
    let cur: string | null = id;
    while (cur) {
      if (cur === ancestorId) return true;
      cur = store.trackById(cur)?.parentId ?? null;
    }
    return false;
  }

  private renderReorderLine() {
    const drop = this.reorderDrop;
    if (!drop) return '';
    const layout = this.trackRowLayout();
    const rows = store.displayTracks;
    let y = 0;
    if (drop.beforeId) {
      y = layout[rows.findIndex((r) => r.id === drop.beforeId)]?.top ?? 0;
    } else if (drop.parentId == null) {
      const busIdx = rows.findIndex((t) => store.isMainBus(t));
      y = busIdx >= 0 ? layout[busIdx].top : (layout.length ? layout[layout.length - 1].bottom : 0);
    } else {
      // Append to a group → after its last visible descendant.
      let last = -1;
      for (let i = 0; i < rows.length; i++) {
        if (this.rowWithin(rows[i].id, drop.parentId)) last = i;
      }
      y = last >= 0 ? layout[last].bottom : 0;
    }
    // Indent the line into the target group's gutter column so the destination reads.
    const pd = drop.parentId ? store.trackDepth(store.trackById(drop.parentId)!) : -1;
    const indent = (pd + 1) * GROUP_INDENT;
    return html`<div class="reorder-line" style="top:${y}px; left:${indent}px"></div>`;
  }

  /** Eligible (plain) display track id nearest a clientY, or null if none exist. */
  eligibleTrackAtClientY(clientY: number): string | null {
    const rect = this.scrollEl.getBoundingClientRect();
    const contentY = clientY - rect.top + this.scrollEl.scrollTop;
    const layout = this.trackRowLayout();
    const tracks = store.displayTracks;
    let best: string | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].kind !== 'track') continue;
      const r = layout[i];
      if (contentY >= r.top && contentY < r.bottom) return tracks[i].id;
      const dist = Math.abs(contentY - (r.top + r.bottom) / 2);
      if (dist < bestDist) { bestDist = dist; best = tracks[i].id; }
    }
    return best;
  }

  /** Highlight (or clear) a lane as the destination of a cross-track clip drag. */
  setClipDropTarget(trackId: string | null) {
    this.clipDropTrackId = trackId;
  }

  /**
   * Resolve a file-drop position: the eligible track + quantized start beat.
   * On the timeline → the beat under the cursor; off it → the play position.
   * Always lands on the nearest eligible (plain) track. Null if none exist.
   */
  resolveDropTarget(clientX: number, clientY: number): { trackId: string; startBeat: number } | null {
    const trackId = this.eligibleTrackAtClientY(clientY);
    if (!trackId) return null;
    const rect = this.scrollEl.getBoundingClientRect();
    const laneLeft = rect.left + store.headerWidth;
    const onTimeline =
      clientX >= laneLeft && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
    const beat = onTimeline ? buildBeatGrid().xToBeat(clientX - laneLeft) : store.positionBeat;
    return { trackId, startBeat: store.quantize(beat) };
  }

  private onLaneDblClick(e: MouseEvent, track: Track) {
    // In automation mode the clip row edits envelopes, not clips — never insert one.
    if (store.automationMode) return;
    if (track.kind === 'group') return;
    if (e.target instanceof Element && e.target.closest('arr-clip')) return;
    const laneRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grid = buildBeatGrid();
    const beat = store.quantize(grid.xToBeat(e.clientX - laneRect.left));
    store.createEmptyClip(track.id, beat);
  }

  // Drag selects a rectangular TIME × TRACK REGION (Ableton-style); a plain
  // click sets the play-from marker. Dragging that starts in the main bus
  // selects the whole time range across ALL tracks (rendered full-height).
  private drag: {
    x0: number;
    y0: number;
    startBeat: number;
    laneLeft: number;
    startTrackId: string;
    /** Automation lane the gesture started on ('' = the track's clip row). */
    startLaneId: string;
    /** Gesture started on the main bus ⇒ the caret spans ALL plain tracks. */
    startIsBus: boolean;
    active: boolean;
    /** Set when the gesture began on a clip BODY: a plain click focuses this clip
     *  (no time box); a drag still does a region selection. */
    clickFocusPath?: string;
  } | null = null;

  /** Per-ROW vertical layout (each track's clip row + its automation lanes). */
  private rowLayout(): Array<{ trackId: string; laneId: string; top: number; bottom: number }> {
    const out: Array<{ trackId: string; laneId: string; top: number; bottom: number }> = [];
    let y = 0;
    for (const t of store.displayTracks) {
      // The clip row carries the overlay lane id in automation mode (the row edits
      // the selected-field automation), matching store.caretRows. Both tracks AND
      // non-bus GROUPS carry automation lanes (a group's FX bus is automatable too).
      const autoOwner = t.kind === 'track' || (t.kind === 'group' && !store.isMainBus(t));
      const overlay = autoOwner ? store.overlayLaneId(t.id) : '';
      out.push({ trackId: t.id, laneId: overlay, top: y, bottom: y + ROW_HEIGHT });
      y += ROW_HEIGHT;
      if (store.automationMode && autoOwner) {
        for (const lane of t.automation) {
          if (lane.id === overlay) continue; // shown as the clip-row overlay
          out.push({ trackId: t.id, laneId: lane.id, top: y, bottom: y + AUTO_LANE_HEIGHT });
          y += AUTO_LANE_HEIGHT;
        }
      }
    }
    return out;
  }

  /** The row (track + lane) at a client Y. */
  private rowAtClientY(clientY: number): { trackId: string; laneId: string } {
    const rect = this.scrollEl.getBoundingClientRect();
    const contentY = clientY - rect.top + this.scrollEl.scrollTop;
    const layout = this.rowLayout();
    // The caret / time-box system targets track, rail AND (non-bus) group rows —
    // a group row stands in for its contained tracks. The master bus isn't a caret
    // row. Clamp the hit to the last selectable row at-or-above it, so dragging past
    // the bottom (over/below the main bus) extends to the final lane instead of
    // collapsing to one track.
    const caretOK = (trackId: string) => {
      const t = store.trackById(trackId);
      return !!t && (t.kind === 'track' || t.kind === 'rail' || (t.kind === 'group' && !store.isMainBus(t)));
    };
    let idx = layout.findIndex((r) => contentY < r.bottom);
    if (idx < 0) idx = layout.length - 1;
    while (idx >= 0 && !caretOK(layout[idx].trackId)) idx--;
    const r = idx >= 0 ? layout[idx] : layout[layout.length - 1];
    return r ? { trackId: r.trackId, laneId: r.laneId } : { trackId: '', laneId: '' };
  }

  /** Track-row vertical layout in content (scroll) coordinates. */
  private trackRowLayout(): Array<{ id: string; top: number; bottom: number }> {
    const out: Array<{ id: string; top: number; bottom: number }> = [];
    let y = 0;
    for (const t of store.displayTracks) {
      // The track's FULL extent (header + its automation lanes) so a click on an
      // automation lane hit-tests to that track, not the next one down.
      let h = ROW_HEIGHT;
      if (store.automationMode) h += t.automation.length * AUTO_LANE_HEIGHT;
      out.push({ id: t.id, top: y, bottom: y + h });
      y += h;
    }
    return out;
  }

  /**
   * Pointerdown anywhere in the scroll area → start a time×track region drag.
   * Skips headers (select/reorder), clips (own handlers), and overlays. Clicking
   * empty space BELOW the main bus lands here too, so it gets the same global
   * time-slice selection as the main-bus lane.
   */
  private onScrollDown = (e: PointerEvent) => {
    const t = e.target;
    if (t instanceof Element && t.closest('.header, .auto-header, arr-clip, .timebar, .reorder-line')) {
      return;
    }
    this.beginRegionFromClient(e);
  };

  // ── Clip move drag (driven by the grid so it survives the clip element being
  //    reparented to another track mid-drag). Cross-track + time-box split-move.
  private clipMove: {
    trackId: string;
    clipId: string;
    startBeat: number;
    grabBeat: number;
    x0: number;
    y0: number;
    active: boolean;
    timebox: boolean;
    /** Cmd/Ctrl held at grab ⇒ DUPLICATE: drag the clip, then drop a clone back
     *  at the original location on release. */
    duplicate: boolean;
    origClip: Clip;
    /** The time box at gesture start (so coalesced frames don't drift as the
     *  box follows the move). Null unless this is a time-box drag. */
    baseSel: { start: number; end: number; scope: string[] } | null;
    /** Caret + playhead at gesture start, so they can slide with the moved content. */
    baseCaret: { anchorBeat: number; headBeat: number; posBeat: number };
  } | null = null;

  /** Begin moving `clip` (from arr-clip). `fromHeader` enables time-box split-move. */
  beginClipMove(e: PointerEvent, trackId: string, clip: Clip, fromHeader: boolean) {
    const grid = buildBeatGrid();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + store.headerWidth;
    const timebox = fromHeader && store.timeBoxCoversClip(trackId, clip.id);
    this.clipMove = {
      trackId,
      clipId: clip.id,
      startBeat: clip.startBeat,
      grabBeat: grid.xToBeat(e.clientX - laneLeft),
      x0: e.clientX,
      y0: e.clientY,
      active: false,
      // Cmd/Ctrl = duplicate (a COPY), for a single clip OR a multi-clip/slice
      // time box. The copy is made live per drag-frame (originals never move).
      duplicate: e.metaKey || e.ctrlKey,
      origClip: JSON.parse(JSON.stringify(clip)),
      // A header drag moves the in-box content (split at the box edges) — incl.
      // between tracks — and the box follows. For a single clip the box is just
      // that clip, so this is also how a plain header drag moves one clip.
      timebox,
      baseSel: timebox
        ? { start: store.timeSelStart!, end: store.timeSelEnd, scope: [...store.timeSelTrackIds] }
        : null,
      baseCaret: {
        anchorBeat: store.caretAnchorBeat,
        headBeat: store.playFromBeat,
        posBeat: store.positionBeat,
      },
    };
    // One coalesced undo entry for the whole drag — immune to pointer dwell.
    store.beginGesture();
    window.addEventListener('pointermove', this.onClipMove);
    window.addEventListener('pointerup', this.onClipUp);
  }

  // The drag is DELTA-based: the clip shifts by how far the cursor moved from
  // pointer-down — NOT to the absolute cursor position. In X, the shift is
  // quantized to the snap grid (round to nearest step). In Y, the clip moves to
  // whichever eligible track's center the shifted clip-center lands nearest. So
  // grabbing a clip anywhere (not just its center) shifts it cleanly by whole
  // tracks / grid steps.
  private onClipMove = (e: PointerEvent) => {
    const d = this.clipMove;
    if (!d) return;
    if (!d.active) {
      // Activate on motion in EITHER axis (a pure vertical between-tracks drag
      // must start too — an X-only threshold silently dropped those).
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.active = true;
    }
    const grid = buildBeatGrid();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + store.headerWidth;
    const free = e.altKey;

    // X: shift in beats from pointer-down, quantized to the snap grid.
    const deltaBeat = grid.xToBeat(e.clientX - laneLeft) - d.grabBeat;
    const snap = store.snapStep;
    const shiftBeat = free ? deltaBeat : Math.round(deltaBeat / snap) * snap;

    if (d.timebox && d.baseSel) {
      // Move (or, with Cmd, COPY) the in-box content by the X shift AND across
      // tracks (Y). Track delta = source→dest in the plain-track order.
      const dest = this.trackByCenterShift(d.trackId, e.clientY - d.y0);
      const plain = store.composition.tracks.filter((t) => t.kind === 'track').map((t) => t.id);
      const td = plain.indexOf(dest) - plain.indexOf(d.trackId);
      this.clipDropTrackId = td !== 0 ? dest : null;
      if (d.duplicate) {
        // Copy the slices to the shifted spot; originals + box stay put.
        store.copyTimeBoxContent(shiftBeat, td, d.baseSel);
      } else {
        store.moveTimeBoxContent(shiftBeat, td, d.baseSel);
        // Caret + (paused) playhead slide with the box by the same beat shift.
        store.slideCaret(d.baseCaret, shiftBeat);
      }
      return;
    }

    // Snap the clip's ABSOLUTE resulting START to the grid (not the delta), so a
    // clip that started off-grid lands on a grid line after the move.
    const targetStart = d.startBeat + deltaBeat;
    const beat = free ? Math.max(0, targetStart) : store.quantize(targetStart);
    const dest = this.trackByCenterShift(d.trackId, e.clientY - d.y0);
    this.clipDropTrackId = dest !== d.trackId ? dest : null;
    if (d.duplicate) {
      // A live COPY tracking the cursor (the original never moves); per-frame
      // under one key so the whole drag is a single undo.
      store.insertClipCopyAt(d.origClip, dest, beat, `dup:${d.clipId}`);
    } else {
      // Always pass the ORIGINAL source track: coalescing reverts to the gesture's
      // base each frame (clip back on its source), then re-applies the move.
      store.moveClipToTrack(d.trackId, d.clipId, dest, beat);
      // Caret + (paused) playhead follow by the ACTUAL applied shift (post-snap).
      store.slideCaret(d.baseCaret, beat - d.startBeat);
    }
  };

  /**
   * Delta-based target track: shift the SOURCE track's row center by `dy` px and
   * return whichever eligible (plain) track's center is nearest. So the clip
   * only changes tracks once the cursor has moved ~half a row, regardless of
   * where on the clip it was grabbed.
   */
  private trackByCenterShift(sourceTrackId: string, dy: number): string {
    const layout = this.trackRowLayout();
    const tracks = store.displayTracks;
    const srcIdx = tracks.findIndex((t) => t.id === sourceTrackId);
    if (srcIdx < 0) return sourceTrackId;
    const center = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2;
    const target = center(layout[srcIdx]) + dy;
    let best = sourceTrackId;
    let bestDist = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].kind !== 'track') continue;
      const dist = Math.abs(center(layout[i]) - target);
      if (dist < bestDist) { bestDist = dist; best = tracks[i].id; }
    }
    return best;
  }

  private onClipUp = () => {
    window.removeEventListener('pointermove', this.onClipMove);
    window.removeEventListener('pointerup', this.onClipUp);
    // Cmd-drag DUPLICATE now makes its copy live during the drag (per-frame,
    // coalesced) — nothing to finalize here beyond closing the gesture.
    store.endGesture();
    this.clipMove = null;
    this.clipDropTrackId = null;
  };

  /**
   * Begin a time × track region drag from raw client coordinates. Public so a
   * clip body can delegate here (clicking a clip's film strip behaves exactly
   * like clicking the grid). The start track is derived from clientY.
   */
  beginRegionFromClient(e: PointerEvent, clickFocusPath?: string) {
    if (this.drag) return;
    store.closeTapPopup();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + store.headerWidth;
    const grid = buildBeatGrid();
    const startBeat = grid.xToBeat(e.clientX - laneLeft);
    const startRow = this.rowAtClientY(e.clientY);
    const startTrack = store.trackById(startRow.trackId);
    const startIsBus = !!startTrack && store.isMainBus(startTrack);
    const qBeat = store.quantize(startBeat, e.altKey);
    // Set the 2D caret to a zero-width slice at the clicked time + ROW (a bus
    // start spans all plain tracks). A drag below extends it into a box/slice.
    const trackId = startIsBus ? '' : startRow.trackId;
    let laneId = startIsBus ? '' : startRow.laneId;
    // A clip-row click in automation mode on a track with a selected field edits
    // that field's automation — materialize its overlay lane so the caret scopes
    // there (and clips aren't selected).
    if (!startIsBus && !laneId && store.automationMode && store.autoField(`track/${trackId}`)) {
      laneId = store.ensureSelectedTrackLane(trackId);
    }
    store.setCaret({ anchorBeat: qBeat, anchorTrackId: trackId, anchorLaneId: laneId, headBeat: qBeat, headTrackId: trackId, headLaneId: laneId });
    // Clicking a clip body focuses it right away; a drag below overrides this.
    if (clickFocusPath) store.selectClipOnly(clickFocusPath);
    // An automation lane has no clips — clicking it touches only that lane.
    else if (laneId) store.clearSelection();
    this.drag = {
      x0: e.clientX,
      y0: e.clientY,
      startBeat,
      laneLeft,
      startTrackId: startRow.trackId,
      startLaneId: startRow.laneId,
      startIsBus,
      active: false,
      clickFocusPath,
    };
    window.addEventListener('pointermove', this.onRegionMove);
    window.addEventListener('pointerup', this.onRegionUp);
  }

  private onRegionMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    // Activate on movement along EITHER axis: a purely vertical drag (clientX
    // unchanged) still arms a region selection — it extends the caret up/down as a
    // vertical I-beam slice (zero-width time box across the dragged rows).
    if (!d.active && (Math.abs(e.clientX - d.x0) > 4 || Math.abs(e.clientY - d.y0) > 4)) d.active = true;
    if (!d.active) return;
    const grid = buildBeatGrid();
    const cur = grid.xToBeat(e.clientX - d.laneLeft);
    const free = e.altKey;
    const headBeat = cur < 0 ? 0 : store.quantize(cur, free);
    const anchorBeat = store.quantize(d.startBeat, free);
    // Vertical span: a bus start stays global; otherwise anchor ROW → the row
    // currently under the cursor (tracks AND automation lanes).
    const headRow = d.startIsBus ? { trackId: '', laneId: '' } : this.rowAtClientY(e.clientY);
    store.setCaret({
      anchorBeat,
      anchorTrackId: d.startIsBus ? '' : d.startTrackId,
      anchorLaneId: d.startIsBus ? '' : d.startLaneId,
      headBeat,
      headTrackId: headRow.trackId,
      headLaneId: headRow.laneId,
    });
    // The caret (box OR vertical slice) selects the clips it intersects (no-op on
    // an automation lane — that's an envelope region, handled by the lane editor).
    store.selectClipsInCaret();
  };

  private onRegionUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onRegionMove);
    window.removeEventListener('pointerup', this.onRegionUp);
    const d = this.drag;
    this.drag = null;
    if (!d || d.active) return;
    // Plain click (no drag): the caret was set on pointerdown. A clip body stays
    // focused; otherwise select what's under the head — a clip if present, else
    // the track underneath (text-caret: the cursor always lands somewhere).
    if (d.clickFocusPath) return;
    // On an automation lane → the caret marks the lane; don't touch clip/track sel.
    if (d.startLaneId) { store.clearSelection(); return; }
    if (d.startIsBus || !d.startTrackId) {
      store.clearSelection();
      return;
    }
    const clip = store.clipAtBeat(d.startTrackId, store.playFromBeat);
    store.selectClipOnly(clip ? paths.clip(d.startTrackId, clip.id) : paths.track(d.startTrackId));
  };

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const cursorX = e.clientX - this.scrollEl.getBoundingClientRect().left - store.headerWidth;
      if (cursorX < 0) return;
      store.zoomAnchored(Math.exp(-e.deltaY * 0.002), cursorX);
      return;
    }
    // 2-D pan. The browser's swipe-back navigation accumulates raw horizontal wheel
    // delta, so a gesture with ANY real horizontal component is OWNED for its whole
    // duration: we preventDefault every event (killing swipe-back) and pan BOTH axes
    // manually — so a diagonal trackpad swipe pans horizontally AND vertically at
    // once. A purely-vertical gesture never engages → native scrolling (momentum).
    clearTimeout(this.wheelIdleTimer);
    this.wheelIdleTimer = window.setTimeout(() => (this.wheelEngaged = false), 140);
    if (!this.wheelEngaged && Math.abs(e.deltaX) > 1 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5) {
      this.wheelEngaged = true;
    }
    if (this.wheelEngaged) {
      e.preventDefault();
      if (e.deltaX) store.scrollBy(e.deltaX / store.pxPerBeat);
      if (e.deltaY) this.scrollEl.scrollTop += e.deltaY; // native scroll is prevented → do it ourselves
    }
  };
}
