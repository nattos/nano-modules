/**
 * Custom inspector for source.brutal_fold — the brutalist axonometric-prism
 * generator.
 *
 * The headline control is an XY pad: a square showing the baked atlas montage
 * (backdrop.png) where the user drags to set complexity (x) and order (y).
 *
 * The pad is a real FieldEditorElement (controlledFields = complexity + order),
 * so the column-group field scanner registers it with the layout manager and tap
 * indicators / rail attachment / selection line up on it just like the standard
 * widgets. The other params use the normal field widgets.
 *
 * Autopilot is a NON-destructive override: when it's on, the effect spirals the
 * effective XY internally without touching the inputs, and broadcasts the live
 * position on autopilot_x / autopilot_y. The pad polls those each frame
 * (requestAnimationFrame) and parks the handle there. While the user is actively
 * dragging we show the drag position for snappy feedback.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, MultiContinuousEditHandle } from '../widgets/field-editor';
import '../widgets/scalar-slider';
import '../widgets/field-toggle';
import '../widgets/field-trigger';
import '../widgets/field-select';
import '../widgets/help-slot';
import './brutal-fold-previews';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The draggable atlas XY pad. A multi-field FieldEditorElement controlling
 * `complexity` (x) and `order` (y) — so the framework treats it as a normal
 * field (taps, layout, selection) even though it's a custom widget.
 */
@customElement('brutal-fold-xy-pad')
export class BrutalFoldXyPad extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'complexity';   // primary controlled field
  @property() label = 'Shape';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return ['complexity', 'order']; }
  getControlElements(): HTMLElement[] {
    const pad = this.renderRoot?.querySelector('.pad') as HTMLElement | null;
    return pad ? [pad] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private rafId = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  // complexity + order must ride in ONE long edit — two separate continuous
  // edits cancel each other (the history has a single active long edit), which
  // is why a naïve two-edit pad snaps one axis back on release.
  private edit: MultiContinuousEditHandle | null = null;

  static styles = css`
    :host { display: block; }
    .group-label {
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px;
    }
    .pad {
      position: relative; width: 100%; aspect-ratio: 1 / 1; margin: 2px 0 6px;
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 1px;
      background-image: var(--bf-backdrop, url(/images/brutal-fold-backdrop.png));
      background-size: 100% 100%; background-position: center;
      background-color: #15131a;
      cursor: crosshair; touch-action: none; user-select: none;
    }
    .handle {
      position: absolute; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #000, 0 0 6px #000;
      transform: translate(-50%, -50%); pointer-events: none; left: 50%; top: 50%;
    }
    .pad-labels {
      display: flex; justify-content: space-between; font-size: var(--app-fs-xs);
      color: var(--app-text-color2, #b0b0b0); margin: -4px 0 2px;
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
      x = clamp01(typeof ax === 'number' ? ax : (b.getValue('complexity') ?? 0.6));
      y = clamp01(typeof ay === 'number' ? ay : (b.getValue('order') ?? 0.6));
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
    this.edit = this.binding.beginContinuousEditMulti?.({ complexity: x, order: y }) ?? null;
    if (!this.edit) {                                  // fallback: one-shot writes
      this.binding.setValue('complexity', x);
      this.binding.setValue('order', y);
    }
    this.syncHandle();
  }
  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    if (this.edit) this.edit.update({ complexity: x, order: y });
    else { this.binding.setValue('complexity', x); this.binding.setValue('order', y); }
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
        <div class="handle"></div>
      </div>
      <div class="pad-labels"><span>← simpler</span><span>more complex →</span></div>
    `;
  }
}

@customElement('brutal-fold-inspector')
export class BrutalFoldInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
  `;

  /** A section header + its help slot (reused across every section). The slot's
   *  default markdown is single-sourced from the schema via binding.helpDefault. */
  private section(title: string, path: string) {
    return html`
      <div class="section">${title}</div>
      <help-slot .binding=${this.binding} .path=${path}></help-slot>
    `;
  }

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      ${this.section('Form', '@group/shape')}
      <brutal-fold-xy-pad .label=${''} .binding=${b}></brutal-fold-xy-pad>
      <scalar-slider style="width: 100%;" .fieldPath=${'liveliness'} .label=${'Liveliness'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'scale'} .label=${'Scale'}
        .min=${0.3} .max=${10} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'balance'} .label=${'Balance'}
        .min=${-1.5} .max=${1.5} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'extrude'} .label=${'Extrude'}
        .min=${0} .max=${6} .step=${0.05} .defaultValue=${1} .binding=${b}></scalar-slider>
      <field-toggle .fieldPath=${'second_structure'} .label=${'2nd Structure'}
        .defaultValue=${1} .binding=${b}></field-toggle>
      <field-toggle .fieldPath=${'interp_cells'} .label=${'Interpolate'}
        .defaultValue=${1} .binding=${b}></field-toggle>

      ${this.section('Animation', '@group/animation')}
      <scalar-slider style="width: 100%;" .fieldPath=${'time_speed'} .label=${'Speed'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'ease'} .label=${'Ease'}
        .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'anim_amount'} .label=${'Anim Amount'}
        .min=${0} .max=${2.5} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      ${this.section('Color Grade', '@group/color')}
      <brutal-fold-diffuse-preview .binding=${b}></brutal-fold-diffuse-preview>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_sat'} .label=${'Strength'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_hue_lo'} .label=${'Shadows Hue'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.58} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_sat_lo'} .label=${'Shadows Sat'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_bri_lo'} .label=${'Shadows Bright'}
        .min=${0} .max=${2} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_hue_mid'} .label=${'Mids Hue'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.08} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_sat_mid'} .label=${'Mids Sat'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_bri_mid'} .label=${'Mids Bright'}
        .min=${0} .max=${2} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_hue_hi'} .label=${'Highs Hue'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.11} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_sat_hi'} .label=${'Highs Sat'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'diff_bri_hi'} .label=${'Highs Bright'}
        .min=${0} .max=${2} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      ${this.section('Atmosphere', '@group/atmosphere')}
      <brutal-fold-fog-preview .binding=${b}></brutal-fold-fog-preview>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog'} .label=${'Fog'}
        .min=${0} .max=${5} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'noise_fog'} .label=${'Fog Static'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'noise_speed'} .label=${'Static Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_sat'} .label=${'Tint'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_hue_lo'} .label=${'Near Hue'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.55} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_sat_lo'} .label=${'Near Sat'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_hue_mid'} .label=${'Mid Hue'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.6} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_sat_mid'} .label=${'Mid Sat'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_hue_hi'} .label=${'Far Hue'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0.66} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'fog_sat_hi'} .label=${'Far Sat'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'sky_hue'} .label=${'Sky Hue +'}
        .min=${-1} .max=${1} .step=${0.005} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'sky_sat'} .label=${'Sky Sat +'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'sky_bri'} .label=${'Sky Bright'}
        .min=${0} .max=${2} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      ${this.section('Volumetrics', '@group/volumetrics')}
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_amount'} .label=${'Amount'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_shape'} .label=${'Shape'}
        .min=${-1} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_angle'} .label=${'Angle'}
        .min=${0} .max=${1} .step=${0.005} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_z'} .label=${'Anchor Z'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_depth'} .label=${'Depth'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_anchor_x'} .label=${'Anchor X'}
        .min=${-1.5} .max=${1.5} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_anchor_y'} .label=${'Anchor Y'}
        .min=${-1.5} .max=${1.5} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_radius'} .label=${'Radius'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_softness_xy'} .label=${'Softness XY'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'vol_softness_z'} .label=${'Softness Z'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'noise_blob'} .label=${'Blob Static'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'noise_blob_tilt'} .label=${'Static Tilt'}
        .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>

      ${this.section('Drift', '@group/drift')}
      <scalar-slider style="width: 100%;" .fieldPath=${'drift_speed'} .label=${'Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'drift_xy'} .label=${'Anchor Drift'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'drift_z'} .label=${'Depth Drift'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'drift_shape'} .label=${'Shape Drift'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'drift_angle'} .label=${'Angle Drift'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>

      ${this.section('Autopilot', '@group/autopilot')}
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

      ${this.section('Skip Empty', '@group/skip')}
      <field-toggle .fieldPath=${'skip_empty'} .label=${'Skip Empty'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_thresh'} .label=${'Sensitivity'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.7} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_w_var'} .label=${'Variance Wt'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_w_edge'} .label=${'Edge Wt'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.07} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_w_motion'} .label=${'Motion Wt'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1.0} .binding=${b}></scalar-slider>
      <field-select .fieldPath=${'skip_debug'} .label=${'Debug View'}
        .options=${[{ label: 'Off', value: 0 }, { label: 'Variance', value: 1 }, { label: 'Edge', value: 2 }, { label: 'Motion', value: 3 }, { label: 'Combined', value: 4 }]}
        .defaultValue=${0} .binding=${b}></field-select>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_recover'} .label=${'Recover'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1.0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_rate'} .label=${'Jog Rate'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <field-toggle .fieldPath=${'skip_autopilot'} .label=${'Jog Autopilot'}
        .defaultValue=${1} .binding=${b}></field-toggle>
    `;
  }
}

editorRegistry.register('source.brutal_fold', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('brutal-fold-inspector') as BrutalFoldInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
