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
    // <select>.value is always a string — convert back to the typed
    // option value (numbers, mostly) before writing. Without this we
    // ship "1" instead of 1, which slips through to bridge core /
    // C++ state and is silently coerced to 0 (val::asNumber returns 0
    // for strings), so the effect never sees the real selection.
    const strValue = (e.target as HTMLSelectElement).value;
    const option = this.options.find(o => String(o.value) === strValue);
    const typed = option ? option.value : strValue;
    this.binding?.setValue(this.fieldPath, typed);
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
      border-radius: 1px;
      padding: 2px 4px;
      font-size: 10px;
      font-family: inherit;
    }
  `;

  render() {
    // We mark the matching option `selected` declaratively rather than
    // setting `.value` on the <select>, because lit applies element
    // properties before child <option>s are appended — the select then
    // can't resolve the value string to a real option and silently
    // falls back to displaying the first option. `?selected` on each
    // option is order-independent and survives re-renders cleanly.
    const v = String(this.value);
    return html`
      <span class="label">${this.label}</span>
      <select @change=${this.onChange}>
        ${this.options.map(opt => html`
          <option value=${String(opt.value)} ?selected=${String(opt.value) === v}>${opt.label}</option>
        `)}
      </select>
    `;
  }
}
