/**
 * <arr-overlay> — app-level wire overlay. A single viewport-fixed SVG that
 * draws rail modulation wires across BOTH the arrangement and the inspector,
 * so a reader wire can terminate at the actual field editor in a clip's chain.
 *
 * Endpoints come from the cross-shadow anchor registry; geometry is refreshed on
 * a rAF loop (positions change on scroll/zoom without re-rendering this element).
 * Wire DOM is reconciled by id so click handlers stay stable. The tap-config
 * popup is rendered reactively from store.tapPopup.
 */

import { html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { anchorRect, AnchorKeys } from './anchor-registry';

interface Pt {
  x: number;
  y: number;
}
interface WireDesc {
  id: string;
  color: string;
  a: Pt; // source (data-out)
  b: Pt; // dest (data-in)
  clipPath: string;
  label: string;
  target: { field?: string; trace?: boolean };
  popup?: boolean; // false = pip selects only (no tap config), e.g. beat warp
}

const WRITER = '#ff8c00';
const READER = '#4dc9f6';
const WARP = '#a07ce0';
const NS = 'http://www.w3.org/2000/svg';

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function wirePath(a: Pt, b: Pt): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const vert = Math.abs(dx) < 30;
  const c1x = a.x + (vert ? 18 : dx * 0.2);
  const c2x = b.x - (vert ? 18 : dx * 0.2);
  const my = a.y + dy * 0.5;
  return `M ${a.x} ${a.y} C ${c1x} ${my}, ${c2x} ${my}, ${b.x} ${b.y}`;
}

@customElement('arr-overlay')
export class ArrOverlay extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 60;
    }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }
    svg path.hit {
      stroke: transparent;
      stroke-width: 12;
      fill: none;
      pointer-events: stroke;
      cursor: pointer;
    }
    svg path.arc {
      fill: none;
      stroke-width: 1.5;
      pointer-events: none;
      stroke-dasharray: 5 3;
      animation: wireflow 0.8s linear infinite;
    }
    svg path.arc.sel {
      stroke: var(--app-hi-color1) !important;
      stroke-width: 2;
      stroke-dasharray: none;
      animation: none;
    }
    @keyframes wireflow {
      to {
        stroke-dashoffset: -8;
      }
    }
    svg circle.pip {
      pointer-events: auto;
      cursor: pointer;
      stroke: var(--app-bg-color1);
      stroke-width: 1;
    }
    .tap-card {
      position: fixed;
      pointer-events: auto;
      z-index: 61;
      width: 188px;
      padding: 7px 9px;
      border-radius: 2px;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-hi-color2);
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.5);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    .tap-card .tc-head {
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      margin-bottom: 5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tap-card .tc-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 3px 0;
    }
    .tap-card select,
    .tap-card input[type='range'] {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      background: var(--app-bg-color1);
      color: var(--app-text-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      max-width: 96px;
    }
    .tap-card .tc-toggle {
      cursor: pointer;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 1px 6px;
      background: var(--app-bg-color1);
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
    }
    .tap-card .tc-toggle.on {
      border-color: var(--app-hi-color2);
      color: var(--app-hi-color2);
    }
  `;

  @query('svg') private svg!: SVGSVGElement;
  private raf = 0;
  private els = new Map<string, { hit: SVGPathElement; arc: SVGPathElement; pip: SVGCircleElement }>();

  firstUpdated() {
    this.tick();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }
  private tick = () => {
    this.sync();
    this.raf = requestAnimationFrame(this.tick);
  };

  render() {
    return html`<svg></svg>${this.renderPopup()}`;
  }

  // ── Wire geometry ───────────────────────────────────────────────────────
  private computeWires(): WireDesc[] {
    if (!store.wiresMode) return [];
    const out: WireDesc[] = [];
    for (const track of store.composition.tracks) {
      if (track.kind !== 'rail' || !track.railId) continue;
      const railRect = anchorRect(AnchorKeys.rail(track.railId));
      if (!railRect) continue;
      const railMidY = (railRect.top + railRect.bottom) / 2;

      // Writers: clip/trace → rail.
      for (const w of store.railWriters(track.railId)) {
        const clipPath = `clip/${w.track.id}/${w.clip.id}`;
        const from =
          anchorRect(AnchorKeys.trace(w.clip.id)) ?? anchorRect(AnchorKeys.clip(w.clip.id));
        if (!from) continue;
        const fx = (from.left + from.right) / 2;
        const fmid = (from.top + from.bottom) / 2;
        const below = railMidY > fmid;
        const a: Pt = { x: fx, y: below ? from.bottom : from.top };
        const b: Pt = {
          x: clamp(fx, railRect.left + 4, railRect.right - 4),
          y: below ? railRect.top : railRect.bottom,
        };
        out.push({
          id: 'w:' + w.exp.id, color: WRITER, a, b, clipPath,
          label: `${w.clip.name} → ${track.name}`, target: { trace: true },
        });
      }

      // Readers: rail → field (when selected) or → clip.
      for (const r of store.railReaders(track.railId)) {
        const clipPath = `clip/${r.track.id}/${r.clip.id}`;
        const clipRect = anchorRect(AnchorKeys.clip(r.clip.id));
        if (!clipRect) continue;
        const cx = (clipRect.left + clipRect.right) / 2;
        const selected = store.isSelected(clipPath);
        const fieldRect = selected
          ? anchorRect(AnchorKeys.field(r.read.targetDeviceId, r.read.targetField))
          : null;
        const railBelowClip = railMidY > (clipRect.top + clipRect.bottom) / 2;
        const a: Pt = {
          x: clamp(cx, railRect.left + 4, railRect.right - 4),
          y: railBelowClip ? railRect.top : railRect.bottom,
        };
        const b: Pt = fieldRect
          ? { x: fieldRect.left, y: (fieldRect.top + fieldRect.bottom) / 2 }
          : { x: cx, y: railBelowClip ? clipRect.bottom : clipRect.top };
        out.push({
          id: 'r:' + r.read.id, color: READER, a, b, clipPath,
          label: `${track.name} → ${r.clip.name}.${r.read.targetField}`,
          target: { field: r.read.targetField },
        });
      }
    }

    // Beat-warp wires: warp clip → beat-warp track (if shown) else main bus.
    const warpDestKey = store.automationMode
      ? AnchorKeys.beatwarp()
      : AnchorKeys.mainbus();
    const warpDest = anchorRect(warpDestKey);
    if (warpDest) {
      const destMidY = (warpDest.top + warpDest.bottom) / 2;
      for (const ww of store.warpWriters()) {
        const clipPath = `clip/${ww.track.id}/${ww.clip.id}`;
        const from =
          anchorRect(AnchorKeys.trace(ww.clip.id)) ?? anchorRect(AnchorKeys.clip(ww.clip.id));
        if (!from) continue;
        const fx = (from.left + from.right) / 2;
        const below = destMidY > (from.top + from.bottom) / 2;
        out.push({
          id: 'warp:' + ww.clip.id,
          color: WARP,
          a: { x: fx, y: below ? from.bottom : from.top },
          b: {
            x: clamp(fx, warpDest.left + 4, warpDest.right - 4),
            y: below ? warpDest.top : warpDest.bottom,
          },
          clipPath,
          label: `${ww.clip.name} ⥲ beat warp`,
          target: {},
          popup: false,
        });
      }
    }
    return out;
  }

  private sync() {
    const svg = this.svg;
    if (!svg) return;
    const wires = this.computeWires();
    const present = new Set(wires.map((w) => w.id));

    // Remove stale.
    for (const [id, g] of this.els) {
      if (!present.has(id)) {
        g.hit.remove();
        g.arc.remove();
        g.pip.remove();
        this.els.delete(id);
      }
    }

    for (const w of wires) {
      let g = this.els.get(w.id);
      if (!g) {
        const hit = document.createElementNS(NS, 'path');
        hit.setAttribute('class', 'hit');
        const arc = document.createElementNS(NS, 'path');
        arc.setAttribute('class', 'arc');
        const pip = document.createElementNS(NS, 'circle');
        pip.setAttribute('class', 'pip');
        pip.setAttribute('r', '3.5');
        const onClick = (e: PointerEvent) => {
          e.stopPropagation();
          store.selectWire(w.id, w.clipPath, w.target);
        };
        hit.addEventListener('pointerdown', onClick);
        pip.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          store.selectWire(w.id, w.clipPath, w.target);
          if (w.popup !== false) {
            store.openTapPopup({ wireId: w.id, x: e.clientX + 8, y: e.clientY + 8, label: w.label });
          }
        });
        svg.appendChild(hit);
        svg.appendChild(arc);
        svg.appendChild(pip);
        g = { hit, arc, pip };
        this.els.set(w.id, g);
      }
      const d = wirePath(w.a, w.b);
      g.hit.setAttribute('d', d);
      g.arc.setAttribute('d', d);
      g.arc.setAttribute('class', 'arc' + (store.selectedWireId === w.id ? ' sel' : ''));
      g.arc.style.stroke = w.color;
      g.pip.setAttribute('cx', String((w.a.x + w.b.x) / 2));
      g.pip.setAttribute('cy', String((w.a.y + w.b.y) / 2));
      g.pip.style.fill = w.color;
    }
  }

  // ── Tap popup ─────────────────────────────────────────────────────────
  private renderPopup() {
    const pop = store.tapPopup;
    if (!pop) return '';
    const tap = store.tapByWireId(pop.wireId);
    if (!tap) return '';
    return html`
      <div
        class="tap-card"
        style="left:${pop.x}px; top:${pop.y}px"
        @pointerdown=${(e: Event) => e.stopPropagation()}
      >
        <div class="tc-head">${pop.label}</div>
        <div class="tc-row">
          <span>Combine</span>
          <select
            .value=${tap.combine}
            @change=${(e: Event) => (tap.combine = (e.target as HTMLSelectElement).value as any)}
          >
            ${['replace', 'mix', 'add', 'mul'].map(
              (m) => html`<option value=${m} ?selected=${m === tap.combine}>${m}</option>`,
            )}
          </select>
        </div>
        <div class="tc-row">
          <span>Magnitude</span>
          <select
            .value=${tap.magnitude}
            @change=${(e: Event) => (tap.magnitude = (e.target as HTMLSelectElement).value as any)}
          >
            ${['auto', 'signed', 'unsigned', 'absolute'].map(
              (m) => html`<option value=${m} ?selected=${m === tap.magnitude}>${m}</option>`,
            )}
          </select>
        </div>
        <div class="tc-row">
          <span>Shapers</span>
          <span style="display:flex; gap:4px">
            <span
              class="tc-toggle ${tap.smoothing ? 'on' : ''}"
              @click=${() => { tap.smoothing = !tap.smoothing; this.requestUpdate(); }}
              >smooth</span
            >
            <span
              class="tc-toggle ${tap.remap ? 'on' : ''}"
              @click=${() => { tap.remap = !tap.remap; this.requestUpdate(); }}
              >remap</span
            >
          </span>
        </div>
        <div class="tc-row">
          <span>Scale</span>
          <input
            type="range" min="0" max="2" step="0.01"
            .value=${String(tap.scale ?? 1)}
            @input=${(e: Event) => (tap.scale = Number((e.target as HTMLInputElement).value))}
          />
        </div>
      </div>
    `;
  }
}
