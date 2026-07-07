/**
 * <field-toggle> — Standard toggle widget for boolean fields.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

@customElement('field-toggle')
export class FieldToggle extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** Label-as-button mode: the button IS the label (no separate label column)
   *  and fills the full field-editor width; ON/OFF is shown by the active tint.
   *  Reflected for the `:host([labelButton])` rules below. */
  @property({ type: Boolean, reflect: true }) labelButton = false;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('button') as HTMLElement | null;
    return el ? [el] : [];
  }

  bindInstance(binding: FieldBinding) {
    this.binding = binding;
  }

  private get value(): boolean {
    if (this.binding) {
      const v = this.binding.getValue(this.fieldPath);
      return typeof v === 'number' ? v > 0.5 : !!v;
    }
    return this.defaultValue > 0.5;
  }

  /** Multi-edit: true when the bound targets disagree — neither ON nor OFF is
   *  active and the button shows "many" until the first click aligns them. */
  private get mixed(): boolean {
    return this.binding?.isMixed?.(this.fieldPath) ?? false;
  }

  private onClick() {
    // Mixed → align everyone to ON; otherwise plain toggle.
    this.binding?.setValue(this.fieldPath, this.mixed ? 1 : this.value ? 0 : 1);
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      padding: 2px 0;
      font-size: var(--app-fs-sm);
    }
    .label {
      min-width: 70px;
      color: var(--app-text-color2, #b0b0b0);
      flex-shrink: 0;
    }
    button {
      flex: 1;
      background: var(--app-tint-2);
      border: 1px solid var(--app-tint-4);
      color: var(--app-text-color2, #b0b0b0);
      font-size: var(--app-fs-xs);
      padding: 3px 6px;
      border-radius: 1px;
      cursor: pointer;
      font-family: inherit;
      text-align: center;
    }
    button:hover { background: var(--app-tint-4); }
    button[active] {
      background: var(--app-hi-color2, #4169E1);
      border-color: var(--app-hi-color2, #4169E1);
      color: #fff;
    }
    button[mixed] { font-style: italic; color: var(--app-text-color2, #888); }

    /* Label-as-button: the button fills the whole width and carries the label;
       the active tint shows the ON state. */
    :host([labelButton]) { display: block; padding: 2px 0; }
    :host([labelButton]) button { width: 100%; }
  `;

  render() {
    const mixed = this.mixed;
    const on = this.value;
    if (this.labelButton) {
      return html`
        <button ?active=${!mixed && on} ?mixed=${mixed} @click=${this.onClick}>
          ${mixed ? `${this.label} (many)` : this.label}
        </button>
      `;
    }
    return html`
      <span class="label">${this.label}</span>
      <button ?active=${!mixed && on} ?mixed=${mixed} @click=${this.onClick}>
        ${mixed ? 'many' : on ? 'ON' : 'OFF'}
      </button>
    `;
  }
}
