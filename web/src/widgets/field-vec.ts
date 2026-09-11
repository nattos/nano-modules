/**
 * <field-vec> — Multi-component vector editor.
 *
 * Reads/writes an array of N floats at a single field path. Renders one
 * scalar-slider per component, labeled X/Y/Z/W (or a caller-supplied
 * componentLabels). Continuous edits coalesce across components into a
 * single long-edit on the whole vector — dragging X just replaces the
 * 0th element of the current vec each frame and writes it through as
 * one atomic value, so undo restores the entire vec.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import './scalar-slider';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';
import { laneKey } from './field-anchor-lookup';

@customElement('field-vec')
export class FieldVec extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) components = 2;        // 2, 3, or 4
  @property({ type: Number }) min = 0;
  @property({ type: Number }) max = 1;
  @property({ type: Number }) step = 0.01;
  @property({ attribute: false }) defaultValue: number[] = [];
  @property({ attribute: false }) binding: FieldBinding | null = null;
  @property({ attribute: false }) componentLabels: string[] | null = null;

  get controlledFields() { return [this.fieldPath]; }
  /**
   * `[0]` is the anchor for the WHOLE field and must strictly CONTAIN every
   * per-lane anchor: the tap overlay paints hit boxes largest-area-first so
   * nested ones stay clickable, and two boxes of equal area would tie — making
   * "the whole vector" and "its X component" impossible to aim at separately.
   * Hence the wrapper, rather than the X slider standing in for the field.
   */
  getControlElements(): HTMLElement[] {
    const sliders = Array.from(
      this.renderRoot.querySelectorAll('scalar-slider')) as HTMLElement[];
    const body = this.renderRoot.querySelector('.vec-body') as HTMLElement | null;
    return body ? [body, ...sliders] : sliders;
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-1);
      font-size: var(--app-fs-sm);
    }
    .vec-body { display: flex; flex-direction: column; gap: var(--app-sp-1); }
    .row { display: inline-flex; align-items: center; gap: var(--app-sp-3); }
    .label {
      min-width: 70px;
      flex-shrink: 0;
      color: var(--app-text-color2, #b0b0b0);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .group-label { font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding-bottom: 1px; }
    scalar-slider { flex: 1; min-width: 0; }
  `;

  /// Read the current vec value (always returns an array of length N).
  private get vec(): number[] {
    const def = (this.defaultValue?.length === this.components)
      ? this.defaultValue
      : new Array(this.components).fill(0);
    if (!this.binding) return def;
    const v = this.binding.getValue(this.fieldPath);
    if (Array.isArray(v) && v.length === this.components) return v as number[];
    return def;
  }

  render() {
    const v = this.vec;
    const labels = this.componentLabels ?? ['X', 'Y', 'Z', 'W'];
    const rows = [];
    for (let i = 0; i < this.components; i++) {
      // Per-component binding wraps the parent vec binding: reading a
      // component returns vec[i]; writing replaces vec[i] and pushes
      // the whole vec back. Continuous edits delegate to the parent
      // and coalesce all per-component writes into one long edit.
      const componentBinding: FieldBinding = {
        instanceKey: this.binding?.instanceKey ?? '',
        getValue: () => this.vec[i] ?? 0,
        setValue: (_path: string, value: any) => {
          if (typeof value !== 'number') return;
          const next = this.vec.slice();
          next[i] = value;
          this.binding?.setValue(this.fieldPath, next);
        },
        beginContinuousEdit: (_path: string, value: any): ContinuousEditHandle => {
          const next = this.vec.slice();
          if (typeof value === 'number') next[i] = value;
          const edit = this.binding?.beginContinuousEdit?.(this.fieldPath, next);
          return {
            update: (cv: any) => {
              if (typeof cv !== 'number') return;
              const cur = this.vec.slice();
              cur[i] = cv;
              edit?.update(cur);
            },
            accept: () => edit?.accept(),
            cancel: () => edit?.cancel(),
          };
        },
        // The band the executor recorded for THIS component. Its telemetry key
        // is the lane path, which is exactly what the slider asks for below —
        // so the whole chain from executor to slider needs no special case.
        getModulation: (path: string) => this.binding?.getModulation?.(path) ?? null,
      };
      rows.push(html`
        <div class="row">
          <span class="label">${labels[i] ?? `[${i}]`}</span>
          <scalar-slider
            .fieldPath=${laneKey(this.fieldPath, i)}
            .min=${this.min}
            .max=${this.max}
            .step=${this.step}
            .defaultValue=${v[i] ?? 0}
            .binding=${componentBinding}
          ></scalar-slider>
        </div>
      `);
    }
    return html`
      ${this.label ? html`<div class="group-label">${this.label}</div>` : nothing}
      <div class="vec-body">${rows}</div>
    `;
  }
}
