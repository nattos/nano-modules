/**
 * <device-card> — one MIDI device (template, user fork, ghost, or deleted
 * row) in the Devices tab grid. Header carries the name + status badge; the
 * body is slotted (the data-driven <device-surface> renders there). Styling
 * follows the Instances tab's card vocabulary: 1px tint borders, radius 1px,
 * dashed for placeholders, --app-ok connection dot, --app-hi-color2 selection.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';

export type DeviceCardStatus =
  'connected' | 'disconnected' | 'template' | 'deleted' | 'ghost' | 'missing';

@customElement('device-card')
export class DeviceCard extends MobxLitElement {
  @property() declare name: string;
  @property() declare subtitle: string;
  @property() declare status: DeviceCardStatus;
  @property({ type: Boolean, reflect: true }) declare selected: boolean;
  /** Define mode: this card can be forked (highlight + hover lift). */
  @property({ type: Boolean, reflect: true }) declare forkable: boolean;
  /** Define mode: everything non-forkable grays out. */
  @property({ type: Boolean, reflect: true }) declare dimmed: boolean;
  /** Optional header action (e.g. 'reassign' on connected cards) — clicking
   *  fires 'card-action' without triggering the card's own click. */
  @property() declare actionLabel: string;

  constructor() {
    super();
    this.name = '';
    this.subtitle = '';
    this.status = 'template';
    this.selected = false;
    this.forkable = false;
    this.dimmed = false;
    this.actionLabel = '';
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 0 0 240px;
      width: 240px;
      background: var(--app-tint-1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      cursor: pointer;
      overflow: visible;   /* bank switcher floats past the corner */
      transition: opacity 0.15s ease, border-color 0.1s ease;
    }
    :host(:hover) { border-color: var(--app-tint-5); }
    :host([selected]) {
      border-color: var(--app-hi-color2);
      background: rgba(65, 105, 225, 0.08);
    }
    :host([status='ghost']) {
      border-style: dashed;
      border-color: var(--app-tint-4);
      opacity: 0.55;
      cursor: default;
    }
    /* Missing: referenced by composition wires but absent from the library —
       dashed like a ghost, but clickable (details panel offers adopt/alias)
       and warm-tinted so it reads as "needs attention", not "inert". */
    :host([status='missing']) {
      border-style: dashed;
      border-color: color-mix(in srgb, var(--app-hi-color1) 55%, transparent);
      opacity: 0.85;
    }
    :host([status='deleted']) { opacity: 0.45; }
    :host([status='deleted']) .name { text-decoration: line-through; }
    :host([dimmed]) {
      opacity: 0.22;
      filter: grayscale(1);
      pointer-events: none;
    }
    :host([forkable]) {
      border-color: var(--app-hi-color2);
      box-shadow: 0 0 0 1px rgba(65, 105, 225, 0.35);
    }
    :host([forkable]:hover) {
      background: rgba(65, 105, 225, 0.1);
      transform: translateY(-1px);
    }

    .head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-bottom: 1px solid var(--app-tint-2);
      min-width: 0;
    }
    .dot {
      flex: 0 0 auto;
      width: 7px; height: 7px;
      border-radius: 50%;
      border: 1px solid var(--app-tint-5);
      box-sizing: border-box;
    }
    .dot.on { background: var(--app-ok); border-color: var(--app-ok); }
    .name {
      flex: 1 1 auto;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge {
      flex: 0 0 auto;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      border: 1px dashed var(--app-tint-4);
      border-radius: 1px;
      padding: 0 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .action {
      flex: 0 0 auto;
      font: inherit;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      background: none;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
      padding: 0 4px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
    }
    .action:hover { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    .sub {
      padding: 2px 8px 0;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .body {
      position: relative;
      padding: 8px;
    }
  `;

  render() {
    const badge =
      this.status === 'template' ? 'template'
      : this.status === 'ghost' ? 'unrecognized'
      : this.status === 'missing' ? 'missing'
      : this.status === 'deleted' ? 'deleted'
      : null;
    return html`
      <div class="head">
        <div class="dot ${this.status === 'connected' ? 'on' : ''}"></div>
        <div class="name" title=${this.name}>${this.name}</div>
        ${badge ? html`<div class="badge">${badge}</div>` : nothing}
        ${this.actionLabel ? html`
          <button class="action" @click=${(e: Event) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('card-action', { bubbles: true, composed: true }));
          }}>${this.actionLabel}</button>` : nothing}
      </div>
      ${this.subtitle ? html`<div class="sub">${this.subtitle}</div>` : nothing}
      <div class="body"><slot></slot></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-card': DeviceCard;
  }
}
