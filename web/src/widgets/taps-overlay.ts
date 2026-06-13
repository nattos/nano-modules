/**
 * <taps-overlay> — the floating taps UI layer for the sketch IDE.
 *
 * A screen-space overlay covering the columns area. When taps mode is active (or
 * a field/rail is selected) it shows, at the top of the viewport, one floating
 * "badge" per rail (MMO name-label style) plus a "+ New" badge, and — when a
 * field is selected — a floating card mirroring that field's inspector, anchored
 * beside the field. Badges/card are positioned by the `floating-layout` solver so
 * they don't overlap, X-tracking their rails as the columns scroll horizontally.
 *
 * Geometry is read from the DOM each frame (rail lines + tap hit-boxes live in
 * the column-group shadow roots); badge/card placement is applied imperatively in
 * a rAF loop so we don't re-render Lit every frame. The badge/card DOM itself is
 * rendered reactively (MobxLitElement) when the rail set or selection changes.
 */

import { html, css, nothing, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { FieldConnectInfo } from '../state/controller';
import type { Rail, Sketch } from '../sketch-types';
import { layoutFloaters, type Floater } from './floating-layout';
import { tapsConnect, NEW_BADGE_ID as NEW_ID } from './taps-connect';
import './spark-chart';

interface RailRef { rail: Rail; scope: 'sketch' | number; }

const BAND_TOP = 6;       // px from the overlay top to the badge band

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
    .leader { stroke: var(--app-text-color2, #888); stroke-width: 1; opacity: 0.5; }
    .connect-line { stroke: var(--app-hi-color2, #4169E1); stroke-width: 2; stroke-dasharray: 4 3; }
    /* Committed connections (taps via rails + explicit wires) drawn as gently
     * arcing field→field curves while in tap/wire mode. The marching-ants dash
     * flows from writer (path start) → reader (path end) to indicate direction.
     * A design faux-pas by our usual standards, but acceptable behind the mode. */
    .wire-arc { fill: none; stroke: var(--app-hi-color2, #4169E1); stroke-width: 1.5;
      opacity: 0.5; stroke-dasharray: 5 4; stroke-linecap: round;
      animation: wire-flow 0.7s linear infinite; }
    .wire-arc.delayed { stroke: var(--app-text-color2, #999); opacity: 0.4; }
    @keyframes wire-flow { to { stroke-dashoffset: -9; } }
    .badge {
      position: absolute; left: 0; top: 0;
      pointer-events: auto; cursor: pointer;
      font-size: 10px; line-height: 1;
      padding: 4px 7px; border-radius: 9px;
      background: var(--app-bg-color3, #2a2a2a);
      border: 1px solid rgba(255,255,255,0.18);
      color: var(--app-text-color1, #ddd);
      white-space: nowrap; user-select: none;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
      will-change: transform;
    }
    .badge:hover { border-color: var(--app-hi-color2, #4169E1); }
    .badge[selected] { border-color: var(--app-hi-color2, #4169E1); background: rgba(65,105,225,0.25); }
    .badge[drop-target] { border-color: var(--app-hi-color1, #ff4500); background: rgba(255,69,0,0.3); }
    .badge.new { color: var(--app-text-color2, #999); border-style: dashed; }
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
    .dir-btn { background: var(--app-bg-color3, #333); border: 1px solid rgba(255,255,255,0.15);
      color: var(--app-text-color2, #999); cursor: pointer; border-radius: 3px;
      font-size: 10px; width: 20px; height: 18px; }
    .dir-btn[active] { background: var(--app-hi-color2, #4169E1); color: #fff; }
  `;

  /** Badges (rail labels + "+ New") show while wiring or with a field/rail selected. */
  private get badgeActive(): boolean {
    const p = appState.local.selection?.path;
    return appState.local.tappingMode || !!(p && (p.startsWith('field/') || p.startsWith('rail/')));
  }

  /** The overlay does anything (badges or card) — drives the rAF positioning. */
  private get active(): boolean {
    return this.badgeActive || this.cardFieldKey() !== null;
  }

  /**
   * The field key whose card to show: a directly-selected `field/…`, or the
   * field a selected `gtap/…` (tap) belongs to. Works in both modes.
   */
  private cardFieldKey(): string | null {
    const p = appState.local.selection?.path ?? '';
    if (p.startsWith('field/')) return p.slice('field/'.length);
    if (p.startsWith('gtap/')) {
      const [, sk, col, chain, tapStr] = p.split('/');
      const entry = appState.database.sketches[sk]?.columns[+col]?.chain[+chain];
      if (entry?.type !== 'module') return null;
      const tap = entry.taps?.[+tapStr];
      return tap ? `${sk}/${col}/${chain}/${tap.fieldPath}` : null;
    }
    return null;
  }

  /** The selected tap's gutter indicator element (for anchoring outside taps mode). */
  private gtapIndicator(path: string): HTMLElement | null {
    const cvRoot = this.columnsRoot();
    if (!cvRoot) return null;
    for (const g of cvRoot.querySelectorAll('column-group')) {
      const el = (g as HTMLElement).shadowRoot?.querySelector(
        `.tap-indicator[data-tap-path="${path}"]`) as HTMLElement | null;
      if (el) return el;
    }
    return null;
  }

  /** The field's option pip in the gutter (anchor when nothing else exists). */
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
   * Element to anchor the card's Y to: the tap hit-box (taps mode), else the
   * selected gutter tap dot, else the field's option pip (so a pip click outside
   * taps mode still anchors the card to the field row instead of (0,0)).
   */
  private cardAnchorEl(fieldKey: string): HTMLElement | null {
    const hit = this.fieldHit(fieldKey);
    if (hit) return hit;
    const p = appState.local.selection?.path ?? '';
    if (p.startsWith('gtap/')) {
      const g = this.gtapIndicator(p);
      if (g) return g;
    }
    return this.fieldOptionPip(fieldKey);
  }

  private railRefs(sketch: Sketch): RailRef[] {
    const refs: RailRef[] = [];
    for (const r of sketch.rails ?? []) refs.push({ rail: r, scope: 'sketch' });
    sketch.columns.forEach((c, ci) => {
      for (const r of c.rails ?? []) refs.push({ rail: r, scope: ci });
    });
    return refs;
  }

  /** Show arcing connection lines while in tap/wire mode. */
  private get showArcs(): boolean { return appState.local.tappingMode; }

  /**
   * Field→field connections to visualize: each legacy tap pair (writer→reader
   * sharing a rail) and each explicit wire (src→dest). Endpoints are field keys
   * `${sketchId}/${col}/${chain}/${field}` (the format `fieldHit` consumes).
   * `delayed` marks a wire whose source is at/below its dest (1-frame delay).
   */
  private connections(sketch: Sketch): { id: string; from: string; to: string; delayed: boolean }[] {
    const sk = this.sketchId;
    const out: { id: string; from: string; to: string; delayed: boolean }[] = [];

    // instanceKey → "col/chain" + global stack position (for delay inference).
    const loc = new Map<string, string>();
    const pos = new Map<string, number>();
    let order = 0;
    sketch.columns.forEach((c, ci) => c.chain.forEach((e, chi) => {
      if (e.type === 'module') { loc.set(e.instance_key, `${ci}/${chi}`); pos.set(e.instance_key, order++); }
    }));

    // Legacy taps, grouped by rail: every writer → every reader.
    const writers = new Map<string, string[]>();
    const readers = new Map<string, string[]>();
    sketch.columns.forEach((c, ci) => c.chain.forEach((e, chi) => {
      if (e.type !== 'module') return;
      for (const t of e.taps ?? []) {
        const key = `${sk}/${ci}/${chi}/${t.fieldPath}`;
        const m = t.direction === 'write' ? writers : readers;
        const arr = m.get(t.railId); if (arr) arr.push(key); else m.set(t.railId, [key]);
      }
    }));
    for (const [railId, ws] of writers) {
      for (const w of ws) for (const r of readers.get(railId) ?? []) {
        out.push({ id: `tap:${railId}:${w}>${r}`, from: w, to: r, delayed: false });
      }
    }

    // Explicit wires: source field → dest field (instanceKey-addressed).
    for (const wire of sketch.wires ?? []) {
      const sl = loc.get(wire.src.instanceKey), dl = loc.get(wire.dest.instanceKey);
      if (!sl || !dl) continue;
      const sp = pos.get(wire.src.instanceKey) ?? 0, dp = pos.get(wire.dest.instanceKey) ?? 0;
      out.push({
        id: `wire:${wire.id}`,
        from: `${sk}/${sl}/${wire.src.field}`,
        to: `${sk}/${dl}/${wire.dest.field}`,
        delayed: sp >= dp,
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
    // Badges show while wiring (taps mode) or with a field/rail selected. The
    // card shows whenever a field OR a tap is selected — including regular mode.
    const showBadges = this.badgeActive && !!sketch;
    if (!showBadges && !cardContent) return html`<svg class="lines"></svg>`;

    const refs = showBadges ? this.railRefs(sketch!) : [];
    refs.forEach(r => this.registerRailSelectable(r));
    const selPath = appState.local.selection?.path ?? '';
    const conns = (this.showArcs && sketch) ? this.connections(sketch) : [];

    return html`
      <svg class="lines">
        ${refs.map(r => svg`<line class="leader" data-rail-id=${r.rail.id}></line>`)}
        ${conns.map(cn => svg`<path class="wire-arc ${cn.delayed ? 'delayed' : ''}"
          data-conn-id=${cn.id} data-from=${cn.from} data-to=${cn.to}></path>`)}
        <line class="connect-line" style="display:none"></line>
      </svg>
      ${showBadges ? html`
        ${refs.map(r => {
          const railPath = `rail/${this.sketchId}/${r.scope}/${r.rail.id}`;
          return html`<div class="badge" data-rail-id=${r.rail.id}
            ?selected=${selPath === railPath}
            @pointerdown=${(e: PointerEvent) => this.onBadgePointerDown(e, r)}
            @click=${() => this.onBadgeClick(r)}>${r.rail.name ?? r.rail.id}</div>`;
        })}
        <div class="badge new" data-rail-id=${NEW_ID}
          @click=${() => this.onNewBadgeClick()}>＋ New</div>
      ` : nothing}
      ${cardContent ? html`<div class="field-card">${cardContent}</div>` : nothing}
    `;
  }

  // --- Geometry / positioning (imperative, per rAF) ---

  private columnsRoot(): ShadowRoot | null {
    const root = this.getRootNode() as ShadowRoot | Document;
    const cv = (root as ParentNode).querySelector?.('columns-view') as HTMLElement | null;
    return cv?.shadowRoot ?? null;
  }

  /** Screen-center X of a rail's first (leftmost) rail-line, or null. */
  private railScreenX(railId: string): number | null {
    const cvRoot = this.columnsRoot();
    if (!cvRoot) return null;
    let best: number | null = null;
    for (const g of cvRoot.querySelectorAll('column-group')) {
      const line = (g as HTMLElement).shadowRoot?.querySelector(
        `.rail-line[data-rail-id="${railId}"]`) as HTMLElement | null;
      if (!line) continue;
      const r = line.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      if (best === null || cx < best) best = cx;
    }
    return best;
  }

  /** Screen X of the right edge of a column's gutter (past all its rails), or null. */
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

  /** The tap hit-box element for a field key `<sketch>/<col>/<chain>/<field>`. */
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
    const badges = Array.from(this.renderRoot.querySelectorAll('.badge')) as HTMLElement[];

    const floaters: Floater[] = [];
    const railX = new Map<string, number>();
    let maxRailX = 40;
    for (const b of badges) {
      const railId = b.dataset.railId!;
      const w = b.offsetWidth, h = b.offsetHeight;
      let anchorX: number;
      if (railId === NEW_ID) {
        anchorX = maxRailX + 64;
      } else {
        const sx = this.railScreenX(railId);
        if (sx === null) { b.style.display = 'none'; continue; }
        b.style.display = '';
        anchorX = sx - overlayRect.left;
        railX.set(railId, anchorX);
        if (anchorX > maxRailX) maxRailX = anchorX;
      }
      floaters.push({
        id: railId, anchorX, anchorY: BAND_TOP + h / 2,
        width: w, height: h, weightX: 0.2, weightY: 50,
      });
    }
    // Re-anchor the New badge to the right of the rightmost rail.
    const newF = floaters.find(f => f.id === NEW_ID);
    if (newF) newF.anchorX = maxRailX + 64;

    // Field card floater (softer anchor; can be pushed down out of the band).
    const card = this.renderRoot.querySelector('.field-card') as HTMLElement | null;
    const fieldKey = this.cardFieldKey();
    let cardAnchorY = 0;
    if (card && fieldKey) {
      const hit = this.cardAnchorEl(fieldKey);
      // Hide the card until we have an anchor, so it never flashes at (0,0).
      card.style.visibility = hit ? 'visible' : 'hidden';
      if (hit) {
        const r = hit.getBoundingClientRect();
        const cw = card.offsetWidth, ch = card.offsetHeight;
        // Anchor to the right of the column's gutter (past ALL its rails) so the
        // card never covers the rail lines; fall back to the field's right edge.
        const colIdx = parseInt(fieldKey.split('/')[1], 10);
        const gutterRight = this.columnGutterRight(colIdx);
        const leftEdge = gutterRight ?? r.right;
        const ax = (leftEdge - overlayRect.left) + 12 + cw / 2;
        const ay = (r.top + r.height / 2 - overlayRect.top);
        cardAnchorY = ay;
        floaters.push({ id: '__card__', anchorX: ax, anchorY: ay,
          width: cw, height: ch, weightX: 2, weightY: 1 });
      }
    }

    const pos = layoutFloaters(floaters, {
      bounds: { minX: 0, minY: 0, maxX: overlayRect.width, maxY: overlayRect.height },
    });

    for (const b of badges) {
      const p = pos.get(b.dataset.railId!);
      if (!p) continue;
      b.style.transform = `translate(${p.x - b.offsetWidth / 2}px, ${p.y - b.offsetHeight / 2}px)`;
    }
    if (card && pos.has('__card__')) {
      const p = pos.get('__card__')!;
      card.style.transform = `translate(${p.x - card.offsetWidth / 2}px, ${p.y - card.offsetHeight / 2}px)`;
    }

    // Leader lines from each floated badge back to its true rail X.
    const svg = this.renderRoot.querySelector('svg.lines') as SVGElement | null;
    if (svg) {
      for (const line of Array.from(svg.querySelectorAll('line.leader')) as SVGLineElement[]) {
        const railId = line.dataset.railId!;
        const p = pos.get(railId);
        const rx = railX.get(railId);
        if (!p || rx === undefined) { line.style.display = 'none'; continue; }
        line.style.display = '';
        line.setAttribute('x1', String(p.x));
        line.setAttribute('y1', String(BAND_TOP + 18));
        line.setAttribute('x2', String(rx));
        line.setAttribute('y2', String(BAND_TOP + 40));
      }
      this.drawArcs(svg, overlayRect);
      this.drawConnectLine(svg, overlayRect, cardAnchorY);
    }
  }

  /** Update each committed connection's arc `d` from live field-port rects. */
  private drawArcs(svg: SVGElement, overlayRect: DOMRect) {
    for (const p of Array.from(svg.querySelectorAll('path.wire-arc')) as SVGPathElement[]) {
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

  /** Live connection line while click/drag-to-connect is in progress (task #64). */
  private drawConnectLine(svg: SVGElement, overlayRect: DOMRect, _cardY: number) {
    const line = svg.querySelector('line.connect-line') as SVGLineElement | null;
    if (!line) return;
    const c = tapsConnect.state;
    if (!c) { line.style.display = 'none'; return; }
    const src = this.connectSourcePoint(c, overlayRect);
    if (!src) { line.style.display = 'none'; return; }
    line.style.display = '';
    line.setAttribute('x1', String(src.x));
    line.setAttribute('y1', String(src.y));
    line.setAttribute('x2', String(c.pointerX - overlayRect.left));
    line.setAttribute('y2', String(c.pointerY - overlayRect.top));
  }

  private connectSourcePoint(c: { sourceKind: 'field' | 'rail'; sourceId: string },
                             overlayRect: DOMRect): { x: number; y: number } | null {
    if (c.sourceKind === 'field') {
      const hit = this.fieldHit(c.sourceId);
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return { x: r.left + r.width / 2 - overlayRect.left, y: r.top + r.height / 2 - overlayRect.top };
    }
    const badge = this.renderRoot.querySelector(`.badge[data-rail-id="${c.sourceId}"]`) as HTMLElement | null;
    if (!badge) return null;
    const r = badge.getBoundingClientRect();
    return { x: r.left + r.width / 2 - overlayRect.left, y: r.top + r.height / 2 - overlayRect.top };
  }

  // --- Interactions ---

  /** Build a FieldConnectInfo from a tap hit-box element. */
  private hitToConnectInfo(hit: HTMLElement): FieldConnectInfo | null {
    const colIdx = parseInt(hit.dataset.colIdx ?? '-1', 10);
    const chainIdx = parseInt(hit.dataset.chainIdx ?? '-1', 10);
    const fieldPath = hit.dataset.fieldPath ?? '';
    if (colIdx < 0 || chainIdx < 0 || !fieldPath) return null;
    const sketch = appState.database.sketches[this.sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    if (entry?.type !== 'module') return null;
    const schemaDef = appState.local.plugins.find(p => p.id === entry.module_type)?.schema?.[fieldPath] ?? null;
    const r = hit.getBoundingClientRect();
    return {
      sketchId: this.sketchId, colIdx, chainIdx, fieldPath,
      isOutput: hit.dataset.isOutput === 'true',
      viewportY: r.top + r.height / 2, schemaDef,
    };
  }

  private selectedFieldInfo(): FieldConnectInfo | null {
    const key = appController.selectedFieldKey();
    if (!key) return null;
    const hit = this.fieldHit(key);
    return hit ? this.hitToConnectInfo(hit) : null;
  }

  private onBadgeClick(ref: RailRef) {
    if (tapsConnect.consumeClickSuppression()) return;
    const railPath = `rail/${this.sketchId}/${ref.scope}/${ref.rail.id}`;
    if (tapsConnect.state) { tapsConnect.completeOnRail(ref.rail.id); return; }
    const field = this.selectedFieldInfo();
    if (field) {
      // A field is selected → wire it straight to this rail (fast path).
      appController.connectFieldToRail(field, ref.rail.id);
    } else if (appState.local.selection?.path === railPath) {
      // Clicking the already-selected rail again picks it up to connect.
      const r = (this.renderRoot.querySelector(`.badge[data-rail-id="${ref.rail.id}"]`) as HTMLElement)
        ?.getBoundingClientRect();
      tapsConnect.beginFromRailClick(this.sketchId, ref.rail.id, r?.left ?? 0, r?.top ?? 0);
    } else {
      // Otherwise select the rail (shows its inspector).
      appController.select(railPath);
    }
  }

  private onBadgePointerDown(e: PointerEvent, ref: RailRef) {
    // If a connect is already in flight, let the click complete it on this rail
    // instead of starting a competing drag that would cancel/clear the gesture.
    if (tapsConnect.state) return;
    // Drag to connect FROM this rail (a plain click falls through to onBadgeClick).
    const el = this.renderRoot.querySelector(`.badge[data-rail-id="${ref.rail.id}"]`) as HTMLElement | null;
    if (el) tapsConnect.beginFromRailDrag(e, el, this.sketchId, ref.rail.id);
  }

  private onNewBadgeClick() {
    if (tapsConnect.consumeClickSuppression()) return;
    if (tapsConnect.state) { tapsConnect.completeOnNewRail(); return; }
    const field = this.selectedFieldInfo();
    if (!field) return;
    if (field.isOutput) {
      appController.autoCreateTapForOutputField(
        field.sketchId, field.colIdx, field.chainIdx, field.fieldPath, field.schemaDef);
    } else {
      appController.autoCreateTapForInputField(
        field.sketchId, field.colIdx, field.chainIdx, field.fieldPath, field.schemaDef);
    }
  }

  // --- Rail selectable (inspector content) ---

  private registerRailSelectable(ref: RailRef) {
    const sketchId = this.sketchId;
    const { rail, scope } = ref;
    appController.defineSelectable({
      path: `rail/${sketchId}/${scope}/${rail.id}`,
      label: rail.name ?? rail.id,
      renderInspectorContent: () => {
        const sketch = appState.database.sketches[sketchId];
        if (!sketch) return undefined;
        const ss = appState.local.engine.sketchState?.[sketchId];
        const val = typeof scope === 'number'
          ? (ss?.[`columns/${scope}`]?.[rail.id]?.value ?? ss?.rails?.[rail.id]?.value)
          : (ss?.rails?.[rail.id]?.value);
        // Taps wired to this rail, across the sketch.
        const conns: { col: number; chain: number; tapIdx: number; dir: string; field: string }[] = [];
        sketch.columns.forEach((c, ci) => c.chain.forEach((e, chi) => {
          if (e.type === 'module') (e.taps ?? []).forEach((t, ti) => {
            if (t.railId === rail.id) conns.push({ col: ci, chain: chi, tapIdx: ti, dir: t.direction, field: t.fieldPath });
          });
        }));
        return html`
          <div class="inspector-field">
            <span class="inspector-field-label">Name</span>
            <input class="inspector-field-value" style="background:var(--app-bg-color3,#333);border:1px solid rgba(255,255,255,0.15);color:inherit;border-radius:3px;padding:2px 4px"
              .value=${rail.name ?? rail.id}
              @change=${(e: Event) => appController.renameRail(
                sketchId, scope, rail.id, (e.target as HTMLInputElement).value)}>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">Type</span>
            <span class="inspector-field-value">${typeof rail.dataType === 'string' ? rail.dataType : 'struct'}</span>
          </div>
          ${rail.dataType === 'float' ? html`
            <div class="inspector-field">
              <span class="inspector-field-label">Value</span>
              <span class="inspector-field-value">${typeof val === 'number' ? val.toFixed(4) : '—'}</span>
            </div>` : nothing}
          <div class="inspector-separator"></div>
          <div class="section-header">Connections (${conns.length})</div>
          ${conns.length === 0
            ? html`<div style="font-size:11px;color:var(--app-text-color2)">No taps on this rail.</div>`
            : conns.map(cn => html`
              <div class="tap-row">
                <span class="tap-row-name">${cn.dir === 'write' ? '→' : '←'} ${cn.field}</span>
                <button class="dir-btn"
                  @click=${() => appController.removeTap(sketchId, cn.col, cn.chain, cn.tapIdx)}>×</button>
              </div>`)}
          <div class="inspector-separator"></div>
          <button class="dir-btn" style="width:100%;height:24px"
            @click=${() => { appController.removeRail(sketchId, scope, rail.id); appController.select(null); }}>
            Remove Rail</button>
        `;
      },
    });
  }
}
