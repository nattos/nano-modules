/**
 * <arr-display-lane> — a display's lane in its timeline row: the display
 * drawn as the Devices view draws it (its screen, the show's frame fitted on
 * it) and where it lands, scaled to the lane's height. A glance; the display
 * is edited in the Devices view or the inspector.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { displayController } from '../state/display-controller';
import { store } from '../state/store';
import { displayWhere } from './displays/display-where';
import './displays/display-surface';

@customElement('arr-display-lane')
export class ArrDisplayLane extends MobxLitElement {
  @property({ attribute: false }) placementId = '';

  static styles = css`
    :host { position: absolute; inset: 0; display: flex; align-items: stretch; gap: 10px; padding: 4px 8px; }
    .where { align-self: center; font-size: var(--app-fs-xs); color: var(--app-text-color2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;

  render() {
    const p = store.placementById(this.placementId);
    const slot = p ? displayController.slot(p.deviceId) : undefined;
    if (!p || !slot) return html``;
    return html`<display-surface compact .slotId=${slot.id} .placementId=${p.id}></display-surface>
      <span class="where">${displayWhere(slot, p.id).text}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'arr-display-lane': ArrDisplayLane }
}
