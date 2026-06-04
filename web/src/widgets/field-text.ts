/**
 * <field-text> — Text-input field editor for string fields.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

@customElement('field-text')
export class FieldText extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property() placeholder = '';
  @property() defaultValue = '';
  // Render a multi-line <textarea> instead of a one-line <input> (e.g. for the
  // gen.richtext HTML field, where you want to paste/edit a whole document).
  @property({ type: Boolean }) multiline = false;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('input, textarea') as HTMLElement | null;
    return el ? [el] : [this];
  }

  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private get value(): string {
    if (this.binding) {
      const v = this.binding.getValue(this.fieldPath);
      return typeof v === 'string' ? v : (v != null ? String(v) : this.defaultValue);
    }
    return this.defaultValue;
  }

  private onInput(e: Event) {
    this.binding?.setValue(this.fieldPath, (e.target as HTMLInputElement | HTMLTextAreaElement).value);
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
    input {
      flex: 1;
      min-width: 0;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 2px;
      padding: 2px 4px;
      font-size: 10px;
      font-family: inherit;
    }
    input:focus { outline: none; border-color: var(--app-hi-color2, #4169E1); }
    :host(.multiline) { align-items: flex-start; }
    textarea {
      flex: 1;
      min-width: 0;
      min-height: 96px;
      resize: vertical;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 2px;
      padding: 3px 4px;
      font-size: 10px;
      font-family: ui-monospace, Menlo, Consolas, monospace;
      line-height: 1.4;
      white-space: pre;
    }
    textarea:focus { outline: none; border-color: var(--app-hi-color2, #4169E1); }
  `;

  render() {
    if (this.multiline) {
      // Reflect a host class so flex-start aligns the label with the box top.
      this.classList.add('multiline');
      return html`
        <span class="label">${this.label}</span>
        <textarea spellcheck="false" .value=${this.value}
                  placeholder=${this.placeholder} @input=${this.onInput}></textarea>
      `;
    }
    return html`
      <span class="label">${this.label}</span>
      <input type="text" .value=${this.value} placeholder=${this.placeholder}
             @input=${this.onInput}>
    `;
  }
}
