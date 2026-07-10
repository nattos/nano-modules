/**
 * <device-slider> / <device-button> — the rest of the standard control set
 * for device surfaces (MFT uses only encoders; other layouts use these).
 * Same contracts as <device-encoder>: imperative `setLive()`, and
 * 'control-drag' / 'control-drag-end' / 'control-click' events resolved from
 * pointer gestures. See device-encoder.ts for the rationale.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { CancelReason, PointerDragOp } from '../../utils/pointer-drag-op';

const DRAG_RANGE_PX = 160;

abstract class DeviceControlBase extends MobxLitElement {
  @property() declare label: string;
  @property({ type: Boolean, reflect: true }) declare selected: boolean;
  @property({ type: Boolean }) declare interactive: boolean;

  protected lastValue = -1;
  protected lastPressed = false;
  private dragOp: PointerDragOp | null = null;
  private dragStartValue = 0;
  private dragged = false;

  constructor() {
    super();
    this.label = '';
    this.selected = false;
    this.interactive = true;
  }

  abstract setLive(value: number, pressed: boolean): void;
  get liveValue(): number { return Math.max(0, this.lastValue); }

  /** Buttons hold a momentary 1 while the pointer is down instead of dragging. */
  protected momentary = false;

  protected onPointerDown(e: PointerEvent) {
    if (!this.interactive || appState.local.tappingMode || e.button !== 0) return;
    e.stopPropagation();
    this.dragStartValue = this.liveValue;
    this.dragged = false;
    if (this.momentary) {
      this.dispatchEvent(new CustomEvent('control-drag', {
        detail: { value: 1 }, bubbles: true, composed: true,
      }));
    }
    this.dragOp = new PointerDragOp(e, this, {
      threshold: this.momentary ? 10000 : 3,   // buttons never enter drag mode
      move: (ev, delta) => {
        this.dragged = true;
        const sens = ev.shiftKey ? 0.25 : 1;
        const value = this.dragStartValue - (delta[1] / DRAG_RANGE_PX) * sens;
        this.dispatchEvent(new CustomEvent('control-drag', {
          detail: { value: Math.min(1, Math.max(0, value)) }, bubbles: true, composed: true,
        }));
      },
      accept: () => this.endGesture(e),
      cancel: reason => {
        if (reason === CancelReason.NoChange) this.endGesture(e);
      },
      complete: () => { this.dragOp = null; },
    });
  }

  private endGesture(down: PointerEvent) {
    if (this.momentary) {
      this.dispatchEvent(new CustomEvent('control-drag', {
        detail: { value: 0 }, bubbles: true, composed: true,
      }));
      this.dispatchEvent(new CustomEvent('control-drag-end', {
        detail: {}, bubbles: true, composed: true,
      }));
      this.dispatchEvent(new CustomEvent('control-click', {
        detail: { additive: down.metaKey || down.ctrlKey, range: down.shiftKey },
        bubbles: true, composed: true,
      }));
      return;
    }
    if (this.dragged) {
      this.dispatchEvent(new CustomEvent('control-drag-end', {
        detail: {}, bubbles: true, composed: true,
      }));
    } else {
      this.dispatchEvent(new CustomEvent('control-click', {
        detail: { additive: down.metaKey || down.ctrlKey, range: down.shiftKey },
        bubbles: true, composed: true,
      }));
    }
  }
}

@customElement('device-slider')
export class DeviceSlider extends DeviceControlBase {
  @query('.fill') private declare fill: HTMLElement;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      cursor: ns-resize;
      position: relative;
    }
    :host(:not([interactive])) { cursor: default; }
    .track {
      flex: 1;
      position: relative;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
      margin: 0 auto;
      width: 38%;
      overflow: hidden;
    }
    :host([selected]) .track { border-color: var(--app-hi-color2); }
    .fill {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 0%;
      background: var(--app-io-input);
      opacity: 0.6;
    }
    .label {
      text-align: center;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      user-select: none;
    }
  `;

  setLive(value: number, _pressed: boolean): void {
    const v = Math.min(1, Math.max(0, value));
    if (v === this.lastValue || !this.fill) return;
    this.lastValue = v;
    this.fill.style.height = `${(v * 100).toFixed(1)}%`;
  }

  render() {
    return html`
      <div class="track" @pointerdown=${this.onPointerDown}><div class="fill"></div></div>
      ${this.label ? html`<div class="label">${this.label}</div>` : nothing}
    `;
  }

  updated() {
    const v = this.lastValue;
    this.lastValue = -1;
    this.setLive(Math.max(0, v), false);
  }
}

@customElement('device-button')
export class DeviceButton extends DeviceControlBase {
  @query('.pad') private declare pad: HTMLElement;

  constructor() {
    super();
    this.momentary = true;
  }

  static styles = css`
    :host { display: block; cursor: pointer; position: relative; }
    :host(:not([interactive])) { cursor: default; }
    .pad {
      width: 100%; height: 100%;
      box-sizing: border-box;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
      background: var(--app-tint-1);
    }
    :host([selected]) .pad { border-color: var(--app-hi-color2); }
    .pad.on { background: var(--app-io-input); opacity: 0.8; }
    .label {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      pointer-events: none;
      user-select: none;
    }
  `;

  setLive(value: number, pressed: boolean): void {
    const on = pressed || value >= 0.5;
    if (on === this.lastPressed || !this.pad) return;
    this.lastPressed = on;
    this.pad.classList.toggle('on', on);
  }

  render() {
    return html`
      <div class="pad" @pointerdown=${this.onPointerDown}></div>
      ${this.label ? html`<div class="label">${this.label}</div>` : nothing}
    `;
  }

  updated() {
    const p = this.lastPressed;
    this.lastPressed = false;
    this.setLive(0, p);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-slider': DeviceSlider;
    'device-button': DeviceButton;
  }
}
