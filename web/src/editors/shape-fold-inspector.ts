/**
 * Custom inspector for video.shape_fold — the evolving-shape generator.
 *
 * The headline control is an XY pad: a square showing the baked atlas montage
 * (backdrop.png) where the user drags to set frequency (x) and simplicity (y).
 *
 * The pad is a real FieldEditorElement (controlledFields = frequency +
 * simplicity), so the column-group field scanner registers it with the layout
 * manager and tap indicators / rail attachment / selection line up on it just
 * like the standard widgets. The other params use the normal field widgets.
 *
 * Autopilot is a NON-destructive override: when it's on, the effect spirals the
 * effective XY internally without touching the inputs, and broadcasts the live
 * position on autopilot_x / autopilot_y. The pad polls those each frame
 * (requestAnimationFrame) and parks the handle there — so it shows the live
 * autopilot motion even though the inputs aren't changing. While the user is
 * actively dragging we show the drag position for snappy feedback.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from '../widgets/field-editor';
import '../widgets/scalar-slider';
import '../widgets/field-select';
import '../widgets/field-toggle';
import '../widgets/field-trigger';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The draggable atlas XY pad. A multi-field FieldEditorElement controlling
 * `frequency` (x) and `simplicity` (y) — so the framework treats it as a normal
 * field (taps, layout, selection) even though it's a custom widget.
 */
@customElement('shape-fold-xy-pad')
export class ShapeFoldXyPad extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'frequency';   // primary controlled field
  @property() label = 'Shape';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return ['frequency', 'simplicity']; }
  getControlElements(): HTMLElement[] {
    const pad = this.renderRoot?.querySelector('.pad') as HTMLElement | null;
    return pad ? [pad] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private rafId = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private editX: ContinuousEditHandle | null = null;
  private editY: ContinuousEditHandle | null = null;

  static styles = css`
    :host { display: block; }
    .group-label {
      font-size: 10px; color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px;
    }
    .pad {
      position: relative; width: 100%; aspect-ratio: 1 / 1; margin: 2px 0 6px;
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 4px;
      background-image: var(--sf-backdrop, url(/images/shape-fold-backdrop.png));
      background-size: 100% 100%; background-position: center;
      cursor: crosshair; touch-action: none; user-select: none;
    }
    .handle {
      position: absolute; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #000, 0 0 6px #000;
      transform: translate(-50%, -50%); pointer-events: none; left: 50%; top: 50%;
    }
    .pad-labels {
      display: flex; justify-content: space-between; font-size: 9px;
      color: var(--app-text-color2, #8a8296); margin: -4px 0 2px;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.syncHandle(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
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
      x = clamp01(typeof ax === 'number' ? ax : (b.getValue('frequency') ?? 0.25));
      y = clamp01(typeof ay === 'number' ? ay : (b.getValue('simplicity') ?? 0.85));
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
    this.editX = this.binding.beginContinuousEdit('frequency', x);
    this.editY = this.binding.beginContinuousEdit('simplicity', y);
    this.syncHandle();
  }
  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    this.editX?.update(x);
    this.editY?.update(y);
    this.syncHandle();
  }
  private onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.editX?.accept(); this.editX = null;
    this.editY?.accept(); this.editY = null;
  }

  render() {
    return html`
      ${this.label ? html`<div class="group-label">${this.label}</div>` : ''}
      <div class="pad"
        @pointerdown=${(e: PointerEvent) => this.onPointerDown(e)}
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${() => this.onPointerUp()}
        @pointercancel=${() => this.onPointerUp()}>
        <div class="handle"></div>
      </div>
      <div class="pad-labels"><span>← low freq</span><span>high freq →</span></div>
    `;
  }
}

@customElement('shape-fold-inspector')
export class ShapeFoldInspector extends MobxLitElement {
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
      <shape-fold-xy-pad .label=${''} .binding=${b}></shape-fold-xy-pad>

      <scalar-slider style="width: 100%;" .fieldPath=${'temporal_complexity'} .label=${'Temporal'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.66} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'scale'} .label=${'Scale'}
        .min=${0.1} .max=${8} .step=${0.05} .defaultValue=${1} .binding=${b}></scalar-slider>

      <div class="section">Animation</div>
      <scalar-slider style="width: 100%;" .fieldPath=${'time_speed'} .label=${'Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.58} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'ease'} .label=${'Ease'}
        .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'birth_softness'} .label=${'Birth Soft'}
        .min=${0.02} .max=${1} .step=${0.01} .defaultValue=${0.45} .binding=${b}></scalar-slider>

      <div class="section">Autopilot</div>
      <field-toggle .fieldPath=${'autopilot'} .label=${'Autopilot'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'ap_speed'} .label=${'AP Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.43} .binding=${b}></scalar-slider>
      <field-toggle .fieldPath=${'ap_snap'} .label=${'Snap'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'ap_hold_period'} .label=${'Hold (s)'}
        .min=${0} .max=${8} .step=${0.25} .defaultValue=${2} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'ap_hold_jitter'} .label=${'Hold Jit'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <field-trigger .fieldPath=${'ap_jump'} .label=${'Jump'} .binding=${b}></field-trigger>

      <div class="section">Levels</div>
      <scalar-slider style="width: 100%;" .fieldPath=${'level_ease'} .label=${'Level Ease'}
        .min=${0} .max=${0.5} .step=${0.005} .defaultValue=${0.25} .binding=${b}></scalar-slider>

      <div class="section">Output</div>
      <scalar-slider style="width: 100%;" .fieldPath=${'exposure'} .label=${'Exposure'}
        .min=${0} .max=${4} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <field-select .fieldPath=${'output_mode'} .label=${'Mode'}
        .options=${[{ label: 'Grayscale', value: 0 }, { label: 'Magma', value: 1 },
                    { label: 'Inferno', value: 2 }, { label: 'Viridis', value: 3 },
                    { label: 'Plasma', value: 4 }, { label: 'Turbo', value: 5 }]}
        .defaultValue=${1} .binding=${b}></field-select>
    `;
  }
}

editorRegistry.register('video.shape_fold', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('shape-fold-inspector') as ShapeFoldInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
