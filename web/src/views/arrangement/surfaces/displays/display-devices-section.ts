/**
 * <display-devices-section> — the arrangement's display devices inside the
 * Devices view (after the lights; DevicesHost.renderDisplays):
 *
 *   DISPLAYS — this machine's slots (Display 1 and 2 always), each drawn as a
 *              panel with the show's frame fitted on it; the card's "in show"
 *              toggle includes it (a timeline row, output on); placed, its
 *              input pip takes a route. "in use": the placed ones.
 *   DELETED  — removed slots (the deleted filter).
 *
 * Selection is the panel's (devicesUi.selectedCardId); <display-details> is
 * the floating panel for it.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import type { DisplaySlot } from '../../../../displays/display-types';
import { devicesUi } from '../../../devices/devices-ui';
import { displayController } from '../../state/display-controller';
import { store } from '../../state/store';
import { displayWhere } from './display-where';

import '../../../devices/device-card';
import '../device-input-pip';
import './display-surface';
import './display-details';

@customElement('display-devices-section')
export class DisplayDevicesSection extends MobxLitElement {
  @property({ attribute: false }) inUse = false;
  @property({ attribute: false }) deleted = false;

  static styles = css`
    :host { display: flex; flex-direction: column; gap: var(--app-sp-6); }
    .group-label {
      font-size: var(--app-fs-xs); letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--app-text-color2); margin-bottom: 6px;
      display: flex; align-items: center; gap: 8px;
    }
    .cards { display: flex; flex-wrap: wrap; gap: var(--app-sp-4); align-items: flex-start; }
    .empty-note {
      font-size: var(--app-fs-sm); color: var(--app-text-color2);
      border: 1px dashed var(--app-tint-3); border-radius: 1px; padding: 10px 12px;
    }
    .chip {
      font: inherit; font-size: var(--app-fs-xs); color: var(--app-text-color2); background: none;
      border: 1px solid var(--app-tint-3); border-radius: 1px; padding: 1px 6px; cursor: pointer;
      text-transform: none; letter-spacing: 0;
    }
    .chip:hover { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    /* Slotted into a card's header (light DOM — styled from here). */
    .include {
      flex: 0 0 auto; font: inherit; font-size: var(--app-fs-xs); cursor: pointer;
      color: var(--app-text-color2); background: none;
      border: 1px solid var(--app-tint-4); border-radius: 1px; padding: 0 4px;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .include:hover, .include.on { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    .pip { display: flex; margin-top: 6px; min-width: 0; }
    display-surface { margin-top: 4px; }
  `;

  render() {
    const placed = new Map(store.displayPlacements.map((p) => [p.deviceId, p]));
    const slots = displayController.slots.filter((s) => !this.inUse || placed.has(s.id));
    // A show from another machine can place a slot this one has never made.
    const foreign = store.displayPlacements.filter((p) => !displayController.slots.some((s) => s.id === p.deviceId));
    const gone = displayController.library.filter((r) => r.deleted && !placed.has(r.id));
    return html`
      <div>
        <div class="group-label">Displays
          <button class="chip" data-display-action="add" title="Another display slot (Display 3, 4, …)"
            @click=${() => devicesUi.selectCard(displayController.newDisplay().id)}>+ display</button></div>
        <div class="cards">
          ${slots.map((s) => this.renderCard(s, placed.get(s.id)?.id))}
          ${foreign.map((p) => {
            const s = displayController.slot(p.deviceId);
            return s ? this.renderCard({ ...s, name: p.label ?? s.name }, p.id) : nothing;
          })}
          ${slots.length === 0 && foreign.length === 0 ? html`<div class="empty-note">
            No displays in this show — "add to show" on a display puts the show on a screen.</div>` : nothing}
        </div>
      </div>
      ${this.deleted && gone.length ? html`<div>
        <div class="group-label">Deleted displays</div>
        <div class="cards">${gone.map((r) => html`
          <device-card .name=${r.name} .subtitle=${'display'} .status=${'deleted'} .actionLabel=${'restore'}
            @card-action=${() => displayController.setDeleted(r.id, false)}
            @click=${() => this.select(r.id)}></device-card>`)}</div>
      </div>` : nothing}
      <display-details></display-details>
    `;
  }

  private select(id: string) {
    devicesUi.selectCard(devicesUi.selectedCardId === id ? null : id);
  }

  private renderCard(slot: DisplaySlot, placementId: string | undefined) {
    const on = !!placementId;
    const where = displayWhere(slot, placementId);
    return html`
      <device-card .name=${slot.name} .subtitle=${where.text}
        .status=${where.state === 'live' ? 'connected' : 'disconnected'}
        data-display-card=${slot.id}
        ?selected=${devicesUi.selectedCardId === slot.id}
        @click=${() => this.select(slot.id)}>
        <button slot="head" class="include ${on ? 'on' : ''}" data-display-include=${slot.id}
          title=${on ? 'In this show — click to take it out (its route goes too)'
                     : 'Add this display to the show: it shows the main output'}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (placementId) store.removeDevicePlacement(placementId);
            else store.includeDevice(slot.id, { kind: 'display', label: slot.name });
          }}>${on ? 'in show' : 'add to show'}</button>
        <display-surface .slotId=${slot.id} .placementId=${placementId ?? ''}></display-surface>
        ${placementId ? html`<div class="pip"><device-input-pip .placementId=${placementId}
          .scope=${'devices'}></device-input-pip></div>` : nothing}
      </device-card>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'display-devices-section': DisplayDevicesSection }
}
