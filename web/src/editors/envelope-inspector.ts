/**
 * Custom inspector for mod.shaper.envelope — the drawn-curve modulation remapper.
 *
 * The headline control is a generic ENVELOPE GRAPH editor (<envelope-graph>): a
 * curve over [0,1]×[0,1] defined by a sorted list of (x, y, ease) control points
 * with per-segment exponential easing. It's deliberately re-architected from the
 * older multi-mode graph-widget into one clean data model + Canvas renderer so
 * any "envelope-like" graph can reuse it.
 *
 * Interactions (the part we care about):
 *   - double-click the curve  → add a node there
 *   - double-click a node     → delete it (endpoints are pinned at x=0 / x=1)
 *   - drag a node             → move it (x clamped between neighbours, y in [0,1])
 *   - drag a segment          → bend its exponential easing (vertical drag)
 *
 * The graph is generic (it just edits a points array via callbacks). The
 * inspector wraps it: it parses/serialises the `curve` string field (a flat JSON
 * number array "[x0,y0,e0, ...]", matching native/src/sketch/envelope.h) and
 * feeds the live modulation input as a cursor so you can see where the incoming
 * signal currently lands on the curve. The eval math mirrors envelope.h so the
 * drawn curve matches what the effect computes.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from '../widgets/field-editor';
import { type EnvPoint, evalEnvelope, parseCurve, serializeCurve, clamp01 } from './envelope-math';
import '../widgets/scalar-slider';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ----- The generic envelope graph editor -------------------------------------

@customElement('envelope-graph')
export class EnvelopeGraph extends MobxLitElement {
  // Plain fields (not reactive @property): the canvas redraws imperatively via
  // rAF, so the parent can mutate these every frame without a Lit re-render.
  points: EnvPoint[] = [{ x: 0, y: 0, ease: 0 }, { x: 1, y: 1, ease: 0 }];
  cursor: number | null = null;       // live input x ∈ [0,1], or null
  interactive = true;
  // Optional X-axis override (data-x [0,1] ↔ pixel-x). When set, the curve maps
  // its x onto an EXTERNAL time grid (e.g. the clip panel's zoomable film strip)
  // instead of the default padded full-width. Y is unaffected. Set imperatively.
  xMap: ((dataX: number) => number) | null = null;
  xUnmap: ((px: number) => number) | null = null;
  /** Optional vertical grid lines in DATA-x [0,1] (e.g. real beat/bar positions).
   *  `bar` lines draw brighter. When null, the default quarter grid is used. */
  gridLines: Array<{ x: number; bar: boolean }> | null = null;
  /** Optional selected range in DATA-x [0,1] — shaded band + edges. */
  selection: { x0: number; x1: number } | null = null;
  onChange: ((points: EnvPoint[]) => void) | null = null;
  onInteractionStart: (() => void) | null = null;
  onInteractionEnd: (() => void) | null = null;
  /**
   * Arrangement clip-editor gesture model (default off ⇒ the Effect IDE keeps
   * its click-anywhere-not-node = bend behavior). When on: a drag OFF the curve
   * line makes a time-box selection (via `onSelect`); on-curve / node gestures
   * become time-box-aware (endpoint move, shelf, group move — see onPointer*).
   */
  timeboxGestures = false;
  /** Drag off the curve → selection range in DATA-x (anchor, head). */
  onSelect: ((anchorX: number, headX: number) => void) | null = null;
  /** Track-lane mode: an off-curve pointerdown is NOT claimed (it bubbles to the
   *  grid behind, which sets the caret), while node/curve edits still work. */
  bubbleOffCurve = false;

  private rafId = 0;
  private readonly pad = 10;          // px inset so edge nodes aren't clipped
  /** True while the user is actively dragging — the parent must not overwrite
   *  `points` from the field, or it would clobber the in-progress edit. */
  get interacting() { return this.mode !== 'none'; }
  // Drag state.
  private mode: 'none' | 'node' | 'segment' | 'select' | 'endpoints' | 'shelf' | 'group' = 'none';
  /** Selection anchor (DATA-x) captured at pointerdown in 'select' mode. */
  private selAnchorX = 0;
  /** Start y of a segment's two endpoints (for the 'endpoints' vertical drag). */
  private startYL = 0;
  private startYR = 0;
  /** Dragged node's start x/y (for the Option axis-lock on a single-node drag). */
  private startNodeX = 0;
  private startNodeY = 0;
  /** 'shelf': built lazily on first move; the inner+interior nodes that lift. */
  private shelfBuilt = false;
  private shelfMoving: Array<{ idx: number; startY: number }> = [];
  /** 'group': nodes inside the box + their start x/y, and the box's x extent. */
  private groupNodes: Array<{ idx: number; startX: number; startY: number; isEnd: boolean }> = [];
  private groupMinX = 0;
  private groupMaxX = 1;
  private dragIndex = -1;             // node index, or segment's left-node index
  private startPx = 0; private startPy = 0;
  private startEase = 0;
  private began = false;              // continuous edit started (after threshold)

  static styles = css`
    :host { display: block; }
    /* Fill mode: stretch to the host (clip panel stacks the curve over the strip
       sharing one time grid) instead of the default fixed 132px. */
    :host([fill]) { height: 100%; }
    :host([fill]) canvas { height: 100%; }
    canvas {
      width: 100%; height: 132px; display: block;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 1px;
      touch-action: none; user-select: none; cursor: crosshair;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.draw(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private get canvas(): HTMLCanvasElement | null {
    return this.renderRoot?.querySelector('canvas') ?? null;
  }

  // --- Coordinate transforms (data [0,1] ↔ canvas px, y up) ---
  private dims() {
    const c = this.canvas!;
    return { w: c.clientWidth, h: c.clientHeight };
  }
  private toPx(x: number, y: number): [number, number] {
    const { w, h } = this.dims();
    const xpx = this.xMap ? this.xMap(x) : this.pad + x * (w - 2 * this.pad);
    return [xpx, (h - this.pad) - y * (h - 2 * this.pad)];
  }
  private fromPx(px: number, py: number): [number, number] {
    const { w, h } = this.dims();
    const dx = this.xUnmap ? clamp01(this.xUnmap(px)) : clamp01((px - this.pad) / (w - 2 * this.pad));
    return [dx, clamp01(((h - this.pad) - py) / (h - 2 * this.pad))];
  }

  private eventXY(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.canvas!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // Nearest node within `radius` px of (px,py), or -1.
  private hitNode(px: number, py: number, radius = 11): number {
    let best = -1, bestD = radius * radius;
    for (let i = 0; i < this.points.length; i++) {
      const [nx, ny] = this.toPx(this.points[i].x, this.points[i].y);
      const d = (nx - px) ** 2 + (ny - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Segment (left-node index) whose x-range contains data-x `dx`, or -1.
  private segmentAt(dx: number): number {
    for (let i = 0; i < this.points.length - 1; i++) {
      if (dx >= this.points[i].x && dx <= this.points[i + 1].x) return i;
    }
    return -1;
  }

  // Is (px,py) within `threshold` px of the drawn (eased) curve line?
  private onCurveLine(px: number, py: number, threshold = 7): boolean {
    const [dx] = this.fromPx(px, py);
    const [, curveY] = this.toPx(dx, evalEnvelope(this.points, dx));
    return Math.abs(py - curveY) < threshold;
  }

  /** Claim the gesture: capture the pointer + stop the event reaching a parent
   *  (e.g. the arr-grid caret/region drag behind a track lane). */
  private claim(e: PointerEvent) {
    try { this.canvas!.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    e.stopPropagation();
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.interactive) return;
    if (e.button !== 0) return;
    const [px, py] = this.eventXY(e);
    this.began = false;
    this.startPx = px; this.startPy = py;
    const [dx] = this.fromPx(px, py);
    const sel = this.timeboxGestures ? this.selection : null;
    const inBox = !!sel && sel.x1 > sel.x0 + 1e-6;
    const node = this.hitNode(px, py);
    if (node >= 0) {
      // A node inside the time box → rigid-X / squishy-Y GROUP move.
      if (inBox && this.points[node].x >= sel!.x0 - 1e-6 && this.points[node].x <= sel!.x1 + 1e-6) {
        this.mode = 'group';
        this.beginGroup(sel!);
        return this.claim(e);
      }
      this.mode = 'node';
      this.dragIndex = node;
      this.startNodeX = this.points[node].x;
      this.startNodeY = this.points[node].y;
      return this.claim(e);
    }
    const offCurve = !this.onCurveLine(px, py);
    if (this.timeboxGestures && offCurve) {
      // Off the curve line → a time-box selection drag.
      this.mode = 'select';
      this.selAnchorX = dx;
      this.onSelect?.(dx, dx);
      return this.claim(e);
    }
    if (this.bubbleOffCurve && offCurve) {
      // Track lane: an off-curve click belongs to the timeline behind us (sets
      // the caret) — don't claim it, let it bubble to the grid.
      this.mode = 'none';
      return;
    }
    // On the curve INSIDE the box → build a hard SHELF on first move.
    if (inBox && dx >= sel!.x0 - 1e-6 && dx <= sel!.x1 + 1e-6) {
      this.mode = 'shelf';
      this.shelfBuilt = false;
      return this.claim(e);
    }
    // On the curve. IDE default + arrangement Option = bend the segment;
    // arrangement plain drag = move the segment's two endpoints vertically.
    const seg = this.segmentAt(dx);
    if (seg < 0) { this.mode = 'none'; return; }
    this.dragIndex = seg;
    if (this.timeboxGestures && !e.altKey) {
      this.mode = 'endpoints';
      this.startYL = this.points[seg].y;
      this.startYR = this.points[seg + 1].y;
    } else {
      this.mode = 'segment';
      this.startEase = this.points[seg].ease;
    }
    this.claim(e);
  }

  private onPointerMove(e: PointerEvent) {
    if (this.mode === 'none') return;
    const [px, py] = this.eventXY(e);
    if (this.mode === 'select') {
      // Selection drag isn't a doc edit (no undo) → report anchor + head.
      const [dx] = this.fromPx(px, py);
      this.onSelect?.(this.selAnchorX, dx);
      return;
    }
    // Start the continuous edit only once the pointer actually moves — so a
    // double-click (two near-stationary downs) doesn't open a spurious edit.
    if (!this.began) {
      if (Math.abs(px - this.startPx) < 3 && Math.abs(py - this.startPy) < 3) return;
      this.began = true;
      this.onInteractionStart?.();
    }
    const slow = e.shiftKey ? 0.25 : 1; // Shift = fine adjustment
    const innerH = this.dims().h - 2 * this.pad;

    if (this.mode === 'shelf') {
      // Build the hard shelf (4 edge nodes) on the first move, then lift the
      // inner + interior nodes by the vertical drag.
      if (!this.shelfBuilt) { this.buildShelf(); this.shelfBuilt = true; }
      const dyData = ((this.startPy - py) / innerH) * slow;
      const pts = this.points.map(p => ({ ...p }));
      for (const m of this.shelfMoving) pts[m.idx].y = clamp01(m.startY + dyData);
      this.points = pts;
      this.onChange?.(pts);
      return;
    }

    if (this.mode === 'group') {
      // Move every node in the box: X rigid (clipped to the box walls), Y squishy
      // (per-node clamp; bounces back). Option locks to the dominant axis.
      const sel = this.selection!;
      let ddx = ((px - this.startPx) / (this.dims().w - 2 * this.pad)) * slow;
      let ddy = ((this.startPy - py) / innerH) * slow;
      if (e.altKey) {
        if (Math.abs(px - this.startPx) >= Math.abs(py - this.startPy)) ddy = 0; else ddx = 0;
      }
      // Rigid X: clamp so the group stays within [x0,x1].
      ddx = clamp(ddx, sel.x0 - this.groupMinX, sel.x1 - this.groupMaxX);
      const pts = this.points.map(p => ({ ...p }));
      for (const g of this.groupNodes) {
        if (!g.isEnd) pts[g.idx].x = clamp(g.startX + ddx, 0, 1);
        pts[g.idx].y = clamp01(g.startY + ddy);
      }
      this.points = pts;
      this.onChange?.(pts);
      return;
    }

    const pts = this.points.map(p => ({ ...p }));
    if (this.mode === 'node') {
      const i = this.dragIndex;
      const [dx, dy] = this.fromPx(px, py);
      const isFirst = i === 0, isLast = i === pts.length - 1;
      // Endpoints pin x at 0/1; interior nodes clamp between neighbours but MAY
      // coincide with them (zero-span segments / hard vertical edges are allowed).
      let nx = isFirst ? 0 : isLast ? 1 : clamp(dx, pts[i - 1].x, pts[i + 1].x);
      let ny = clamp01(dy);
      // Option locks to the dominant axis (whichever moved further in px), holding
      // the other at its start value.
      if (e.altKey) {
        if (Math.abs(px - this.startPx) >= Math.abs(py - this.startPy)) ny = this.startNodeY;
        else nx = isFirst ? 0 : isLast ? 1 : this.startNodeX;
      }
      pts[i].x = nx;
      pts[i].y = ny;
    } else if (this.mode === 'endpoints') {
      // Grab the curve, drag vertically → shift the segment's two endpoints' y.
      const i = this.dragIndex;
      const dyData = ((this.startPy - py) / innerH) * slow;
      pts[i].y = clamp01(this.startYL + dyData);
      pts[i + 1].y = clamp01(this.startYR + dyData);
    } else {
      // Vertical drag bends the segment's easing (~120px ⇒ full ±1 range).
      const dyPx = (py - this.startPy) * slow;
      pts[this.dragIndex].ease = clamp(this.startEase - dyPx / 120, -1, 1);
    }
    this.points = pts;
    this.onChange?.(pts);
  }

  /** Insert up to 4 nodes to form a hard shelf spanning the time box, and record
   *  which nodes (inner edges + interior) lift with the drag. */
  private buildShelf() {
    const sel = this.selection!;
    // Both nodes at each box edge sit at EXACTLY the same x → a true zero-span
    // (vertical) edge. Outer = fixed (original value); inner = lifts. Existing
    // nodes on the edges are dropped so we never stack more than the pair.
    const vL = evalEnvelope(this.points, sel.x0);
    const vR = evalEnvelope(this.points, sel.x1);
    const E = 1e-6;
    const left = this.points.filter((p) => p.x < sel.x0 - E);
    const mid = this.points.filter((p) => p.x > sel.x0 + E && p.x < sel.x1 - E);
    const right = this.points.filter((p) => p.x > sel.x1 + E);
    const pts: EnvPoint[] = [
      ...left,
      { x: sel.x0, y: vL, ease: 0 }, // outer L (fixed)
      { x: sel.x0, y: vL, ease: 0 }, // inner L (lifts)
      ...mid,
      { x: sel.x1, y: vR, ease: 0 }, // inner R (lifts)
      { x: sel.x1, y: vR, ease: 0 }, // outer R (fixed)
      ...right,
    ];
    this.points = pts;
    this.onChange?.(pts);
    // Lifting set: inner-left + interior + inner-right (NOT the outer fixed pair).
    const L = left.length;
    const M = mid.length;
    this.shelfMoving = [{ idx: L + 1, startY: vL }];
    for (let i = 0; i < M; i++) this.shelfMoving.push({ idx: L + 2 + i, startY: mid[i].y });
    this.shelfMoving.push({ idx: L + 2 + M, startY: vR });
  }

  /** Capture the nodes inside the box (+ their start x/y + the box x-extent). */
  private beginGroup(sel: { x0: number; x1: number }) {
    this.groupNodes = [];
    for (let i = 0; i < this.points.length; i++) {
      const px = this.points[i].x;
      if (px >= sel.x0 - 1e-6 && px <= sel.x1 + 1e-6) {
        this.groupNodes.push({ idx: i, startX: px, startY: this.points[i].y, isEnd: i === 0 || i === this.points.length - 1 });
      }
    }
    this.groupMinX = Math.min(...this.groupNodes.map((g) => g.startX));
    this.groupMaxX = Math.max(...this.groupNodes.map((g) => g.startX));
  }

  private onPointerUp() {
    if (this.began) this.onInteractionEnd?.();
    this.mode = 'none';
    this.dragIndex = -1;
    this.began = false;
  }

  private onDblClick(e: MouseEvent) {
    if (!this.interactive) return;
    e.preventDefault();
    const [px, py] = this.eventXY(e);
    const node = this.hitNode(px, py);
    if (node >= 0) {
      // Delete a node — but never the pinned endpoints.
      if (node === 0 || node === this.points.length - 1) return;
      const pts = this.points.filter((_, i) => i !== node);
      this.points = pts;
      this.onChange?.(pts);
      return;
    }
    // Add a node at the click position (sorted by x), linear easing.
    const [dx, dy] = this.fromPx(px, py);
    const x = clamp(dx, 1e-3, 1 - 1e-3);
    const pts = [...this.points.map(p => ({ ...p })), { x, y: clamp01(dy), ease: 0 }];
    pts.sort((a, b) => a.x - b.x);
    this.points = pts;
    this.onChange?.(pts);
  }

  // --- Imperative canvas draw (rAF) ---
  private draw() {
    const c = this.canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    const { w: cw, h: ch } = this.dims();
    ctx.clearRect(0, 0, cw, ch);

    const accent = getComputedStyle(this).getPropertyValue('--app-hi-color1').trim() || '#ff4500';

    // Horizontal grid (value quarters).
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (let q = 0; q <= 4; q++) {
      const [, gy] = this.toPx(0, q / 4);
      ctx.beginPath(); ctx.moveTo(this.pad, gy); ctx.lineTo(cw - this.pad, gy); ctx.stroke();
    }
    // Vertical grid: real beat/bar lines when provided, else quarters.
    if (this.gridLines) {
      for (const g of this.gridLines) {
        const [gx] = this.toPx(g.x, 0);
        if (gx < this.pad - 0.5 || gx > cw - this.pad + 0.5) continue;
        ctx.strokeStyle = g.bar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.moveTo(gx, this.pad); ctx.lineTo(gx, ch - this.pad); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      for (let q = 0; q <= 4; q++) {
        const [gx] = this.toPx(q / 4, 0);
        ctx.beginPath(); ctx.moveTo(gx, this.pad); ctx.lineTo(gx, ch - this.pad); ctx.stroke();
      }
    }

    // Selected range: a shaded band with bright edges (matches the timeline box).
    if (this.selection && this.selection.x1 > this.selection.x0 + 1e-6) {
      const [bx0] = this.toPx(this.selection.x0, 0);
      const [bx1] = this.toPx(this.selection.x1, 0);
      ctx.fillStyle = 'rgba(65,105,225,0.16)';
      ctx.fillRect(bx0, this.pad, bx1 - bx0, ch - 2 * this.pad);
      ctx.fillStyle = 'rgba(65,105,225,0.85)';
      ctx.fillRect(Math.round(bx0), this.pad, 1, ch - 2 * this.pad);
      ctx.fillRect(Math.round(bx1), this.pad, 1, ch - 2 * this.pad);
    }

    // Curve + fill, sampled per SEGMENT so a zero-span segment (two coincident
    // control nodes) renders as a hard VERTICAL edge instead of being skipped by
    // a uniform sampler and drawn as a slope.
    const N = 96;
    const samples: [number, number][] = [this.toPx(this.points[0].x, this.points[0].y)];
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i], b = this.points[i + 1];
      if (b.x - a.x < 1e-9) {
        samples.push(this.toPx(b.x, b.y)); // vertical jump
        continue;
      }
      const steps = Math.max(2, Math.round((b.x - a.x) * N));
      for (let s = 1; s <= steps; s++) {
        const x = a.x + (b.x - a.x) * (s / steps);
        samples.push(this.toPx(x, evalEnvelope(this.points, x)));
      }
    }
    const [, baseY] = this.toPx(0, 0);
    ctx.beginPath();
    ctx.moveTo(samples[0][0], baseY);
    for (const [sx, sy] of samples) ctx.lineTo(sx, sy);
    ctx.lineTo(samples[samples.length - 1][0], baseY);
    ctx.closePath();
    ctx.fillStyle = accent + '22';
    ctx.fill();

    ctx.beginPath();
    samples.forEach(([sx, sy], i) => (i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)));
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Live input cursor: vertical line + dot at eval(cursor).
    if (this.cursor != null && this.cursor >= 0 && this.cursor <= 1) {
      const cx = this.cursor;
      const cy = evalEnvelope(this.points, cx);
      const [lx] = this.toPx(cx, 0);
      const [dotx, doty] = this.toPx(cx, cy);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(lx, this.pad); ctx.lineTo(lx, ch - this.pad); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(dotx, doty, 3.5, 0, Math.PI * 2); ctx.fill();
    }

    // Nodes.
    for (let i = 0; i < this.points.length; i++) {
      const [nx, ny] = this.toPx(this.points[i].x, this.points[i].y);
      ctx.beginPath(); ctx.arc(nx, ny, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#0a0a0a'; ctx.stroke();
    }
    ctx.restore();
  }

  render() {
    return html`<canvas
      @pointerdown=${(e: PointerEvent) => this.onPointerDown(e)}
      @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
      @pointerup=${() => this.onPointerUp()}
      @pointercancel=${() => this.onPointerUp()}
      @dblclick=${(e: MouseEvent) => this.onDblClick(e)}></canvas>`;
  }
}

// ----- The mod.shaper.envelope inspector --------------------------------------------

@customElement('envelope-inspector')
export class EnvelopeInspector extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'curve';
  @property() label = 'Envelope';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return ['curve']; }
  getControlElements(): HTMLElement[] {
    const g = this.renderRoot?.querySelector('envelope-graph') as HTMLElement | null;
    return g ? [g] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private edit: ContinuousEditHandle | null = null;
  private rafId = 0;
  // Cache the parse so the rAF sync doesn't re-JSON.parse an unchanged string 60×/s.
  private lastRaw: any = undefined;
  private lastPts: EnvPoint[] = [];

  private pointsFromField(): EnvPoint[] {
    const raw = this.binding?.getValue(this.fieldPath);
    if (raw !== this.lastRaw) { this.lastRaw = raw; this.lastPts = parseCurve(raw); }
    return this.lastPts;
  }

  static styles = css`
    :host { display: block; }
    .label {
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding: 2px 0;
    }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); opacity: 0.7;
      padding: 4px 0 2px; line-height: 1.4;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Feed the live modulation input into the graph cursor each frame, and keep
    // the points in sync with the field (which may change via undo/redo/load).
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const g = this.renderRoot?.querySelector('envelope-graph') as EnvelopeGraph | null;
      if (!g || !this.binding) return;
      // Sync points from the field (undo/redo/load) EXCEPT while dragging.
      if (!g.interacting) g.points = this.pointsFromField();
      const mod = this.binding.getModulation?.('input');
      const live = mod ? mod.value : this.binding.getValue('input');
      g.cursor = typeof live === 'number' ? live : null;
    };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private onChange = (pts: EnvPoint[]) => {
    if (!this.binding) return;
    const str = serializeCurve(pts);
    if (this.edit) this.edit.update(str);
    else this.binding.setValue(this.fieldPath, str);   // one-shot (dbl-click add/remove)
  };
  private onStart = () => {
    if (!this.binding) return;
    this.edit = this.binding.beginContinuousEdit(this.fieldPath,
      serializeCurve(this.pointsFromField()));
  };
  private onEnd = () => { this.edit?.accept(); this.edit = null; };

  render() {
    if (!this.binding) return html``;
    // `points` is synced imperatively via the rAF loop (so a drag isn't clobbered
    // by re-renders); here we just wire the element + its callbacks.
    return html`
      ${this.label ? html`<div class="label">${this.label}</div>` : ''}
      <envelope-graph
        .onChange=${this.onChange}
        .onInteractionStart=${this.onStart}
        .onInteractionEnd=${this.onEnd}></envelope-graph>
      <div class="hint">double-click to add / remove a node · drag a segment to bend its easing</div>
      <!-- The modulation input (the curve's x). Shown even when auto-connected so
           it exposes a wire port AND lets you scrub it by hand for testing; when a
           wire drives it the slider shows the live value + modulation band. -->
      <scalar-slider style="width: 100%;" .fieldPath=${'input'} .label=${'Input'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0}
        .binding=${this.binding}></scalar-slider>
    `;
  }
}

editorRegistry.register('mod.shaper.envelope', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('envelope-inspector') as EnvelopeInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
