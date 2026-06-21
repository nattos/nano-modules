/**
 * <field-color> — RGB(A) color editor.
 *
 * Reads/writes an array of 3 floats (rgb) or 4 floats (rgba) at a single
 * field path. Renders a native HTML <input type="color"> swatch plus an
 * inline alpha slider when components === 4. Values are clamped to
 * [0, 1] in the array; the swatch shows the perceived sRGB color.
 *
 * Continuous edits coalesce as in field-vec — all RGB(A) channel writes
 * during a single drag flow through one long-edit on the whole vec.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import './scalar-slider';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';

@customElement('field-color')
export class FieldColor extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) components = 3;        // 3 = rgb, 4 = rgba
  @property({ attribute: false }) defaultValue: number[] = [];
  @property({ attribute: false }) binding: FieldBinding | null = null;

  private alphaEdit: ContinuousEditHandle | null = null;

  get controlledFields() { return [this.fieldPath]; }
  getControlElements(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const swatch = this.renderRoot.querySelector('input[type=color]') as HTMLElement | null;
    if (swatch) out.push(swatch);
    const alpha = this.renderRoot.querySelector('scalar-slider') as HTMLElement | null;
    if (alpha) out.push(alpha);
    return out;
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--app-sp-3);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1, #eaeaea);
    }
    .label {
      min-width: 70px;
      flex-shrink: 0;
      color: var(--app-text-color2, #b0b0b0);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    input[type=color] {
      width: 28px;
      height: 18px;
      padding: 0;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 1px;
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
    }
    input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
    input[type=color]::-webkit-color-swatch { border: none; border-radius: 1px; }
    .alpha-row { display: inline-flex; align-items: center; gap: var(--app-sp-2); flex: 1; min-width: 0; }
    .alpha-label { color: var(--app-text-color2, #b0b0b0); flex-shrink: 0; }
    scalar-slider { flex: 1; min-width: 0; }
  `;

  /// Read current vec from binding (always length-N array, defaulting black).
  private get vec(): number[] {
    const def = (this.defaultValue?.length === this.components)
      ? this.defaultValue
      : new Array(this.components).fill(0);
    if (!this.binding) return def;
    const v = this.binding.getValue(this.fieldPath);
    if (Array.isArray(v) && v.length === this.components) return v as number[];
    return def;
  }

  /// Convert the current rgb portion of the vec to a #rrggbb string.
  private get hex(): string {
    const v = this.vec;
    const to8 = (x: number) => {
      const c = Math.max(0, Math.min(1, x));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${to8(v[0] ?? 0)}${to8(v[1] ?? 0)}${to8(v[2] ?? 0)}`;
  }

  private onColorInput = (e: Event) => {
    const hex = (e.target as HTMLInputElement).value;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const next = this.vec.slice();
    next[0] = r;
    next[1] = g;
    next[2] = b;
    this.binding?.setValue(this.fieldPath, next);
  };

  render() {
    const v = this.vec;
    const labelEl = this.label ? html`<span class="label">${this.label}</span>` : nothing;

    let alphaEl: any = nothing;
    if (this.components === 4) {
      // Per-component binding wraps the parent vec, exactly like field-vec.
      const alphaBinding: FieldBinding = {
        instanceKey: this.binding?.instanceKey ?? '',
        getValue: () => this.vec[3] ?? 1,
        setValue: (_p: string, val: any) => {
          if (typeof val !== 'number') return;
          const next = this.vec.slice();
          next[3] = val;
          this.binding?.setValue(this.fieldPath, next);
        },
        beginContinuousEdit: this.binding?.beginContinuousEdit
          ? (_p: string, val: any): ContinuousEditHandle => {
              const next = this.vec.slice();
              if (typeof val === 'number') next[3] = val;
              const edit = this.binding!.beginContinuousEdit!(this.fieldPath, next);
              return {
                update: (cv: any) => {
                  if (typeof cv !== 'number') return;
                  const cur = this.vec.slice();
                  cur[3] = cv;
                  edit.update(cur);
                },
                accept: () => edit.accept(),
                cancel: () => edit.cancel(),
              };
            }
          : undefined,
      };
      alphaEl = html`
        <div class="alpha-row">
          <span class="alpha-label">A</span>
          <scalar-slider
            .fieldPath=${'value'}
            .min=${0}
            .max=${1}
            .step=${0.01}
            .defaultValue=${v[3] ?? 1}
            .binding=${alphaBinding}
          ></scalar-slider>
        </div>
      `;
    }

    return html`
      ${labelEl}
      <input type="color" .value=${this.hex} @input=${this.onColorInput}>
      ${alphaEl}
    `;
  }
}
