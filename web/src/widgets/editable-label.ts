/**
 * <editable-label> — Double-click-to-edit text label, with an optional
 * autocomplete provider.
 *
 * The arrangement needs a lot of inline text editing (clip / track / region
 * names) that the effect IDE didn't; this is the shared affordance. It has two
 * modes:
 *
 *  - PLAIN (no `provider`): renders a one-line <input> seeded with `value`.
 *    Enter or blur → `commit` (detail = the new string); Escape → `cancel`.
 *
 *  - PROVIDER (`provider` set): renders the element the provider builds (e.g.
 *    <smart-input> for effect-type retyping) and re-dispatches its terminal
 *    events verbatim. The provider's element is expected to emit the
 *    smart-input event surface: `preview` / `commit` / `cancel` /
 *    `delete-request`. editable-label forwards them through and exits edit mode
 *    on any terminal one, so the host keeps its existing handler semantics.
 *
 * Exactly one terminal event (commit / cancel / delete-request) fires per edit
 * session — a `finished` guard mirrors <smart-input> so a trailing blur after
 * Enter can't double-fire.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** Builds the editor element for the provider (autocomplete) variant. The
 *  returned element must dispatch `preview`/`commit`/`cancel`/`delete-request`
 *  CustomEvents (the <smart-input> contract). */
export type EditableLabelProvider = (opts: { value: string }) => HTMLElement;

@customElement('editable-label')
export class EditableLabel extends LitElement {
  @property() value = '';
  @property() placeholder = '';
  /** Optional autocomplete-editor factory; when set, edit mode hosts its element. */
  @property({ attribute: false }) provider: EditableLabelProvider | null = null;

  @state() private editing = false;

  /** The provider's editor element for the current session (provider variant). */
  private editorEl: HTMLElement | null = null;
  /** Guards against a second terminal event racing in (e.g. blur after Enter). */
  private finished = false;
  /** True for the first render after entering edit mode, so we focus once. */
  private justEntered = false;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      min-height: 22px;          /* lock one row height so the swap doesn't jump */
      min-width: 0;
      max-width: 100%;
    }
    .display {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: text;
      border-radius: 1px;
      padding: 0 2px;
      outline: none;
    }
    .display:hover { background: var(--app-tint-3, rgba(255,255,255,0.06)); }
    .display:focus-visible { box-shadow: 0 0 0 1px var(--app-hi-color2, #4169E1); }
    .display.placeholder { color: var(--app-text-color2, #888); font-style: italic; }
    .edit-host { flex: 1; min-width: 0; display: flex; }
    input {
      flex: 1;
      min-width: 0;
      /* Restore text selection — an ancestor may set user-select:none. */
      -webkit-user-select: text;
      user-select: text;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--app-hi-color2, #4169E1);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 1px;
      padding: 0 3px;
      font: inherit;
      font-size: inherit;
      line-height: 20px;
    }
    input:focus { outline: none; }
  `;

  /** Enter edit mode programmatically (also the dblclick / Enter-key path). */
  beginEdit() {
    if (this.editing) return;
    this.finished = false;
    this.justEntered = true;
    if (this.provider) {
      const el = this.provider({ value: this.value });
      el.addEventListener('preview', this.onProviderPreview);
      el.addEventListener('commit', this.onProviderCommit);
      el.addEventListener('cancel', this.onProviderCancel);
      el.addEventListener('delete-request', this.onProviderDelete);
      this.editorEl = el;
    }
    this.editing = true;
  }

  private exitEdit() {
    if (this.editorEl) {
      this.editorEl.removeEventListener('preview', this.onProviderPreview);
      this.editorEl.removeEventListener('commit', this.onProviderCommit);
      this.editorEl.removeEventListener('cancel', this.onProviderCancel);
      this.editorEl.removeEventListener('delete-request', this.onProviderDelete);
      this.editorEl = null;
    }
    this.editing = false;
  }

  // --- Provider (autocomplete) variant: pass terminal events straight through.
  private onProviderPreview = (e: Event) => {
    this.dispatchEvent(new CustomEvent('preview', { detail: (e as CustomEvent).detail }));
  };
  private onProviderCommit = (e: Event) => {
    if (this.finished) return;
    this.finished = true;
    const detail = (e as CustomEvent).detail;
    this.exitEdit();
    this.dispatchEvent(new CustomEvent('commit', { detail }));
  };
  private onProviderCancel = () => this.cancel();
  private onProviderDelete = () => {
    if (this.finished) return;
    this.finished = true;
    this.exitEdit();
    this.dispatchEvent(new CustomEvent('delete-request'));
  };

  // --- Plain variant.
  private commitPlain(raw: string) {
    if (this.finished) return;
    this.finished = true;
    this.exitEdit();
    this.dispatchEvent(new CustomEvent('commit', { detail: raw }));
  }

  private cancel() {
    if (this.finished) return;
    this.finished = true;
    this.exitEdit();
    this.dispatchEvent(new CustomEvent('cancel'));
  }

  private onInputKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitPlain((e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    }
  };

  private onInputBlur = (e: FocusEvent) => {
    // Blur commits (plain variant). A no-op if Enter/Escape already finished.
    this.commitPlain((e.target as HTMLInputElement).value);
  };

  private onDisplayKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      this.beginEdit();
    }
  };

  protected updated() {
    if (!this.editing || !this.justEntered) return;
    this.justEntered = false;
    if (this.provider) {
      // The provider element manages its own focus (smart-input autofocuses).
      return;
    }
    const input = this.renderRoot.querySelector('input') as HTMLInputElement | null;
    if (input) {
      input.focus();
      input.select();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.exitEdit();
  }

  render() {
    if (!this.editing) {
      const empty = this.value.length === 0;
      return html`
        <span
          class="display ${empty ? 'placeholder' : ''}"
          role="button"
          tabindex="0"
          aria-label=${this.value || this.placeholder}
          @dblclick=${this.beginEdit}
          @keydown=${this.onDisplayKeydown}
        >${empty ? this.placeholder : this.value}</span>
      `;
    }
    if (this.provider && this.editorEl) {
      return html`<div class="edit-host">${this.editorEl}</div>`;
    }
    return html`
      <div class="edit-host">
        <input
          type="text"
          .value=${this.value}
          placeholder=${this.placeholder}
          spellcheck="false"
          @keydown=${this.onInputKeydown}
          @blur=${this.onInputBlur}
        />
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editable-label': EditableLabel;
  }
}
