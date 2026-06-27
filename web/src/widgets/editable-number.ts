/**
 * <editable-number> — focusable numeric field that jogs with the arrow keys and
 * drops into a real text box to type an exact value.
 *
 * Two states, mirroring <editable-label> but for numbers:
 *  - DISPLAY (focusable): shows the formatted value. Arrow Up/Right increment,
 *    Down/Left decrement by `step` (Shift / PageUp·Down by `shiftStep`); Home/End
 *    jump to a finite min/max. Backspace/Delete reset to `defaultValue` if set.
 *  - EDIT: pressing a digit (`-`, `.`, `e` too), Enter, or double-click swaps in
 *    an <editable-text>. A typed character seeds the box (replace); Enter /
 *    double-click seed the current value and select it. Enter/blur commit (parse
 *    + clamp + round), Escape reverts. The IME guard etc. come from editable-text.
 *
 * Emits a single `input` event (detail: number) on every value change — each jog
 * press and each committed text edit — so consumers bind it like editable-text.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './editable-text';
import type { EditableText } from './editable-text';

@customElement('editable-number')
export class EditableNumber extends LitElement {
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = -Infinity;
  @property({ type: Number }) max = Infinity;
  /** Arrow-key increment, and the source of display decimals (e.g. 0.1 → 1 dp). */
  @property({ type: Number }) step = 1;
  /** Shift+Arrow / PageUp·Down increment. Defaults to step×10. */
  @property({ type: Number }) shiftStep = NaN;
  /** Display/edit decimal places; NaN ⇒ derive from `step`. (Jog still uses step.) */
  @property({ type: Number }) precision = NaN;
  /** Suffix shown after the value in DISPLAY mode only (e.g. "bpm"). */
  @property() units = '';
  /** Reset target for Backspace/Delete; NaN ⇒ those keys do nothing. */
  @property({ type: Number }) defaultValue = NaN;
  @property({ type: Boolean }) disabled = false;
  /** Accessible name for the display control. */
  @property() label = '';

  @state() private editing = false;

  private editSeed = '';
  private selectOnEdit = false;
  /** What to focus after the next render: the display, or the edit box. */
  private pendingFocus: 'display' | 'edit' | null = null;

  static styles = css`
    :host { display: inline-flex; min-width: 0; }
    .display {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      text-align: right;
      font-variant-numeric: tabular-nums;
      cursor: ns-resize;
      border: 1px solid transparent;
      border-radius: var(--editable-text-radius, 1px);
      padding: var(--editable-text-pad, 2px 4px);
      outline: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .display:hover { background: var(--app-tint-3, rgba(255, 255, 255, 0.06)); }
    .display:focus-visible,
    .display.focused {
      border-color: var(--app-hi-color2, #4169E1);
      background: var(--editable-text-bg, rgba(0, 0, 0, 0.3));
    }
    :host([disabled]) .display { opacity: 0.5; pointer-events: none; }
    editable-text { flex: 1; min-width: 0; --editable-text-pad: 2px 4px; }
    editable-text::part(control) { text-align: right; font-variant-numeric: tabular-nums; }
  `;

  /** Decimal places: explicit `precision`, else implied by `step` (0 for ints). */
  private get decimals(): number {
    if (Number.isFinite(this.precision)) return Math.max(0, this.precision);
    if (!Number.isFinite(this.step) || Number.isInteger(this.step)) return 0;
    return this.step.toString().split('.')[1]?.length ?? 0;
  }
  private get bigStep(): number {
    return Number.isFinite(this.shiftStep) ? this.shiftStep : this.step * 10;
  }

  private roundTo(v: number): number {
    const f = Math.pow(10, this.decimals);
    return Math.round(v * f) / f;
  }
  private clamp(v: number): number {
    return Math.max(this.min, Math.min(this.max, v));
  }

  /** Value as a bare number string for the edit box (no units, trimmed). */
  private get rawString(): string {
    if (!Number.isFinite(this.value)) return '0';
    return String(this.roundTo(this.value));
  }
  private get displayString(): string {
    if (!Number.isFinite(this.value)) return '0';
    const n = this.roundTo(this.value);
    const s = this.decimals > 0 ? n.toFixed(this.decimals) : String(n);
    return this.units ? `${s} ${this.units}` : s;
  }

  /** Set value (clamped + rounded) and emit `input` if it actually changed. */
  private setValue(v: number) {
    const next = this.clamp(this.roundTo(v));
    if (next === this.value) return;
    this.value = next;
    this.dispatchEvent(new CustomEvent('input', { detail: next, composed: true }));
  }

  private jog(dirSteps: number, big: boolean) {
    const inc = (big ? this.bigStep : this.step) * dirSteps;
    this.setValue((Number.isFinite(this.value) ? this.value : 0) + inc);
  }

  private enterEdit(seed: string, selectAll: boolean) {
    if (this.disabled) return;
    this.editSeed = seed;
    this.selectOnEdit = selectAll;
    this.editing = true;
    this.pendingFocus = 'edit';
  }

  private onDisplayKeydown = (e: KeyboardEvent) => {
    if (this.disabled) return;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight':
        e.preventDefault(); this.jog(1, e.shiftKey); return;
      case 'ArrowDown': case 'ArrowLeft':
        e.preventDefault(); this.jog(-1, e.shiftKey); return;
      case 'PageUp':
        e.preventDefault(); this.jog(1, true); return;
      case 'PageDown':
        e.preventDefault(); this.jog(-1, true); return;
      case 'Home':
        if (Number.isFinite(this.min)) { e.preventDefault(); this.setValue(this.min); } return;
      case 'End':
        if (Number.isFinite(this.max)) { e.preventDefault(); this.setValue(this.max); } return;
      case 'Enter':
        e.preventDefault(); this.enterEdit(this.rawString, true); return;
      case 'Backspace': case 'Delete':
        if (Number.isFinite(this.defaultValue)) { e.preventDefault(); this.setValue(this.defaultValue); } return;
    }
    // Type-to-edit: a numeric character starts editing seeded with it (replace).
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /[0-9.\-+eE]/.test(e.key)) {
      e.preventDefault();
      this.enterEdit(e.key, false);
    }
  };

  private onEditCommit = (e: Event) => {
    const raw = (e as CustomEvent<string>).detail.trim();
    if (raw !== '') {
      const n = parseFloat(raw);
      if (Number.isFinite(n)) this.setValue(n);
    } else if (Number.isFinite(this.defaultValue)) {
      this.setValue(this.defaultValue);
    }
    this.editing = false;
    this.pendingFocus = 'display';
  };
  private onEditCancel = () => {
    this.editing = false;
    this.pendingFocus = 'display';
  };

  /** Focus the display control (e.g. after a parent decides to edit this field). */
  focus() {
    (this.renderRoot.querySelector('.display') as HTMLElement | null)?.focus();
  }

  protected updated() {
    const want = this.pendingFocus;
    if (!want) return;
    this.pendingFocus = null;
    if (want === 'edit') {
      // Await <editable-text>'s own render so its <input> exists before we focus it
      // (a synchronous focus here often no-op'd → the flaky double-click-to-edit).
      const et = this.renderRoot.querySelector('editable-text') as EditableText | null;
      if (et) void et.updateComplete.then(() => { if (this.editing) (this.selectOnEdit ? et.selectAll() : et.focus()); });
    } else {
      this.focus();
    }
  }

  render() {
    if (this.editing) {
      return html`
        <editable-text
          .value=${this.editSeed}
          ?selectOnFocus=${this.selectOnEdit}
          @commit=${this.onEditCommit}
          @cancel=${this.onEditCancel}
        ></editable-text>
      `;
    }
    return html`
      <div
        class="display"
        role="spinbutton"
        tabindex=${this.disabled ? -1 : 0}
        aria-label=${this.label}
        aria-valuenow=${Number.isFinite(this.value) ? this.value : 0}
        aria-valuemin=${Number.isFinite(this.min) ? this.min : ''}
        aria-valuemax=${Number.isFinite(this.max) ? this.max : ''}
        @keydown=${this.onDisplayKeydown}
        @dblclick=${() => this.enterEdit(this.rawString, true)}
      >${this.displayString}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'editable-number': EditableNumber;
  }
}
