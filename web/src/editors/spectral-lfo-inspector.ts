/**
 * Custom inspector for data.spectral_lfo — the spectral-morph LFO generator.
 *
 * The headline control is an XY pad over the t-SNE manifold: the baked shape
 * atlas is drawn as a faint scatter (per the selected metric), and the user
 * drags to set morph_x / morph_y — the position that selects + morphs the
 * surrounding LFO shapes. Same shape as the *_fold inspectors.
 *
 * The pad is a real FieldEditorElement (controlledFields = morph_x + morph_y),
 * so the column-group field scanner registers it with the layout manager and
 * tap indicators / rail attachment / selection line up like the standard
 * widgets. The other params use the normal field widgets.
 *
 * Autopilot is a NON-destructive override: when on, the effect orbits the
 * manifold internally without touching the inputs, and broadcasts the live
 * position on autopilot_x / autopilot_y. The pad polls those each frame and
 * parks the handle there; mid-drag it shows the cursor for snappy feedback.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, MultiContinuousEditHandle } from '../widgets/field-editor';
import { decodeScatter, SCATTER_NUM_METRICS, SCATTER_NUM_POINTS } from './spectral-lfo-scatter-data';
import '../widgets/scalar-slider';
import '../widgets/field-select';
import '../widgets/field-toggle';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const METRIC_OPTIONS = [
  { label: 'FFT Magnitude', value: 0 },
  { label: 'Phase Coherence', value: 1 },
  { label: 'Roughness', value: 2 },
  { label: 'Spectral vs TD', value: 3 },
  { label: 'Combined', value: 4 },
];

// Decoded once, shared by every pad instance.
const SCATTER = decodeScatter();

/**
 * The draggable manifold XY pad. A multi-field FieldEditorElement controlling
 * `morph_x` (x) and `morph_y` (y) — so the framework treats it as a normal
 * field (taps, layout, selection) even though it's a custom widget. A canvas
 * backdrop renders the t-SNE scatter for the active metric.
 */
@customElement('spectral-lfo-xy-pad')
export class SpectralLfoXyPad extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'morph_x';   // primary controlled field
  @property() label = 'Manifold';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return ['morph_x', 'morph_y']; }
  getControlElements(): HTMLElement[] {
    const pad = this.renderRoot?.querySelector('.pad') as HTMLElement | null;
    return pad ? [pad] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private rafId = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  // morph_x + morph_y must ride in ONE long edit — two separate continuous edits
  // cancel each other (history has a single active long edit), snapping one back.
  private edit: MultiContinuousEditHandle | null = null;
  // Backdrop redraw memo (only when metric or canvas size changes).
  private drawnMetric = -1;
  private drawnW = 0;
  private drawnH = 0;

  static styles = css`
    :host { display: block; }
    .group-label {
      font-size: 10px; color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px;
    }
    .pad {
      position: relative; width: 100%; aspect-ratio: 1 / 1; margin: 2px 0 6px;
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 4px;
      background-color: #0b0b12; overflow: hidden;
      cursor: crosshair; touch-action: none; user-select: none;
    }
    .scatter {
      position: absolute; inset: 0; width: 100%; height: 100%;
      pointer-events: none; display: block;
    }
    .handle {
      position: absolute; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #000, 0 0 6px #000;
      transform: translate(-50%, -50%); pointer-events: none; left: 50%; top: 50%;
    }
    .pad-caption {
      text-align: center; font-size: 9px;
      color: var(--app-text-color2, #8a8296); margin: -4px 0 2px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.frame(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private currentMetric(): number {
    const m = Number(this.binding?.getValue('metric') ?? 0);
    return m >= 0 && m < SCATTER_NUM_METRICS ? (m | 0) : 0;
  }

  private frame() {
    this.drawScatter();
    this.syncHandle();
  }

  // Repaint the manifold scatter when the metric or the canvas size changes.
  private drawScatter() {
    const canvas = this.renderRoot?.querySelector('.scatter') as HTMLCanvasElement | null;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    const metric = this.currentMetric();
    if (metric === this.drawnMetric && w === this.drawnW && h === this.drawnH) return;
    this.drawnMetric = metric; this.drawnW = w; this.drawnH = h;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(150, 180, 255, 0.5)';
    const r = Math.max(1, Math.round(dpr));
    const base = metric * SCATTER_NUM_POINTS * 2;
    for (let i = 0; i < SCATTER_NUM_POINTS; i++) {
      const x = (SCATTER[base + i * 2] / 255) * w;
      const y = (1 - SCATTER[base + i * 2 + 1] / 255) * h;   // y up
      ctx.fillRect(x - r * 0.5, y - r * 0.5, r, r);
    }
  }

  // Park the handle at the live autopilot position (or, mid-drag, at the cursor).
  private syncHandle() {
    const handle = this.renderRoot?.querySelector('.handle') as HTMLElement | null;
    if (!handle || !this.binding) return;
    let x: number, y: number;
    if (this.dragging) {
      x = this.dragX; y = this.dragY;
    } else {
      const b = this.binding;
      const ax = b.getValue('autopilot_x');
      const ay = b.getValue('autopilot_y');
      x = clamp01(typeof ax === 'number' ? ax : (b.getValue('morph_x') ?? 0.5));
      y = clamp01(typeof ay === 'number' ? ay : (b.getValue('morph_y') ?? 0.5));
    }
    handle.style.left = x * 100 + '%';
    handle.style.top = (1 - y) * 100 + '%';
  }

  private xyFromEvent(e: PointerEvent, pad: HTMLElement): [number, number] {
    const r = pad.getBoundingClientRect();
    const x = clamp01((e.clientX - r.left) / r.width);
    const y = clamp01(1 - (e.clientY - r.top) / r.height);  // y up
    return [x, y];
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    pad.setPointerCapture(e.pointerId);
    this.dragging = true;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    this.edit = this.binding.beginContinuousEditMulti?.({ morph_x: x, morph_y: y }) ?? null;
    if (!this.edit) {                                  // fallback: one-shot writes
      this.binding.setValue('morph_x', x);
      this.binding.setValue('morph_y', y);
    }
    this.syncHandle();
  }
  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    if (this.edit) this.edit.update({ morph_x: x, morph_y: y });
    else { this.binding.setValue('morph_x', x); this.binding.setValue('morph_y', y); }
    this.syncHandle();
  }
  private onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.edit?.accept();
    this.edit = null;
  }

  render() {
    return html`
      ${this.label ? html`<div class="group-label">${this.label}</div>` : ''}
      <div class="pad"
        @pointerdown=${(e: PointerEvent) => this.onPointerDown(e)}
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${() => this.onPointerUp()}
        @pointercancel=${() => this.onPointerUp()}>
        <canvas class="scatter"></canvas>
        <div class="handle"></div>
      </div>
      <div class="pad-caption">spectral manifold</div>
    `;
  }
}

@customElement('spectral-lfo-inspector')
export class SpectralLfoInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
  `;

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <div class="section">Shape</div>
      <spectral-lfo-xy-pad .label=${''} .binding=${b}></spectral-lfo-xy-pad>
      <field-select .fieldPath=${'metric'} .label=${'Metric'}
        .options=${METRIC_OPTIONS} .defaultValue=${0} .binding=${b}></field-select>
      <field-toggle .fieldPath=${'interpolation'} .label=${'Interpolation'}
        .defaultValue=${1} .binding=${b}></field-toggle>

      <div class="section">Output</div>
      <scalar-slider style="width: 100%;" .fieldPath=${'rate'} .label=${'Rate'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.4} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'amplitude'} .label=${'Amplitude'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      <div class="section">Autopilot</div>
      <field-toggle .fieldPath=${'autopilot'} .label=${'Autopilot'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'ap_speed'} .label=${'AP Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
    `;
  }
}

editorRegistry.register('data.spectral_lfo', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('spectral-lfo-inspector') as SpectralLfoInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
