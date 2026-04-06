/**
 * <field-slider> — Standard slider widget for numeric fields.
 *
 * Displays a labeled slider that reads/writes a numeric value
 * at a specific field path in module instance state.
 */

import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

@customElement('field-slider')
export class FieldSlider extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  bindInstance(binding: FieldBinding) {
    this.binding = binding;
  }

  private get value(): number {
    if (this.binding) {
      const v = this.binding.getValue(this.fieldPath);
      return typeof v === 'number' ? v : this.defaultValue;
    }
    return this.defaultValue;
  }

  private onInput(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    this.binding?.setValue(this.fieldPath, v);
  }

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
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    input[type=range] {
      flex: 1;
      height: 4px;
      accent-color: var(--app-hi-color2, #4169E1);
      min-width: 0;
    }
    .value {
      min-width: 28px;
      text-align: right;
      color: var(--app-text-color2, #b0b0b0);
      font-size: 9px;
    }
  `;

  render() {
    const v = this.value;
    const display = this.step >= 1 ? Math.round(v).toString() : v.toFixed(2);
    return html`
      <span class="label">${this.label}</span>
      <input type="range" .min=${String(this.min)} .max=${String(this.max)}
             .step=${String(this.step)} .value=${String(v)}
             @input=${this.onInput}>
      <span class="value">${display}</span>
    `;
  }
}
