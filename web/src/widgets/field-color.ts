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
 *
 * A disclosure caret reveals one slider PER CHANNEL. Those rows are what give
 * each channel a DOM anchor, which is what lets a wire or an automation curve
 * address one component of a colour — the swatch alone has a single rect and
 * nothing to aim at. Collapsed by default so the compact row is unchanged.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import './scalar-slider';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';
import { laneKey } from './field-anchor-lookup';

/** Component names for a colour's lanes, matching the executor's lane order. */
const CHANNEL_LABELS = ['R', 'G', 'B', 'A'];

@customElement('field-color')
export class FieldColor extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property({ type: Number }) components = 3;        // 3 = rgb, 4 = rgba
  @property({ attribute: false }) defaultValue: number[] = [];
  @property({ attribute: false }) binding: FieldBinding | null = null;

  private swatchEdit: ContinuousEditHandle | null = null;

  @state() private channelsOpen = false;

  get controlledFields() { return [this.fieldPath]; }
  /**
   * `[0]` anchors the WHOLE field and must strictly contain the per-channel
   * anchors — the tap overlay sorts hit boxes largest-first, and equal areas
   * tie (see field-vec). When the channels are open the wrapper is that box;
   * collapsed, there are no lane anchors and the swatch stands for the field.
   */
  getControlElements(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const body = this.renderRoot.querySelector('.color-body') as HTMLElement | null;
    const swatch = this.renderRoot.querySelector('input[type=color]') as HTMLElement | null;
    if (this.channelsOpen && body) out.push(body);
    else if (swatch) out.push(swatch);
    for (const el of this.renderRoot.querySelectorAll('scalar-slider')) {
      out.push(el as HTMLElement);
    }
    return out;
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  static styles = css`
    :host {
      display: block;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1, #eaeaea);
    }
    .color-body { display: flex; flex-direction: column; gap: var(--app-sp-1); }
    .swatch-row {
      display: inline-flex;
      align-items: center;
      gap: var(--app-sp-3);
    }
    .caret {
      appearance: none;
      background: transparent;
      border: none;
      padding: 0 2px;
      margin: 0;
      cursor: pointer;
      color: var(--app-text-color2, #b0b0b0);
      font-size: var(--app-fs-sm);
      line-height: 1;
      flex-shrink: 0;
    }
    .caret:hover { color: var(--app-text-color1, #eaeaea); }
    .row { display: inline-flex; align-items: center; gap: var(--app-sp-3); }
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
    .ch-label { color: var(--app-text-color2, #b0b0b0); flex-shrink: 0; min-width: 10px; }
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
    // The OS picker fires `input` per movement; coalesce the whole interaction
    // into one long-edit so it lands as a single undo point on `change`.
    if (this.swatchEdit) {
      this.swatchEdit.update(next);
    } else if (this.binding?.beginContinuousEdit) {
      this.swatchEdit = this.binding.beginContinuousEdit(this.fieldPath, next);
    } else {
      this.binding?.setValue(this.fieldPath, next);
    }
  };

  private onColorChange = () => {
    this.swatchEdit?.accept();
    this.swatchEdit = null;
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    this.swatchEdit?.accept();
    this.swatchEdit = null;
  }

  /**
   * A binding for ONE channel, wrapping the parent vec — the same shape
   * field-vec uses. Reading gives that component; writing splices it into the
   * current vec and pushes the whole array back, so the document never sees a
   * partial colour.
   */
  private componentBinding(i: number): FieldBinding {
    const fallback = i === 3 ? 1 : 0;
    return {
      instanceKey: this.binding?.instanceKey ?? '',
      getValue: () => this.vec[i] ?? fallback,
      setValue: (_p: string, val: any) => {
        if (typeof val !== 'number') return;
        this.onColorChange();  // settle any pending swatch long-edit first
        const next = this.vec.slice();
        next[i] = val;
        this.binding?.setValue(this.fieldPath, next);
      },
      beginContinuousEdit: (_p: string, val: any): ContinuousEditHandle => {
        // Only one long-edit may be active (history contract) — beginning a
        // channel edit while the swatch panel is still open would cancel-and-
        // revert the RGB edit, so commit it first.
        this.onColorChange();
        const next = this.vec.slice();
        if (typeof val === 'number') next[i] = val;
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
      // The band recorded for this channel; its telemetry key is the lane path
      // the slider below already asks for.
      getModulation: (path: string) => this.binding?.getModulation?.(path) ?? null,
    };
  }

  private channelRow(i: number) {
    const v = this.vec;
    const fallback = i === 3 ? 1 : 0;
    return html`
      <div class="row">
        <span class="ch-label">${CHANNEL_LABELS[i] ?? `[${i}]`}</span>
        <scalar-slider
          .fieldPath=${laneKey(this.fieldPath, i)}
          .min=${0}
          .max=${1}
          .step=${0.01}
          .defaultValue=${v[i] ?? fallback}
          .binding=${this.componentBinding(i)}
        ></scalar-slider>
      </div>
    `;
  }

  render() {
    const v = this.vec;
    const labelEl = this.label ? html`<span class="label">${this.label}</span>` : nothing;

    // Expanded: every channel gets a row (and therefore an anchor a wire or an
    // automation curve can address). Collapsed: the compact swatch, plus the
    // inline alpha it has always had.
    const rows = [];
    if (this.channelsOpen) {
      for (let i = 0; i < this.components; i++) rows.push(this.channelRow(i));
    }

    const alphaEl = (!this.channelsOpen && this.components === 4)
      ? html`
        <div class="alpha-row">
          <span class="ch-label">A</span>
          <scalar-slider
            .fieldPath=${laneKey(this.fieldPath, 3)}
            .min=${0}
            .max=${1}
            .step=${0.01}
            .defaultValue=${v[3] ?? 1}
            .binding=${this.componentBinding(3)}
          ></scalar-slider>
        </div>`
      : nothing;

    return html`
      <div class="color-body">
        <div class="swatch-row">
          ${labelEl}
          <button
            class="caret"
            part="caret"
            title=${this.channelsOpen ? 'Hide channels' : 'Show channels'}
            aria-expanded=${this.channelsOpen ? 'true' : 'false'}
            @click=${() => { this.channelsOpen = !this.channelsOpen; }}
          >${this.channelsOpen ? '\u25BE' : '\u25B8'}</button>
          <input type="color" .value=${this.hex}
                 @input=${this.onColorInput} @change=${this.onColorChange}>
          ${alphaEl}
        </div>
        ${rows}
      </div>
    `;
  }
}
