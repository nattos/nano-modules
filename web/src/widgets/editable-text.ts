/**
 * <editable-text> — the app's standard free-form text input primitive.
 *
 * One place that owns the *hard* parts of a themed text control so every
 * surface (effect-IDE field editors, arrangement inline names, the font search
 * box, …) behaves identically:
 *
 *  - **IME composition guard.** While an input method is composing (Japanese
 *    kanji conversion, accent dead-keys, …) intermediate `input` events must
 *    NOT round-trip through the consumer's store: committing half-composed text
 *    re-renders the host, which rewrites the control's `.value` and wipes the
 *    live composition buffer mid-edit (rapid typing garbles/duplicates chars —
 *    slow typing happens to work because each composition finishes first). We
 *    hold writes for the composition and commit the final string once, on
 *    `compositionend`.
 *  - **Imperative value reflection.** We deliberately do NOT bind `.value`
 *    reactively: a bound `.value` re-asserts on every async re-render and can
 *    land mid-composition and clobber it. Instead we reflect `value` into the
 *    control in `updated()`, only when it truly differs and not while composing
 *    (so ordinary typing never resets the caret either).
 *
 * API (all CustomEvents are composed so they cross the shadow boundary):
 *  - `input`  detail=string — live, per-keystroke, IME-guarded. Use this for a
 *             field that writes through to a store on every change (field-text).
 *  - `commit` detail=string — terminal: Enter (single-line) or blur. Use this
 *             for label-style "edit then confirm" flows (editable-label).
 *  - `cancel`               — terminal: Escape; the control reverts to `value`.
 *
 * `commit`/`cancel` fire at most once per focus session (a `finished` guard, so
 * a trailing blur after Enter can't double-fire); the native `input` event is
 * stopped at the boundary so only the clean CustomEvent leaks out.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('editable-text')
export class EditableText extends LitElement {
  @property() value = '';
  @property() placeholder = '';
  /** Render a multi-line <textarea> instead of a one-line <input>. */
  @property({ type: Boolean, reflect: true }) multiline = false;
  /** Monospace font for the textarea (code / markup editing). */
  @property({ type: Boolean }) monospace = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) spellcheck = false;
  /** Select the whole value when the control gains focus (rename flows). */
  @property({ type: Boolean }) selectOnFocus = false;

  static styles = css`
    :host { display: flex; min-width: 0; }
    .control {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      /* Restore text selection — an ancestor may set user-select:none. */
      -webkit-user-select: text;
      user-select: text;
      background: var(--editable-text-bg, rgba(0, 0, 0, 0.3));
      border: 1px solid var(--editable-text-border, var(--app-tint-4));
      color: var(--app-text-color1, #eaeaea);
      border-radius: var(--editable-text-radius, 1px);
      padding: var(--editable-text-pad, 2px 4px);
      font: inherit;
      font-size: inherit;
    }
    .control:focus {
      outline: none;
      border-color: var(--editable-text-focus, var(--app-hi-color2, #4169E1));
    }
    textarea.control {
      min-height: var(--editable-text-min-h, 96px);
      resize: vertical;
      line-height: 1.4;
      white-space: pre;
    }
    textarea.mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
  `;

  // --- IME composition guard (see file header).
  private composing = false;
  /** Guards commit/cancel against a second terminal event in one focus session. */
  private finished = false;
  /** External value last seen in render(); reflected imperatively in updated(). */
  private renderedValue = '';

  private get control(): HTMLInputElement | HTMLTextAreaElement | null {
    return this.renderRoot.querySelector('.control') as
      HTMLInputElement | HTMLTextAreaElement | null;
  }

  /** Focus the inner control (delegated; the host itself isn't focusable). */
  focus() { this.control?.focus(); }
  /** Focus and select the whole value (rename entry point). */
  selectAll() {
    const el = this.control;
    if (el) { el.focus(); el.select(); }
  }

  private onFocus = () => {
    this.finished = false;
    if (this.selectOnFocus) (this.control as HTMLInputElement | null)?.select?.();
  };

  private onCompositionStart = () => { this.composing = true; };
  private onCompositionEnd = (e: CompositionEvent) => {
    this.composing = false;
    // compositionend can fire before OR after the terminating `input` event
    // (browser-dependent), so emit the composed text here directly. A trailing
    // post-composition input emits the same value — idempotent for consumers.
    this.emitInput(e.target as HTMLInputElement | HTMLTextAreaElement);
  };

  private onInput = (e: Event) => {
    e.stopPropagation(); // don't let the raw native event leak past the boundary
    // Drop intermediate composition events; onCompositionEnd emits the result.
    // isComposing covers the rare case where compositionstart didn't fire.
    if (this.composing || (e as InputEvent).isComposing) return;
    this.emitInput(e.target as HTMLInputElement | HTMLTextAreaElement);
  };

  private emitInput(el: HTMLInputElement | HTMLTextAreaElement) {
    this.dispatchEvent(new CustomEvent('input', { detail: el.value, composed: true }));
  }

  private commit(raw: string) {
    if (this.finished) return;
    this.finished = true;
    this.dispatchEvent(new CustomEvent('commit', { detail: raw, composed: true }));
  }
  private cancel() {
    if (this.finished) return;
    this.finished = true;
    // Revert the control to the external value before notifying.
    const el = this.control;
    if (el) el.value = this.value;
    this.dispatchEvent(new CustomEvent('cancel', { composed: true }));
  }

  private onKeydown = (e: KeyboardEvent) => {
    if (this.composing || (e as any).isComposing) return;
    // Single-line Enter commits; in a textarea Enter inserts a newline.
    if (e.key === 'Enter' && !this.multiline) {
      e.preventDefault();
      this.commit((e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    }
  };

  private onBlur = (e: FocusEvent) => {
    // Blur commits (a no-op if Enter/Escape already finished this session).
    this.commit((e.target as HTMLInputElement | HTMLTextAreaElement).value);
  };

  render() {
    this.renderedValue = this.value; // track the observable; reflected in updated()
    if (this.multiline) {
      return html`
        <textarea
          class="control ${this.monospace ? 'mono' : ''}"
          part="control"
          ?disabled=${this.disabled}
          spellcheck=${this.spellcheck}
          placeholder=${this.placeholder}
          @input=${this.onInput}
          @keydown=${this.onKeydown}
          @focus=${this.onFocus}
          @blur=${this.onBlur}
          @compositionstart=${this.onCompositionStart}
          @compositionend=${this.onCompositionEnd}
        ></textarea>
      `;
    }
    return html`
      <input
        type="text"
        class="control"
        part="control"
        ?disabled=${this.disabled}
        spellcheck=${this.spellcheck}
        placeholder=${this.placeholder}
        @input=${this.onInput}
        @keydown=${this.onKeydown}
        @focus=${this.onFocus}
        @blur=${this.onBlur}
        @compositionstart=${this.onCompositionStart}
        @compositionend=${this.onCompositionEnd}
      />
    `;
  }

  protected updated() {
    // Reflect the external value imperatively (see file header for why not via a
    // reactive `.value=` binding). Skip while composing; otherwise write only on
    // a true difference so the caret never jumps during ordinary typing.
    const el = this.control;
    if (!el || this.composing) return;
    if (el.value !== this.renderedValue) el.value = this.renderedValue;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editable-text': EditableText;
  }
}
