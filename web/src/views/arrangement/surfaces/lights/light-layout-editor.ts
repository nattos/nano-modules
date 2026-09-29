/**
 * <light-layout-editor> — where a placed rig's slots sample the frame, in THIS
 * show. The frame is drawn at the composition's aspect with each slot as its
 * strip (live colours when the engine reports them):
 *
 *   - drag a strip to move it;
 *   - drag its corner handle to resize it;
 *   - click one to select it (its numbers are editable below; `select` event).
 *
 * Every drag lands as ONE undo point (store.setLightLayout's coalesce key).
 * The rig's own layout is the default; the show's rects override it per slot.
 */

import { html, css, svg, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import type { SlotRect } from '../../../../lights/light-types';
import { lightController } from '../../state/light-controller';
import { store } from '../../state/store';
import { drawSlots, frameAspect, pixelCells, UNLIT } from './light-draw';

const HANDLE = 0.035;   // corner handle size, frame-height units
const MIN_GRAB = 0.03;  // thin strips get a wider invisible grab area
const MIN_DRAW = 0.022; // …and are drawn at least this wide

let dragSeq = 0;

@customElement('light-layout-editor')
export class LightLayoutEditor extends MobxLitElement {
  @property({ attribute: false }) placementId = '';
  @property({ attribute: false }) selectedSlot = '';

  static styles = css`
    :host { display: block; }
    svg { display: block; width: 100%; height: auto; touch-action: none; user-select: none; }
    .grab { cursor: move; }
    .handle { cursor: nwse-resize; }
  `;

  private drag: {
    slotId: string; mode: 'move' | 'size'; start: SlotRect; x0: number; y0: number; key: string;
  } | null = null;

  render() {
    const p = store.placementById(this.placementId);
    const rig = p ? lightController.rig(p.deviceId) : undefined;
    if (!p || !rig) return nothing;
    const aspect = frameAspect();
    const slots = drawSlots(rig, this.placementId);
    return html`<svg viewBox="0 0 ${aspect} 1"
        @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp}>
      <rect x="0" y="0" width=${aspect} height="1" fill="#0b0b0e"
        stroke="rgba(255,255,255,0.18)" stroke-width="1" vector-effect="non-scaling-stroke"></rect>
      ${slots.map((s) => {
        const r = { x: s.rect.x * aspect, y: s.rect.y, w: s.rect.w * aspect, h: s.rect.h };
        // Thin strips are DRAWN at a readable width (centred); the numbers and
        // the grab area keep the true rect.
        const tall = s.vertical;
        const d = { ...r };
        if (tall && d.w < MIN_DRAW) { d.x -= (MIN_DRAW - d.w) / 2; d.w = MIN_DRAW; }
        if (!tall && d.h < MIN_DRAW) { d.y -= (MIN_DRAW - d.h) / 2; d.h = MIN_DRAW; }
        const cells = pixelCells(d, s.type?.pixels ?? 0, s.vertical, s.reverse);
        const sel = s.slotId === this.selectedSlot;
        const gx = r.w < MIN_GRAB ? r.x - (MIN_GRAB - r.w) / 2 : r.x;
        const gw = Math.max(r.w, MIN_GRAB);
        const gy = r.h < MIN_GRAB ? r.y - (MIN_GRAB - r.h) / 2 : r.y;
        const gh = Math.max(r.h, MIN_GRAB);
        return svg`<g data-layout-slot=${s.slotId}>
          ${cells.map((c, i) => svg`<rect x=${c.x} y=${c.y} width=${c.w} height=${c.h}
            fill=${s.colors?.[i] ?? UNLIT}></rect>`)}
          <rect x=${r.x} y=${r.y} width=${r.w} height=${r.h} fill="none"
            stroke=${sel ? 'var(--app-hi-color2, #4169e1)' : 'rgba(255,255,255,0.4)'}
            stroke-width=${sel ? 2 : 1} vector-effect="non-scaling-stroke"></rect>
          <text x=${r.x + r.w / 2} y=${Math.min(0.97, r.y + r.h + 0.05)} font-size="0.045"
            fill="rgba(255,255,255,0.55)" text-anchor="middle">${s.index + 1}</text>
          <rect class="grab" x=${gx} y=${gy} width=${gw} height=${gh} fill="transparent"
            @pointerdown=${(e: PointerEvent) => this.onDown(e, s.slotId, s.rect, 'move')}></rect>
          ${sel ? svg`<rect class="handle" data-layout-handle=${s.slotId}
            x=${r.x + r.w - HANDLE / 2} y=${r.y + r.h - HANDLE / 2} width=${HANDLE} height=${HANDLE}
            fill="var(--app-hi-color2, #4169e1)"
            @pointerdown=${(e: PointerEvent) => this.onDown(e, s.slotId, s.rect, 'size')}></rect>` : nothing}
        </g>`;
      })}
    </svg>`;
  }

  /** Client px → frame units (x in 0..1 of the width, y in 0..1). */
  private toFrame(e: PointerEvent): { x: number; y: number } {
    const svgEl = this.renderRoot.querySelector('svg')!;
    const b = svgEl.getBoundingClientRect();
    return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height };
  }

  private onDown(e: PointerEvent, slotId: string, rect: SlotRect, mode: 'move' | 'size') {
    e.stopPropagation();
    e.preventDefault();
    this.dispatchEvent(new CustomEvent('select', { detail: slotId }));
    const at = this.toFrame(e);
    this.drag = { slotId, mode, start: { ...rect }, x0: at.x, y0: at.y, key: `lightlayout:${++dragSeq}` };
    (this.renderRoot.querySelector('svg') as SVGSVGElement).setPointerCapture(e.pointerId);
  }

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const at = this.toFrame(e);
    const dx = at.x - d.x0, dy = at.y - d.y0;
    const r = d.mode === 'move'
      ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy }
      : { ...d.start, w: Math.max(0.004, d.start.w + dx), h: Math.max(0.004, d.start.h + dy) };
    store.setLightLayout(this.placementId, d.slotId, r, d.key);
  };

  private onUp = () => { this.drag = null; };
}

declare global {
  interface HTMLElementTagNameMap { 'light-layout-editor': LightLayoutEditor }
}
