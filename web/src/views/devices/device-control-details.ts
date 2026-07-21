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
 *
 * Below the mapping rows, a scrollable <device-wires-panel> lists every wire
 * the selection drives across the whole composition (grouped per instance,
 * with the full wire-mod inspector + a locate button per wire). Selecting a
 * DEVICE CARD (no controls) shows the panel alone, scoped to the whole device.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { midiController } from '../../state/midi-controller';
import { allDeviceTemplates, getDeviceTemplate } from '../../midi/device-registry';
import type { ControlGesture, ControlMapping } from '../../midi/midi-types';
import { devicesUi } from './devices-ui';
import { deviceColorCss } from './device-surface';
import { ghostScan } from './ghost-scan';
import './device-wires-panel';

@customElement('device-control-details')
export class DeviceControlDetails extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed;
      right: 12px;
      z-index: 210;
      width: 300px;
      display: flex;
      flex-direction: column;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      color: var(--app-text-color1);
      font-size: var(--app-fs-sm);
    }
    /* Nothing selected → no empty bordered sliver (render() stamps this). */
    :host([data-empty]) { display: none; }
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
    /* Device color values are a 0..127 hue wheel — pick on a hue strip. */
    input[type='range'].hue {
      flex: 1;
      -webkit-appearance: none;
      appearance: none;
      height: 10px;
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      background: linear-gradient(to right,
        hsl(0,75%,55%), hsl(60,75%,55%), hsl(120,75%,55%), hsl(180,75%,55%),
        hsl(240,75%,55%), hsl(300,75%,55%), hsl(330,75%,55%));
    }
    input[type='range'].hue::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 6px;
      height: 14px;
      background: var(--app-text-color1);
      border: 1px solid var(--app-bg-color1);
      border-radius: 1px;
      cursor: ew-resize;
    }
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
    .wires-head {
      flex: none;
      padding: 5px 10px 0;
      border-top: 1px solid var(--app-tint-2);
      font-size: var(--app-fs-xs);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--app-text-color2);
    }
    /* The wires list is the panel's scrollable tail — it shrinks first when
     * the host hits its max-height budget (host is bottom-anchored, so it
     * grows upward until then). */
    device-wires-panel {
      flex: 0 1 auto;
      min-height: 0;
      padding: 0 10px 8px;
    }
    /* Ghost (missing-device) branch. */
    .ghost-hint {
      padding: 6px 10px 0;
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      line-height: 1.4;
    }
    .ghost-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
    }
    .ghost-btn {
      font: inherit;
      font-size: var(--app-fs-sm);
      text-align: left;
      color: var(--app-text-color1);
      background: color-mix(in srgb, var(--app-hi-color1) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--app-hi-color1) 45%, transparent);
      border-radius: 1px;
      padding: 3px 8px;
      cursor: pointer;
    }
    .ghost-btn:hover { background: color-mix(in srgb, var(--app-hi-color1) 22%, transparent); }
    .ghost-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 0 10px 8px;
      border-bottom: 1px solid var(--app-tint-2);
    }
    .ghost-control {
      font-size: var(--app-fs-xs);
      color: var(--app-text-color1);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      padding: 1px 5px;
    }
    .ghost-gestures { color: var(--app-text-color2); }
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

  /** 0..127 hue-wheel picker. Commits on every input — the LED follows the
   *  drag live (config edits re-render device output; persistence is
   *  debounced by the controller). */
  private hueSlider(gesture: ControlGesture, key: 'ringColor' | 'capColor', value: number | undefined) {
    return html`
      <input type="range" class="hue" min="0" max="127" .value=${String(value ?? 0)}
        @input=${(e: Event) => {
          const v = Math.min(127, Math.max(0, Math.round(Number((e.target as HTMLInputElement).value))));
          this.commit(gesture, { [key]: v });
        }}
      />
      <div class="swatch" style="background:${deviceColorCss(value, 'transparent')}"></div>
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
          ${this.hueSlider(gesture, 'ringColor', mapping.ringColor)}
        </div>
        <div class="row">
          <label>Cap color</label>
          ${this.hueSlider(gesture, 'capColor', mapping.capColor)}
        </div>` : nothing}
    `;
  }

  /** Anchor directly above the floating output monitor, growing upward —
   *  capped so a long wires list scrolls instead of running off-screen. */
  private anchorAboveMonitor() {
    const bottom = appState.local.userSettings.devicesMonitorHeight + 24;
    this.style.bottom = `${bottom}px`;
    this.style.maxHeight = `calc(100vh - ${bottom + 60}px)`;
  }

  /** Card selection (no controls): the device's whole wire fan-out. Only
   *  library instances — a template can't own wires (wiring lazy-forks) —
   *  plus GHOST cards (missing devices reconstructed from composition wires). */
  private renderDeviceCard() {
    const id = devicesUi.selectedCardId;
    const instance = id ? midiController.instance(id) : undefined;
    if (!instance) return id ? this.renderGhostCard(id) : nothing;
    this.anchorAboveMonitor();
    return html`
      <div class="head">
        <span class="title">${instance.name}</span>
        <span class="count">wires</span>
      </div>
      <device-wires-panel .deviceId=${instance.id} .controlIds=${null}></device-wires-panel>
    `;
  }

  /**
   * Missing-device details: what the composition maps on it (controls +
   * gesture sets, wire fan-out — the wires panel keys on the raw uuid and
   * works for ghosts as-is) and the two repair actions. NEITHER rewrites any
   * sketch wire:
   *   - adopt: new library instance whose id IS this uuid (then claim
   *     hardware via the normal define flow);
   *   - alias: an existing device additionally answers to this uuid
   *     (DeviceInstance.knownAs).
   */
  private renderGhostCard(deviceId: string) {
    const ghost = ghostScan.ghost(deviceId);
    if (!ghost) return nothing;
    this.anchorAboveMonitor();
    const candidates = appState.local.midi.library.filter(i => !i.deleted);
    return html`
      <div class="head">
        <span class="title">Unknown device · ${deviceId.slice(0, 8)}…</span>
        <span class="count">${ghost.wireCount} wires · ${ghost.sketchCount}
          sketch${ghost.sketchCount === 1 ? '' : 'es'}</span>
      </div>
      <div class="ghost-hint">
        Wires in this composition map ${ghost.controls.length}
        control${ghost.controls.length === 1 ? '' : 's'} of a device this
        library doesn't know. Adopt it (no wires are modified):
      </div>
      <div class="ghost-actions">
        ${allDeviceTemplates().map(t => html`
          <button class="ghost-btn"
            title="Create a new ${t.name} whose id is this device's uuid — its wires go live once you define hardware for it"
            @click=${() => {
              const inst = midiController.adoptGhost(deviceId, t.templateId);
              devicesUi.selectCard(inst.id);
            }}>Adopt as new ${t.name}</button>
        `)}
        ${candidates.map(i => html`
          <button class="ghost-btn"
            title="Add this uuid to ${i.name}'s known-as aliases — its wires read ${i.name}'s values from now on"
            @click=${() => {
              midiController.addKnownAs(i.id, deviceId);
              devicesUi.selectCard(i.id);
            }}>This is my «${i.name}»</button>
        `)}
      </div>
      <div class="ghost-controls">
        ${ghost.controls.map(c => html`
          <span class="ghost-control">${c.controlId}
            <span class="ghost-gestures">${c.gestures.join('/')}</span></span>
        `)}
      </div>
      <device-wires-panel .deviceId=${deviceId} .controlIds=${null}></device-wires-panel>
    `;
  }

  render() {
    const content = this.renderContent();
    this.toggleAttribute('data-empty', content === nothing);
    return content;
  }

  private renderContent() {
    const selection = devicesUi.selectedControls;
    if (selection.length === 0) return this.renderDeviceCard();
    const primary = selection[0];
    const instance = midiController.instance(primary.deviceId);
    const template = getDeviceTemplate(instance?.templateId ?? primary.deviceId);
    if (!template) return nothing;
    const def = template.layout.controls.find(c => c.id === primary.controlId);
    const deviceName = instance?.name ?? template.name;
    this.anchorAboveMonitor();
    // The wires panel scopes to the selected controls of the PRIMARY device
    // (cross-device multi-selections edit mappings per device group above,
    // but one wires list keeps the panel readable).
    const controlIds = selection
      .filter(s => s.deviceId === primary.deviceId)
      .map(s => s.controlId);

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
      <div class="wires-head">Wires</div>
      <device-wires-panel .deviceId=${primary.deviceId} .controlIds=${controlIds}></device-wires-panel>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-control-details': DeviceControlDetails;
  }
}
