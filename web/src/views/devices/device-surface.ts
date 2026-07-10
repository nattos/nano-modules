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
import type { ControlGesture, DeviceControlDef, DeviceTemplate } from '../../midi/midi-types';
import type { FieldConnectInfo } from '../../sketch-types';
import { tapsConnect, WireConnect } from '../../widgets/taps-connect';
import { DeviceAnchorKeys, setDeviceAnchor } from './device-anchors';
import { devicesUi } from './devices-ui';

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

    /* --- W wire-mode hit zones (sources) --- */
    /* Same visual language as column-group's tap ports, output-colored (a
       device control is always a wire SOURCE). Stacked above the widgets so
       they own the pointer while wire mode is on. */
    .tap-overlay-hit {
      position: absolute;
      z-index: 3;
      box-sizing: border-box;
      border: 1px dashed var(--app-io-output, #ff8c00);
      background: rgba(255, 140, 0, 0.07);
      cursor: crosshair;
    }
    .tap-overlay-hit:hover,
    .tap-overlay-hit[tap-drop-target] {
      border-style: solid;
      background: rgba(255, 140, 0, 0.18);
    }
    .hit-turn { border-radius: 50%; }
    .hit-press {
      border-radius: 50%;
      background: rgba(255, 140, 0, 0.12);
    }
    .hit-shift {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px; height: 14px;
      font-size: 9px;
      line-height: 1;
      color: var(--app-io-output, #ff8c00);
      background: var(--app-bg-color2);
      border-radius: 50%;
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

  // --- W wire-mode hit zones ---

  private connectInfo(endpoint: string, el: HTMLElement): FieldConnectInfo {
    const r = el.getBoundingClientRect();
    return {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: true,
      viewportY: r.top + r.height / 2, schemaDef: null,
      deviceControl: { deviceInstanceId: this.deviceId, controlId: endpoint },
    };
  }

  private onHitPointerDown(e: PointerEvent, endpoint: string) {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    tapsConnect.beginFromFieldDrag(
      e, el, '', `device/${this.deviceId}/${endpoint}`, this.connectInfo(endpoint, el));
  }

  private onHitClick(e: MouseEvent, endpoint: string) {
    e.stopPropagation();
    if (tapsConnect.consumeClickSuppression()) return;
    // A gesture in flight completes here (the device is the writer);
    // otherwise the click PICKS UP this control as the source.
    if (WireConnect.active) {
      WireConnect.active.completeOnDeviceControl(this.deviceId, endpoint);
      return;
    }
    const el = e.currentTarget as HTMLElement;
    tapsConnect.beginFromFieldClick(
      '', `device/${this.deviceId}/${endpoint}`, this.connectInfo(endpoint, el));
  }

  /** Hit zones for one control: turn = the dial annulus, press = the center
   *  disc, shift = a small satellite pip at the cell's top-right. */
  private renderHitZones(def: DeviceControlDef) {
    const zones = [];
    const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
    const mk = (gesture: ControlGesture, cls: string, style: string, label = '') => {
      const endpoint = `${def.id}/${gesture}`;
      return html`
        <div class="tap-overlay-hit ${cls}" style=${style}
          data-endpoint=${endpoint}
          data-device-instance=${this.deviceId}
          data-device-control=${endpoint}
          title="${def.id} · ${gesture}"
          @pointerdown=${(e: PointerEvent) => this.onHitPointerDown(e, endpoint)}
          @click=${(e: MouseEvent) => this.onHitClick(e, endpoint)}
        >${label}</div>`;
    };
    for (const gesture of def.gestures) {
      switch (gesture) {
        case 'turn':
          zones.push(mk('turn', 'hit-turn',
            `left:${pct(def.x)}; top:${pct(def.y)}; width:${pct(def.w)}; height:${pct(def.h)};`));
          break;
        case 'press':
          zones.push(mk('press', 'hit-press',
            `left:${pct(def.x + def.w * 0.28)}; top:${pct(def.y + def.h * 0.28)}; ` +
            `width:${pct(def.w * 0.44)}; height:${pct(def.h * 0.44)};`));
          break;
        case 'shift':
          zones.push(mk('shift', 'hit-shift',
            `left: calc(${pct(def.x + def.w)} - 8px); top: calc(${pct(def.y)} - 6px);`, '⇧'));
          break;
      }
    }
    return zones;
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
        ${this.interactive && appState.local.tappingMode
          ? this.shownControls().map(def => this.renderHitZones(def))
          : nothing}
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
    // Register the W-mode hit zones as wire anchors (self-pruning rects).
    for (const el of this.renderRoot.querySelectorAll('[data-endpoint]')) {
      setDeviceAnchor(
        DeviceAnchorKeys.control(this.deviceId, el.getAttribute('data-endpoint')!), el);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-surface': DeviceSurface;
  }
}
