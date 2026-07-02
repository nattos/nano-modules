/**
 * Custom inspector for source.phase_fold — the limit-cycle phase-portrait
 * generator.
 *
 * Headline control is an XY pad over the baked atlas montage: drag to set
 * eccentricity (x) and lobedness (y), which pick a cell (or a blend of four).
 * The pad is a real FieldEditorElement (controlledFields = eccentricity +
 * lobedness) so the column-group scanner registers it with the layout manager
 * and taps / rails / selection line up like the standard widgets.
 *
 * Autopilot is non-destructive: when on, the effect spirals the effective XY
 * internally and broadcasts it on autopilot_x / autopilot_y; the pad polls those
 * each frame and parks the handle there (mid-drag it shows the cursor instead).
 *
 * The streamline tracer and the limit-cycle tracer are independent GPU stages,
 * each with its own on/off toggle here.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, MultiContinuousEditHandle } from '../widgets/field-editor';
import '../widgets/scalar-slider';
import '../widgets/field-toggle';
import '../widgets/field-tab-bar';
import '../widgets/help-slot';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The draggable atlas XY pad — a multi-field FieldEditorElement controlling
 * `eccentricity` (x) and `lobedness` (y).
 */
@customElement('phase-fold-xy-pad')
export class PhaseFoldXyPad extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'eccentricity';   // primary controlled field
  @property() label = 'Shape';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return ['eccentricity', 'lobedness']; }
  getControlElements(): HTMLElement[] {
    const pad = this.renderRoot?.querySelector('.pad') as HTMLElement | null;
    return pad ? [pad] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private rafId = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  // Both axes must ride in ONE long edit — two separate continuous edits cancel
  // each other (history has a single active long edit), snapping one axis back.
  private edit: MultiContinuousEditHandle | null = null;

  static styles = css`
    :host { display: block; }
    .group-label {
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px;
    }
    .pad {
      position: relative; width: 100%; aspect-ratio: 1 / 1; margin: 2px 0 6px;
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 1px;
      background-image: var(--pf-backdrop, url(/images/phase-fold-backdrop.png));
      background-size: 100% 100%; background-position: center;
      background-color: var(--app-bg-color1);
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
      x = clamp01(typeof ax === 'number' ? ax : (b.getValue('eccentricity') ?? 0.2));
      y = clamp01(typeof ay === 'number' ? ay : (b.getValue('lobedness') ?? 0.2));
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
    this.edit = this.binding.beginContinuousEditMulti?.({ eccentricity: x, lobedness: y }) ?? null;
    if (!this.edit) {
      this.binding.setValue('eccentricity', x);
      this.binding.setValue('lobedness', y);
    }
    this.syncHandle();
  }
  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    if (this.edit) this.edit.update({ eccentricity: x, lobedness: y });
    else { this.binding.setValue('eccentricity', x); this.binding.setValue('lobedness', y); }
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
      <div class="pad-labels"><span>← round</span><span>elongated →</span></div>
    `;
  }
}

@customElement('phase-fold-inspector')
export class PhaseFoldInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
  `;

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    const mode = Number(b.getValue('cycle_mode') ?? 0);   // 0=Relax 1=Tracer 2=Trace
    const isRelax = mode === 0;
    const isTracer = mode === 1;          // tracer with a drawn ring
    const isTrace = mode === 1 || mode === 2;  // any flow tracer
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      <div class="section">Shape</div>
      <help-slot .binding=${b} .path=${'@group/shape'}></help-slot>
      <phase-fold-xy-pad .label=${''} .binding=${b}></phase-fold-xy-pad>
      <scalar-slider style="width: 100%;" .fieldPath=${'jitter'} .label=${'Jitter'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'jitter_speed'} .label=${'Jitter Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'scale'} .label=${'Scale'}
        .min=${0.1} .max=${8} .step=${0.05} .defaultValue=${1} .binding=${b}></scalar-slider>
      <field-toggle .fieldPath=${'interpolate'} .label=${'Interpolate'}
        .defaultValue=${1} .binding=${b}></field-toggle>

      <div class="section">Dynamics</div>
      <help-slot .binding=${b} .path=${'@group/domain'}></help-slot>
      <scalar-slider style="width: 100%;" .fieldPath=${'wind'} .label=${'Wind (z)'}
        .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'wind_jitter'} .label=${'Wind Jitter'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'wind_jitter_speed'} .label=${'Wind Jitter Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'bias'} .label=${'Bias'}
        .min=${-0.6} .max=${0.6} .step=${0.005} .defaultValue=${0} .binding=${b}></scalar-slider>

      <div class="section">Backdrop</div>
      <help-slot .binding=${b} .path=${'@group/backdrop'}></help-slot>
      <field-tab-bar .fieldPath=${'shading_mode'} .label=${'Shading'} ?wrap=${true}
        .options=${[{ label: 'Bands', value: 0 }, { label: 'Gradient', value: 1 },
                    { label: 'Magma', value: 2 }, { label: 'Inferno', value: 3 },
                    { label: 'Viridis', value: 4 }, { label: 'Plasma', value: 5 },
                    { label: 'Turbo', value: 6 }]}
        .defaultValue=${0} .binding=${b}></field-tab-bar>
      <scalar-slider style="width: 100%;" .fieldPath=${'bands'} .label=${'Bands'}
        .min=${2} .max=${24} .step=${1} .defaultValue=${13} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'contrast'} .label=${'Contrast'}
        .min=${0.4} .max=${4} .step=${0.05} .defaultValue=${1.6} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'backdrop_dim'} .label=${'Strength'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.42} .binding=${b}></scalar-slider>

      <div class="section">Streamlines</div>
      <help-slot .binding=${b} .path=${'@group/streamlines'}></help-slot>
      <field-toggle .fieldPath=${'show_streamlines'} .label=${'Show Streamlines'}
        .defaultValue=${1} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'flow_speed'} .label=${'Flow Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'stream_width'} .label=${'Width'}
        .min=${0.002} .max=${0.05} .step=${0.001} .defaultValue=${0.012} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'stream_spread'} .label=${'Spread'}
        .min=${0.5} .max=${4} .step=${0.05} .defaultValue=${1.6} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'line_opacity'} .label=${'Opacity'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.55} .binding=${b}></scalar-slider>

      <div class="section">Limit Cycle</div>
      <help-slot .binding=${b} .path=${'@group/limit_cycle'}></help-slot>
      <field-toggle .fieldPath=${'show_limit_cycle'} .label=${'Show Limit Cycle'}
        .defaultValue=${1} .binding=${b}></field-toggle>
      <field-tab-bar .fieldPath=${'cycle_mode'} .label=${'Algorithm'}
        .options=${[{ label: 'Relax', value: 0 }, { label: 'Tracer', value: 1 }, { label: 'Trace', value: 2 }, { label: 'Contour', value: 3 }]}
        .defaultValue=${0} .binding=${b}></field-tab-bar>
      <scalar-slider style="width: 100%;" .fieldPath=${'cycle_width'} .label=${'Width'}
        .min=${0.004} .max=${0.06} .step=${0.001} .defaultValue=${0.02} .binding=${b}></scalar-slider>
      ${(isRelax || isTracer) ? html`
      <scalar-slider style="width: 100%;" .fieldPath=${'momentum'} .label=${'Momentum'}
        .min=${0} .max=${0.95} .step=${0.01} .defaultValue=${0.6} .binding=${b}></scalar-slider>` : ''}
      ${isRelax ? html`
      <scalar-slider style="width: 100%;" .fieldPath=${'solve_steps'} .label=${'Solve Steps'}
        .min=${1} .max=${16} .step=${1} .defaultValue=${4} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'step_size'} .label=${'Step Size'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.75} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'break_dist'} .label=${'Break Dist'}
        .min=${0.05} .max=${0.6} .step=${0.01} .defaultValue=${0.2} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'break_turn'} .label=${'Break Turn'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'respawn_time'} .label=${'Respawn (s)'}
        .min=${0.1} .max=${10} .step=${0.1} .defaultValue=${2} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'respawn_arc'} .label=${'Respawn Arc'}
        .min=${0} .max=${4} .step=${0.05} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'morph_rate'} .label=${'Morph Rate'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.1} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'explore'} .label=${'Explore'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'spread'} .label=${'Spread'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>` : ''}
      ${isTrace ? html`
      <scalar-slider style="width: 100%;" .fieldPath=${'arc_angle'} .label=${'Arc Angle'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'trace_step'} .label=${'Trace Step'}
        .min=${0.002} .max=${0.06} .step=${0.001} .defaultValue=${0.02} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'trace_steps'} .label=${'Trace Steps/Fr'}
        .min=${1} .max=${16} .step=${1} .defaultValue=${4} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'trace_eps'} .label=${'Loop Eps'}
        .min=${0.01} .max=${0.2} .step=${0.005} .defaultValue=${0.06} .binding=${b}></scalar-slider>` : ''}
      ${isTracer ? html`
      <scalar-slider style="width: 100%;" .fieldPath=${'trace_pull'} .label=${'Trace Pull'}
        .min=${0} .max=${0.4} .step=${0.005} .defaultValue=${0.05} .binding=${b}></scalar-slider>` : ''}

      <div class="section">Autopilot</div>
      <help-slot .binding=${b} .path=${'@group/autopilot'}></help-slot>
      <field-toggle .fieldPath=${'autopilot'} .label=${'Autopilot'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'ap_speed'} .label=${'AP Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.35} .binding=${b}></scalar-slider>

      <div class="section">Skip Empty</div>
      <help-slot .binding=${b} .path=${'@group/skip'}></help-slot>
      <field-toggle .fieldPath=${'skip_empty'} .label=${'Skip Empty'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'skip_thresh'} .label=${'Sensitivity'}
        .min=${0} .max=${0.5} .step=${0.005} .defaultValue=${0.12} .binding=${b}></scalar-slider>
    `;
  }
}

editorRegistry.register('source.phase_fold', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('phase-fold-inspector') as PhaseFoldInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
