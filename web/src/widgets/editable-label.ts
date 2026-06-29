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
import './editable-text';
import type { EditableText } from './editable-text';

/** Builds the editor element for the provider (autocomplete) variant. The
 *  returned element must dispatch `preview`/`commit`/`cancel`/`delete-request`
 *  CustomEvents (the <smart-input> contract). */
export type EditableLabelProvider = (opts: { value: string }) => HTMLElement;

@customElement('editable-label')
export class EditableLabel extends LitElement {
  @property() value = '';
  /** Optional resolved text shown when NOT editing (e.g. a `#`-token name expanded
   *  to its context). Edit mode still seeds from the raw {@link value}. Empty ⇒ show
   *  {@link value}. */
  @property() displayValue = '';
  @property() placeholder = '';
  /**
   * Flat mode: drop the display's own hover background + text cursor so the
   * label blends into an enclosing hover target (e.g. a list row) instead of
   * being a second nested one. Double-click still enters edit mode.
   */
  @property({ type: Boolean, reflect: true }) flat = false;
  /** Optional autocomplete-editor factory; when set, edit mode hosts its element. */
  @property({ attribute: false }) provider: EditableLabelProvider | null = null;

  @state() private editing = false;

  /** Seed for the plain edit box this session: a typed char (type-to-edit,
   *  caret at end) or null (Enter/dblclick → seed the full value + select). */
  private editSeed: string | null = null;
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
    /* Flat: blend into the enclosing hover target — no inner hover / text cursor. */
    :host([flat]) .display { cursor: inherit; }
    :host([flat]) .display:hover { background: transparent; }
    .edit-host { flex: 1; min-width: 0; display: flex; }
    /* The plain variant hosts <editable-text>; keep the label's tight,
       accent-bordered look via its themable parts/vars. */
    editable-text {
      flex: 1;
      min-width: 0;
      --editable-text-border: var(--app-hi-color2, #4169E1);
      --editable-text-pad: 0 3px;
    }
    editable-text::part(control) { line-height: 20px; }
  `;

  /** Enter edit mode programmatically (also the dblclick / Enter-key path).
   *  `seed` (plain variant only) starts the edit with that text + caret at end
   *  instead of the full value selected — the type-to-edit entry point. */
  beginEdit(seed: string | null = null) {
    if (this.editing) return;
    this.finished = false;
    this.justEntered = true;
    this.editSeed = this.provider ? null : seed;
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
    this.editSeed = null;
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

  // Plain variant: <editable-text> already maps Enter/blur→commit, Escape→cancel
  // and owns the IME guard. Forward its terminal events to our event surface.
  private onTextCommit = (e: Event) => this.commitPlain((e as CustomEvent<string>).detail);
  private onTextCancel = () => this.cancel();

  private onDisplayKeydown = (e: KeyboardEvent) => {
    // Only an EXPLICIT Enter/F2 enters edit mode. Type-to-edit (a printable char
    // starting an edit) is deliberately NOT supported for free-form text: on a
    // focusable label like a track header it's far too easy to clobber the name by
    // typing while it happens to hold focus. Numeric fields keep type-to-edit.
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
    // Focus the inner control AFTER <editable-text> has rendered its own <input>:
    // focusing synchronously here often hit a not-yet-rendered control and silently
    // no-op'd (the flaky "double-click didn't focus the field"). Await its update.
    const text = this.renderRoot.querySelector('editable-text') as EditableText | null;
    if (text) void text.updateComplete.then(() => { if (this.editing) text.focus(); });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.exitEdit();
  }

  render() {
    if (!this.editing) {
      const shown = this.displayValue !== '' ? this.displayValue : this.value;
      const empty = shown.length === 0;
      return html`
        <span
          class="display ${empty ? 'placeholder' : ''}"
          role="button"
          tabindex="0"
          aria-label=${shown || this.placeholder}
          @dblclick=${() => this.beginEdit()}
          @keydown=${this.onDisplayKeydown}
        >${empty ? this.placeholder : shown}</span>
      `;
    }
    if (this.provider && this.editorEl) {
      return html`<div class="edit-host">${this.editorEl}</div>`;
    }
    // Type-to-edit seeds the box with the typed char (caret at end); otherwise
    // seed the full value and select it (Enter / double-click).
    const seeded = this.editSeed != null;
    return html`
      <div class="edit-host">
        <editable-text
          .value=${seeded ? this.editSeed! : this.value}
          placeholder=${this.placeholder}
          ?selectOnFocus=${!seeded}
          @commit=${this.onTextCommit}
          @cancel=${this.onTextCancel}
        ></editable-text>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editable-label': EditableLabel;
  }
}
