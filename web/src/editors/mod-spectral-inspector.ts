/**
 * Custom inspector for mod.spectral — the Spectral Curve modulation remapper.
 *
 * It reuses data.spectral_lfo's morph controls: the <spectral-lfo-xy-pad> picks
 * the manifold position (morph_x/morph_y) and <spectral-lfo-preview> draws the
 * morphed curve. Unlike the LFO (which sweeps the curve over time), this shaper
 * INDEXES the curve by its `input` value — so we park the preview's playhead at
 * the live input (the remap "lookup" position), giving the same feedback as the
 * envelope shaper. An `input` slider lets you scrub it / exposes a wire port.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import { METRIC_OPTIONS, type SpectralLfoPreview } from './spectral-lfo-inspector';  // defines the pad + preview tags
import '../widgets/scalar-slider';
import '../widgets/field-select';
import '../widgets/field-toggle';

@customElement('mod-spectral-inspector')
export class ModSpectralInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;
  private rafId = 0;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Drive the preview playhead from the live modulation input each frame.
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const preview = this.renderRoot?.querySelector('spectral-lfo-preview') as SpectralLfoPreview | null;
      if (!preview || !this.binding) return;
      const mod = this.binding.getModulation?.('input');
      const live = mod ? mod.value : this.binding.getValue('input');
      preview.cursor = typeof live === 'number' ? live : null;
    };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <div class="section">Manifold</div>
      <spectral-lfo-xy-pad .label=${''} .binding=${b}></spectral-lfo-xy-pad>
      <spectral-lfo-preview .binding=${b}></spectral-lfo-preview>
      <field-select .fieldPath=${'metric'} .label=${'Metric'}
        .options=${METRIC_OPTIONS} .defaultValue=${0} .binding=${b}></field-select>
      <field-toggle .fieldPath=${'interpolation'} .label=${'Interpolation'}
        .defaultValue=${1} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'amplitude'} .label=${'Amplitude'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      <div class="section">Input</div>
      <scalar-slider style="width: 100%;" .fieldPath=${'input'} .label=${'Input'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
    `;
  }
}

editorRegistry.register('mod.spectral', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('mod-spectral-inspector') as ModSpectralInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
