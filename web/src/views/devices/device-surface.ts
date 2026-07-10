/**
 * <device-surface> — the generic, data-driven device layout renderer.
 *
 * The template supplies a `DeviceLayout` (normalized 0..1 control positions +
 * kinds + banks); this component owns only positioning, the standard control
 * widgets, and the interaction plumbing — a new device model is pure data.
 *
 * Live values: ONE rAF loop per surface polls the MidiManager's merged
 * live+sim table (deliberately outside MobX — see midi-manager.ts) and pushes
 * into the child widgets imperatively via `setLive()`.
 *
 * Interactions (outside W wire mode):
 *   drag       → simulate the control's value (MidiManager sim layer). On
 *                release: connected device → clear (snap back to hardware);
 *                disconnected → leave sticky (session-only).
 *   click      → select the control (details panel); cmd/ctrl toggles,
 *                shift extends an ordinal range within the shown bank.
 *   bank pips  → switch which bank is SHOWN (values for all banks persist).
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { midiController } from '../../state/midi-controller';
import { getDeviceTemplate } from '../../midi/device-registry';
import type { DeviceControlDef, DeviceTemplate } from '../../midi/midi-types';
import { devicesUi } from './devices-ui';
import type { DeviceEncoder } from './device-encoder';

import './device-encoder';
import './device-slider';
import './device-bank-switcher';

interface LiveWidget extends HTMLElement {
  setLive(value: number, pressed: boolean): void;
}

/** Device color values are the MFT-style 0..127 hue wheel. */
export function deviceColorCss(v: number | undefined, fallback: string): string {
  if (v === undefined) return fallback;
  return `hsl(${Math.round((v / 127) * 330)}, 75%, 55%)`;
}

@customElement('device-surface')
export class DeviceSurface extends MobxLitElement {
  /** Instance uuid or template id (templates render their factory state). */
  @property() declare deviceId: string;
  @property({ type: Boolean }) declare interactive: boolean;

  constructor() {
    super();
    this.deviceId = '';
    this.interactive = true;
  }

  static styles = css`
    :host { display: block; position: relative; }
    .body {
      position: relative;
      width: 100%;
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      background: var(--app-bg-color1);
    }
    .control { position: absolute; }
    .banks {
      position: absolute;
      right: 2px;
      bottom: 2px;
      z-index: 2;
    }
  `;

  private raf = 0;
  private widgets = new Map<string, LiveWidget>();

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.pushLiveValues();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }

  private template(): DeviceTemplate | undefined {
    const instance = midiController.instance(this.deviceId);
    return getDeviceTemplate(instance?.templateId ?? this.deviceId);
  }

  private config(): unknown {
    const instance = midiController.instance(this.deviceId);
    return instance?.config ?? this.template()?.defaultConfig;
  }

  private pushLiveValues() {
    if (this.widgets.size === 0) return;
    const values = midiController.manager.getValues(this.deviceId);
    for (const [controlId, widget] of this.widgets) {
      widget.setLive(
        values.get(`${controlId}/turn`) ?? 0,
        (values.get(`${controlId}/press`) ?? 0) >= 0.5);
    }
  }

  // --- Simulation + selection ---

  private simGesture(def: DeviceControlDef): 'turn' | 'press' {
    return def.kind === 'button' || def.kind === 'pad' ? 'press' : 'turn';
  }

  private onDrag(def: DeviceControlDef, value: number) {
    midiController.manager.setSimulatedValue(
      this.deviceId, `${def.id}/${this.simGesture(def)}`, value);
  }

  private onDragEnd(def: DeviceControlDef) {
    // Connected → snap back to the hardware's real value; disconnected →
    // sticky (session-only; never persisted on the instance).
    if (appState.local.midi.connected[this.deviceId]) {
      midiController.manager.setSimulatedValue(
        this.deviceId, `${def.id}/${this.simGesture(def)}`, null);
    }
  }

  private onClick(def: DeviceControlDef, detail: { additive: boolean; range: boolean }) {
    if (detail.range && devicesUi.selectedControls.length > 0) {
      // Ordinal range within the shown bank, anchored on the primary.
      const shown = this.shownControls();
      const primary = devicesUi.selectedControls[0];
      const from = primary.deviceId === this.deviceId
        ? shown.findIndex(c => c.id === primary.controlId) : -1;
      const to = shown.findIndex(c => c.id === def.id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        const span = shown.slice(lo, hi + 1).map(c => ({ deviceId: this.deviceId, controlId: c.id }));
        // Keep the primary first so relative-shift edits anchor on it.
        span.sort((a, b) => (a.controlId === primary.controlId ? -1 : b.controlId === primary.controlId ? 1 : 0));
        devicesUi.selectControls(span);
        return;
      }
    }
    devicesUi.selectControl(this.deviceId, def.id, { additive: detail.additive });
  }

  private shownControls(): DeviceControlDef[] {
    const template = this.template();
    if (!template) return [];
    const bank = devicesUi.bankFor(this.deviceId);
    return template.layout.controls.filter(c => c.bank === undefined || c.bank === bank);
  }

  // --- Render ---

  private renderControl(def: DeviceControlDef) {
    const template = this.template()!;
    const mapping = template.mapping.get(this.config() as never, `${def.id}/turn`);
    const selected = devicesUi.isControlSelected(this.deviceId, def.id);
    const style = `left:${def.x * 100}%; top:${def.y * 100}%; width:${def.w * 100}%; height:${def.h * 100}%;`;
    const common = {
      style,
      controlId: def.id,
    };
    const events = {
      onDrag: (e: CustomEvent) => this.onDrag(def, e.detail.value),
      onDragEnd: () => this.onDragEnd(def),
      onClick: (e: CustomEvent) => this.onClick(def, e.detail),
    };
    switch (def.kind) {
      case 'encoder':
        return html`
          <device-encoder class="control" style=${common.style}
            data-control-id=${def.id}
            .label=${def.label ?? ''}
            .ringColor=${deviceColorCss(mapping?.ringColor, 'var(--app-io-input)')}
            .capColor=${deviceColorCss(mapping?.capColor, 'var(--app-tint-3)')}
            .interactive=${this.interactive}
            ?selected=${selected}
            @control-drag=${events.onDrag}
            @control-drag-end=${events.onDragEnd}
            @control-click=${events.onClick}
          ></device-encoder>`;
      case 'slider':
        return html`
          <device-slider class="control" style=${common.style}
            data-control-id=${def.id}
            .label=${def.label ?? ''}
            .interactive=${this.interactive}
            ?selected=${selected}
            @control-drag=${events.onDrag}
            @control-drag-end=${events.onDragEnd}
            @control-click=${events.onClick}
          ></device-slider>`;
      case 'button':
      case 'pad':
        return html`
          <device-button class="control" style=${common.style}
            data-control-id=${def.id}
            .label=${def.label ?? ''}
            .interactive=${this.interactive}
            ?selected=${selected}
            @control-drag=${events.onDrag}
            @control-drag-end=${events.onDragEnd}
            @control-click=${events.onClick}
          ></device-button>`;
    }
  }

  render() {
    const template = this.template();
    if (!template) return nothing;
    const { layout } = template;
    const shownBank = devicesUi.bankFor(this.deviceId);
    const hwBank = appState.local.midi.connected[this.deviceId]
      ? (appState.local.midi.activeBanks[this.deviceId] ?? 0) : -1;
    return html`
      <div class="body" style="aspect-ratio: ${layout.aspect}"
        @click=${(e: Event) => {
          // Control clicks select controls; don't also toggle the card —
          // EXCEPT in define mode, where any click means "fork this".
          if (!devicesUi.defineMode) e.stopPropagation();
        }}>
        ${this.shownControls().map(def => this.renderControl(def))}
        ${layout.banks > 1 ? html`
          <device-bank-switcher class="banks"
            .banks=${layout.banks}
            .active=${shownBank}
            .hardware=${hwBank}
            @bank-select=${(e: CustomEvent) => devicesUi.setBank(this.deviceId, e.detail.bank)}
          ></device-bank-switcher>` : nothing}
      </div>
    `;
  }

  updated() {
    this.widgets.clear();
    for (const el of this.renderRoot.querySelectorAll<LiveWidget & Element>('[data-control-id]')) {
      this.widgets.set(el.getAttribute('data-control-id')!, el as LiveWidget);
    }
    this.pushLiveValues();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-surface': DeviceSurface;
  }
}
