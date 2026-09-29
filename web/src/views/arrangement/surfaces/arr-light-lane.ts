/**
 * <arr-light-lane> — a light rig's lane in its timeline row: the rig drawn as
 * the Devices view draws it (its bars where they sample the frame, in the
 * colours they are showing now), scaled to the lane's height. A glance, like
 * a MIDI row's knobs; the rig is edited in the Devices view.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { lightController } from '../state/light-controller';
import { store } from '../state/store';
import './lights/light-rig-surface';

@customElement('arr-light-lane')
export class ArrLightLane extends MobxLitElement {
  @property({ attribute: false }) placementId = '';

  static styles = css`
    :host { position: absolute; inset: 0; display: flex; align-items: stretch; padding: 4px 8px; }
    light-rig-surface.off { opacity: 0.45; }
    .none { align-self: center; font-size: var(--app-fs-xs); color: var(--app-text-color2); }
  `;

  render() {
    const p = store.placementById(this.placementId);
    const rig = p ? lightController.rig(p.deviceId) : undefined;
    if (!p || !rig) return html`<span class="none">not in this machine's library</span>`;
    return html`<light-rig-surface compact class=${p.enabled === false ? 'off' : ''}
      .rigId=${rig.id} .placementId=${this.placementId}></light-rig-surface>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'arr-light-lane': ArrLightLane }
}
