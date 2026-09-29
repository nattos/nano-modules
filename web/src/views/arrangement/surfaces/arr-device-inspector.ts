/**
 * <arr-device-inspector> — the inspector for a device row selected on the
 * timeline (`device/<placementId>`): what it is, whether it's live, for a
 * light what it samples and where each bar listens, for a display where it
 * lands, how the frame fits and what it shows. Selecting a row never leaves
 * the timeline; "Edit in Devices" is the explicit way there.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { addressLabel, slotChannels } from '../../../lights/light-types';
import { rigWarnings } from '../../../lights/light-plan';
import { getDeviceTemplate } from '../../../midi/device-registry';
import { midiController } from '../../../state/midi-controller';
import { appState } from '../../../state/app-state';
import { devicesUi } from '../../devices/devices-ui';
import { engineBridge } from '../engine/engine-bridge';
import { lightController } from '../state/light-controller';
import { displayController } from '../state/display-controller';
import { outputMaster } from '../state/output-master';
import { DISPLAY_FITS } from '../../../displays/display-types';
import { displayWhere } from './displays/display-where';
import { store } from '../state/store';
import type { DevicePlacement } from '../model/composition';
import { routeEndLabel } from './arr-io';
import './lights/light-rig-surface';
import './displays/display-surface';

@customElement('arr-device-inspector')
export class ArrDeviceInspector extends MobxLitElement {
  @property({ attribute: false }) placementId = '';

  static styles = css`
    :host { display: block; }
    .section-header {
      font-size: var(--app-fs-sm); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2); padding: var(--app-sp-4) var(--app-sp-5) var(--app-sp-2);
      border-bottom: 1px solid var(--app-tint-2);
    }
    .body { padding: var(--app-sp-4) var(--app-sp-5); display: flex; flex-direction: column; gap: var(--app-sp-3); }
    .row { display: flex; align-items: center; justify-content: space-between; gap: var(--app-sp-4); min-height: 22px; }
    .row label { color: var(--app-text-color2); font-size: var(--app-fs-sm); flex: none; }
    .val { color: var(--app-text-color1); font-variant-numeric: tabular-nums; text-align: right;
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: var(--app-text-color2); font-size: var(--app-fs-sm); }
    .warn { color: var(--app-hi-color1, #e0a040); font-size: var(--app-fs-sm); }
    .bars { display: flex; flex-direction: column; gap: 2px; font-size: var(--app-fs-sm); }
    .bar { display: flex; gap: var(--app-sp-3); color: var(--app-text-color1); font-variant-numeric: tabular-nums; }
    .bar .n { flex: 0 0 16px; text-align: right; color: var(--app-text-color2); }
    .bar .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--app-text-color2); }
    .actions { display: flex; flex-wrap: wrap; gap: var(--app-sp-3); }
    button {
      font-family: inherit; font-size: var(--app-fs-sm); color: var(--app-text-color1);
      background: var(--app-bg-color1); border: 1px solid var(--app-tint-4); border-radius: 2px;
      padding: 3px 8px; cursor: pointer;
    }
    button:hover { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    button.on { border-color: var(--app-cat-source, #57b47a); color: var(--app-cat-source, #57b47a); }
    light-rig-surface, display-surface { max-width: 320px; }
    .fits { display: flex; gap: 4px; }
  `;

  render() {
    const p = store.placementById(this.placementId);
    if (!p) return html`<div class="section-header">Device</div>
      <div class="body"><span class="muted">No longer in this show.</span></div>`;
    return p.kind === 'light' ? this.renderLight(p)
      : p.kind === 'display' ? this.renderDisplay(p) : this.renderMidi(p);
  }

  private renderLight(p: DevicePlacement) {
    const rig = lightController.rig(p.deviceId);
    const name = rig?.name ?? p.label ?? 'Missing light';
    const on = p.enabled !== false;
    const route = store.deviceInputRoute(p.id);
    const status = lightController.status;
    const sending = !rig || rig.deleted ? 'not in this machine’s library'
      : !engineBridge.outputsLights ? 'this engine doesn’t transmit'
      : status?.error ? status.error
      : on && !outputMaster.armed ? 'output is off (the Devices panel’s switch)'
      : on ? `${status?.pps ?? 0} packets/s` : 'not sending';
    const types = rig ? [...new Set(rig.slots.map((s) => lightController.type(s.typeId)?.name ?? 'missing type'))] : [];
    const chans = rig ? rig.slots.reduce((n, s) => {
      const t = lightController.type(s.typeId);
      return n + (t ? slotChannels(t) : 0);
    }, 0) : 0;
    return html`
      <div class="section-header">Light · ${name}</div>
      <div class="body">
        ${rig && !rig.deleted ? html`<light-rig-surface .rigId=${rig.id} .placementId=${p.id}></light-rig-surface>` : nothing}
        <div class="row"><label>Output</label>
          <span class="val muted">${sending}</span>
          <button class=${on ? 'on' : ''} data-inspector-light-enable
            @click=${() => store.setLightEnabled(p.id, !on)}>${on ? 'on' : 'off'}</button></div>
        <div class="row"><label>Samples</label>
          <span class="val">${route ? routeEndLabel(route.src) : 'main output'}</span>
          ${route ? html`<button title="Sample the main output again"
            @click=${() => store.removeRoute(route.id)}>main</button>` : nothing}</div>
        ${rig && !rig.deleted ? html`
          <div class="row"><label>Rig</label>
            <span class="val">${rig.slots.length} bar${rig.slots.length === 1 ? '' : 's'} · ${chans} ch</span></div>
          <div class="row"><label>Type</label><span class="val">${types.join(', ')}</span></div>
          <div class="bars">${rig.slots.map((s, i) => html`<div class="bar">
            <span class="n">${i + 1}</span><span>${addressLabel(s.address)}</span>
            <span class="t">${[
              s.address.network ? `via ${lightController.network(s.address.network)?.name ?? 'a missing network'}` : '',
              s.reverse ? 'reversed' : '',
            ].filter(Boolean).join(' · ')}</span></div>`)}</div>
          ${rigWarnings(rig, lightController.library).map((w) => html`<div class="warn">${w.message}</div>`)}`
        : html`<span class="muted">This show includes a rig this machine's library doesn't have, so
            nothing is sent for it.</span>`}
        <div class="actions">
          <button data-inspector-action="edit-in-devices" @click=${() => {
            devicesUi.selectCard(rig && !rig.deleted ? rig.id : `missing-light:${p.id}`);
            store.setMainView('devices');
          }}>Edit in Devices</button>
          <button @click=${() => this.removeFromShow(p.id)}>Remove from show</button>
        </div>
      </div>`;
  }

  private renderDisplay(p: DevicePlacement) {
    const slot = displayController.slot(p.deviceId);
    const name = slot?.name ?? p.label ?? 'Display';
    const on = p.enabled !== false;
    const route = store.deviceInputRoute(p.id);
    const fit = p.fit ?? 'fit';
    return html`
      <div class="section-header">Display · ${name}</div>
      <div class="body">
        ${slot ? html`<display-surface .slotId=${slot.id} .placementId=${p.id}></display-surface>` : nothing}
        <div class="row"><label>Output</label>
          <span class="val muted">${slot ? displayWhere(slot, p.id).text : ''}</span>
          <button class=${on ? 'on' : ''} data-inspector-display-enable
            @click=${() => store.setDisplayEnabled(p.id, !on)}>${on ? 'on' : 'off'}</button></div>
        <div class="row"><label>Fit</label>
          <span class="fits">${DISPLAY_FITS.map((f) => html`<button class=${fit === f.id ? 'on' : ''}
            data-inspector-display-fit=${f.id} title=${f.title}
            @click=${() => store.setDisplayFit(p.id, f.id)}>${f.label}</button>`)}</span></div>
        <div class="row"><label>Shows</label>
          <span class="val">${route ? routeEndLabel(route.src) : 'main output'}</span>
          ${route ? html`<button title="Show the main output again"
            @click=${() => store.removeRoute(route.id)}>main</button>` : nothing}</div>
        <div class="actions">
          <button data-inspector-action="edit-in-devices" @click=${() => {
            devicesUi.selectCard(p.deviceId);
            store.setMainView('devices');
          }}>Edit in Devices</button>
          <button @click=${() => this.removeFromShow(p.id)}>Remove from show</button>
        </div>
      </div>`;
  }

  private renderMidi(p: DevicePlacement) {
    const inst = midiController.instance(p.deviceId);
    const name = inst?.name ?? p.label ?? 'Missing device';
    const status = !inst ? 'not in this machine’s device library'
      : appState.local.midi.connected[p.deviceId] ? 'connected'
      : 'not connected (on-screen controls still drive it)';
    const wires = store.deviceWireCount(p.deviceId);
    return html`
      <div class="section-header">MIDI · ${name}</div>
      <div class="body">
        ${inst ? html`<div class="row"><label>Device</label>
          <span class="val">${getDeviceTemplate(inst.templateId)?.name ?? inst.templateId}</span></div>` : nothing}
        <div class="row"><label>Status</label><span class="val muted">${status}</span></div>
        <div class="row"><label>Wires</label><span class="val">${wires}</span></div>
        <div class="actions">
          <button data-inspector-action="edit-in-devices" @click=${() => {
            devicesUi.selectCard(p.deviceId);
            store.setMainView('devices');
          }}>Edit in Devices</button>
          <button @click=${() => this.removeFromShow(p.id)}>Remove from timeline</button>
        </div>
      </div>`;
  }

  private removeFromShow(placementId: string) {
    store.removeDevicePlacement(placementId);
    store.clearSelection();
  }
}

declare global {
  interface HTMLElementTagNameMap { 'arr-device-inspector': ArrDeviceInspector }
}
