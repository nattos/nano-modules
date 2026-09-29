/**
 * <arr-devices-panel> — the right panel's "Devices" tab: this machine's
 * device LIBRARY, and what the show includes from it.
 *
 * The library is app-level (the same one the sketch editor's Devices tab
 * edits, shared with the plugin through midi-devices.json); the show only
 * INCLUDES library devices (store.includeDevice → a device row under the
 * tracks). From here:
 *   - include a library device;
 *   - define a plugged-in controller nobody has claimed yet, as one of the
 *     templates that recognise it (or any template);
 *   - make a device from a template with no hardware (its on-screen controls
 *     still drive the show).
 * Mappings, colours and aliases stay in the editor's Devices tab.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { appState } from '../../../state/app-state';
import { midiController } from '../../../state/midi-controller';
import { allDeviceTemplates, getDeviceTemplate, matchTemplatesForPort } from '../../../midi/device-registry';
import type { DeviceInstance, PhysicalIdentity } from '../../../midi/midi-types';
import { store } from '../state/store';
import '../../../widgets/ui-icon';

@customElement('arr-devices-panel')
export class ArrDevicesPanel extends MobxLitElement {
  static styles = css`
    :host { display: block; font-size: var(--app-fs-sm); color: var(--app-text-color1); }
    .section-header {
      padding: 8px 10px; font-size: var(--app-fs-xs); text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--app-text-color2);
      border-bottom: 1px solid var(--app-tint-2);
    }
    .body { padding: 8px 10px; }
    .hint { color: var(--app-text-color2); font-size: var(--app-fs-xs); margin: 4px 0 8px; }
    .dev {
      display: flex; align-items: center; gap: 6px; padding: 4px 0;
      border-bottom: 1px solid var(--app-tint-1, rgba(255,255,255,0.04));
    }
    .dev .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dev .model { color: var(--app-text-color2); font-size: var(--app-fs-xs); white-space: nowrap; }
    .stat { width: 7px; height: 7px; border-radius: 50%; background: var(--app-tint-4); flex-shrink: 0; }
    .stat.live { background: var(--app-cat-source, #57b47a); }
    button {
      font: inherit; font-size: var(--app-fs-xs); cursor: pointer; white-space: nowrap;
      padding: 2px 8px; border-radius: 2px; border: 1px solid var(--app-tint-4);
      background: var(--app-bg-color1); color: var(--app-text-color1);
    }
    button.primary { border-color: #ff8c00; color: #ff8c00; }
    button[disabled] { opacity: 0.5; cursor: default; }
    .row { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 10px; }
  `;

  private include(inst: DeviceInstance) {
    const id = store.includeDevice(inst.id, { label: inst.name, templateId: inst.templateId });
    store.setSelection([`device/${id}`]);
  }

  private define(port: PhysicalIdentity, templateId: string) {
    this.include(midiController.claimPort(templateId, port));
  }

  private fromTemplate(templateId: string) {
    this.include(midiController.ensureInstanceForEdit(templateId));
  }

  private renderLibraryRow(inst: DeviceInstance) {
    const inShow = !!store.placementForDevice(inst.id);
    const live = !!appState.local.midi.connected[inst.id];
    return html`<div class="dev" data-lib-device=${inst.id}>
      <span class="stat ${live ? 'live' : ''}" title=${live ? 'Connected' : 'Not connected'}></span>
      <span class="name" title=${inst.name}>${inst.name}</span>
      <span class="model">${getDeviceTemplate(inst.templateId)?.name ?? inst.templateId}</span>
      <button class=${inShow ? '' : 'primary'} ?disabled=${inShow}
        @click=${() => this.include(inst)}>${inShow ? 'In show' : 'Add to show'}</button>
    </div>`;
  }

  private renderUnknownPort(port: PhysicalIdentity) {
    const matches = matchTemplatesForPort(port);
    const offer = matches.length ? matches : allDeviceTemplates();
    return html`<div class="dev"><span class="name">${port.name}</span>
        <span class="model">${port.manufacturer}</span></div>
      <div class="row">${offer.map((t) => html`<button class=${matches.length ? 'primary' : ''}
        @click=${() => this.define(port, t.templateId)}>Add as ${t.name}</button>`)}</div>`;
  }

  render() {
    const midi = appState.local.midi;
    const library = midi.library.filter((i) => !i.deleted);
    const unknown = midi.unknownPorts ?? [];
    return html`
      <div class="section-header">Devices</div>
      <div class="body">
        <div class="hint">
          This machine’s devices. A show includes the ones it uses — each gets a row under
          the tracks, and its controls wire to any field (W).
        </div>
        ${library.length
          ? library.map((i) => this.renderLibraryRow(i))
          : html`<div class="hint">No devices in the library yet.</div>`}
        ${unknown.length
          ? html`<div class="hint" style="margin-top:10px">Plugged in, not in the library:</div>
              ${unknown.map((p) => this.renderUnknownPort(p))}`
          : nothing}
        ${midiController.manager.initialized
          ? nothing
          : html`<div class="row"><button @click=${() => void midiController.initMidi()}>
              <ui-icon icon="la-plug"></ui-icon> Look for MIDI devices</button></div>`}
        <div class="hint" style="margin-top:10px">New device without hardware:</div>
        <div class="row">${allDeviceTemplates().map((t) => html`<button
          @click=${() => this.fromTemplate(t.templateId)}>${t.name}</button>`)}</div>
      </div>
    `;
  }
}
