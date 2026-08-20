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
import { isCanvasEntry, sketchChain } from '../sketch-types';
import { layoutFloaters, type Floater } from './floating-layout';
import { activeCanvasView, activeEditorColumnsRoots, fieldHitIn, fieldOptionPipIn } from './field-anchor-lookup';

/** The bit of <sketch-canvas-view> this overlay needs, kept structural so the
 *  widget layer takes no dependency on the view module. */
interface Connection {
  id: string;
  from: string;
  to: string;
  delayed: boolean;
  wireId: string;
  /** Set when exactly ONE end is a sidecar-canvas card: which end, and its
   *  chain index (so clicking its proxy pip can select the card). */
  proxy?: { end: 'from' | 'to'; chainIdx: number };
}

interface SketchCanvasHost extends HTMLElement {
  beginInsertOnWire?(wireId: string, clientX: number, clientY: number): void;
}
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

/** Inset of a proxy pip from the editor's right edge, and the vertical spread
 *  applied when several land on the same row. */
const PROXY_MARGIN = 10;
const PROXY_SPREAD = 12;

const bezPath = (z: Bezier): string =>
  `M ${z.p0.x} ${z.p0.y} C ${z.c1.x} ${z.c1.y} ${z.c2.x} ${z.c2.y} ${z.p3.x} ${z.p3.y}`;

function arcPath(a: Pt, b: Pt): string { return bezPath(arcBezier(a, b)); }

const lerpPt = (p: Pt, q: Pt, t: number): Pt =>
  ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** Split a cubic bezier at `t` (de Casteljau) → the two halves + the join point. */
function splitAt(z: Bezier, t: number): { first: Bezier; second: Bezier; mid: Pt } {
  const a = lerpPt(z.p0, z.c1, t), b = lerpPt(z.c1, z.c2, t), c = lerpPt(z.c2, z.p3, t);
  const d = lerpPt(a, b, t), e = lerpPt(b, c, t);
  const f = lerpPt(d, e, t);
  return {
    first: { p0: z.p0, c1: a, c2: d, p3: f },
    second: { p0: f, c1: e, c2: c, p3: z.p3 },
    mid: f,
  };
}

/** Split at the midpoint — the two halves a delayed wire animates alternately. */
function splitBezier(z: Bezier) { return splitAt(z, 0.5); }

/**
 * Arc length approximated from the control polygon — accurate enough to turn a
 * pixel clearance into a curve parameter, and unlike `getTotalLength()` it
 * needs no live path (measuring one mid-write would force a reflow per wire,
 * which is exactly what drawArcs' two-phase structure exists to avoid).
 */
function bezLength(z: Bezier): number {
  const d = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
  return (d(z.p0, z.p3) + d(z.p0, z.c1) + d(z.c1, z.c2) + d(z.c2, z.p3)) / 2;
}

/** `z` with roughly `clear` px trimmed off EACH end. */
function trimBezier(z: Bezier, clear: number): Bezier {
  const t = Math.min(clear / Math.max(bezLength(z), 1), 0.35);
  // After dropping [0,t] the remainder is reparameterized over [t,1], so the
  // original 1-t lands at (1-2t)/(1-t).
  return splitAt(splitAt(z, t).second, (1 - 2 * t) / (1 - t)).first;
}

/**
 * How far the fat click target stops short of each endpoint. The hit path is a
 * 14px stroke landing dead-centre on the very pip the wire connects to, and
 * with the sidecar canvas open this overlay is a viewport-FIXED layer above the
 * cards — so an untrimmed hit swallowed every click aimed at a canvas port and
 * opened the wire's popup instead of starting a connection.
 */
const WIRE_HIT_END_CLEAR = 16;

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
    /* Terminus of a wire whose far end is a card on the CLOSED sidecar canvas.
     * The only interactive thing in this svg besides .wire-hit — click it to
     * open the canvas on that card. */
    .wire-proxy-pip {
      fill: var(--app-bg-color1); stroke: var(--app-hi-color2, #4169E1);
      stroke-width: 2; pointer-events: all; cursor: pointer;
    }
    .wire-proxy-pip:hover, .wire-proxy-pip.selected {
      fill: var(--app-hi-color2, #4169E1);
    }
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
    /* Two click targets per wire, because this layer sits ABOVE the cards
     * (viewport-fixed once the sidecar canvas is open) and an unclipped fat
     * stroke crossing a card swallowed every click meant for the header, a
     * slider or a port underneath it:
     *   .wire-hit       — 14px, CLIPPED to the gaps between cards (hitClipPath).
     *                     Generous targeting wherever the wire is the only
     *                     thing there.
     *   .wire-hit.fine  — 6px, unclipped. Over a card you have to actually aim
     *                     at the drawn line, which reads as deliberate; the
     *                     card keeps every other pixel it owns. Without it a
     *                     wire that runs card-to-card is simply unselectable.
     * Both carry the same handlers and the same (end-trimmed) geometry. */
    .wire-hit { fill: none; stroke: transparent; stroke-width: 14;
      pointer-events: stroke; cursor: pointer; clip-path: url(#wire-hit-clip); }
    .wire-hit.fine { stroke-width: 6; clip-path: none; }
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

  /** Draw wire arcs while in wire mode — or whenever the sidecar canvas is open.
   *  The canvas IS a wiring surface (its ports are always-live pips, not
   *  W-gated row hit-boxes), so its wires — and the cross-panel ones — have to
   *  be drawn without the user holding the editor in wire mode. The LINEAR
   *  list keeps its W gate: its tap hit-boxes cover whole field rows, and
   *  always-on ones would make every slider undraggable. */
  private get showArcs(): boolean {
    return appState.local.tappingMode
        || appState.local.userSettings.sketchCanvasOpen === true;
  }

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
   * Where the card should sit when the selection came from clicking a WIRE:
   * the click point itself, in viewport coordinates. A wire runs between two
   * cards that may be panels apart (and, with the canvas open, in different
   * scroll spaces), so anchoring its popup to the dest field's column drops it
   * somewhere the user never looked. Kept with the selection path so a stale
   * point can never leak onto the next selection.
   */
  private cardPoint: { path: string; x: number; y: number } | null = null;

  /** Single click on a wire: select it, remembering WHERE it was clicked so the
   *  popup lands under the pointer rather than beside the dest field's column. */
  private onWireClick(e: MouseEvent, wireId: string) {
    const path = wireSelectablePath(this.sketchId, wireId);
    this.cardPoint = { path, x: e.clientX, y: e.clientY };
    appController.select(path);
  }

  /**
   * Double-clicking a wire SPLICES a new node into it — the producer feeds the
   * new node, the new node feeds the original consumer, with the wire's tuned
   * shaping carried onto the second half. The node lands on the sidecar canvas
   * (opening it if needed) with its type picker open, all as one continuous
   * edit: Escape backs out the node AND the rewiring, leaving the original wire
   * exactly as it was.
   *
   * This REPLACES double-click-to-delete. Breaking a wire is still Delete on a
   * selected wire, or the × in the dest field's Wires section.
   */
  private onWireDblClick(e: MouseEvent, wireId: string) {
    e.preventDefault();
    e.stopPropagation();
    appController.setSketchCanvasOpen(true);
    // The canvas may only now be mounting, so place on the next frames.
    const place = (tries: number) => {
      const view = activeCanvasView() as SketchCanvasHost | null;
      if (!view?.beginInsertOnWire) {
        if (tries > 0) requestAnimationFrame(() => place(tries - 1));
        return;
      }
      view.beginInsertOnWire(wireId, e.clientX, e.clientY);
    };
    requestAnimationFrame(() => place(60));
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
  private connections(sketch: Sketch): Connection[] {
    const sk = this.sketchId;
    const out: Connection[] = [];

    // instanceKey → "col/chain". Single linear stack now → col index is always 0
    // (kept in the key to match the DOM hit-box `data-col-idx`).
    const loc = new Map<string, string>();
    const onCanvas = new Map<string, number>();   // key → chain index, canvas only
    sketchChain(sketch).forEach((e, chi) => {
      if (e.type !== 'module') return;
      loc.set(e.instance_key, `0/${chi}`);
      if (isCanvasEntry(e)) onCanvas.set(e.instance_key, chi);
    });
    const pos = execPositions(sketch);

    for (const wire of sketch.wires ?? []) {
      const sl = loc.get(wire.src.instanceKey), dl = loc.get(wire.dest.instanceKey);
      if (!sl || !dl) continue;
      const srcCanvas = onCanvas.get(wire.src.instanceKey);
      const destCanvas = onCanvas.get(wire.dest.instanceKey);
      out.push({
        id: `wire:${wire.id}`,
        from: `${sk}/${sl}/${wire.src.field}`,
        to: `${sk}/${dl}/${wire.dest.field}`,
        delayed: wireIsDelayed(pos, wire.src.instanceKey, wire.dest.instanceKey),
        wireId: wire.id,
        // Exactly ONE end on the canvas, while the canvas is closed → that end
        // has no card in the DOM, so the arc terminates at a proxy pip on the
        // editor's right margin instead of vanishing.
        proxy: (srcCanvas === undefined) === (destCanvas === undefined) ? undefined
          : { end: srcCanvas !== undefined ? 'from' : 'to',
              chainIdx: (srcCanvas ?? destCanvas)! },
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
    // Proxy pips stand in for canvas cards only while the canvas is CLOSED;
    // once it's open both ends have real anchors.
    const proxies = !appState.local.userSettings.sketchCanvasOpen;
    return html`
      <svg class="lines">
        <defs>
          <clipPath id="wire-hit-clip" clipPathUnits="userSpaceOnUse">
            <path class="hit-clip" clip-rule="evenodd" d=""></path>
          </clipPath>
        </defs>
        ${conns.map(cn => {
          // Each wire has a fat companion hit path in front of the thin visible
          // arc: single click SELECTS the wire (so it isn't deleted by accident),
          // double click BREAKS it.
          const sel = wireSelectablePath(this.sketchId, cn.wireId) === selectedPath;
          const selCls = sel ? 'selected' : '';
          const proxyEnd = proxies && cn.proxy ? cn.proxy.end : undefined;
          // The visible terminus when the far end's card is on the closed
          // canvas. Rendered for delayed wires too — a feedback wire into the
          // canvas needs a way back just as much.
          const proxyPip = proxyEnd ? svg`
            <circle class="wire-proxy-pip ${sel ? 'selected' : ''}" r="5"
              data-from=${cn.from} data-to=${cn.to}
              data-proxy-end=${proxyEnd} data-wire-id=${cn.wireId}
              @click=${() => this.onProxyPipClick(cn.proxy!.chainIdx)}>
              <title>On the sidecar canvas — click to open it</title>
            </circle>` : nothing;
          const hitPath = (fine: boolean) => svg`
            <path class="arc-path wire-hit ${fine ? 'fine' : ''}"
              data-proxy-end=${proxyEnd ?? nothing}
              data-from=${cn.from} data-to=${cn.to}
              @click=${(e: MouseEvent) => this.onWireClick(e, cn.wireId)}
              @dblclick=${(e: MouseEvent) => this.onWireDblClick(e, cn.wireId)}></path>`;
          const hit = svg`${hitPath(false)}${hitPath(true)}`;
          // A 1-frame-delayed (feedback) wire: drawn in two halves that animate
          // alternately, with a dot at the relay point — and in the output-pip red.
          if (cn.delayed) {
            return svg`<g class="wire-group">
              ${hit}
              <path class="arc-path wire-arc delayed seg-a ${selCls}" data-seg="0"
                data-proxy-end=${proxyEnd ?? nothing}
                data-from=${cn.from} data-to=${cn.to}></path>
              <path class="arc-path wire-arc delayed seg-b ${selCls}" data-seg="1"
                data-proxy-end=${proxyEnd ?? nothing}
                data-from=${cn.from} data-to=${cn.to}></path>
              <circle class="wire-dot ${selCls}" r="3" data-from=${cn.from} data-to=${cn.to}></circle>
              ${proxyPip}
            </g>`;
          }
          return svg`<g class="wire-group">
            ${hit}
            <path class="arc-path wire-arc ${selCls}" data-conn-id=${cn.id}
              data-proxy-end=${proxyEnd ?? nothing}
              data-from=${cn.from} data-to=${cn.to}></path>
            ${proxyPip}
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
    // The local columns-view first (this overlay's own panel), then every root
    // the active surface exposes — which adds the sidecar canvas, and covers
    // the case where this overlay isn't a sibling of the columns-view it draws
    // for. Cheap: both are single querySelector walks per rAF.
    const out: ShadowRoot[] = [];
    const local = this.columnsRoot();
    if (local) out.push(local);
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
    // A wire selected BY CLICKING it anchors its popup to the click point (see
    // cardPoint). Guarded on the selection path, so the point dies with the
    // selection it was captured for; any other route to a wire selection
    // (keyboard, proxy pip) falls through to the dest-field anchor below.
    const pt = this.cardPoint?.path === (appState.local.selection?.path ?? '')
      ? this.cardPoint : null;
    if (card && fieldKey && pt) {
      card.style.visibility = 'visible';
      const cw = card.offsetWidth, ch = card.offsetHeight;
      const px = pt.x - overlayRect.left, py = pt.y - overlayRect.top;
      // Beside the pointer, preferring the right — flipped left when the card
      // wouldn't fit, so the clamp below never slides it back over the wire.
      const fitsRight = pt.x + 12 + cw <= overlayRect.right;
      floaters.push({
        id: '__card__',
        anchorX: fitsRight ? px + 12 + cw / 2 : px - 12 - cw / 2,
        anchorY: py,
        width: cw, height: ch, weightX: 2, weightY: 1,
      });
    } else if (card && fieldKey) {
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
  /**
   * The region where a wire is clickable: the whole overlay MINUS every card.
   * An even-odd path — the outer rect, then one rect per card, which cancel
   * into holes. Rebuilt each rAF alongside the arc geometry (cards move with
   * scroll, zoom and drags), in the same READ phase, so it costs no extra
   * reflow.
   */
  private hitClipPath(overlayRect: DOMRect): string {
    const rect = (x: number, y: number, w: number, h: number) =>
      `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
    let d = rect(0, 0, overlayRect.width, overlayRect.height);
    for (const root of this.roots()) {
      for (const el of root.querySelectorAll('column-group')) {
        for (const card of (el as HTMLElement).shadowRoot
                            ?.querySelectorAll('.effect-card') ?? []) {
          const r = (card as HTMLElement).getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          d += ' ' + rect(r.left - overlayRect.left, r.top - overlayRect.top,
                          r.width, r.height);
        }
      }
    }
    return d;
  }

  private drawArcs(svg: SVGElement, overlayRect: DOMRect) {
    // READ phase — no DOM writes, so only the first rect query forces a reflow.
    const clipD = this.hitClipPath(overlayRect);
    const paths = Array.from(svg.querySelectorAll('path.arc-path')) as SVGPathElement[];
    // A wire with one end on the CLOSED canvas has no anchor there; substitute
    // a point on the right margin, level with the end that IS visible.
    const ends = (el: SVGElement) => {
      let a = this.fieldCenter(el.dataset.from ?? '', overlayRect);
      let b = this.fieldCenter(el.dataset.to ?? '', overlayRect);
      const proxyEnd = el.dataset.proxyEnd;
      if (proxyEnd === 'from' && !a && b) a = this.proxyPoint(b, overlayRect);
      else if (proxyEnd === 'to' && !b && a) b = this.proxyPoint(a, overlayRect);
      return { a, b };
    };
    const arcs = paths.map(p => ({ p, ...ends(p), seg: p.dataset.seg }));
    const dots = Array.from(svg.querySelectorAll('circle.wire-dot')) as SVGCircleElement[];
    const dotData = dots.map(dot => ({ dot, ...ends(dot) }));
    // Proxy pips, ordered by wire id so a deterministic spread can separate any
    // that land on the same row (and so they don't jitter frame to frame).
    const pipData = (Array.from(
        svg.querySelectorAll('circle.wire-proxy-pip')) as SVGCircleElement[])
      .map(pip => ({ pip, ...ends(pip), wireId: pip.dataset.wireId ?? '' }))
      .sort((x, y) => x.wireId.localeCompare(y.wireId));

    // WRITE phase.
    (svg.querySelector('path.hit-clip') as SVGPathElement | null)
      ?.setAttribute('d', clipD);
    for (const { p, a, b, seg } of arcs) {
      if (!a || !b) { p.style.display = 'none'; continue; }
      p.style.display = '';
      // The click target stops short of both ports (see WIRE_HIT_END_CLEAR).
      if (p.classList.contains('wire-hit')) {
        p.setAttribute('d', bezPath(trimBezier(arcBezier(a, b), WIRE_HIT_END_CLEAR)));
        continue;
      }
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
    // Proxy pips: the visible terminus of a wire into the closed canvas.
    const usedY: number[] = [];
    for (const { pip, a, b } of pipData) {
      const end = pip.dataset.proxyEnd === 'from' ? a : b;
      if (!end) { pip.style.display = 'none'; continue; }
      pip.style.display = '';
      let y = end.y;
      while (usedY.some(u => Math.abs(u - y) < PROXY_SPREAD)) y += PROXY_SPREAD;
      usedY.push(y);
      pip.setAttribute('cx', String(end.x));
      pip.setAttribute('cy', String(y));
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

  /**
   * Where a wire whose far end is a hidden canvas card terminates: a pip on the
   * editor's RIGHT margin, level with the end that IS visible. Clamped into the
   * visible band so a wire to a card scrolled off-screen still shows a reachable
   * pip rather than running away.
   */
  private proxyPoint(anchor: { x: number; y: number }, overlayRect: DOMRect) {
    return {
      x: overlayRect.width - PROXY_MARGIN,
      y: Math.min(Math.max(anchor.y, PROXY_MARGIN), overlayRect.height - PROXY_MARGIN),
    };
  }

  /** Clicking a proxy pip opens the canvas and selects the card it stands for. */
  private onProxyPipClick(chainIdx: number) {
    appController.setSketchCanvasOpen(true);
    appController.select(`effect/${this.sketchId}/0/${chainIdx}`);
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
