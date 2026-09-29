/**
 * <arr-device-lane> — a MIDI controller's lane in a device row: the SHOWN
 * bank's controls laid out in a strip (row-major from the template layout),
 * using the Devices tab's widgets.
 *
 *   - Live values: one rAF loop pushes the MidiManager's merged live+sim table
 *     into the widgets (outside MobX, as <device-surface> does).
 *   - Dragging a control simulates it (released: a connected device snaps
 *     back to the hardware, a disconnected one keeps the value).
 *   - In W mode (or while any connect gesture is in flight) every gesture of
 *     every control wears the output mask and is a wire SOURCE: drag it onto
 *     an input field (or a track's fader), or click to pick it up. A gesture
 *     started elsewhere completes on a click here.
 *   - Each mask registers `AnchorKeys.deviceControl` so <arr-overlay> can
 *     draw the device's wires from it.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { appState } from '../../../state/app-state';
import { midiController } from '../../../state/midi-controller';
import { getDeviceTemplate } from '../../../midi/device-registry';
import type { ControlGesture, DeviceControlDef, DeviceTemplate } from '../../../midi/midi-types';
import type { FieldConnectInfo } from '../../../sketch-types';
import { WireConnect, connectGestureActive } from '../../../widgets/taps-connect';
import { tapHitStyles } from '../../../widgets/tap-hit-styles';
import { devicesUi } from '../../devices/devices-ui';
import { deviceColorCss } from '../../devices/device-surface';
import { store } from '../state/store';
import { setAnchor, AnchorKeys } from './anchor-registry';
import { portConnect } from './arr-io';

import '../../devices/device-encoder';
import '../../devices/device-slider';

interface LiveWidget extends HTMLElement {
  setLive(value: number, pressed: boolean): void;
}

@customElement('arr-device-lane')
export class ArrDeviceLane extends MobxLitElement {
  @property({ attribute: false }) placementId = '';

  static styles = [tapHitStyles, css`
    :host {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px;
      overflow: hidden;
    }
    .banks { display: flex; flex-direction: column; gap: 2px; flex: 0 0 auto; }
    .banks button {
      width: 16px; height: 11px; padding: 0; font-size: 8px; line-height: 1;
      border: 1px solid var(--app-tint-3); border-radius: 2px; cursor: pointer;
      background: none; color: var(--app-text-color2);
    }
    .banks button.on { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    .banks button.hw { box-shadow: inset 0 -2px 0 var(--app-cat-source, #57b47a); }
    .cell {
      position: relative;
      flex: 0 0 auto;
      width: 38px;
      height: 44px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .cell .control { width: 34px; height: 34px; }
    .cell .idx {
      font-size: 8px; line-height: 10px; color: var(--app-text-color2);
      max-width: 38px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tap-overlay-hit { z-index: 3; cursor: crosshair; }
    .hit-turn { left: 2px; top: 0; width: 34px; height: 34px; border-radius: 50%; }
    .hit-turn.linear { border-radius: 2px; }
    .hit-press { left: 12px; top: 10px; width: 14px; height: 14px; border-radius: 50%; }
    .hit-shift {
      right: -4px; top: -3px; width: 12px; height: 12px; border-radius: 50%;
      font-size: 8px; line-height: 12px; text-align: center; color: var(--app-text-color1);
    }
    .missing {
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      font-style: italic;
    }
  `];

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

  private get deviceId(): string {
    return store.devicePlacements.find((p) => p.id === this.placementId)?.deviceId ?? '';
  }

  private template(): DeviceTemplate | undefined {
    const p = store.devicePlacements.find((x) => x.id === this.placementId);
    if (!p) return undefined;
    const inst = midiController.instance(p.deviceId);
    return getDeviceTemplate(inst?.templateId ?? p.templateId ?? '');
  }

  private shownControls(t: DeviceTemplate): DeviceControlDef[] {
    const bank = devicesUi.bankFor(this.deviceId);
    return t.layout.controls
      .filter((c) => c.bank === undefined || c.bank === bank)
      .slice()
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  private pushLiveValues() {
    if (this.widgets.size === 0) return;
    const values = midiController.manager.getValues(this.deviceId);
    for (const [controlId, w] of this.widgets) {
      w.setLive(values.get(`${controlId}/turn`) ?? 0, (values.get(`${controlId}/press`) ?? 0) >= 0.5);
    }
  }

  // ── Simulation ──────────────────────────────────────────────────────────

  private simGesture(def: DeviceControlDef): 'turn' | 'press' {
    return def.kind === 'button' || def.kind === 'pad' ? 'press' : 'turn';
  }

  private onDrag(def: DeviceControlDef, value: number) {
    midiController.manager.setSimulatedValue(this.deviceId, `${def.id}/${this.simGesture(def)}`, value);
  }

  private onDragEnd(def: DeviceControlDef) {
    if (appState.local.midi.connected[this.deviceId]) {
      midiController.manager.setSimulatedValue(this.deviceId, `${def.id}/${this.simGesture(def)}`, null);
    }
  }

  // ── Wire gestures (the device is always the writer) ────────────────────

  private connectInfo(endpoint: string, el: HTMLElement): FieldConnectInfo {
    const r = el.getBoundingClientRect();
    return {
      sketchId: '', colIdx: -1, chainIdx: -1, fieldPath: '', isOutput: true,
      viewportY: r.top + r.height / 2, schemaDef: null,
      deviceControl: { deviceInstanceId: this.deviceId, controlId: endpoint },
    };
  }

  private eatClick = false;

  private onHitDown(e: PointerEvent, endpoint: string) {
    e.stopPropagation();
    this.eatClick = false;
    // A gesture in flight (e.g. picked up from a field) completes here.
    if (WireConnect.active) {
      e.preventDefault();
      WireConnect.active.completeOnDeviceControl(this.deviceId, endpoint);
      this.eatClick = true;
      return;
    }
    const el = e.currentTarget as HTMLElement;
    portConnect.beginFromFieldDrag(e, el, '', `device/${this.deviceId}/${endpoint}`,
      this.connectInfo(endpoint, el));
  }

  private onHitClick(e: MouseEvent, endpoint: string) {
    e.stopPropagation();
    if (portConnect.consumeClickSuppression()) return;
    if (this.eatClick) { this.eatClick = false; return; }
    const el = e.currentTarget as HTMLElement;
    const info = this.connectInfo(endpoint, el);
    portConnect.beginFromFieldClick('', `device/${this.deviceId}/${endpoint}`, info);
    const r = el.getBoundingClientRect();
    if (portConnect.state) {
      portConnect.state.pointerX = (r.left + r.right) / 2;
      portConnect.state.pointerY = (r.top + r.bottom) / 2;
    }
  }

  private renderMask(def: DeviceControlDef, gesture: ControlGesture) {
    const endpoint = `${def.id}/${gesture}`;
    const cls = gesture === 'turn' ? `hit-turn ${def.kind === 'slider' ? 'linear' : ''}`
      : gesture === 'press' ? 'hit-press' : 'hit-shift';
    return html`<span class="tap-overlay-hit output ${cls}"
      data-device-instance=${this.deviceId}
      data-device-control=${endpoint}
      data-endpoint=${endpoint}
      title="${def.label ?? def.id} · ${gesture}"
      @pointerdown=${(e: PointerEvent) => this.onHitDown(e, endpoint)}
      @click=${(e: MouseEvent) => this.onHitClick(e, endpoint)}
    >${gesture === 'shift' ? '⇧' : ''}</span>`;
  }

  private renderControl(t: DeviceTemplate, def: DeviceControlDef, masks: boolean) {
    const inst = midiController.instance(this.deviceId);
    const mapping = t.mapping.get((inst?.config ?? t.defaultConfig) as never, `${def.id}/turn`);
    const onDrag = (e: CustomEvent) => this.onDrag(def, e.detail.value);
    const onEnd = () => this.onDragEnd(def);
    const widget = def.kind === 'encoder'
      ? html`<device-encoder class="control" data-control-id=${def.id}
          .label=${''} .interactive=${true}
          .ringColor=${deviceColorCss(mapping?.ringColor, 'var(--app-io-input)')}
          .capColor=${deviceColorCss(mapping?.capColor, 'var(--app-tint-3)')}
          @control-drag=${onDrag} @control-drag-end=${onEnd}></device-encoder>`
      : def.kind === 'slider'
        ? html`<device-slider class="control" data-control-id=${def.id}
            .label=${''} .interactive=${true}
            @control-drag=${onDrag} @control-drag-end=${onEnd}></device-slider>`
        : html`<device-button class="control" data-control-id=${def.id}
            .label=${''} .interactive=${true}
            @control-drag=${onDrag} @control-drag-end=${onEnd}></device-button>`;
    return html`<div class="cell" data-control=${def.id}>
      ${widget}
      <span class="idx">${def.label ?? def.id.replace(/^b\d+\//, '')}</span>
      ${masks ? def.gestures.map((g) => this.renderMask(def, g)) : nothing}
    </div>`;
  }

  render() {
    const t = this.template();
    const p = store.devicePlacements.find((x) => x.id === this.placementId);
    if (!p) return nothing;
    if (!t || !midiController.instance(p.deviceId)) {
      return html`<span class="missing">${p.label ?? 'This device'} isn’t in this machine’s library — its wires are inert.</span>`;
    }
    const masks = store.wiresMode || connectGestureActive();
    const bank = devicesUi.bankFor(p.deviceId);
    const hw = appState.local.midi.connected[p.deviceId]
      ? (appState.local.midi.activeBanks[p.deviceId] ?? 0) : -1;
    const banks = t.layout.banks > 1
      ? html`<div class="banks">${Array.from({ length: t.layout.banks }, (_, i) => html`
          <button class="${i === bank ? 'on' : ''} ${i === hw ? 'hw' : ''}" title="Bank ${i + 1}"
            @pointerdown=${(e: Event) => { e.stopPropagation(); devicesUi.setBank(p.deviceId, i); }}
          >${i + 1}</button>`)}</div>`
      : nothing;
    return html`${banks}${this.shownControls(t).map((def) => this.renderControl(t, def, masks))}`;
  }

  updated() {
    // Widgets for the live-value loop, and control anchors for the overlay.
    this.widgets.clear();
    for (const el of this.renderRoot.querySelectorAll<HTMLElement>('.control[data-control-id]')) {
      this.widgets.set(el.dataset.controlId!, el as unknown as LiveWidget);
    }
    const id = this.deviceId;
    for (const cell of this.renderRoot.querySelectorAll<HTMLElement>('.cell[data-control]')) {
      const control = cell.querySelector('.control');
      for (const g of ['turn', 'press', 'shift'] as const) {
        const mask = cell.querySelector<HTMLElement>(`.tap-overlay-hit[data-endpoint="${cell.dataset.control}/${g}"]`);
        setAnchor(AnchorKeys.deviceControl(id, `${cell.dataset.control}/${g}`), mask ?? control);
      }
    }
  }
}
