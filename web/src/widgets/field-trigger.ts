/**
 * <field-trigger> — Standard momentary button widget for event fields.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

@customElement('field-trigger')
export class FieldTrigger extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('button') as HTMLElement | null;
    return el ? [el] : [];
  }

  bindInstance(binding: FieldBinding) {
    this.binding = binding;
  }

  private onDown() { this.binding?.setValue(this.fieldPath, 1); }
  private onUp() { this.binding?.setValue(this.fieldPath, 0); }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-size: 10px;
    }
    .label {
      min-width: 70px;
      color: var(--app-text-color2, #b0b0b0);
      flex-shrink: 0;
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
    return html`
      <span class="label">${this.label}</span>
      <button @mousedown=${this.onDown} @mouseup=${this.onUp}
              @mouseleave=${this.onUp}>Trigger</button>
    `;
  }
}
