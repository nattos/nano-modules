/**
 * <sketch-canvas-view> — the sidecar canvas.
 *
 * A freeform surface holding the sketch's canvas-partition nodes, opened to the
 * RIGHT of the linear effects list (it takes over the monitor area, which pops
 * out to the floating overlay). Cards are the SAME <column-group> effect cards
 * as the linear list — one instance in `canvas` layout mode, rendering only the
 * entries carrying a placement — so selection, field widgets, inspectors and
 * wire anchoring all work here with no parallel implementation.
 *
 * The canvas has no <columns-view>: no virtualization, no column widths, no
 * horizontal column layout. Just a scrolling viewport over an absolutely
 * positioned surface, scaled by a CSS transform.
 *
 * At zoom 1 the vertical scroll is LINKED to the list's, so a canvas node sits
 * beside the effect it modulates; zooming breaks the link (the mapping stops
 * being exact) until the reset control re-establishes it.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { snackbars } from '../../widgets/snackbars';
import { canvasChain, sketchChain, type ChainEntry } from '../../sketch-types';
import { loadSketchUiState, saveSketchUiState } from '../../state/sketch-ui-store';
import { PointerDragOp } from '../../utils/pointer-drag-op';
import { linearScrollTop, publishScroll, subscribeScroll } from '../../widgets/scroll-link';
import { CANVAS_CARD_WIDTH, CANVAS_CHIP_DROP, type ColumnGroup, type ColumnGroupCallbacks } from '../../widgets/column-group';
import { activeLinearColumnGroup } from '../../widgets/field-anchor-lookup';
import { InspectorCache } from '../../widgets/inspector-cache';
import { ideColumnAdapter } from '../../state/ide-column-adapter';

import '../../widgets/column-group';

/** Scroll-past-the-end tail, mirroring columns-view.updateContentHeight(). */
const TAIL_MIN = 120;
/** Rough card height used to size the scrollable surface. */
const CARD_EXTENT = 240;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
/** Snap distance, in SCREEN px — divided by zoom so it feels the same at any scale. */
const SNAP_PX = 8;
/** Card gutter, matching columns-view's gap, for edge-to-edge snapping. */
const SNAP_GAP = 16;
/** Trackpad gesture latch (arr-grid's `wheelEngaged`), ms. */
const WHEEL_LATCH_MS = 140;

interface SnapLines { xs: number[]; ys: number[]; }

/**
 * The linear list's insertion index under a viewport point, or null when the
 * point isn't over the list at all. Reuses <column-group>'s own insertion
 * points so a card dragged off the canvas lands exactly where the list's native
 * reorder drag would put it.
 */
function linearInsertIdxAt(x: number, y: number): number | null {
  const group = activeLinearColumnGroup() as ColumnGroup | null;
  if (!group) return null;
  const r = group.getBoundingClientRect();
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
  const pts = group.getInsertionPoints();
  if (pts.length === 0) return 0;
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.y - y) < Math.abs(best.y - y)) best = p;
  return best.insertIdx;
}

@customElement('sketch-canvas-view')
export class SketchCanvasView extends MobxLitElement {
  @property() sketchId: string | null = null;

  @state() private contentH = 600;
  @state() private zoom = 1;
  @state() private linked = true;
  /** Active alignment guides while dragging a card, in canvas coordinates. */
  @state() private guides: { x: number | null; y: number | null } = { x: null, y: null };

  /** Cards drag freely here; custom inspectors cache per surface. */
  private readonly inspectorCache = new InspectorCache();
  private readonly cardCallbacks: ColumnGroupCallbacks = {
    onCardPointerDown: (e, _sketchId, _colIdx, chainIdx) => this.beginCardDrag(e, chainIdx),
    getInspectorElement: (instanceKey, moduleType, binding) =>
      this.inspectorCache.get(instanceKey, moduleType, binding),
  };

  private unsubScroll: (() => void) | null = null;
  /**
   * The scroll position we last wrote programmatically, held until its (async)
   * scroll event arrives so we don't echo it back as a user scroll. A flag set
   * and cleared around the assignment would be useless — the event fires long
   * after the synchronous block ends.
   */
  private echoTop: number | null = null;
  private dragOp: PointerDragOp | null = null;
  private uiStateSketchId: string | null = null;
  private saveTimer = 0;
  /** Wheel-gesture latch: once a gesture is zooming (or scrolling) it stays so. */
  private wheelZooming = false;
  private wheelIdleTimer = 0;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--app-bg-color1);
      position: relative;
    }
    .viewport { width: 100%; height: 100%; overflow: auto; position: relative; }
    .sizer { position: relative; }
    .surface {
      position: absolute;
      left: 0; top: 0;
      transform-origin: 0 0;
      /* Same padding as columns-view's .scroll-container, so canvas y=0 lines
         up with the first linear card while the two scrolls are linked. */
      padding: var(--app-sp-6);
      box-sizing: border-box;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      color: var(--app-text-color3);
      font-size: var(--app-fs-md);
      text-align: center;
      padding: 0 32px;
      line-height: 1.6;
    }
    .guide {
      position: absolute;
      background: var(--app-hi-color2, #4169E1);
      opacity: 0.7;
      pointer-events: none;
      z-index: 5;
    }
    .guide.v { top: 0; bottom: 0; width: 1px; }
    .guide.h { left: 0; right: 0; height: 1px; }
    .reset {
      position: absolute;
      right: 12px; top: 12px;
      z-index: 20;
      display: flex; align-items: center; gap: 6px;
      padding: 4px 9px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      cursor: pointer;
    }
    .reset:hover { color: var(--app-text-color1); border-color: var(--app-hi-color2, #4169E1); }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.unsubScroll = subscribeScroll((source, top) => {
      if (source !== 'linear' || !this.linked || this.zoom !== 1) return;
      this.applyLinkedScroll(top);
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener(CANVAS_CHIP_DROP, this.onChipDrop as EventListener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubScroll?.();
    this.unsubScroll = null;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener(CANVAS_CHIP_DROP, this.onChipDrop as EventListener);
    this.dragOp?.dispose();
    this.inspectorCache.clear();
    this.flushUiState();
  }

  // --- Scroll link -------------------------------------------------------

  private viewportEl(): HTMLElement | null {
    return this.renderRoot.querySelector('.viewport');
  }

  private applyLinkedScroll(top: number) {
    const vp = this.viewportEl();
    if (!vp || Math.abs(vp.scrollTop - top) < 0.5) return;
    this.echoTop = top;
    vp.scrollTop = top;
  }

  private onScroll = (e: Event) => {
    const top = (e.currentTarget as HTMLElement).scrollTop;
    const isEcho = this.echoTop !== null && Math.abs(top - this.echoTop) < 0.5;
    this.echoTop = null;
    // A CLAMPED write (the surface couldn't reach the requested position) is a
    // real position change, not an echo, so it still propagates.
    if (!isEcho && this.linked && this.zoom === 1) publishScroll('canvas', top);
    this.scheduleUiSave();
  };

  // --- Zoom --------------------------------------------------------------

  /**
   * Option/Alt + wheel zooms, anchored under the cursor; a plain wheel scrolls
   * natively. A gesture LATCHES on its first event (arr-grid's rule) so a
   * diagonal trackpad swipe can't half-zoom and half-scroll mid-flick.
   */
  private onWheel = (e: WheelEvent) => {
    clearTimeout(this.wheelIdleTimer);
    this.wheelIdleTimer = window.setTimeout(() => { this.wheelZooming = false; }, WHEEL_LATCH_MS);
    if (!this.wheelZooming) {
      if (!e.altKey) return;          // plain wheel: let the viewport scroll
      this.wheelZooming = true;
    }
    e.preventDefault();
    const vp = this.viewportEl();
    if (!vp) return;
    const r = vp.getBoundingClientRect();
    this.zoomAnchored(Math.exp(-e.deltaY * 0.002),
      e.clientX - r.left + vp.scrollLeft, e.clientY - r.top + vp.scrollTop);
  };

  /** Scale about a point given in VIEWPORT-content coordinates, keeping it fixed. */
  private zoomAnchored(factor: number, ax: number, ay: number) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    if (next === this.zoom) return;
    const vp = this.viewportEl();
    const ratio = next / this.zoom;
    this.zoom = next;
    // Any zoom away from 1 makes the list↔canvas mapping inexact, so the link
    // ends here rather than drifting silently.
    this.linked = false;
    if (vp) {
      vp.scrollLeft += ax * (ratio - 1);
      vp.scrollTop += ay * (ratio - 1);
    }
    this.scheduleUiSave();
  }

  private resetView = async () => {
    this.zoom = 1;
    // Wait for the surface to SETTLE, not just re-render once: measureContent()
    // runs in updated() and requests a further update, so the first frame after
    // a zoom change still has the old content height — writing the scroll then
    // would clamp it to the smaller range and lose the position.
    await this.settled();
    // Re-link only AFTER the scroll lands: while zoomed, this surface's own
    // scrollTop is meaningless to the list, and re-linking first would let the
    // relayout's scroll event publish that stale position and drag the list to it.
    this.applyLinkedScroll(linearScrollTop());
    this.linked = true;
    this.scheduleUiSave();
  };

  /** Resolve once no further render is pending (bounded, so a render loop
   *  can't hang the gesture). */
  private async settled(maxPasses = 5) {
    for (let i = 0; i < maxPasses; i++) {
      if (await this.updateComplete) return;
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '0') {
      e.preventDefault();
      this.resetView();
    }
  };

  // --- Card drag + snapping ----------------------------------------------

  /** Viewport-space point → canvas coordinates (undo the scale and padding). */
  viewportToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const surf = this.renderRoot.querySelector('.surface') as HTMLElement | null;
    if (!surf) return { x: 0, y: 0 };
    const r = surf.getBoundingClientRect();
    return { x: (clientX - r.left) / this.zoom, y: (clientY - r.top) / this.zoom };
  }

  /**
   * Alignment guides from the OTHER cards' edges. Cards only — no grid, no
   * lanes: the point is for a node to line up with its neighbours (and, while
   * the scroll link holds, with the linear effect it modulates).
   */
  private snapLines(exceptChainIdx: number): SnapLines {
    const sketch = this.sketchId ? appState.database.sketches[this.sketchId] : null;
    const xs: number[] = [];
    const ys: number[] = [];
    if (!sketch) return { xs, ys };
    sketchChain(sketch).forEach((e: ChainEntry, i) => {
      if (i === exceptChainIdx || !e.canvas) return;
      const w = e.canvas.w ?? CANVAS_CARD_WIDTH;
      xs.push(e.canvas.x, e.canvas.x + w + SNAP_GAP);
      ys.push(e.canvas.y);
    });
    // Card BOTTOMS need a measured height, so read them off the DOM.
    for (const el of this.cardEls()) {
      const idx = Number(el.dataset.chainIdx);
      if (idx === exceptChainIdx) continue;
      const h = el.getBoundingClientRect().height / this.zoom;
      if (h > 0) ys.push(parseFloat(el.style.top) + h + SNAP_GAP);
    }
    return { xs, ys };
  }

  private cardEls(): HTMLElement[] {
    const group = this.renderRoot.querySelector('column-group');
    return Array.from(group?.shadowRoot?.querySelectorAll('.canvas-card') ?? []) as HTMLElement[];
  }

  private snap(v: number, lines: number[]): { v: number; hit: number | null } {
    const tol = SNAP_PX / this.zoom;
    let best: number | null = null;
    for (const l of lines) {
      if (Math.abs(l - v) > tol) continue;
      // Ties break to the smaller coordinate, so the result is deterministic.
      if (best === null || Math.abs(l - v) < Math.abs(best - v) ||
          (Math.abs(l - v) === Math.abs(best - v) && l < best)) best = l;
    }
    return best === null ? { v, hit: null } : { v: best, hit: best };
  }

  /** Begin dragging a canvas card by its header (routed from <column-group>). */
  private beginCardDrag(e: PointerEvent, chainIdx: number) {
    const sketchId = this.sketchId;
    const sketch = sketchId ? appState.database.sketches[sketchId] : null;
    const entry = sketch ? sketchChain(sketch)[chainIdx] : null;
    if (!sketchId || !entry?.canvas) return;
    const start = { x: entry.canvas.x, y: entry.canvas.y };
    const origin = { x: e.clientX, y: e.clientY };
    const lines = this.snapLines(chainIdx);
    const edit = appController.beginSetCanvasPos(sketchId, chainIdx, start);

    this.dragOp?.dispose();
    this.dragOp = new PointerDragOp(e, this, {
      move: (ev: PointerEvent) => {
        const rawX = start.x + (ev.clientX - origin.x) / this.zoom;
        const rawY = start.y + (ev.clientY - origin.y) / this.zoom;
        const sx = this.snap(rawX, lines.xs);
        const sy = this.snap(rawY, lines.ys);
        this.guides = { x: sx.hit, y: sy.hit };
        appController.updateSetCanvasPos(edit, sketchId, chainIdx, { x: sx.v, y: sy.v });
      },
      accept: (ev: PointerEvent) => {
        this.guides = { x: null, y: null };
        // Dropped back over the effects LIST: this stops being a position edit
        // and becomes a partition move. Cancel the placement (no undo point for
        // the drag) and re-splice the entry into the linear chain instead.
        const insertIdx = linearInsertIdxAt(ev.clientX, ev.clientY);
        if (insertIdx !== null) {
          edit.cancel();
          appController.moveEffectToLinear(sketchId, chainIdx, insertIdx);
          return;
        }
        edit.accept();
      },
      cancel: () => { this.guides = { x: null, y: null }; edit.cancel(); },
    });
  }

  /**
   * Double-click on EMPTY canvas inserts a node there and opens the type picker
   * — the same continuous-edit flow the list's insert header uses, so Escape
   * backs out cleanly with no history. A double-click on a card is the card's
   * own collapse gesture, so ignore anything landing on one.
   */
  private onSurfaceDblClick = (e: MouseEvent) => {
    const path = e.composedPath();
    if (path.some(n => n instanceof HTMLElement && n.classList?.contains('effect-card'))) return;
    const group = this.renderRoot.querySelector('column-group') as ColumnGroup | null;
    if (!group) return;
    e.preventDefault();
    group.beginCanvasInsertAt(this.viewportToCanvas(e.clientX, e.clientY));
  };

  /** A category chip from the list's insert header, dropped onto the canvas. */
  private onChipDrop = (e: CustomEvent<{ sketchId: string; clientX: number;
                                         clientY: number; category?: string }>) => {
    if (e.detail.sketchId !== this.sketchId) return;
    const group = this.renderRoot.querySelector('column-group') as ColumnGroup | null;
    group?.beginCanvasInsertAt(
      this.viewportToCanvas(e.detail.clientX, e.detail.clientY), e.detail.category);
  };

  /**
   * Splice a node into `wireId` at a viewport point (double-click on a wire).
   * Delegates the document edit to the controller and the type-picker session
   * to <column-group>, so it behaves exactly like any other insertion.
   */
  beginInsertOnWire(wireId: string, clientX: number, clientY: number) {
    const sketchId = this.sketchId;
    const group = this.renderRoot.querySelector('column-group') as ColumnGroup | null;
    if (!sketchId || !group) return;
    const pos = this.pointInsideViewport(clientX, clientY)
      ? this.viewportToCanvas(clientX, clientY)
      : this.freeSpotNearWire(sketchId, wireId);
    if (!group.beginInsertOnWireAt(wireId, pos)) {
      snackbars.show({
        message: 'No available effect can pass that wire through.',
        dedupeKey: 'canvas-splice-no-port',
      });
    }
  }

  private pointInsideViewport(x: number, y: number): boolean {
    const r = this.viewportEl()?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /**
   * Placement for a splice started from OUTSIDE the canvas (the wire was
   * double-clicked over the effects list): below the lowest existing card, at
   * the canvas's left edge, so it's visible without overlapping anything.
   */
  private freeSpotNearWire(sketchId: string, _wireId: string): { x: number; y: number } {
    const sketch = appState.database.sketches[sketchId];
    let bottom = 0;
    for (const e of sketch ? canvasChain(sketch) : []) {
      bottom = Math.max(bottom, e.canvas!.y + CARD_EXTENT);
    }
    return { x: 40, y: bottom + 20 };
  }

  // --- Persistence -------------------------------------------------------

  private scheduleUiSave() {
    const id = this.sketchId;
    if (!id) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = 0; this.flushUiState(); }, 300);
  }

  private flushUiState() {
    const id = this.sketchId;
    if (!id) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    void saveSketchUiState(id, {
      canvasZoom: this.zoom,
      canvasLinked: this.linked,
      canvasScrollTop: this.viewportEl()?.scrollTop ?? 0,
    });
  }

  private async restoreUiState(id: string) {
    const st = await loadSketchUiState(id);
    if (this.sketchId !== id) return;
    this.zoom = st?.canvasZoom && st.canvasZoom > 0 ? st.canvasZoom : 1;
    this.linked = st?.canvasLinked !== false;
    await this.settled();
    const top = this.linked ? linearScrollTop() : (st?.canvasScrollTop ?? 0);
    this.applyLinkedScroll(top);
  }

  // --- Render ------------------------------------------------------------

  private measureContent() {
    const sketch = this.sketchId ? appState.database.sketches[this.sketchId] : null;
    if (!sketch) return;
    let bottom = 0;
    for (const e of canvasChain(sketch)) bottom = Math.max(bottom, e.canvas!.y + CARD_EXTENT);
    const vpH = this.viewportEl()?.clientHeight ?? 0;
    const next = Math.max(bottom, vpH / this.zoom) + Math.max(TAIL_MIN, vpH * 0.5);
    if (Math.abs(next - this.contentH) > 1) this.contentH = next;
  }

  protected updated() {
    if (this.sketchId !== this.uiStateSketchId) {
      this.flushUiState();
      this.uiStateSketchId = this.sketchId;
      if (this.sketchId) void this.restoreUiState(this.sketchId);
    }
    this.measureContent();
    // Listener is passive:false so alt+wheel can preventDefault (matching
    // arr-grid); Lit's @wheel binding can't express that.
    const vp = this.viewportEl();
    if (vp && !vp.dataset.wheelBound) {
      vp.dataset.wheelBound = '1';
      vp.addEventListener('wheel', this.onWheel, { passive: false });
    }
  }

  render() {
    const sketchId = this.sketchId;
    const sketch = sketchId ? appState.database.sketches[sketchId] : null;
    if (!sketchId || !sketch) {
      return html`<div class="viewport"><div class="empty">
        No sketch selected for editing.</div></div>`;
    }
    const empty = sketchChain(sketch).every(e => !e.canvas);
    const z = this.zoom;
    const surfaceW = 2400;

    return html`
      <div class="viewport" @scroll=${this.onScroll} @dblclick=${this.onSurfaceDblClick}>
        <div class="sizer" style="width:${surfaceW * z}px;height:${this.contentH * z}px">
          <div class="surface"
            style="width:${surfaceW}px;height:${this.contentH}px;transform:scale(${z})">
            <column-group
              layoutMode="canvas"
              .sketchId=${sketchId}
              .colIdx=${0}
              .columnWidth=${CANVAS_CARD_WIDTH}
              .adapter=${ideColumnAdapter}
              .callbacks=${this.cardCallbacks}
            ></column-group>
            ${this.guides.x === null ? nothing
              : html`<div class="guide v" style="left:${this.guides.x}px"></div>`}
            ${this.guides.y === null ? nothing
              : html`<div class="guide h" style="top:${this.guides.y}px"></div>`}
          </div>
        </div>
        ${empty ? html`<div class="empty">
          The sidecar canvas is empty. Drag an effect out of the list, or
          double-click here to add one.</div>` : nothing}
        ${this.linked && z === 1 ? nothing : html`
          <div class="reset" @click=${this.resetView}
            title="Reset zoom and re-link scrolling to the effects list (⌘0)">
            <span>${Math.round(z * 100)}%</span><span>Reset</span>
          </div>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sketch-canvas-view': SketchCanvasView;
  }
}
