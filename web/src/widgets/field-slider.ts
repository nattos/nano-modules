/**
 * <field-slider> — Standard slider widget for numeric fields.
 *
 * Displays a labeled slider that reads/writes a numeric value
 * at a specific field path in module instance state.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement, FieldLayoutManager } from './field-editor';

@customElement('field-slider')
export class FieldSlider extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;
  @property({ type: Boolean }) tappingMode = false;
  @property({ type: Boolean }) selected = false;
  @property({ attribute: false }) layoutManager: FieldLayoutManager | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('input[type=range]') as HTMLElement | null;
    return el ? [el] : [];
  }

  bindInstance(binding: FieldBinding) {
    this.binding = binding;
  }

  updated() {
    this.layoutManager?.notifyLayoutChanged();
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
  `;

  private onTapSelect(e: Event) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('field-tap-select', {
      bubbles: true, composed: true,
      detail: { fieldPath: this.fieldPath },
    }));
  }

  render() {
    if (this.selected) this.setAttribute('selected', '');
    else this.removeAttribute('selected');

    const v = this.value;
    const display = this.step >= 1 ? Math.round(v).toString() : v.toFixed(2);
    return html`
      ${this.tappingMode ? html`<div class="tap-overlay" @click=${this.onTapSelect}></div>` : nothing}
      <span class="label">${this.label}</span>
      <input type="range" .min=${String(this.min)} .max=${String(this.max)}
             .step=${String(this.step)} .value=${String(v)}
             @input=${this.onInput}>
      <span class="value">${display}</span>
    `;
  }
}
