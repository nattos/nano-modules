/**
 * <arr-chain> — a prototype effect chain in the inspector, styled like the
 * sketch IDE's column-group cards. Renders a clip/track sketch's devices as a
 * vertical stack of cards with category dots, a bypass toggle, and real
 * <scalar-slider> params driven by a FakeBinding. Lets us feel what hosting an
 * effect chain in the right panel is like before wiring the real engine.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { Device, ClipSketch, deviceProcessesTexture } from '../model/composition';
import { categoryColor, effectDomain } from '../../../widgets/category-color';
import { fakeParamsFor, FakeBinding, FakeParam } from './fake-binding';
import { setAnchor, AnchorKeys } from './anchor-registry';
import { store } from '../state/store';
import '../../../widgets/scalar-slider';
import '../../../widgets/ui-icon';

export interface FieldWire {
  wireId: string;
  dir: 'in' | 'out';
  label: string;
  clipPath: string;
  target: { field?: string };
}

@customElement('arr-chain')
export class ArrChain extends MobxLitElement {
  /** The sketch whose devices form the chain. */
  @property({ attribute: false }) sketch!: ClipSketch;
  /** When true, offer an "add source" action (empty clip → video clip). */
  @property({ type: Boolean }) allowSource = false;
  /** Callback to add a device (host decides where). */
  @property({ attribute: false }) onAdd?: (kind: 'source' | 'effect') => void;
  /** Fields (per device id) a rail read targets — ensures a slider exists to
      anchor the wire to, even if not in the synthesized param set. */
  @property({ attribute: false }) highlightFields: Record<string, string[]> = {};
  /** Wired fields keyed by `deviceId:field` → pip metadata. */
  @property({ attribute: false }) fieldWires: Record<string, FieldWire> = {};

  updated() {
    // Register each wired field's pip as the wire anchor.
    this.shadowRoot?.querySelectorAll('.fpip[data-anchor-field]').forEach((el) => {
      const dev = el.getAttribute('data-anchor-dev') ?? '';
      const field = el.getAttribute('data-anchor-field') ?? '';
      setAnchor(AnchorKeys.field(dev, field), el);
    });
  }

  private onPipDown(e: PointerEvent, wire: FieldWire) {
    e.stopPropagation();
    store.selectWire(wire.wireId, wire.clipPath, wire.target);
    store.openTapPopup({ wireId: wire.wireId, x: e.clientX + 8, y: e.clientY + 8, label: wire.label });
  }

  static styles = css`
    :host {
      display: block;
    }
    .card {
      border: 1px solid var(--app-tint-3);
      border-radius: 3px;
      background: var(--app-bg-color1);
      margin-bottom: var(--app-sp-3);
      overflow: hidden;
    }
    .card.bypassed .params {
      opacity: 0.4;
    }
    .chead {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 7px;
      background: var(--app-bg-color2);
      border-bottom: 1px solid var(--app-tint-2);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .cname {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cmod {
      font-size: 8px;
      color: var(--app-cat-mod);
      border: 1px solid var(--app-cat-mod);
      border-radius: 2px;
      padding: 0 3px;
    }
    .cbypass {
      background: none;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      color: var(--app-text-color2);
      cursor: pointer;
      width: 18px;
      height: 16px;
      --icon-size: 10px;
      padding: 0;
    }
    .cbypass.on {
      border-color: var(--app-error);
      color: var(--app-error);
    }
    .params {
      padding: 5px 7px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .frow {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .frow scalar-slider {
      flex: 1;
      min-width: 0;
      display: block;
    }
    .fpip {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      cursor: pointer;
      border: 1px solid var(--app-bg-color1);
    }
    .fpip.in {
      background: var(--app-io-input);
    }
    .fpip.out {
      background: var(--app-io-output);
    }
    .fpip-empty {
      width: 8px;
      flex-shrink: 0;
    }
    .empty {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      opacity: 0.6;
      padding: 4px 0;
    }
    .add {
      display: flex;
      gap: var(--app-sp-3);
    }
    .add button {
      flex: 1;
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px dashed var(--app-tint-4);
      border-radius: 2px;
      padding: 5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      --icon-size: 11px;
    }
    .add button:hover {
      color: var(--app-text-color1);
      border-color: var(--app-tint-5);
    }
  `;

  render() {
    const devices = this.sketch?.devices ?? [];
    return html`
      ${devices.length === 0
        ? html`<div class="empty">Empty chain — add a device.</div>`
        : devices.map((d) => this.renderCard(d))}
      <div class="add">
        ${this.allowSource
          ? html`<button @click=${() => this.onAdd?.('source')}>
              <ui-icon icon="la-video"></ui-icon> add source
            </button>`
          : ''}
        <button @click=${() => this.onAdd?.('effect')}>
          <ui-icon icon="la-plus"></ui-icon> add effect
        </button>
      </div>
    `;
  }

  private renderCard(device: Device) {
    const accent = categoryColor(effectDomain(device.moduleType));
    const params = fakeParamsFor(device);
    // Ensure any rail-read target fields exist as sliders to anchor wires to.
    for (const f of this.highlightFields[device.id] ?? []) {
      if (!params.some((p) => p.path === f)) {
        const extra: FakeParam = { path: f, label: f, min: 0, max: 1, step: 0.01, defaultValue: 0.5 };
        params.push(extra);
      }
    }
    const binding = new FakeBinding(device, params);
    const st = (device.state ?? {}) as Record<string, any>;
    const bypassed = !!st.__bypass;
    const isMod = !deviceProcessesTexture(device);
    return html`
      <div class="card ${bypassed ? 'bypassed' : ''}">
        <div class="chead">
          <span class="dot" style="background:${accent}"></span>
          <span class="cname" title=${device.moduleType}>${device.name}</span>
          ${isMod ? html`<span class="cmod">mod</span>` : ''}
          <button
            class="cbypass ${bypassed ? 'on' : ''}"
            title="Bypass device"
            @click=${() => {
              if (!device.state) device.state = {};
              (device.state as any).__bypass = !bypassed;
              this.requestUpdate();
            }}
          >
            <ui-icon icon="la-power-off"></ui-icon>
          </button>
        </div>
        <div class="params">
          ${params.map((p) => {
            const wire = this.fieldWires[`${device.id}:${p.path}`];
            return html`<div class="frow">
              ${wire
                ? html`<span
                    class="fpip ${wire.dir}"
                    title="${wire.label}"
                    data-anchor-dev=${device.id}
                    data-anchor-field=${p.path}
                    @pointerdown=${(e: PointerEvent) => this.onPipDown(e, wire)}
                  ></span>`
                : html`<span class="fpip-empty"></span>`}
              <scalar-slider
                .fieldPath=${p.path}
                .label=${p.label}
                .min=${p.min}
                .max=${p.max}
                .step=${p.step}
                .defaultValue=${p.defaultValue}
                .binding=${binding}
              ></scalar-slider>
            </div>`;
          })}
        </div>
      </div>
    `;
  }
}
