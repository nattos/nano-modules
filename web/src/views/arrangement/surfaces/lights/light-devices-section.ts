/**
 * <light-devices-section> — the arrangement's light devices inside the
 * Devices view (after the MIDI groups; DevicesHost.renderLights):
 *
 *   LIGHTS    — rigs: each drawn as its bars in the frame, live; the card's
 *               "in show" toggle includes it (a timeline row, output on);
 *               placed, its input pip takes a route.
 *   MISSING   — rigs the show includes that this machine doesn't have.
 *   TYPES     — the library's light types (hidden under "in use").
 *   TEMPLATES — the code templates (the panel's templates filter).
 *   DELETED   — soft-deleted rigs and types (the deleted filter).
 *
 * Selection is the panel's (devicesUi.selectedCardId); <light-details> is the
 * floating panel for it.
 */

import { html, css, nothing, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import {
  LIGHT_TEMPLATES, LIGHT_FORMATS, slotChannels, type LightRig, type LightType,
} from '../../../../lights/light-types';
import { devicesUi } from '../../../devices/devices-ui';
import { lightController } from '../../state/light-controller';
import { store } from '../../state/store';
import { MISSING_PREFIX } from './light-details';

import '../../../devices/device-card';
import './light-rig-surface';
import './light-input-pip';
import './light-details';

@customElement('light-devices-section')
export class LightDevicesSection extends MobxLitElement {
  @property({ attribute: false }) inUse = false;
  @property({ attribute: false }) templates = true;
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
    .meta { margin-top: 4px; font-size: var(--app-fs-xs); color: var(--app-text-color2); }
    .bar { display: block; width: 100%; height: 18px; }
  `;

  render() {
    const placed = new Map(store.lightPlacements.map((p) => [p.deviceId, p]));
    const rigs = lightController.rigs.filter((r) => !this.inUse || placed.has(r.id));
    const missing = store.lightPlacements.filter((p) => !lightController.rig(p.deviceId)
      || lightController.rig(p.deviceId)!.deleted);
    const types = lightController.types;
    const gone = lightController.library.filter((r) => r.deleted);
    return html`
      <div>
        <div class="group-label">Lights
          <button class="chip" data-light-action="add-rig" title="A new rig of LED bars"
            @click=${this.onAddRig}>+ rig</button></div>
        <div class="cards">
          ${rigs.map((r) => this.renderRigCard(r, placed.get(r.id)?.id))}
          ${missing.map((p) => html`<device-card .name=${p.label ?? 'Light'} .subtitle=${'not in this machine\'s library'}
              .status=${'missing'} ?selected=${devicesUi.selectedCardId === MISSING_PREFIX + p.id}
              @click=${() => devicesUi.selectCard(MISSING_PREFIX + p.id)}></device-card>`)}
          ${rigs.length === 0 && missing.length === 0 ? html`<div class="empty-note">${this.inUse
            ? 'No lights in this show — "in show" on a rig adds one.'
            : types.length ? 'No rigs yet — select a type to make one.'
            : 'No lights yet — "+ rig" starts from the LED strip template.'}</div>` : nothing}
        </div>
      </div>
      ${!this.inUse && types.length ? html`<div>
        <div class="group-label">Light types</div>
        <div class="cards">${types.map((t) => this.renderTypeCard(t))}</div>
      </div>` : nothing}
      ${this.templates && !this.inUse ? html`<div>
        <div class="group-label">Light templates</div>
        <div class="cards">${LIGHT_TEMPLATES.map((t) => html`
          <device-card .name=${t.name} .subtitle=${'a bar of addressable pixels'} .status=${'template'}
            data-light-card=${t.templateId}
            ?selected=${devicesUi.selectedCardId === t.templateId}
            @click=${() => this.select(t.templateId)}>
            ${this.bar(t.defaults.pixels, t.defaults.ledsPerPixel)}
          </device-card>`)}</div>
      </div>` : nothing}
      ${this.deleted && gone.length ? html`<div>
        <div class="group-label">Deleted lights</div>
        <div class="cards">${gone.map((r) => html`
          <device-card .name=${r.name} .subtitle=${r.kind} .status=${'deleted'} .actionLabel=${'restore'}
            @card-action=${() => lightController.setDeleted(r.id, false)}
            @click=${() => this.select(r.id)}></device-card>`)}</div>
      </div>` : nothing}
      <light-details></light-details>
    `;
  }

  private select(id: string) {
    devicesUi.selectCard(devicesUi.selectedCardId === id ? null : id);
  }

  /** "+ rig": a type to make it from (the most recent, or a fresh one from
   *  the template), selected so its details offer the new-rig form. */
  private onAddRig = () => {
    const t = lightController.types[lightController.types.length - 1]
      ?? lightController.newType(LIGHT_TEMPLATES[0].templateId);
    if (t) devicesUi.selectCard(t.id);
  };

  private renderRigCard(rig: LightRig, placementId: string | undefined) {
    const on = !!placementId;
    const chans = rig.slots.reduce((n, s) => {
      const t = lightController.type(s.typeId);
      return n + (t ? slotChannels(t) : 0);
    }, 0);
    const universes = [...new Set(rig.slots.map((s) => s.address.universe))];
    return html`
      <device-card .name=${rig.name}
        .subtitle=${`${rig.slots.length} bar${rig.slots.length === 1 ? '' : 's'} · ${chans} ch · u${universes.join(',')}`}
        .status=${on && store.placementById(placementId!)?.enabled !== false ? 'connected' : 'disconnected'}
        data-light-card=${rig.id}
        ?selected=${devicesUi.selectedCardId === rig.id}
        @click=${() => this.select(rig.id)}>
        <button slot="head" class="include ${on ? 'on' : ''}" data-light-include=${rig.id}
          title=${on ? 'In this show — click to take it out (its layout and route go too)'
                     : 'Add this rig to the show: it samples the main output and transmits'}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (placementId) store.removeDevicePlacement(placementId);
            else store.includeDevice(rig.id, { kind: 'light', label: rig.name });
          }}>${on ? 'in show' : 'add to show'}</button>
        <light-rig-surface .rigId=${rig.id} .placementId=${placementId ?? ''}></light-rig-surface>
        ${placementId ? html`<div class="pip"><light-input-pip .placementId=${placementId}
          .scope=${'devices'}></light-input-pip></div>` : nothing}
      </device-card>`;
  }

  private renderTypeCard(t: LightType) {
    const fmt = LIGHT_FORMATS.find((f) => f.id === t.format)?.label ?? t.format;
    return html`
      <device-card .name=${t.name}
        .subtitle=${`${t.vertical !== false ? '↕' : '↔'} ${t.pixels} px${t.ledsPerPixel > 1 ? ` × ${t.ledsPerPixel} LEDs` : ''} · ${fmt} · γ${t.gamma}`}
        .status=${'disconnected'} data-light-card=${t.id}
        ?selected=${devicesUi.selectedCardId === t.id}
        @click=${() => this.select(t.id)}>
        ${this.bar(t.pixels, t.ledsPerPixel)}
      </device-card>`;
  }

  /** A type drawn as its bar: `pixels` cells, each `leds` dots. */
  private bar(pixels: number, leds: number) {
    const n = Math.max(1, Math.min(pixels, 120));
    const w = 100 / n;
    const k = Math.max(1, Math.min(leds, 8));
    return html`<svg class="bar" viewBox="0 0 100 10" preserveAspectRatio="none">
      ${Array.from({ length: n }, (_, i) => k === 1
        ? svg`<rect x=${i * w + w * 0.08} y="1" width=${w * 0.84} height="8" fill="rgba(255,255,255,0.35)"></rect>`
        : Array.from({ length: k }, (_, j) => svg`<rect x=${i * w + (w * (j + 0.2)) / k} y="3"
            width=${(w * 0.6) / k} height="4" fill="rgba(255,255,255,0.35)"></rect>`))}
    </svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'light-devices-section': LightDevicesSection }
}
