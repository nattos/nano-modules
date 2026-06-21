/**
 * <taps-overlay> — the floating wire/inspector layer for the sketch IDE.
 *
 * A screen-space overlay covering the columns area. While in wire mode it draws
 * committed wires as gently-arcing field→field curves; whenever a field is
 * selected it shows a floating card mirroring that field's inspector, anchored
 * beside the field.
 *
 * Geometry is read from the DOM each frame (field tap-port hit-boxes live in the
 * column-group shadow roots); arc/card placement is applied imperatively in a
 * rAF loop so we don't re-render Lit every frame. The arc/card DOM itself is
 * rendered reactively (MobxLitElement) when the wire set or selection changes.
 */

import { html, css, nothing, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController, wireSelectablePath } from '../state/controller';
import type { Sketch } from '../sketch-types';
import { sketchChain } from '../sketch-types';
import { layoutFloaters, type Floater } from './floating-layout';
import { tapsConnect } from './taps-connect';
import './spark-chart';

type Pt = { x: number; y: number };
interface Bezier { p0: Pt; c1: Pt; c2: Pt; p3: Pt; }

/**
 * A gently arcing cubic bezier from `a` (writer) to `b` (reader). Both control
 * points bow to the right (+x) so same-column connections read as a soft C; the
 * bow scales mildly with vertical distance. Path direction a→b drives the
 * marching-ants dash so the animation indicates data-flow direction.
 */
function arcBezier(a: Pt, b: Pt): Bezier {
  const dy = b.y - a.y;
  const bow = Math.min(Math.max(Math.abs(dy) * 0.25 + 26, 32), 90);
  return {
    p0: a,
    c1: { x: a.x + bow, y: a.y + dy * 0.33 },
    c2: { x: b.x + bow, y: b.y - dy * 0.33 },
    p3: b,
  };
}

const bezPath = (z: Bezier): string =>
  `M ${z.p0.x} ${z.p0.y} C ${z.c1.x} ${z.c1.y} ${z.c2.x} ${z.c2.y} ${z.p3.x} ${z.p3.y}`;

function arcPath(a: Pt, b: Pt): string { return bezPath(arcBezier(a, b)); }

const midpoint = (p: Pt, q: Pt): Pt => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });

/** Split a cubic bezier at t=0.5 (de Casteljau) → two halves + the join point. */
function splitBezier(z: Bezier): { first: Bezier; second: Bezier; mid: Pt } {
  const a = midpoint(z.p0, z.c1), b = midpoint(z.c1, z.c2), c = midpoint(z.c2, z.p3);
  const d = midpoint(a, b), e = midpoint(b, c);
  const f = midpoint(d, e);
  return {
    first: { p0: z.p0, c1: a, c2: d, p3: f },
    second: { p0: f, c1: e, c2: c, p3: z.p3 },
    mid: f,
  };
}

@customElement('taps-overlay')
export class TapsOverlay extends MobxLitElement {
  @property({ type: String }) sketchId = '';

  private rafId = 0;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.position();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  static styles = css`
    :host {
      position: absolute; inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 30;
    }
    .lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible;
      pointer-events: none; }
    .connect-line { stroke: var(--app-hi-color2, #4169E1); stroke-width: 2; stroke-dasharray: 4 3; }
    /* Committed wires drawn as gently arcing field→field curves while in wire
     * mode. The marching-ants dash flows from writer (path start) → reader (path
     * end) to indicate direction. A design faux-pas by our usual standards, but
     * acceptable behind the mode. */
    .wire-arc { fill: none; stroke: var(--app-hi-color2, #4169E1); stroke-width: 1.5;
      opacity: 0.5; stroke-dasharray: 5 4; stroke-linecap: round;
      animation: wire-flow 0.7s linear infinite; }
    /* 1-frame-delayed (feedback) wire: output-pip red, split into two halves that
     * animate alternately (relay through the midpoint dot) so the delay reads
     * visually. seg-a flows src→mid while seg-b holds, then they swap. */
    .wire-arc.delayed { stroke: var(--app-hi-color1, #ff4500); opacity: 0.7; animation: none; }
    .wire-arc.delayed.seg-a { animation: wire-relay-a 1.4s linear infinite; }
    .wire-arc.delayed.seg-b { animation: wire-relay-b 1.4s linear infinite; }
    .wire-dot { fill: var(--app-hi-color1, #ff4500); opacity: 0.9; }
    /* Selected wire: solid, bright, no marching ants — double-click to break. */
    .wire-arc.selected { stroke: var(--app-hi-color1, #ff4500); opacity: 1;
      stroke-width: 2.5; stroke-dasharray: none; animation: none; }
    .wire-dot.selected { opacity: 1; }
    @keyframes wire-flow { to { stroke-dashoffset: -9; } }
    /* Relay: each half marches during one half of the cycle and holds the other,
     * with a brief shared pause at the dot for a clear hand-off beat. */
    @keyframes wire-relay-a {
      0% { stroke-dashoffset: 0; } 45% { stroke-dashoffset: -9; } 100% { stroke-dashoffset: -9; }
    }
    @keyframes wire-relay-b {
      0% { stroke-dashoffset: 0; } 55% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -9; }
    }
    /* Fat transparent companion that catches clicks (the visible arc is thin and
     * dashed). pointer-events:stroke works even though the parent svg is
     * pointer-events:none (a descendant may opt back in). Click selects the wire;
     * double-click breaks it. */
    .wire-hit { fill: none; stroke: transparent; stroke-width: 14;
      pointer-events: stroke; cursor: pointer; }
    .wire-group:hover .wire-arc { stroke: var(--app-hi-color1, #ff4500); opacity: 0.95; }
    .field-card {
      position: absolute; left: 0; top: 0;
      pointer-events: auto;
      width: 220px;
      max-height: 70vh; overflow-y: auto;
      padding: 8px 10px; border-radius: 1px;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-hi-color2, #4169E1);
      box-shadow: 0 3px 12px rgba(0,0,0,0.5);
      font-size: 11px;
      will-change: transform;
    }
    /* Inspector field rows reused inside the card (mirrors edit-tab styles). */
    .section-header { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--app-text-color2, #999); margin: 4px 0; }
    .tap-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
    .tap-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--app-text-color1, #ddd); }
  `;

  /** Draw wire arcs while in wire mode. */
  private get showArcs(): boolean { return appState.local.tappingMode; }

  /** The overlay does anything (arcs or card) — drives the rAF positioning. */
  private get active(): boolean {
    return this.showArcs || this.cardFieldKey() !== null;
  }

  /** The field key whose card to show: a directly-selected `field/…`. */
  private cardFieldKey(): string | null {
    const p = appState.local.selection?.path ?? '';
    if (p.startsWith('field/')) return p.slice('field/'.length);
    return null;
  }

  /** The field's option pip in the gutter (anchor for the card). */
  private fieldOptionPip(fieldKey: string): HTMLElement | null {
    const cvRoot = this.columnsRoot();
    if (!cvRoot) return null;
    for (const g of cvRoot.querySelectorAll('column-group')) {
      const el = (g as HTMLElement).shadowRoot?.querySelector(
        `.field-option-pip[data-field-key="${fieldKey}"]`) as HTMLElement | null;
      if (el) return el;
    }
    return null;
  }

  /**
   * Element to anchor the card's Y to: the field's tap-port hit-box, else its
   * gutter option pip (so a pip click outside wire mode still anchors the card
   * to the field row instead of (0,0)).
   */
  private cardAnchorEl(fieldKey: string): HTMLElement | null {
    return this.fieldHit(fieldKey) ?? this.fieldOptionPip(fieldKey);
  }

  /**
   * Field→field wires to visualize. Endpoints are field keys
   * `${sketchId}/${col}/${chain}/${field}` (the format `fieldHit` consumes).
   * `delayed` marks a wire whose source is at/below its dest (1-frame delay).
   */
  private connections(sketch: Sketch): { id: string; from: string; to: string; delayed: boolean; wireId: string }[] {
    const sk = this.sketchId;
    const out: { id: string; from: string; to: string; delayed: boolean; wireId: string }[] = [];

    // instanceKey → "col/chain" + global stack position (for delay inference).
    // Single linear stack now → col index is always 0 (kept in the key to match
    // the DOM hit-box `data-col-idx`).
    const loc = new Map<string, string>();
    const pos = new Map<string, number>();
    let order = 0;
    sketchChain(sketch).forEach((e, chi) => {
      if (e.type === 'module') { loc.set(e.instance_key, `0/${chi}`); pos.set(e.instance_key, order++); }
    });

    for (const wire of sketch.wires ?? []) {
      const sl = loc.get(wire.src.instanceKey), dl = loc.get(wire.dest.instanceKey);
      if (!sl || !dl) continue;
      const sp = pos.get(wire.src.instanceKey) ?? 0, dp = pos.get(wire.dest.instanceKey) ?? 0;
      out.push({
        id: `wire:${wire.id}`,
        from: `${sk}/${sl}/${wire.src.field}`,
        to: `${sk}/${dl}/${wire.dest.field}`,
        delayed: sp >= dp,
        wireId: wire.id,
      });
    }
    return out;
  }

  /**
   * Register each wire as a Selectable. Selecting a wire shows the same inspector
   * as selecting its DEST (reader) field — the field whose value the wire feeds
   * and modulates (including this wire's mod controls in the Wires section). The
   * dest field's Selectable is registered by column-group; we just delegate to it.
   */
  private registerWireSelectables(sketch: Sketch) {
    for (const wire of sketch.wires ?? []) {
      const sId = this.sketchId;
      const path = wireSelectablePath(sId, wire.id);
      appController.defineSelectable({
        path,
        label: `Wire → ${wire.dest.field}`,
        renderInspectorContent: () => {
          const sk = appState.database.sketches[sId];
          if (!sk) return undefined;
          const idx = sketchChain(sk).findIndex(
            e => e.type === 'module' && e.instance_key === wire.dest.instanceKey);
          if (idx < 0) return undefined;
          return appController.getSelectable(`field/${sId}/0/${idx}/${wire.dest.field}`)
            ?.renderInspectorContent?.();
        },
      });
    }
  }

  render() {
    const sketch = appState.database.sketches[this.sketchId];
    const fieldKey = this.cardFieldKey();
    const cardContent = fieldKey
      ? appController.getSelectable(`field/${fieldKey}`)?.renderInspectorContent?.()
      : undefined;
    if (this.showArcs && sketch) this.registerWireSelectables(sketch);
    const conns = (this.showArcs && sketch) ? this.connections(sketch) : [];
    if (conns.length === 0 && !cardContent) return html`<svg class="lines"></svg>`;

    const selectedPath = appState.local.selection?.path ?? '';
    return html`
      <svg class="lines">
        ${conns.map(cn => {
          // Each wire has a fat companion hit path in front of the thin visible
          // arc: single click SELECTS the wire (so it isn't deleted by accident),
          // double click BREAKS it.
          const sel = wireSelectablePath(this.sketchId, cn.wireId) === selectedPath;
          const selCls = sel ? 'selected' : '';
          const hit = svg`<path class="arc-path wire-hit" data-from=${cn.from} data-to=${cn.to}
            @click=${() => appController.select(wireSelectablePath(this.sketchId, cn.wireId))}
            @dblclick=${() => appController.removeWire(this.sketchId, cn.wireId)}></path>`;
          // A 1-frame-delayed (feedback) wire: drawn in two halves that animate
          // alternately, with a dot at the relay point — and in the output-pip red.
          if (cn.delayed) {
            return svg`<g class="wire-group">
              ${hit}
              <path class="arc-path wire-arc delayed seg-a ${selCls}" data-seg="0"
                data-from=${cn.from} data-to=${cn.to}></path>
              <path class="arc-path wire-arc delayed seg-b ${selCls}" data-seg="1"
                data-from=${cn.from} data-to=${cn.to}></path>
              <circle class="wire-dot ${selCls}" r="3" data-from=${cn.from} data-to=${cn.to}></circle>
            </g>`;
          }
          return svg`<g class="wire-group">
            ${hit}
            <path class="arc-path wire-arc ${selCls}" data-conn-id=${cn.id}
              data-from=${cn.from} data-to=${cn.to}></path>
          </g>`;
        })}
        <line class="connect-line" style="display:none"></line>
      </svg>
      ${cardContent ? html`<div class="field-card">${cardContent}</div>` : nothing}
    `;
  }

  // --- Geometry / positioning (imperative, per rAF) ---

  private columnsRoot(): ShadowRoot | null {
    const root = this.getRootNode() as ShadowRoot | Document;
    const cv = (root as ParentNode).querySelector?.('columns-view') as HTMLElement | null;
    return cv?.shadowRoot ?? null;
  }

  /** Screen X of the right edge of a column's gutter, or null. */
  private columnGutterRight(colIdx: number): number | null {
    const cvRoot = this.columnsRoot();
    if (!cvRoot) return null;
    for (const g of cvRoot.querySelectorAll('column-group')) {
      const gut = (g as HTMLElement).shadowRoot?.querySelector(
        `.column-gutter[data-col="${colIdx}"]`) as HTMLElement | null;
      if (gut) return gut.getBoundingClientRect().right;
    }
    return null;
  }

  /** The tap-port hit-box element for a field key `<sketch>/<col>/<chain>/<field>`. */
  private fieldHit(key: string): HTMLElement | null {
    const cvRoot = this.columnsRoot();
    if (!cvRoot) return null;
    const [, colStr, chainStr, ...fp] = key.split('/');
    const sel = `.tap-overlay-hit[data-col-idx="${colStr}"][data-chain-idx="${chainStr}"][data-field-path="${fp.join('/')}"]`;
    for (const g of cvRoot.querySelectorAll('column-group')) {
      const hit = (g as HTMLElement).shadowRoot?.querySelector(sel) as HTMLElement | null;
      if (hit) return hit;
    }
    return null;
  }

  private position() {
    if (!this.active) return;
    const overlayRect = this.getBoundingClientRect();

    // Field card floater — placed beside the selected field's row, clamped to
    // the overlay bounds.
    const floaters: Floater[] = [];
    const card = this.renderRoot.querySelector('.field-card') as HTMLElement | null;
    const fieldKey = this.cardFieldKey();
    if (card && fieldKey) {
      const hit = this.cardAnchorEl(fieldKey);
      // Hide the card until we have an anchor, so it never flashes at (0,0).
      card.style.visibility = hit ? 'visible' : 'hidden';
      if (hit) {
        const r = hit.getBoundingClientRect();
        const cw = card.offsetWidth, ch = card.offsetHeight;
        // Anchor to the right of the column's gutter so the card never covers
        // the gutter; fall back to the field's right edge.
        const colIdx = parseInt(fieldKey.split('/')[1], 10);
        const gutterRight = this.columnGutterRight(colIdx);
        const leftEdge = gutterRight ?? r.right;
        const ax = (leftEdge - overlayRect.left) + 12 + cw / 2;
        const ay = (r.top + r.height / 2 - overlayRect.top);
        floaters.push({ id: '__card__', anchorX: ax, anchorY: ay,
          width: cw, height: ch, weightX: 2, weightY: 1 });
      }
    }

    const pos = layoutFloaters(floaters, {
      bounds: { minX: 0, minY: 0, maxX: overlayRect.width, maxY: overlayRect.height },
    });

    if (card && pos.has('__card__')) {
      const p = pos.get('__card__')!;
      card.style.transform = `translate(${p.x - card.offsetWidth / 2}px, ${p.y - card.offsetHeight / 2}px)`;
    }

    const svgEl = this.renderRoot.querySelector('svg.lines') as SVGElement | null;
    if (svgEl) {
      this.drawArcs(svgEl, overlayRect);
      this.drawConnectLine(svgEl, overlayRect);
    }
  }

  /**
   * Update each committed wire's arc `d` from live field-port rects.
   *
   * Strictly two-phase — measure ALL endpoints first, then write ALL geometry —
   * to avoid layout thrashing. Interleaving `getBoundingClientRect` (read) with
   * `setAttribute('d')` (write) forces a synchronous reflow per wire; with the
   * floating field card in the DOM (whenever a field is selected / picked up for
   * click-to-connect) each of those reflows re-lays-out the heavy inspector
   * card, which tanked the framerate. Batched, the whole pass costs one reflow.
   */
  private drawArcs(svg: SVGElement, overlayRect: DOMRect) {
    // READ phase — no DOM writes, so only the first rect query forces a reflow.
    const paths = Array.from(svg.querySelectorAll('path.arc-path')) as SVGPathElement[];
    const arcs = paths.map(p => ({
      p,
      a: this.fieldCenter(p.dataset.from ?? '', overlayRect),
      b: this.fieldCenter(p.dataset.to ?? '', overlayRect),
      seg: p.dataset.seg,
    }));
    const dots = Array.from(svg.querySelectorAll('circle.wire-dot')) as SVGCircleElement[];
    const dotData = dots.map(dot => ({
      dot,
      a: this.fieldCenter(dot.dataset.from ?? '', overlayRect),
      b: this.fieldCenter(dot.dataset.to ?? '', overlayRect),
    }));

    // WRITE phase.
    for (const { p, a, b, seg } of arcs) {
      if (!a || !b) { p.style.display = 'none'; continue; }
      p.style.display = '';
      // `data-seg` 0/1 → one half of a delayed wire's split bezier; absent → full arc.
      if (seg === undefined) { p.setAttribute('d', arcPath(a, b)); continue; }
      const split = splitBezier(arcBezier(a, b));
      p.setAttribute('d', bezPath(seg === '0' ? split.first : split.second));
    }
    // Midpoint dot for delayed wires (the relay between the two animated halves).
    for (const { dot, a, b } of dotData) {
      if (!a || !b) { dot.style.display = 'none'; continue; }
      dot.style.display = '';
      const m = splitBezier(arcBezier(a, b)).mid;
      dot.setAttribute('cx', String(m.x));
      dot.setAttribute('cy', String(m.y));
    }
  }

  /** Overlay-relative center of a field's connection anchor: its tap-port
   *  hit-box on an expanded card, or its splayed option pip when the card is
   *  collapsed (cardAnchorEl resolves whichever exists). */
  private fieldCenter(key: string, overlayRect: DOMRect): { x: number; y: number } | null {
    if (!key) return null;
    const hit = this.cardAnchorEl(key);
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.left + r.width / 2 - overlayRect.left, y: r.top + r.height / 2 - overlayRect.top };
  }

  /** Live rubber-band line while a click/drag-to-connect is in progress. */
  private drawConnectLine(svg: SVGElement, overlayRect: DOMRect) {
    const line = svg.querySelector('line.connect-line') as SVGLineElement | null;
    if (!line) return;
    const c = tapsConnect.state;
    if (!c) { line.style.display = 'none'; return; }
    const src = this.fieldCenter(c.sourceId, overlayRect);
    if (!src) { line.style.display = 'none'; return; }
    line.style.display = '';
    line.setAttribute('x1', String(src.x));
    line.setAttribute('y1', String(src.y));
    line.setAttribute('x2', String(c.pointerX - overlayRect.left));
    line.setAttribute('y2', String(c.pointerY - overlayRect.top));
  }
}
