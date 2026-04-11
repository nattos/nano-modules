/**
 * <field-slider> — Standard slider widget for numeric fields.
 *
 * Displays a labeled slider that reads/writes a numeric value
 * at a specific field path in module instance state.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';

@customElement('field-slider')
export class FieldSlider extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  private activeEdit: ContinuousEditHandle | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('input[type=range]') as HTMLElement | null;
    return el ? [el] : [];
  }

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

  /** Dragging — start or update continuous edit (no undo points). */
  private onInput(e: Event) {
    const v = parseFloat((e.target as HTMLInputElement).value);
    if (!this.activeEdit && this.binding?.beginContinuousEdit) {
      this.activeEdit = this.binding.beginContinuousEdit(this.fieldPath, v);
    } else if (this.activeEdit) {
      this.activeEdit.update(v);
    } else {
      // Fallback for bindings that don't support continuous edit
      this.binding?.setValue(this.fieldPath, v);
    }
  }

  /** Mouse release — commit the drag as a single undo point. */
  private onChange() {
    if (this.activeEdit) {
      this.activeEdit.accept();
      this.activeEdit = null;
    }
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
             @input=${this.onInput}
             @change=${this.onChange}>
      <span class="value">${display}</span>
    `;
  }
}
