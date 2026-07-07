/**
 * <field-trigger> — Standard momentary button widget for event fields.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

@customElement('field-trigger')
export class FieldTrigger extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** Label-as-button mode: the button IS the label (no separate label column)
   *  and fills the full field-editor width. Reflected for the `:host([labelButton])`
   *  rules below. */
  @property({ type: Boolean, reflect: true }) labelButton = false;
  /** Double-height button (label-as-button mode). Reflected. */
  @property({ type: Boolean, reflect: true }) tall = false;
  /** Optional leading glyph (emoji/text) shown on the button, above the label in
   *  tall mode. NOTE: an icon-font class (line-awesome) won't work here — the
   *  class→glyph rules aren't in this shadow root; pass a literal glyph. */
  @property() icon = '';

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
      color: var(--app-text-color1, #eaeaea);
      font-size: var(--app-fs-xs);
      padding: 3px 6px;
      border-radius: 1px;
      cursor: pointer;
      font-family: inherit;
      text-align: center;
      user-select: none;
    }
    button:active {
      background: var(--app-hi-color2, #4169E1);
      border-color: var(--app-hi-color2, #4169E1);
    }

    /* Label-as-button: the button fills the whole width and carries the label. */
    :host([labelButton]) { display: block; padding: 2px 0; }
    :host([labelButton]) button { width: 100%; }
    /* Tall (double-height) button: icon stacked above the label. */
    :host([tall]) button {
      min-height: 42px;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 2px; line-height: 1.1;
    }
    .ico { font-size: 1.25em; line-height: 1; }
  `;

  private content() {
    return html`${this.icon ? html`<span class="ico">${this.icon}</span>` : nothing}
      <span>${this.label || 'Trigger'}</span>`;
  }

  render() {
    if (this.labelButton) {
      return html`
        <button @mousedown=${this.onDown} @mouseup=${this.onUp}
                @mouseleave=${this.onUp}>${this.content()}</button>
      `;
    }
    return html`
      <span class="label">${this.label}</span>
      <button @mousedown=${this.onDown} @mouseup=${this.onUp}
              @mouseleave=${this.onUp}>Trigger</button>
    `;
  }
}
