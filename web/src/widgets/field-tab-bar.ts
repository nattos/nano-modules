/**
 * <field-tab-bar> — Row-of-buttons enum editor.
 *
 * Used as the default UI for `selectField` / `select`-type inspector
 * fields. Every option is visible at all times and selectable in one
 * click — the right shape for live / event-driven controls where
 * dropdowns (mouse → menu hover → submenu click) are expensive
 * compared to a single hit-target. Save the dropdown for cases where
 * the option count is genuinely large; for the small enums we have
 * (mode selectors, algorithm pickers, etc.), a tab bar wins.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

export interface FieldTabBarOption { label: string; value: any; }

@customElement('field-tab-bar')
export class FieldTabBar extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ attribute: false }) options: FieldTabBarOption[] = [];
  @property({ attribute: false }) defaultValue: any = undefined;
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** Let the options flow onto multiple rows instead of one squeezed strip.
   *  Reflected so the `:host([wrap])` rules below can restyle the layout. */
  @property({ type: Boolean, reflect: true }) wrap = false;

  get controlledFields() { return [this.fieldPath]; }
  getControlElements(): HTMLElement[] {
    return Array.from(this.renderRoot.querySelectorAll('button')) as HTMLElement[];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private get value(): any {
    if (this.binding) {
      const v = this.binding.getValue(this.fieldPath);
      if (v !== undefined && v !== null) return v;
    }
    return this.defaultValue ?? this.options[0]?.value;
  }

  private onPick(opt: FieldTabBarOption) {
    // Pass the option's typed value (number, usually) — never the
    // string-coerced label. Same lesson as <field-select>: serialised
    // state and on_state_patched both expect typed values.
    this.binding?.setValue(this.fieldPath, opt.value);
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
      flex-shrink: 0;
      color: var(--app-text-color2, #b0b0b0);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tabs {
      display: inline-flex;
      flex: 1;
      min-width: 0;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
      overflow: hidden;
    }
    button {
      flex: 1 1 0;
      min-width: 0;
      background: rgba(0, 0, 0, 0.2);
      border: none;
      border-right: 1px solid var(--app-tint-3);
      color: var(--app-text-color2, #b0b0b0);
      font-size: var(--app-fs-sm);
      font-family: inherit;
      padding: 3px 6px;
      cursor: pointer;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: background 60ms ease-out;
    }
    button:last-child { border-right: none; }
    button:hover {
      background: var(--app-tint-2);
      color: var(--app-text-color1, #eaeaea);
    }
    button[active] {
      background: var(--app-hi-color2, #4169E1);
      color: #fff;
    }
    button[active]:hover {
      background: var(--app-hi-color2, #4169E1);
    }

    /* Wrap mode: options flow onto multiple rows as discrete chips (each
     * keeps its own border + corner) rather than one seamless segmented
     * strip. Used for large enums like blend modes. */
    :host([wrap]) { align-items: flex-start; }
    :host([wrap]) .label { padding-top: 4px; }
    :host([wrap]) .tabs {
      flex-wrap: wrap;
      gap: 2px;
      border: none;
      overflow: visible;
    }
    :host([wrap]) button {
      flex: 0 1 auto;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
    }
  `;

  render() {
    const v = this.value;
    return html`
      ${this.label ? html`<span class="label">${this.label}</span>` : nothing}
      <div class="tabs">
        ${this.options.map(opt => html`
          <button
            ?active=${String(opt.value) === String(v)}
            @click=${() => this.onPick(opt)}
          >${opt.label}</button>
        `)}
      </div>
    `;
  }
}
