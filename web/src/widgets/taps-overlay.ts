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
import { activeEditorColumnsRoots, fieldHitIn, fieldOptionPipIn } from './field-anchor-lookup';
import { execPositions, wireIsDelayed } from '../state/exec-order';
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
  /**
   * Draw in VIEWPORT space instead of inside the editor panel. Set while the
   * sidecar canvas is open: a canvas↔list wire spans two panels, and the panel
   * this overlay lives in clips its overflow. One fixed layer draws them all —
   * two overlays would double-draw any wire with both ends visible and then
   * need arbitration for the hit path and the selection click.
   */
  @property({ type: Boolean, reflect: true }) viewportFixed = false;

  private rafId = 0;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      this.position();
    };
    this.rafId = requestAnimationFrame(tick);
    window.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener('pointerdown', this.onDocPointerDown, true);
  }

  /**
   * Click-away: dismiss the field/wire options popup (it's selection-driven) when
   * the pointer lands outside the popup itself or an element that sets its own
   * selection. Crucially the effect card swallows its own clicks
   * (stopPropagation), so without this a click on the output-trace area (a sibling
   * of the card body, inside the card but on no field) never cleared the
   * selection and the popup stayed stuck. Mirrors the arrangement's capture-phase
   * dismissal: keep on the popup + pips + the field widgets/header (which replace
   * the selection on their own handlers); dismiss everywhere else.
   */
  private onDocPointerDown = (e: PointerEvent) => {
    const sel = appState.local.selection?.path ?? '';
    if (!sel.startsWith('field/') && !sel.startsWith('wire/')) return; // no popup open
    const composed = e.composedPath();
    const hasClass = (c: string) =>
      composed.some((n) => (n as Element)?.classList?.contains?.(c));
    // Always keep: the popup itself; the pips / tap hit-ports + wire arcs (they set
    // their OWN selection on click → the popup switches); the card header (its
    // pointerdown selects the card, replacing the field → the popup closes anyway).
    if (hasClass('field-card') || hasClass('tap-overlay-hit') || hasClass('field-option-pip')
      || hasClass('wire-hit') || hasClass('wire-dot') || hasClass('effect-card-header')) return;
    // A click inside a FIELD body keeps the popup only when it's the SELECTED
    // field's OWN inline widget. Any OTHER field (different fieldPath, or a field
    // in another card), the trace area, or blank space dismisses it — so clicking
    // a different field closes the popup. (The IDE doesn't select-on-field-click,
    // so without this the field row would never clear the prior selection.)
    if (sel.startsWith('field/')) {
      const body = composed.find(
        (n) => (n as Element)?.classList?.contains?.('effect-card-body')) as HTMLElement | undefined;
      if (body) {
        const cardKey = body.dataset.cardKey ?? ''; // `<sketchId>/<col>/<chain>`
        const selField = sel.slice('field/'.length); // `<sketchId>/<col>/<chain>/<fieldPath>`
        if (selField.startsWith(cardKey + '/')) {
          // Click is inside the selected field's own card; keep iff it's that
          // field's widget (or a non-field custom editor in that card).
          const editor = composed.find(
            (n) => typeof (n as { fieldPath?: unknown }).fieldPath === 'string') as { fieldPath: string } | undefined;
          if (!editor || `${cardKey}/${editor.fieldPath}` === selField) return;
        }
      }
    }
    appController.select(null);
  };

  static styles = css`
    :host {
      position: absolute; inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 30;
    }
    /* Escape the panel's overflow clip so cross-panel arcs are visible. Above
     * the panels, below the floating monitor (z-index 200). */
    :host([viewportfixed]) {
      position: fixed;
      z-index: 150;
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
      font-size: var(--app-fs-md);
      will-change: transform;
    }
    /* Inspector field rows reused inside the card (mirrors edit-tab styles). */
    .section-header { font-size: var(--app-fs-sm); text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2, #b0b0b0); margin: 4px 0; }
    .tap-row { display: flex; align-items: center; gap: var(--app-sp-3); padding: 3px 0; }
    .tap-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; color: var(--app-text-color1, #ddd); }
  `;

  /** Draw wire arcs while in wire mode. */
  private get showArcs(): boolean { return appState.local.tappingMode; }

  /** The overlay does anything (arcs or card) — drives the rAF positioning. */
  private get active(): boolean {
    return this.showArcs || this.cardFieldKey() !== null;
  }

  /** The field key whose card to show: a directly-selected `field/…`, OR — for a
   *  selected `wire/…` — its DEST (reader) field, whose inspector holds this wire's mod
   *  controls. Resolving the wire here is what makes clicking a wire open the popup in
   *  place (it showed nothing before, since the card only rendered for field selections). */
  private cardFieldKey(): string | null {
    const p = appState.local.selection?.path ?? '';
    if (p.startsWith('field/')) return p.slice('field/'.length);
    if (p.startsWith('wire/')) {
      const [, sId, wireId] = p.split('/');
      const sk = appState.database.sketches[sId];
      const wire = sk?.wires?.find((w) => w.id === wireId);
      if (!wire) return null;
      const idx = sketchChain(sk).findIndex(
        (e) => e.type === 'module' && e.instance_key === wire.dest.instanceKey);
      if (idx < 0) return null;
      return `${sId}/0/${idx}/${wire.dest.field}`;
    }
    return null;
  }

  /** The field's option pip in the gutter (anchor for the card). */
  private fieldOptionPip(fieldKey: string): HTMLElement | null {
    for (const root of this.roots()) {
      const el = fieldOptionPipIn(root, fieldKey);
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
   * `delayed` marks a wire whose source runs at/after its dest in the merged
   * EXECUTION order (1-frame delay). That order — not chain position — is what
   * the executor uses, so this reads it back from the same stored list rather
   * than re-deriving it; see the `delayed` computation in
   * native/src/sketch/sketch_executor.cpp and state/exec-order.ts.
   */
  private connections(sketch: Sketch): { id: string; from: string; to: string; delayed: boolean; wireId: string }[] {
    const sk = this.sketchId;
    const out: { id: string; from: string; to: string; delayed: boolean; wireId: string }[] = [];

    // instanceKey → "col/chain". Single linear stack now → col index is always 0
    // (kept in the key to match the DOM hit-box `data-col-idx`).
    const loc = new Map<string, string>();
    sketchChain(sketch).forEach((e, chi) => {
      if (e.type === 'module') loc.set(e.instance_key, `0/${chi}`);
    });
    const pos = execPositions(sketch);

    for (const wire of sketch.wires ?? []) {
      const sl = loc.get(wire.src.instanceKey), dl = loc.get(wire.dest.instanceKey);
      if (!sl || !dl) continue;
      out.push({
        id: `wire:${wire.id}`,
        from: `${sk}/${sl}/${wire.src.field}`,
        to: `${sk}/${dl}/${wire.dest.field}`,
        delayed: wireIsDelayed(pos, wire.src.instanceKey, wire.dest.instanceKey),
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

  /** The tap-port hit-box element for a field key `<sketch>/<col>/<chain>/<field>`. */
  private fieldHit(key: string): HTMLElement | null {
    for (const root of this.roots()) {
      const el = fieldHitIn(root, key);
      if (el) return el;
    }
    return null;
  }

  /**
   * Roots that can hold this sketch's cards. The local columns-view always (so
   * the canvas-closed path is byte-identical to before); the sidecar canvas too
   * once we're drawing in viewport space.
   */
  private roots(): ShadowRoot[] {
    const local = this.columnsRoot();
    if (!this.viewportFixed) return local ? [local] : [];
    const out = local ? [local] : [];
    for (const r of activeEditorColumnsRoots()) if (!out.includes(r)) out.push(r);
    return out;
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
        // Anchor beside the COLUMN hosting the field, not beside the hit box
        // itself: an output trace card is a narrow tile in a wide row, and a
        // card anchored to the tile's edge sits on top of its siblings — and
        // of the very port the user must click again for click-to-connect.
        // Beside the column, the whole card (fields + trace row) stays
        // clickable. Field-row hits span the column anyway, so this only
        // changes where trace-tile popups land.
        const colRect = (hit.closest('.column') as HTMLElement | null)
          ?.getBoundingClientRect() ?? r;
        // Prefer the right side; flip to the left when the right side hasn't
        // room for the card (otherwise the bounds clamp would slide it back
        // over the column).
        const fitsRight = colRect.right + 12 + cw <= overlayRect.right;
        const fitsLeft = colRect.left - 12 - cw >= overlayRect.left;
        let ax: number;
        let ay = (r.top + r.height / 2 - overlayRect.top);
        if (fitsRight || fitsLeft) {
          ax = fitsRight
            ? (colRect.right - overlayRect.left) + 12 + cw / 2
            : (colRect.left - overlayRect.left) - 12 - cw / 2;
        } else {
          // No room on EITHER side (wide column / narrow view — the arrangement
          // panel's normal shape): the card must overlap the column, and the
          // bounds clamp used to slide it back dead-center over the selected
          // field. Dodge VERTICALLY instead: hug the right edge and sit just
          // below (else above) the field's row, so the row being inspected —
          // the very port a click-to-connect needs again — stays visible.
          ax = overlayRect.width - 8 - cw / 2;
          const below = (r.bottom - overlayRect.top) + 12 + ch / 2;
          const above = (r.top - overlayRect.top) - 12 - ch / 2;
          const fitsBelow = below + ch / 2 <= overlayRect.height;
          const fitsAbove = above - ch / 2 >= 0;
          if (fitsBelow) ay = below;
          else if (fitsAbove) ay = above;
          // Card taller than both gaps: overlap is unavoidable — take whichever
          // side has more room and let the bounds clamp settle the rest.
          else ay = (overlayRect.bottom - r.bottom) >= (r.top - overlayRect.top)
            ? below : above;
        }
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
