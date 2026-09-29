/**
 * <output-master-button> — the master output switch (output-master.ts) in the
 * Devices panel's header. Off at every launch; while off, no display shows
 * and no light transmits, whatever each one's own switch says. ⌘⇧D turns it
 * off from anywhere (Resolume's "Disable Output").
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { outputMaster } from '../state/output-master';

@customElement('output-master-button')
export class OutputMasterButton extends MobxLitElement {
  static styles = css`
    :host { display: inline-flex; }
    button {
      display: inline-flex; align-items: center; gap: 6px;
      font: inherit; font-size: var(--app-fs-sm); letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--app-text-color2); background: none; cursor: pointer;
      border: 1px solid var(--app-tint-4); border-radius: 2px; padding: 2px 8px;
    }
    button:hover { border-color: var(--app-hi-color2); color: var(--app-text-color1); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--app-tint-4); }
    button.on {
      color: #fff; border-color: var(--app-error, #e06c6c);
      background: color-mix(in srgb, var(--app-error, #e06c6c) 35%, transparent);
    }
    button.on .dot { background: var(--app-error, #e06c6c); box-shadow: 0 0 6px var(--app-error, #e06c6c); }
    .key { font-size: var(--app-fs-xs); opacity: 0.6; text-transform: none; letter-spacing: 0; }
  `;

  render() {
    const on = outputMaster.armed;
    return html`<button class=${on ? 'on' : ''} data-output-master=${on ? 'on' : 'off'}
      title=${on
        ? 'Output is ON: displays show and lights transmit. Click (or ⌘⇧D) to disable output.'
        : 'Output is OFF: no display shows and no light transmits (it starts off every launch). Click to enable.'}
      @click=${() => outputMaster.set(!on)}>
      <span class="dot"></span>${on ? 'output on' : 'output off'}${on ? html`<span class="key">⌘⇧D</span>` : ''}
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'output-master-button': OutputMasterButton }
}
