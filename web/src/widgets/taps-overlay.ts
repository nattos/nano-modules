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
import { appController } from '../state/controller';
import type { Sketch } from '../sketch-types';
import { layoutFloaters, type Floater } from './floating-layout';
import { tapsConnect } from './taps-connect';
import './spark-chart';

/**
 * A gently arcing cubic-bezier path from `a` (writer) to `b` (reader). Both
 * control points bow to the right (+x) so same-column connections read as a soft
 * C; the bow scales mildly with vertical distance. Path direction a→b drives the
 * marching-ants dash so the animation indicates data-flow direction.
 */
function arcPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dy = b.y - a.y;
  const bow = Math.min(Math.max(Math.abs(dy) * 0.25 + 26, 32), 90);
  const c1x = a.x + bow, c1y = a.y + dy * 0.33;
  const c2x = b.x + bow, c2y = b.y - dy * 0.33;
  return `M ${a.x} ${a.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${b.x} ${b.y}`;
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
    .wire-arc.delayed { stroke: var(--app-text-color2, #999); opacity: 0.4; }
    @keyframes wire-flow { to { stroke-dashoffset: -9; } }
    /* Fat transparent companion that catches clicks (the visible arc is thin and
     * dashed). pointer-events:stroke works even though the parent svg is
     * pointer-events:none (a descendant may opt back in). Click removes the wire. */
    .wire-hit { fill: none; stroke: transparent; stroke-width: 14;
      pointer-events: stroke; cursor: pointer; }
    .wire-hit:hover + .wire-arc { stroke: var(--app-hi-color1, #ff4500); opacity: 0.95; }
    .field-card {
      position: absolute; left: 0; top: 0;
      pointer-events: auto;
      width: 220px;
      max-height: 70vh; overflow-y: auto;
      padding: 8px 10px; border-radius: 6px;
      background: var(--app-bg-color2, #1e1e1e);
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
    const loc = new Map<string, string>();
    const pos = new Map<string, number>();
    let order = 0;
    sketch.columns.forEach((c, ci) => c.chain.forEach((e, chi) => {
      if (e.type === 'module') { loc.set(e.instance_key, `${ci}/${chi}`); pos.set(e.instance_key, order++); }
    }));

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

  render() {
    const sketch = appState.database.sketches[this.sketchId];
    const fieldKey = this.cardFieldKey();
    const cardContent = fieldKey
      ? appController.getSelectable(`field/${fieldKey}`)?.renderInspectorContent?.()
      : undefined;
    const conns = (this.showArcs && sketch) ? this.connections(sketch) : [];
    if (conns.length === 0 && !cardContent) return html`<svg class="lines"></svg>`;

    return html`
      <svg class="lines">
        ${conns.map(cn => {
          // Each wire gets a fat click-to-remove hit path in front of the
          // visible arc.
          const hit = svg`<path class="arc-path wire-hit" data-from=${cn.from} data-to=${cn.to}
            @click=${() => appController.removeWire(this.sketchId, cn.wireId)}></path>`;
          return [hit, svg`<path class="arc-path wire-arc ${cn.delayed ? 'delayed' : ''}"
            data-conn-id=${cn.id} data-from=${cn.from} data-to=${cn.to}></path>`];
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

  /** Update each committed wire's arc `d` from live field-port rects. */
  private drawArcs(svg: SVGElement, overlayRect: DOMRect) {
    for (const p of Array.from(svg.querySelectorAll('path.arc-path')) as SVGPathElement[]) {
      const a = this.fieldCenter(p.dataset.from ?? '', overlayRect);
      const b = this.fieldCenter(p.dataset.to ?? '', overlayRect);
      if (!a || !b) { p.style.display = 'none'; continue; }
      p.style.display = '';
      p.setAttribute('d', arcPath(a, b));
    }
  }

  /** Overlay-relative center of a field's tap-port hit-box (manager-backed Y). */
  private fieldCenter(key: string, overlayRect: DOMRect): { x: number; y: number } | null {
    if (!key) return null;
    const hit = this.fieldHit(key);
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
