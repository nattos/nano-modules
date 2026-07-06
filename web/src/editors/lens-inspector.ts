/**
 * Custom inspector for filter.blur.lens — the photographic-lens sim.
 *
 * The effect has ~45 knobs. The stock column-group renders them fine; the ONLY
 * reason this custom inspector exists is the PRESET picker. `preset` is an inert
 * schema field (the shader stores it but ignores it). Picking a look must set a
 * whole bundle of character params (coating, bokeh, flare, finish) as ONE undo
 * step — a stock <field-select> would fire its own single-field edit and leave
 * the siblings untouched.
 *
 * So we render `preset` as a plain <select> whose @change applies the baked
 * override dict via `beginContinuousEditMulti({ preset, ...overrides }).accept()`
 * — one Immer transaction = one undo point covering the preset + every param it
 * touches (same mechanism as the brutal-fold XY pad). Everything else is stock
 * widgets bound through the same FieldBinding.
 *
 * LENS_PRESETS is baked from the prototype's presets.py (LOOKS), translated to
 * the effect's NORMALIZED schema ids/ranges: `coating` string→enum index,
 * `distortion` raw ÷ DIST_SCALE(0.30), `tca` raw ÷ TCA_SCALE(0.03), cats_eye
 * clamped to the [0,1] slider, sun_color as an rgb array. Only the keys a preset
 * overrides appear — every other param stays as the user left it.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import '../widgets/scalar-slider';
import '../widgets/field-tab-bar';
import '../widgets/field-color';
import '../widgets/field-vec';
import '../widgets/help-slot';

/** Baked lens looks, keyed by the `preset` select value (0 = Custom = no-op). */
export const LENS_PRESETS: Record<number, Record<string, number | number[]>> = {
  // 1 — Modern Prime: neutral SMC, rounded creamy bokeh, gentle everything.
  1: {
    coating: 0, blades: 9, blade_curvature: 0.6, apodize: 0.6, rim: 0.10,
    onion_ring: 0.04, loca: 0.10, cats_eye: 0.6, field_curvature: 0.4,
    tca: 0.133, distortion: -0.067, hl_desat: 0.6, halation: 0.15, bloom: 0.10,
    tone: 0.9, tone_black: 0.02, grain: 0.04, mech_vignette: 0.22,
  },
  // 2 — Vintage: warm single-coat, swirl, busy rim, heavy character.
  2: {
    coating: 1, warmth: 0.16, blades: 8, blade_curvature: 0.2, apodize: 0.35,
    rim: 0.35, onion_ring: 0.25, loca: 0.42, cats_eye: 1.0, swirl: 0.75,
    field_curvature: 0.8, element_curvature: 0.5, tca: 0.433, distortion: -0.167,
    hl_desat: 0.4, halation: 0.35, bloom: 0.15, tone: 0.7, tone_black: 0.015,
    grain: 0.09, mech_vignette: 0.36,
  },
  // 3 — Anamorphic: oval bokeh, cool cast, mild squeeze distortion.
  3: {
    coating: 0, blades: 7, blade_curvature: 0.3, anamorphic: 0.5, apodize: 0.5,
    cats_eye: 0.85, loca: 0.15, sun_color: [0.5, 0.7, 1.0], tca: 0.2,
    distortion: -0.10, hl_desat: 0.55, halation: 0.22, bloom: 0.12, tone: 0.85,
    tone_black: 0.02, grain: 0.05, mech_vignette: 0.3,
  },
  // 4 — Dreamy: very soft, blooming, low contrast, big rounded bokeh. (Blur
  // Amount is the overall DOF-strength knob — a preset never touches it; the
  // prototype's coc_amount override is deliberately dropped here.)
  4: {
    coating: 1, warmth: 0.10, blades: 11, blade_curvature: 0.85, apodize: 0.8,
    rim: 0.05, onion_ring: 0.0, loca: 0.15, cats_eye: 0.5,
    bloom: 0.4, halation: 0.42, hl_desat: 0.7, tone: 0.6, tone_black: 0.0,
    grain: 0.05, mech_vignette: 0.26,
  },
  // 5 — Clinical: sterile, punchy, apochromatic, no grain — deliberately perfect.
  5: {
    coating: 0, blades: 9, blade_curvature: 0.9, apodize: 0.4, rim: 0.05,
    onion_ring: 0.0, loca: 0.0, tca: 0.0, cats_eye: 0.3, field_curvature: 0.1,
    halation: 0.05, bloom: 0.05, hl_desat: 0.5, tone: 1.0, tone_black: 0.03,
    grain: 0.0, mech_vignette: 0.10,
  },
};

/**
 * The single multi-field edit a preset selection applies: the `preset` value
 * itself (for serialization) plus every character override it bundles. Custom
 * (0) carries no overrides, so it just records the choice. Pure — the inspector
 * feeds this to `beginContinuousEditMulti().accept()` for one undo point.
 */
export function lensPresetEdit(value: number): Record<string, number | number[]> {
  return { preset: value, ...(LENS_PRESETS[value] ?? {}) };
}

const PRESET_OPTIONS = [
  { label: 'Custom', value: 0 },
  { label: 'Modern Prime', value: 1 },
  { label: 'Vintage', value: 2 },
  { label: 'Anamorphic', value: 3 },
  { label: 'Dreamy', value: 4 },
  { label: 'Clinical', value: 5 },
];

@customElement('lens-inspector')
export class LensInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
    /* Preset picker: a tab bar (matching <field-tab-bar>) rather than a stock
       widget, because its click must apply the whole override bundle as one undo
       point — a plain <field-tab-bar> would fire its own single-field edit. */
    .preset-row {
      display: flex; align-items: flex-start; gap: var(--app-sp-3);
      padding: 2px 0; margin: 2px 0 4px; font-size: var(--app-fs-sm);
    }
    .preset-row .label {
      min-width: 70px; flex-shrink: 0; padding-top: 4px;
      color: var(--app-text-color2, #b0b0b0);
    }
    .tabs {
      display: inline-flex; flex: 1; min-width: 0; flex-wrap: wrap; justify-content: center;
      border: 1px solid var(--app-tint-4); border-radius: 4px;
      overflow: hidden; background: var(--app-bg-color1);
    }
    .tabs button {
      flex: 0 1 auto; min-width: 0; background: transparent; border: none;
      border-left: 1px solid var(--app-tint-4); color: var(--app-text-color2, #b0b0b0);
      font-size: var(--app-fs-sm); font-family: inherit; padding: 3px 9px;
      cursor: pointer; text-align: center; white-space: nowrap;
    }
    .tabs button:first-child { border-left: none; }
    .tabs button:hover { background: var(--app-tint-2); color: var(--app-text-color1, #eaeaea); }
    .tabs button[active] {
      color: var(--app-hi-color2, #4169E1); background: var(--app-tint-3);
      box-shadow: inset 0 -2px 0 var(--app-hi-color2, #4169E1);
    }
    .tabs button[active]:hover { background: var(--app-tint-3); }
  `;

  /** Section header + its schema-sourced help slot. */
  private section(title: string, groupId: string) {
    return html`
      <div class="section">${title}</div>
      <help-slot .binding=${this.binding} .path=${'@group/' + groupId}></help-slot>
    `;
  }

  /** A stock scalar slider bound to `id`. */
  private s(id: string, label: string, min: number, max: number, step: number,
            def: number, units = '') {
    return html`<scalar-slider style="width: 100%;" .fieldPath=${id} .label=${label}
      .min=${min} .max=${max} .step=${step} .defaultValue=${def} .units=${units}
      .binding=${this.binding}></scalar-slider>`;
  }

  /** Apply a preset as ONE undo point (preset field + all its overrides). */
  private applyPreset(value: number) {
    this.binding?.beginContinuousEditMulti?.(lensPresetEdit(value))?.accept();
  }

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    const preset = Math.round(Number(b.getValue('preset') ?? 0));
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>

      <div class="preset-row">
        <span class="label">Preset</span>
        <div class="tabs">
          ${PRESET_OPTIONS.map((o) => html`
            <button ?active=${o.value === preset} @click=${() => this.applyPreset(o.value)}>${o.label}</button>`)}
        </div>
      </div>

      ${this.section('Depth of Field', 'focus')}
      ${this.s('blur_amount', 'Blur Amount', 0, 1, 0.01, 0.16)}
      ${this.s('field_curvature', 'Field Curvature', 0, 1, 0.01, 0)}
      <field-vec .fieldPath=${'focus_center'} .label=${'Focus Centre'} .components=${2}
        .min=${-1} .max=${1} .step=${0.01} .defaultValue=${[0, 0]}
        .binding=${b}></field-vec>

      ${this.section('Bokeh Shape', 'bokeh')}
      ${this.s('blades', 'Blades', 3, 14, 1, 7)}
      ${this.s('blade_curvature', 'Roundness', 0, 1, 0.01, 0.15)}
      ${this.s('aperture_rotation', 'Iris Rotation', 0, 1, 0.01, 0)}
      ${this.s('cats_eye', "Cat's Eye", 0, 1, 0.01, 0.8)}
      ${this.s('swirl', 'Swirl', 0, 1, 0.01, 0)}
      ${this.s('anamorphic', 'Anamorphic', 0, 1, 0.01, 0)}
      ${this.s('loca', 'LoCA', 0, 1, 0.01, 0.25)}
      ${this.s('rim', 'Rim', 0, 1, 0.01, 0.12)}
      ${this.s('onion_ring', 'Onion Ring', 0, 1, 0.01, 0.06)}
      ${this.s('apodize', 'Apodize', 0, 1, 0.01, 0.55)}

      ${this.section('Highlights', 'highlight')}
      ${this.s('hl_threshold', 'HL Threshold', 0, 2, 0.01, 1.0)}
      ${this.s('hl_boost', 'HL Boost', 0, 1, 0.01, 0.375)}

      ${this.section('Coating & Colour', 'coating')}
      <field-tab-bar .fieldPath=${'coating'} .label=${'Coating'}
        .options=${[{ label: 'SMC', value: 0 }, { label: 'Single', value: 1 },
                    { label: 'Uncoated', value: 2 }, { label: 'Custom', value: 3 }]}
        .defaultValue=${0} .binding=${b}></field-tab-bar>
      ${this.s('warmth', 'Warmth', -1, 1, 0.01, 0)}
      ${this.s('transmission', 'Transmission', 0.5, 1.5, 0.01, 1.0)}

      ${this.section('Flare & Glare', 'flare')}
      ${this.s('flare_strength', 'Veiling Glare', 0, 1, 0.01, 0.5)}
      ${this.s('hood_extension', 'Hood Extension', 0, 1, 0.01, 1.0)}
      ${this.s('hood_shape', 'Hood Shape', 0, 1, 0.01, 0.3)}

      ${this.section('Sun / Stray Light', 'sun')}
      ${this.s('sun_intensity', 'Sun Intensity', 0, 1, 0.01, 0)}
      ${this.s('sun_azimuth', 'Sun Azimuth', 0, 1, 0.01, 0.0955)}
      ${this.s('sun_obliqueness', 'Obliqueness', 0, 1, 0.01, 0.35)}
      <field-color .fieldPath=${'sun_color'} .label=${'Sun Colour'} .components=${3}
        .defaultValue=${[1, 0.85, 0.6]} .binding=${b}></field-color>
      ${this.s('sun_veil', 'Sun Veil', 0, 1, 0.01, 0.6)}
      ${this.s('sun_glow', 'Sun Glow', 0, 1, 0.01, 0.7)}
      ${this.s('sun_streak', 'Sun Streak', 0, 1, 0.01, 0.18)}
      ${this.s('sun_ghost', 'Sun Ghost', 0, 1, 0.01, 0.15)}
      ${this.s('element_curvature', 'Element Curve', 0, 1, 0.01, 0.45)}
      ${this.s('dispersion', 'Dispersion', 0, 1, 0.01, 0.35)}

      ${this.section('Halation & Bloom', 'glow')}
      ${this.s('halation', 'Halation', 0, 1, 0.01, 0.22)}
      <field-color .fieldPath=${'halation_color'} .label=${'Halation Colour'} .components=${3}
        .defaultValue=${[1, 0.4, 0.22]} .binding=${b}></field-color>
      ${this.s('bloom', 'Bloom', 0, 1, 0.01, 0.12)}

      ${this.section('Distortion', 'geometry')}
      ${this.s('distortion', 'Distortion', -1, 1, 0.01, 0)}
      ${this.s('distortion_wave', 'Mustache', -1, 1, 0.01, 0)}
      ${this.s('tca', 'Chromatic Aberration', 0, 1, 0.01, 0)}

      ${this.section('Finish', 'finish')}
      ${this.s('exposure', 'Exposure', -1, 1, 0.01, 0)}
      ${this.s('mech_vignette', 'Vignette', 0, 1, 0.01, 0.25)}
      ${this.s('hl_desat', 'HL Desat', 0, 1, 0.01, 0.6)}
      ${this.s('tone', 'Tone', 0, 1, 0.01, 0.85)}
      ${this.s('tone_black', 'Black Point', 0, 1, 0.01, 0.02)}
      ${this.s('grain', 'Grain', 0, 1, 0.01, 0.05)}

      ${this.section('Quality', 'quality')}
      <field-tab-bar .fieldPath=${'quality'} .label=${'Quality'}
        .options=${[{ label: 'Cheap', value: 0 }, { label: 'Standard', value: 1 },
                    { label: 'Max', value: 2 }]}
        .defaultValue=${1} .binding=${b}></field-tab-bar>
      ${this.s('taps', 'Taps', 16, 192, 1, 96)}
      ${this.s('work_radius', 'Work Radius', 4, 24, 0.5, 11, 'px')}
      ${this.s('fill', 'Fill', 0, 2, 0.05, 0.7, 'px')}

      ${this.section('Debug', 'debug')}
      <field-tab-bar .fieldPath=${'debug_view'} .label=${'Debug View'} ?wrap=${true}
        .options=${[{ label: 'Off', value: 0 }, { label: 'Highlight Mask', value: 1 },
                    { label: 'CoC Field', value: 2 }, { label: 'Bokeh Only', value: 3 },
                    { label: 'Flare Only', value: 4 }]}
        .defaultValue=${0} .binding=${b}></field-tab-bar>
    `;
  }
}

editorRegistry.register('filter.blur.lens', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('lens-inspector') as LensInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
