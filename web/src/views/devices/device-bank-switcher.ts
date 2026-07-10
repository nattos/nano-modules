/**
 * <device-bank-switcher> — the `1 2 3 4` micro-buttons floating at a device
 * card's bottom-right. Switches which bank the surface SHOWS (UI view state
 * in devicesUi); a dot marks the bank the hardware itself last reported.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';

@customElement('device-bank-switcher')
export class DeviceBankSwitcher extends MobxLitElement {
  @property({ type: Number }) declare banks: number;
  @property({ type: Number }) declare active: number;
  /** The hardware's live bank (-1 when unknown/disconnected). */
  @property({ type: Number }) declare hardware: number;

  constructor() {
    super();
    this.banks = 1;
    this.active = 0;
    this.hardware = -1;
  }

  static styles = css`
    :host { display: flex; gap: 3px; }
    button {
      font: inherit;
      font-size: var(--app-fs-xs);
      width: 16px; height: 16px;
      padding: 0;
      line-height: 1;
      color: var(--app-text-color2);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      cursor: pointer;
      position: relative;
    }
    button:hover { border-color: var(--app-tint-5); }
    button[data-active] {
      color: var(--app-text-color1);
      border-color: var(--app-hi-color2);
      background: rgba(65, 105, 225, 0.15);
    }
    button[data-hw]::after {
      content: '';
      position: absolute;
      right: 1px; top: 1px;
      width: 3px; height: 3px;
      border-radius: 50%;
      background: var(--app-ok);
    }
  `;

  render() {
    return html`${[...Array(this.banks).keys()].map(bank => html`
      <button
        ?data-active=${bank === this.active}
        ?data-hw=${bank === this.hardware}
        @click=${(e: Event) => {
          e.stopPropagation();
          this.dispatchEvent(new CustomEvent('bank-select', {
            detail: { bank }, bubbles: true, composed: true,
          }));
        }}
      >${bank + 1}</button>
    `)}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-bank-switcher': DeviceBankSwitcher;
  }
}
