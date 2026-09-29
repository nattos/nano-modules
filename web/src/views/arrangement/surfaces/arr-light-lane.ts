/**
 * <arr-light-lane> — a light rig's lane in its timeline row: each bar as a
 * horizontal strip of its pixels in the colour it is showing now (pixel 0 on
 * the left), one strip per slot. A glance, like a MIDI row's knobs; the rig
 * is edited in the Devices view.
 */

import { html, css, svg, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { lightController } from '../state/light-controller';
import { store } from '../state/store';
import { drawSlots, UNLIT } from './lights/light-draw';

@customElement('arr-light-lane')
export class ArrLightLane extends MobxLitElement {
  @property({ attribute: false }) placementId = '';

  static styles = css`
    :host { position: absolute; inset: 0; display: flex; align-items: center; padding: 4px 8px; }
    svg { display: block; width: min(100%, 480px); height: 100%; }
    .none { font-size: var(--app-fs-xs); color: var(--app-text-color2); }
  `;

  render() {
    const p = store.placementById(this.placementId);
    const rig = p ? lightController.rig(p.deviceId) : undefined;
    if (!p || !rig) return html`<span class="none">not in this machine's library</span>`;
    const slots = drawSlots(rig, this.placementId);
    const n = Math.max(1, slots.length);
    const gap = 0.25;
    const h = 1 / (n + gap * (n - 1));
    const dim = p.enabled === false;
    return html`<svg viewBox="0 0 100 1" preserveAspectRatio="none" style=${dim ? 'opacity:0.45' : ''}>
      ${slots.map((s, i) => {
        const px = s.type?.pixels ?? 0;
        if (!px) return nothing;
        const y = i * h * (1 + gap);
        const w = 100 / px;
        return svg`${Array.from({ length: px }, (_, k) => svg`<rect x=${k * w + w * 0.06} y=${y}
          width=${w * 0.88} height=${h} fill=${s.colors?.[k] ?? UNLIT}></rect>`)}`;
      })}
    </svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'arr-light-lane': ArrLightLane }
}
