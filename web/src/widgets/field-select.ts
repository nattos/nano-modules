/**
 * <field-select> — Dropdown field editor for enumerated options.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

export interface FieldSelectOption { label: string; value: any; }

@customElement('field-select')
export class FieldSelect extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ attribute: false }) options: FieldSelectOption[] = [];
  @property({ attribute: false }) defaultValue: any = undefined;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('select') as HTMLElement | null;
    return el ? [el] : [this];
  }

  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private get value(): any {
    if (this.binding) {
      const v = this.binding.getValue(this.fieldPath);
      if (v !== undefined && v !== null) return v;
    }
    return this.defaultValue ?? this.options[0]?.value;
  }

  private onChange(e: Event) {
    this.binding?.setValue(this.fieldPath, (e.target as HTMLSelectElement).value);
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
      min-width: 60px;
      color: var(--app-text-color2, #b0b0b0);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    select {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 2px;
      padding: 2px 4px;
      font-size: 10px;
      font-family: inherit;
    }
  `;

  render() {
    return html`
      <span class="label">${this.label}</span>
      <select .value=${String(this.value)} @change=${this.onChange}>
        ${this.options.map(opt => html`
          <option value=${opt.value}>${opt.label}</option>
        `)}
      </select>
    `;
  }
}
