/**
 * <scalar-knob> — Rotary twin of <scalar-slider>.
 *
 * A compact rotary control with the SAME FieldBinding contract as scalar-slider,
 * so it drops into the field-editor framework (wire hit-boxes, layout scanning,
 * continuous long edits) unchanged. Built for the util.dashboard knob row.
 *
 * - Vertical drag to set value (up = increase); Shift = fine
 * - Double-click or type digits to enter text edit mode
 * - Delete/Backspace resets to defaultValue
 * - The pointer angle + filled arc show the normalized position within [min,max]
 *
 * Dispatches 'input' on every drag movement and 'change' on commit, matching
 * scalar-slider.
 */

import { LitElement, html, css, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CancelReason, PointerDragOp } from '../utils/pointer-drag-op';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';

/** Degrees of rotation spanning the whole [min,max] range (gap at the bottom). */
const SWEEP = 270;
/** Vertical pixels of drag for one full min→max sweep. */
const DRAG_RANGE_PX = 160;

@customElement('scalar-knob')
export class ScalarKnob extends LitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property({ type: Number }) defaultValue = 0;
  /** Grayed-out: the control currently has no effect (e.g. a dashboard knob with
   *  no outgoing wire, or overridden by a `replace` input wire). Still editable. */
  @property({ type: Boolean, reflect: true }) muted = false;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }
  getControlElements(): HTMLElement[] { return [this]; }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  @state() private isEditing = false;
  private tempValue = '';
  private startValue = 0;
  private dragOp: PointerDragOp | null = null;
  private activeEdit: ContinuousEditHandle | null = null;

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: var(--app-sp-2);
      user-select: none;
      font-family: inherit;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color1, #eaeaea);
      touch-action: none;
      width: 44px;
    }
    .dial {
      position: relative;
      width: 34px;
      height: 34px;
      cursor: ns-resize;
    }
    svg { display: block; width: 34px; height: 34px; overflow: visible; }
    .track { stroke: var(--app-tint-4); }
    .fill { stroke: var(--app-hi-color2, #4169E1); }
    .pointer { stroke: var(--app-text-color1, #eaeaea); }
    :host([dragging]) .fill { stroke: var(--app-hi-color2, #4169E1); filter: drop-shadow(0 0 2px var(--app-hi-color2, #4169E1)); }
    :host([dragging]) .pointer { stroke: var(--app-hi-color2, #4169E1); }
    :host(:focus) { outline: none; }
    :host(:focus) .knob-hub { stroke: var(--app-hi-color2, #4169E1); }
    /* No-effect knob: dimmed + desaturated so it reads as inert (still editable). */
    :host([muted]) { opacity: 0.4; }
    :host([muted]) .fill { stroke: var(--app-text-color2, #888); filter: none; }
    :host([muted]) .pointer { stroke: var(--app-text-color2, #888); }
    .knob-hub { fill: rgba(0,0,0,0.35); stroke: var(--app-tint-5); }
    .dial:hover .knob-hub { stroke: var(--app-hi-color2, #4169E1); }
    .label { color: var(--app-text-color2, #b0b0b0); overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; max-width: 44px; text-align: center; }
    .val { font-variant-numeric: tabular-nums; }
    input {
      width: 40px; height: 14px; border: none; border-radius: 1px;
      background: rgba(0,0,0,0.7); color: var(--app-text-color1, #eaeaea);
      font-family: inherit; font-size: var(--app-fs-xs); padding: 0 2px; margin: 0;
      outline: none; text-align: center;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    this.addEventListener('keydown', this.handleHostKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.handleHostKeyDown);
    this.dragOp?.dispose();
  }

  private get effectiveValue(): number {
    if (this.binding && this.fieldPath) {
      const v = this.binding.getValue(this.fieldPath);
      return typeof v === 'number' ? v : this.defaultValue;
    }
    return this.value;
  }

  private setValue(v: number) {
    this.value = v;
    if (!this.binding || !this.fieldPath) return;
    if (this.activeEdit) this.activeEdit.update(v);
    else this.binding.setValue(this.fieldPath, v);
  }

  /** Normalized [0,1] position of `val` within [min,max]. */
  private norm(val: number): number {
    if (!(this.max > this.min)) return 0;
    return Math.max(0, Math.min(1, (val - this.min) / (this.max - this.min)));
  }

  /** Arc path from angle a0 to a1 (degrees, 0 = straight up, clockwise). */
  private arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
    const p = (a: number) => {
      const rad = (a - 90) * Math.PI / 180;
      return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
    };
    const [x0, y0] = p(a0), [x1, y1] = p(a1);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  }

  render() {
    if (this.isEditing) {
      return html`
        <input type="text" @input=${this.handleInput}
          @keydown=${this.handleInputKeyDown} @blur=${this.commitEdit} />
      `;
    }
    const val = this.effectiveValue;
    const t = this.norm(val);
    const a0 = -SWEEP / 2, a1 = a0 + t * SWEEP;
    const cx = 17, cy = 17, r = 13;
    const rad = (a1 - 90) * Math.PI / 180;
    const px = cx + r * Math.cos(rad), py = cy + r * Math.sin(rad);
    return html`
      <div class="dial" @pointerdown=${this.handlePointerDown} @dblclick=${this.handleDoubleClick}
        title=${`${this.label}: ${this.formatValue(val)}`}>
        <svg viewBox="0 0 34 34">
          <path class="track" fill="none" stroke-width="3" stroke-linecap="round"
            d=${this.arc(cx, cy, r, a0, a0 + SWEEP)}></path>
          ${t > 0 ? svg`<path class="fill" fill="none" stroke-width="3" stroke-linecap="round"
            d=${this.arc(cx, cy, r, a0, a1)}></path>` : nothing}
          <circle class="knob-hub" cx=${cx} cy=${cy} r="8" stroke-width="1"></circle>
          <line class="pointer" x1=${cx} y1=${cy} x2=${px} y2=${py}
            stroke-width="2" stroke-linecap="round"></line>
        </svg>
      </div>
      <div class="val">${this.formatValue(val)}</div>
      ${this.label ? html`<div class="label">${this.label}</div>` : nothing}
    `;
  }

  private formatValue(val: number): string {
    if (typeof val !== 'number' || isNaN(val)) return '0';
    if (Number.isInteger(this.step)) return val.toString();
    const decimals = this.step.toString().split('.')[1]?.length || 0;
    return val.toFixed(decimals);
  }

  private handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (e.detail === 2) { this.handleDoubleClick(); return; }
    this.startValue = this.effectiveValue;
    let dragging = false;

    this.dragOp = new PointerDragOp(e, this, {
      threshold: 0,
      move: (ev, delta) => {
        if (!dragging) {
          dragging = true;
          this.setAttribute('dragging', '');
          if (this.binding?.beginContinuousEdit && this.fieldPath) {
            this.activeEdit = this.binding.beginContinuousEdit(this.fieldPath, this.startValue);
          }
        }
        this.updateValueFromDelta(ev, delta[1]);
      },
      accept: () => {
        if (dragging) this.dispatchEvent(new CustomEvent('change', { detail: this.effectiveValue }));
        this.activeEdit?.accept();
        this.activeEdit = null;
        this.cleanupDrag();
        this.focus();
      },
      cancel: (reason) => {
        this.activeEdit?.cancel();
        this.activeEdit = null;
        if (reason === CancelReason.UserAction || reason === CancelReason.Programmatic) {
          this.value = this.startValue;
          this.dispatchEvent(new CustomEvent('change', { detail: this.startValue }));
        }
        this.cleanupDrag();
      },
    });
  }

  /** Vertical drag: up (negative dy) increases. */
  private updateValueFromDelta(e: PointerEvent, deltaY: number) {
    const range = (this.max > this.min) ? this.max - this.min : 1;
    const sens = e.shiftKey ? 0.25 : 1;
    let newValue = this.startValue - (deltaY / DRAG_RANGE_PX) * range * sens;

    const precision = this.step.toString().split('.')[1]?.length || 0;
    const factor = Math.pow(10, precision);
    newValue = Math.round(newValue * factor) / factor;
    if (!e.ctrlKey) newValue = Math.max(this.min, Math.min(this.max, newValue));

    if (newValue !== this.effectiveValue) {
      this.setValue(newValue);
      this.dispatchEvent(new CustomEvent('input', { detail: newValue }));
    }
  }

  private cleanupDrag() {
    this.removeAttribute('dragging');
    this.dragOp = null;
  }

  private handleHostKeyDown = async (e: KeyboardEvent) => {
    if (this.isEditing) return;
    if (/^[0-9.\-]$/.test(e.key) || e.key === 'Enter') {
      this.isEditing = true;
      this.tempValue = e.key === 'Enter' ? this.effectiveValue.toString() : e.key;
      e.preventDefault();
      await this.updateComplete;
      const input = this.shadowRoot?.querySelector('input');
      if (input) {
        input.value = this.tempValue;
        input.focus();
        if (e.key === 'Enter') input.select();
        else input.selectionStart = input.selectionEnd = input.value.length;
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      this.setValue(this.defaultValue);
      this.dispatchEvent(new CustomEvent('change', { detail: this.defaultValue }));
    }
  };

  private async handleDoubleClick(e?: Event) {
    e?.stopPropagation();
    this.isEditing = true;
    this.tempValue = this.effectiveValue.toString();
    await this.updateComplete;
    const input = this.shadowRoot?.querySelector('input');
    if (input) { input.value = this.tempValue; input.focus(); input.select(); }
  }

  private handleInput(e: InputEvent) { this.tempValue = (e.target as HTMLInputElement).value; }

  private handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') this.commitEdit();
    else if (e.key === 'Escape') { this.isEditing = false; this.focus(); }
    e.stopPropagation();
  }

  private commitEdit() {
    const num = this.tempValue.trim() === '' ? this.defaultValue : parseFloat(this.tempValue);
    if (!isNaN(num)) {
      this.setValue(num);
      this.dispatchEvent(new CustomEvent('change', { detail: num }));
    }
    this.isEditing = false;
    this.focus();
  }
}
