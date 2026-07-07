/**
 * <field-trigger> — Standard momentary button widget for event fields.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';
import './ui-icon';

/** Light sanitize for a Line Awesome icon NAME before it becomes a CSS class —
 *  only the chars a `la-*` name can contain. */
function cleanIcon(name: string): string { return (name || '').replace(/[^a-z0-9-]/gi, ''); }
/** Light sanitize for an accent CSS color before it becomes a custom-property
 *  value — only the chars a color literal needs (rgb()/hsl()/#hex/name/%). */
function cleanColor(c: string): string { return (c || '').replace(/[^a-z0-9(),.#%\s-]/gi, ''); }

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
  /** Optional Line Awesome icon NAME (e.g. "la-trash") shown on the button,
   *  above the label in tall mode. Rendered via <ui-icon> (which carries the
   *  icon font), lightly sanitized. */
  @property() icon = '';
  /** Optional accent CSS color: lightly tints the resting button and fills it on
   *  press. Applied via the `--acc` custom property (color-mix). */
  @property() accent = '';

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
      /* --acc (optional accent) lightly tints the resting button; unset → the
         plain tint (color-mix falls back to tint-2/tint-4, so no visual change). */
      background: color-mix(in srgb, var(--acc, var(--app-tint-2)) 14%, var(--app-tint-2));
      border: 1px solid color-mix(in srgb, var(--acc, var(--app-tint-4)) 42%, var(--app-tint-4));
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
      background: var(--acc, var(--app-hi-color2, #4169E1));
      border-color: var(--acc, var(--app-hi-color2, #4169E1));
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
    .ico { --icon-size: 1.35em; line-height: 1; }
  `;

  private content() {
    const ico = cleanIcon(this.icon);
    return html`${ico ? html`<ui-icon class="ico" .icon=${ico}></ui-icon>` : nothing}
      <span>${this.label || 'Trigger'}</span>`;
  }

  render() {
    const acc = this.accent ? `--acc:${cleanColor(this.accent)}` : nothing;
    if (this.labelButton) {
      return html`
        <button style=${acc} @mousedown=${this.onDown} @mouseup=${this.onUp}
                @mouseleave=${this.onUp}>${this.content()}</button>
      `;
    }
    return html`
      <span class="label">${this.label}</span>
      <button style=${acc} @mousedown=${this.onDown} @mouseup=${this.onUp}
              @mouseleave=${this.onUp}>Trigger</button>
    `;
  }
}
