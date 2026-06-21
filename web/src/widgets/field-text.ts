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
  // source.text.rich HTML field, where you want to paste/edit a whole document).
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

  // IME composition guard. While an input method is composing (e.g. Japanese
  // kanji conversion, or accent dead-keys), intermediate `input` events must
  // NOT round-trip through the binding: committing the half-composed text
  // mutates the MobX store, which re-renders this element and rewrites the
  // control's `.value` — that resets the live composition buffer mid-edit, so
  // rapid typing / cycling candidate conversions duplicates and garbles
  // characters (typing very slowly happens to work because each composition
  // finishes before the writeback lands). We hold writes for the duration of
  // the composition and commit the final string once, on compositionend.
  private composing = false;

  private onCompositionStart() {
    this.composing = true;
  }

  private onCompositionEnd(e: CompositionEvent) {
    this.composing = false;
    // compositionend can fire before OR after the terminating `input` event
    // (browser-dependent), so commit the composed text here directly rather
    // than relying on a trailing input. If a post-composition input also
    // fires, it writes the same value — an idempotent no-op for the store.
    this.commit(e.target as HTMLInputElement | HTMLTextAreaElement);
  }

  private onInput(e: Event) {
    // Drop intermediate composition events; onCompositionEnd commits the
    // result. isComposing covers the rare case where compositionstart didn't.
    if (this.composing || (e as InputEvent).isComposing) return;
    this.commit(e.target as HTMLInputElement | HTMLTextAreaElement);
  }

  private commit(el: HTMLInputElement | HTMLTextAreaElement) {
    this.binding?.setValue(this.fieldPath, el.value);
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
      border: 1px solid var(--app-tint-4);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 1px;
      padding: 2px 4px;
      font-size: var(--app-fs-sm);
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
      border: 1px solid var(--app-tint-4);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 1px;
      padding: 3px 4px;
      font-size: var(--app-fs-sm);
      font-family: ui-monospace, Menlo, Consolas, monospace;
      line-height: 1.4;
      white-space: pre;
    }
    textarea:focus { outline: none; border-color: var(--app-hi-color2, #4169E1); }
  `;

  // External value last seen in render(). We read this.value in render() so
  // MobX still tracks it (the component stays reactive to external changes),
  // but we deliberately DON'T bind it to the control's `.value` in the
  // template — see updated() for why.
  private renderedValue = '';

  render() {
    this.renderedValue = this.value;  // track the observable; reflected in updated()
    if (this.multiline) {
      // Reflect a host class so flex-start aligns the label with the box top.
      this.classList.add('multiline');
      return html`
        <span class="label">${this.label}</span>
        <textarea spellcheck="false"
                  placeholder=${this.placeholder} @input=${this.onInput}
                  @compositionstart=${this.onCompositionStart}
                  @compositionend=${this.onCompositionEnd}></textarea>
      `;
    }
    return html`
      <span class="label">${this.label}</span>
      <input type="text" placeholder=${this.placeholder}
             @input=${this.onInput}
             @compositionstart=${this.onCompositionStart}
             @compositionend=${this.onCompositionEnd}>
    `;
  }

  protected updated() {
    // Reflect the external value into the control IMPERATIVELY rather than via a
    // reactive `.value=${this.value}` binding. A bound `.value` re-asserts the
    // DOM value on every re-render — and because every store write (including
    // our own compositionend commit) schedules an ASYNC re-render, that
    // re-assert can land in the middle of the NEXT IME composition and wipe the
    // half-composed text. That async clobber is why a plain onInput
    // composition-guard alone didn't fix rapid kanji input. Here we skip the
    // write entirely while composing, and otherwise write only when the value
    // truly differs (so ordinary typing never resets the caret either).
    const el = this.renderRoot.querySelector('input, textarea') as
      HTMLInputElement | HTMLTextAreaElement | null;
    if (!el || this.composing) return;
    if (el.value !== this.renderedValue) el.value = this.renderedValue;
  }
}
