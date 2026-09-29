/**
 * <light-rig-surface> — a rig drawn as what it is: its bars at the places
 * they sample in the frame (this show's layout when placed, else the rig's
 * default), each pixel in the colour it is showing now. A pixel that lights
 * several LEDs (a 24 V segment) is drawn as that many dots.
 *
 * Draws only; the layout editor (light-details) is the interactive twin.
 * Stroke widths are in screen pixels (vector-effect), so thin strips stay
 * visible at any frame aspect.
 */

import { html, css, svg, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import { lightController } from '../../state/light-controller';
import { drawSlots, frameAspect, pixelCells, UNLIT, type DrawSlot } from './light-draw';

/** Strips narrower than this (in frame units) are drawn at it, so a 1/60-wide
 *  bar reads as a bar on a 220 px card. */
const MIN_DRAW = 0.05;

@customElement('light-rig-surface')
export class LightRigSurface extends MobxLitElement {
  @property({ attribute: false }) rigId = '';
  /** Draw at this show's layout + live colours. */
  @property({ attribute: false }) placementId = '';
  /** Highlight one slot (the details panel's selection). */
  @property({ attribute: false }) selectedSlot = '';

  static styles = css`
    :host { display: block; }
    svg { display: block; width: 100%; height: auto; }
  `;

  render() {
    const rig = lightController.rig(this.rigId);
    if (!rig) return nothing;
    const aspect = frameAspect();
    const slots = drawSlots(rig, this.placementId || undefined);
    return html`<svg viewBox="0 0 ${aspect} 1" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width=${aspect} height="1" fill="#0b0b0e"
        stroke="rgba(255,255,255,0.12)" stroke-width="1" vector-effect="non-scaling-stroke"></rect>
      ${slots.map((s) => this.drawSlot(s, aspect))}
    </svg>`;
  }

  private drawSlot(s: DrawSlot, aspect: number) {
    const px = s.type?.pixels ?? 0;
    const leds = Math.max(1, s.type?.ledsPerPixel ?? 1);
    // Frame units: x scaled by the aspect so the viewBox stays 0..aspect × 0..1.
    const tall = s.rect.h >= s.rect.w;
    const r = {
      x: s.rect.x * aspect, y: s.rect.y, w: s.rect.w * aspect, h: s.rect.h,
    };
    if (tall && r.w < MIN_DRAW) { r.x -= (MIN_DRAW - r.w) / 2; r.w = MIN_DRAW; }
    if (!tall && r.h < MIN_DRAW) { r.y -= (MIN_DRAW - r.h) / 2; r.h = MIN_DRAW; }
    const cells = pixelCells(r, px, s.reverse);
    const sel = this.selectedSlot === s.slotId;
    return svg`
      <g data-slot=${s.slotId}>
        ${cells.map((c, i) => {
          const fill = s.colors?.[i] ?? UNLIT;
          if (leds === 1) {
            return svg`<rect x=${c.x} y=${c.y} width=${c.w} height=${c.h} fill=${fill}
              stroke="#000" stroke-width="0.5" vector-effect="non-scaling-stroke"></rect>`;
          }
          const dots = [];
          for (let k = 0; k < leds; k++) {
            const cx = tall ? c.x + c.w / 2 : c.x + (c.w * (k + 0.5)) / leds;
            const cy = tall ? c.y + (c.h * (k + 0.5)) / leds : c.y + c.h / 2;
            const rad = Math.min(tall ? c.w : c.h, tall ? c.h / leds : c.w / leds) * 0.4;
            dots.push(svg`<circle cx=${cx} cy=${cy} r=${rad} fill=${fill}></circle>`);
          }
          return svg`<rect x=${c.x} y=${c.y} width=${c.w} height=${c.h} fill="#000"
            stroke="rgba(255,255,255,0.08)" stroke-width="0.5" vector-effect="non-scaling-stroke"></rect>${dots}`;
        })}
        <rect x=${r.x} y=${r.y} width=${r.w} height=${r.h} fill="none"
          stroke=${sel ? 'var(--app-hi-color2, #4169e1)' : 'rgba(255,255,255,0.25)'}
          stroke-width=${sel ? 2 : 1} vector-effect="non-scaling-stroke"></rect>
        ${px > 0 ? svg`<circle cx=${cells[0].x + cells[0].w / 2} cy=${cells[0].y + cells[0].h / 2}
          r="0.006" fill="#e0a040" opacity="0.8"></circle>` : nothing}
      </g>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'light-rig-surface': LightRigSurface }
}
