/**
 * <field-trigger> — Standard momentary button widget for event fields.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement, FieldLayoutManager } from './field-editor';

@customElement('field-trigger')
export class FieldTrigger extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;
  @property({ type: Boolean }) tappingMode = false;
  @property({ type: Boolean }) selected = false;
  @property({ attribute: false }) layoutManager: FieldLayoutManager | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('button') as HTMLElement | null;
    return el ? [el] : [];
  }

  bindInstance(binding: FieldBinding) {
    this.binding = binding;
  }

  updated() {
    this.layoutManager?.notifyLayoutChanged();
  }

  private onDown() { this.binding?.setValue(this.fieldPath, 1); }
  private onUp() { this.binding?.setValue(this.fieldPath, 0); }

  private onTapSelect(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('field-tap-select', {
      bubbles: true, composed: true,
      detail: { fieldPath: this.fieldPath },
    }));
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-size: 10px;
      position: relative;
    }
    :host([selected]) {
      outline: 1px solid var(--app-hi-color2, #4169E1);
      outline-offset: 1px;
      border-radius: 2px;
    }
    .label {
      min-width: 70px;
      color: var(--app-text-color2, #b0b0b0);
      flex-shrink: 0;
    }
    .tap-overlay {
      position: absolute;
      inset: 0;
      background: rgba(65, 105, 225, 0.12);
      border: 1px solid rgba(65, 105, 225, 0.3);
      border-radius: 2px;
      cursor: pointer;
      z-index: 5;
    }
    .tap-overlay:hover {
      background: rgba(65, 105, 225, 0.25);
    }
    button {
      flex: 1;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--app-text-color1, #eaeaea);
      font-size: 9px;
      padding: 3px 6px;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
      text-align: center;
      user-select: none;
    }
    button:active {
      background: var(--app-hi-color2, #4169E1);
      border-color: var(--app-hi-color2, #4169E1);
    }
  `;

  render() {
    if (this.selected) this.setAttribute('selected', '');
    else this.removeAttribute('selected');

    return html`
      ${this.tappingMode ? html`<div class="tap-overlay" @click=${this.onTapSelect}></div>` : nothing}
      <span class="label">${this.label}</span>
      <button @mousedown=${this.onDown} @mouseup=${this.onUp}
              @mouseleave=${this.onUp}>Trigger</button>
    `;
  }
}
