/**
 * <field-text> — Text-input field editor for string fields.
 *
 * A thin FieldBinding adapter over <editable-text>: it owns the label + binding
 * round-trip and delegates the actual control (and the IME-composition guard /
 * imperative value reflection) to the shared primitive.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';
import './editable-text';

@customElement('field-text')
export class FieldText extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property() placeholder = '';
  @property() defaultValue = '';
  // Render a multi-line <textarea> instead of a one-line <input> (e.g. for the
  // source.text.rich HTML field, where you want to paste/edit a whole document).
  @property({ type: Boolean }) multiline = false;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    // The <editable-text> host's rect encloses its inner control — good enough
    // for the framework's bounding-box queries (it doesn't reach into shadows).
    const el = this.renderRoot.querySelector('editable-text') as HTMLElement | null;
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

  // Live writeback: <editable-text> emits IME-guarded `input` events whose detail
  // is the current string. Just push it to the binding.
  private onInput = (e: Event) => {
    this.binding?.setValue(this.fieldPath, (e as CustomEvent<string>).detail);
  };

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      padding: 2px 0;
      font-size: var(--app-fs-sm);
    }
    .label {
      min-width: 60px;
      color: var(--app-text-color2, #b0b0b0);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    editable-text { flex: 1; min-width: 0; }
    :host(.multiline) { align-items: flex-start; }
  `;

  render() {
    if (this.multiline) this.classList.add('multiline');
    // Multi-edit: bound clips disagree → show an empty control with a "many"
    // placeholder; typing commits one value to every clip (clearing mixed).
    const mixed = this.binding?.isMixed?.(this.fieldPath) ?? false;
    return html`
      <span class="label">${this.label}</span>
      <editable-text
        .value=${mixed ? '' : this.value}
        ?multiline=${this.multiline}
        ?monospace=${this.multiline}
        placeholder=${mixed ? 'many' : this.placeholder}
        @input=${this.onInput}
      ></editable-text>
    `;
  }
}
