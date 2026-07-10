/**
 * <device-control-details> — the floating mapping panel, anchored above the
 * bottom-right output monitor overlay. Shows the selected control(s)' MIDI
 * addressing per gesture (CC / channel / mode / colors) and edits it through
 * the midi controller — every edit lazy-forks a template into a real
 * instance first (selection re-targets to the fork).
 *
 * Multi-select: numeric CC edits are RELATIVE — the input shows the primary
 * control's value, and committing shifts every selected control by the delta
 * (so a block of encoders slides together instead of collapsing onto one
 * CC). Channel/mode apply uniformly.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { midiController } from '../../state/midi-controller';
import { getDeviceTemplate } from '../../midi/device-registry';
import type { ControlGesture, ControlMapping } from '../../midi/midi-types';
import { devicesUi } from './devices-ui';
import { deviceColorCss } from './device-surface';

@customElement('device-control-details')
export class DeviceControlDetails extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed;
      right: 12px;
      z-index: 210;
      width: 300px;
      display: block;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      color: var(--app-text-color1);
      font-size: var(--app-fs-sm);
    }
    .head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--app-tint-2);
    }
    .head .title { flex: 1; color: var(--app-text-color1); }
    .head .count { color: var(--app-text-color2); font-size: var(--app-fs-xs); }
    .rows { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
    .gesture {
      margin-top: 4px;
      font-size: var(--app-fs-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--app-text-color2);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .row label { flex: 0 0 64px; color: var(--app-text-color2); }
    .row .range { flex: 1; text-align: right; color: var(--app-text-color2); font-size: var(--app-fs-xs); }
    input[type='number'], select {
      font: inherit;
      width: 64px;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      padding: 1px 4px;
    }
    input:focus, select:focus { outline: none; border-color: var(--app-hi-color2); }
    .swatch {
      width: 14px; height: 14px;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
    }
    .hint {
      padding: 0 10px 8px;
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
    }
  `;

  /** Selections grouped per device (edits apply per device group). */
  private grouped(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const s of devicesUi.selectedControls) {
      const list = groups.get(s.deviceId);
      if (list) list.push(s.controlId); else groups.set(s.deviceId, [s.controlId]);
    }
    return groups;
  }

  private mappingOf(deviceId: string, controlId: string, gesture: ControlGesture): ControlMapping | null {
    return midiController.getControlMapping(deviceId, `${controlId}/${gesture}`);
  }

  /** Apply an edit to every selected endpoint of `gesture`. Numeric `shiftKey`
   *  edits go through the relative-shift path when 2+ are selected. */
  private commit(gesture: ControlGesture, patch: ControlMapping, shiftKey?: 'cc' | 'channel') {
    const primary = devicesUi.selectedControls[0];
    for (const [deviceId, controlIds] of this.grouped()) {
      const endpoints = controlIds.map(id => `${id}/${gesture}`);
      let newId: string;
      const multi = devicesUi.selectedControls.length > 1;
      if (multi && shiftKey && patch[shiftKey] !== undefined) {
        const anchor = deviceId === primary.deviceId
          ? this.mappingOf(deviceId, primary.controlId, gesture)?.[shiftKey]
          : this.mappingOf(deviceId, controlIds[0], gesture)?.[shiftKey];
        const delta = (patch[shiftKey] as number) - (anchor ?? 0);
        if (delta === 0) continue;
        newId = midiController.shiftControlMappings(deviceId, endpoints, shiftKey, delta);
      } else {
        newId = midiController.updateControlMapping(deviceId, endpoints, patch);
      }
      if (newId !== deviceId) devicesUi.retargetSelection(deviceId, newId);
    }
  }

  private numberInput(
    gesture: ControlGesture, key: 'cc' | 'channel' | 'ringColor' | 'capColor',
    value: number | undefined,
    max: number, rangeLabel: string, opts: { shift?: boolean; offset?: number } = {},
  ) {
    if (value === undefined) return nothing;
    const display = value + (opts.offset ?? 0);
    return html`
      <input type="number" min=${(opts.offset ?? 0)} max=${max + (opts.offset ?? 0)} .value=${String(display)}
        @change=${(e: Event) => {
          const raw = Number((e.target as HTMLInputElement).value);
          if (!Number.isFinite(raw)) return;
          const v = Math.min(max, Math.max(0, Math.round(raw) - (opts.offset ?? 0)));
          this.commit(gesture, { [key]: v },
            opts.shift && (key === 'cc' || key === 'channel') ? key : undefined);
        }}
      />
      ${rangeLabel ? html`<span class="range">${rangeLabel}</span>` : nothing}
    `;
  }

  private gestureRows(gesture: ControlGesture) {
    const primary = devicesUi.selectedControls[0];
    const mapping = this.mappingOf(primary.deviceId, primary.controlId, gesture);
    if (!mapping) return nothing;
    const multi = devicesUi.selectedControls.length > 1;

    // The selection's CC span, for the "12…27" range hint.
    let ccLo = Infinity, ccHi = -Infinity;
    if (multi) {
      for (const s of devicesUi.selectedControls) {
        const cc = this.mappingOf(s.deviceId, s.controlId, gesture)?.cc;
        if (cc === undefined) continue;
        ccLo = Math.min(ccLo, cc); ccHi = Math.max(ccHi, cc);
      }
    }
    const ccRange = multi && ccHi >= ccLo && ccLo !== ccHi ? `${ccLo}…${ccHi}` : '';

    return html`
      <div class="gesture">${gesture}</div>
      <div class="row">
        <label>CC</label>
        ${this.numberInput(gesture, 'cc', mapping.cc, 127, ccRange, { shift: true })}
      </div>
      <div class="row">
        <label>Channel</label>
        ${this.numberInput(gesture, 'channel', mapping.channel, 15, '', { offset: 1 })}
      </div>
      ${mapping.mode !== undefined ? html`
        <div class="row">
          <label>Mode</label>
          <select .value=${mapping.mode}
            @change=${(e: Event) => this.commit(gesture,
              { mode: (e.target as HTMLSelectElement).value as 'absolute' | 'relative' })}>
            <option value="absolute">absolute</option>
            <option value="relative">relative</option>
          </select>
        </div>` : nothing}
      ${gesture === 'turn' ? html`
        <div class="row">
          <label>Ring color</label>
          ${this.numberInput(gesture, 'ringColor', mapping.ringColor ?? 0, 127, '')}
          <div class="swatch" style="background:${deviceColorCss(mapping.ringColor, 'transparent')}"></div>
        </div>
        <div class="row">
          <label>Cap color</label>
          ${this.numberInput(gesture, 'capColor', mapping.capColor ?? 0, 127, '')}
          <div class="swatch" style="background:${deviceColorCss(mapping.capColor, 'transparent')}"></div>
        </div>` : nothing}
    `;
  }

  render() {
    const selection = devicesUi.selectedControls;
    if (selection.length === 0) return nothing;
    const primary = selection[0];
    const instance = midiController.instance(primary.deviceId);
    const template = getDeviceTemplate(instance?.templateId ?? primary.deviceId);
    if (!template) return nothing;
    const def = template.layout.controls.find(c => c.id === primary.controlId);
    const deviceName = instance?.name ?? template.name;
    // Anchor directly above the floating output monitor.
    this.style.bottom = `${appState.local.userSettings.devicesMonitorHeight + 24}px`;

    return html`
      <div class="head">
        <span class="title">${deviceName} · ${primary.controlId}${def?.label ? ` (${def.label})` : ''}</span>
        ${selection.length > 1 ? html`<span class="count">${selection.length} selected</span>` : nothing}
      </div>
      <div class="rows">
        ${(def?.gestures ?? ['turn']).map(g => this.gestureRows(g))}
      </div>
      ${selection.length > 1
        ? html`<div class="hint">Numeric edits shift the whole selection relative to the primary.</div>`
        : nothing}
      ${!instance
        ? html`<div class="hint">Template — the first edit forks it into your devices.</div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-control-details': DeviceControlDetails;
  }
}
