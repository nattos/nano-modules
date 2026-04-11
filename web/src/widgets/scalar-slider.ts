/**
 * <scalar-slider> — Drag-to-edit numeric slider with inline text editing.
 *
 * Ported from nano-repatch. Features:
 * - Click and drag horizontally to set value (absolute positioning)
 * - Shift+drag for fine relative control
 * - Double-click or type digits to enter text edit mode
 * - Delete/Backspace resets to defaultValue
 * - Filled bar shows normalized position within [min, max]
 *
 * Dispatches:
 * - 'input' on every drag movement (detail: number)
 * - 'change' on commit (pointer up, enter, blur) (detail: number)
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { CancelReason, PointerDragOp } from '../utils/pointer-drag-op';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';

@customElement('scalar-slider')
export class ScalarSlider extends LitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) value = 0;
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property({ type: Number }) defaultValue = 0;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] { return [this]; }

  bindInstance(binding: FieldBinding) { this.binding = binding; }

  @state() private isDragging = false;
  @state() private isEditing = false;
  @state() private tempValue = '';

  private startValue = 0;
  private rect: DOMRect | null = null;
  private dragOp: PointerDragOp | null = null;
  private activeEdit: ContinuousEditHandle | null = null;

  static styles = css`
    :host {
      display: inline-block;
      user-select: none;
      cursor: ew-resize;
      position: relative;
      min-width: 40px;
      height: 18px;
      line-height: 18px;
      font-family: inherit;
      font-size: 10px;
      color: var(--app-text-color1, #eaeaea);
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 2px;
      box-sizing: border-box;
      touch-action: none;
      overflow: hidden;
    }

    :host(:hover) {
      border-color: var(--app-hi-color2, #4169E1);
      background: rgba(0, 0, 0, 0.3);
    }

    :host([dragging]) {
      border-color: var(--app-hi-color2, #4169E1);
      color: var(--app-hi-color2, #4169E1);
    }

    :host(:focus) {
      border-color: var(--app-hi-color2, #4169E1);
      outline: none;
    }

    .bar {
      position: absolute;
      top: 0;
      left: 0;
      bottom: 0;
      background-image: repeating-linear-gradient(
        45deg,
        transparent 0px,
        transparent 3px,
        rgba(65, 105, 225, 0.12) 3px,
        rgba(65, 105, 225, 0.12) 4px
      );
      background-size: 18px 18px;
      background-position: 100% 0;
      pointer-events: none;
      z-index: 0;
      border-right: 1px solid var(--app-hi-color2, #4169E1);
    }

    :host([dragging]) .bar {
      background-color: rgba(65, 105, 225, 0.1);
      border-right-width: 3px;
      opacity: 1;
    }

    .value-display {
      position: relative;
      z-index: 1;
      padding: 0 4px;
      text-align: center;
      width: 100%;
      height: 100%;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    input {
      position: relative;
      z-index: 2;
      width: 100%;
      height: 100%;
      border: none;
      background: rgba(0, 0, 0, 0.6);
      color: var(--app-text-color1, #eaeaea);
      font-family: inherit;
      font-size: inherit;
      padding: 0 4px;
      margin: 0;
      outline: none;
      text-align: center;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (!this.hasAttribute('tabindex')) {
      this.setAttribute('tabindex', '0');
    }
    this.addEventListener('keydown', this.handleHostKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.handleHostKeyDown);
    this.dragOp?.dispose();
  }

  /** When a binding is present, read the current value from it. */
  private get effectiveValue(): number {
    if (this.binding && this.fieldPath) {
      const v = this.binding.getValue(this.fieldPath);
      return typeof v === 'number' ? v : this.defaultValue;
    }
    return this.value;
  }

  /** Write a value — routes through continuous edit if active, else one-shot. */
  private setValue(v: number) {
    this.value = v;
    if (!this.binding || !this.fieldPath) return;

    if (this.activeEdit) {
      this.activeEdit.update(v);
    } else {
      this.binding.setValue(this.fieldPath, v);
    }
  }

  render() {
    if (this.isEditing) {
      return html`
        <input
          type="text"
          .value=${this.tempValue}
          @input=${this.handleInput}
          @keydown=${this.handleInputKeyDown}
          @blur=${this.commitEdit}
        />
      `;
    }

    const val = this.effectiveValue;
    let barWidth = 0;
    if (Number.isFinite(this.min) && Number.isFinite(this.max) && this.max > this.min) {
      const clamped = Math.max(this.min, Math.min(this.max, val));
      barWidth = ((clamped - this.min) / (this.max - this.min)) * 100;
    }

    return html`
      <div class="bar" style="width: ${barWidth}%"></div>
      <div
        class="value-display"
        @pointerdown=${this.handlePointerDown}
        @dblclick=${this.handleDoubleClick}
      >
        ${this.formatValue(val)}
      </div>
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
    this.rect = this.getBoundingClientRect();
    this.isDragging = false;

    this.dragOp = new PointerDragOp(e, this, {
      threshold: 0,
      move: (e, delta) => {
        // Begin continuous edit on first movement
        if (!this.isDragging) {
          this.isDragging = true;
          this.setAttribute('dragging', '');
          if (this.binding?.beginContinuousEdit && this.fieldPath) {
            this.activeEdit = this.binding.beginContinuousEdit(this.fieldPath, this.startValue);
          }
        }
        this.updateValueFromDelta(e, delta[0]);
      },
      accept: () => {
        if (this.isDragging) {
          this.dispatchEvent(new CustomEvent('change', { detail: this.effectiveValue }));
        }
        if (this.activeEdit) {
          this.activeEdit.accept();
          this.activeEdit = null;
        }
        this.cleanupDrag();
        this.focus();
      },
      cancel: (reason) => {
        if (this.activeEdit) {
          this.activeEdit.cancel();
          this.activeEdit = null;
        }
        if (reason === CancelReason.UserAction || reason === CancelReason.Programmatic) {
          this.value = this.startValue;
          this.dispatchEvent(new CustomEvent('change', { detail: this.startValue }));
        }
        this.cleanupDrag();
      }
    });
  }

  private updateValueFromDelta(e: PointerEvent, deltaX: number) {
    let newValue = this.value;

    if (e.shiftKey) {
      const range = this.max - this.min;
      if (!Number.isFinite(range)) {
        newValue = this.startValue + (deltaX * 0.1 * this.step);
      } else {
        const width = this.rect?.width || 100;
        const deltaValue = (deltaX / width) * range * 0.1;
        newValue = this.startValue + deltaValue;
      }
    } else {
      if (this.rect && Number.isFinite(this.min) && Number.isFinite(this.max)) {
        const relativeX = e.clientX - this.rect.left;
        const ratio = Math.max(0, Math.min(1, relativeX / this.rect.width));
        newValue = this.min + ratio * (this.max - this.min);
      } else {
        newValue = this.startValue + deltaX * this.step;
      }
    }

    const precision = this.step.toString().split('.')[1]?.length || 0;
    const factor = Math.pow(10, precision);
    newValue = Math.round(newValue * factor) / factor;

    if (!e.ctrlKey) {
      newValue = Math.max(this.min, Math.min(this.max, newValue));
    }

    if (newValue !== this.effectiveValue) {
      this.setValue(newValue);
      this.dispatchEvent(new CustomEvent('input', { detail: newValue }));
    }
  }

  private cleanupDrag() {
    this.removeAttribute('dragging');
    this.isDragging = false;
    this.rect = null;
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
        input.focus();
        if (e.key === 'Enter') {
          input.select();
        } else {
          input.selectionStart = input.selectionEnd = input.value.length;
        }
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
    if (input) {
      input.focus();
      input.select();
    }
  }

  private handleInput(e: InputEvent) {
    this.tempValue = (e.target as HTMLInputElement).value;
  }

  private handleInputKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      this.commitEdit();
    } else if (e.key === 'Escape') {
      this.isEditing = false;
      this.focus();
    }
    e.stopPropagation();
  }

  private commitEdit() {
    if (this.tempValue.trim() === '') {
      this.setValue(this.defaultValue);
      this.dispatchEvent(new CustomEvent('change', { detail: this.defaultValue }));
    } else {
      const num = parseFloat(this.tempValue);
      if (!isNaN(num)) {
        this.setValue(num);
        this.dispatchEvent(new CustomEvent('change', { detail: num }));
      }
    }
    this.isEditing = false;
    this.focus();
  }
}
