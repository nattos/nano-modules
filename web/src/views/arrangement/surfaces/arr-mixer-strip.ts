/**
 * <arr-mixer-strip> — per-track opacity/level control (the "fader" into the bus).
 * In a video tool the "level" is opacity, so this is a field-editor-style
 * <scalar-slider> in its gradient variant (a solid filled bar), shown as a percent.
 * Used in BOTH the track header and the inspector Opacity row.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { LAYER_TARGET_ID } from '../model/composition';
import { WireConnect } from '../../../widgets/taps-connect';
import '../../../widgets/scalar-slider';

const DEFAULT_LEVEL = 0.85;

@customElement('arr-mixer-strip')
export class ArrMixerStrip extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;

  static styles = css`
    :host { display: block; position: relative; }
    scalar-slider { width: 100%; font-size: var(--app-fs-xs); }
    .layer-hit {
      position: absolute; inset: 0; z-index: 2; cursor: crosshair;
      border: 1px dashed color-mix(in srgb, var(--app-accent-color, #7aa2ff) 70%, transparent);
      border-radius: 3px;
    }
    .layer-hit:hover, .layer-hit[tap-drop-target] {
      background: color-mix(in srgb, var(--app-accent-color, #7aa2ff) 18%, transparent);
    }
  `;

  render() {
    const track = store.trackById(this.trackId);
    if (!track) return html``;
    const level = track.level ?? DEFAULT_LEVEL;
    const set = (e: CustomEvent<number>) => store.setTrackLevel(this.trackId, e.detail / 100);
    // Live modulation band: the comp build resolves where this layer's opacity
    // lives (store.layerTargets); telemetry is in field units [0,1] — scale to
    // the slider's percent range.
    const lt = store.layerTargets[this.trackId];
    const mod = lt ? store.modulationData[lt.instanceKey]?.[lt.field] ?? null : null;
    const binding = {
      instanceKey: `layer:${this.trackId}`,
      getValue: () => Math.round((store.trackById(this.trackId)?.level ?? DEFAULT_LEVEL) * 100),
      getModulation: () => mod
        ? { value: mod.value * 100, min: mod.min * 100, max: mod.max * 100,
            neutral: mod.neutral * 100 }
        : null,
      setValue: (_f: string, v: number) => store.setTrackLevel(this.trackId, v / 100),
      beginContinuousEdit: (_f: string, v: number) => {
        store.setTrackLevel(this.trackId, v / 100);
        return {
          update: (nv: number) => store.setTrackLevel(this.trackId, nv / 100),
          accept: () => {},
          cancel: () => {},
        };
      },
    };
    return html`
      <scalar-slider
        gradient
        title="Opacity into the bus"
        .fieldPath=${'level'}
        .binding=${binding as any}
        .value=${Math.round(level * 100)}
        .min=${0}
        .max=${100}
        .step=${1}
        .defaultValue=${100}
        .units=${'%'}
        @input=${set}
        @change=${set}
        @pointerdown=${(e: Event) => e.stopPropagation()}
      ></scalar-slider>
      ${store.wiresMode ? html`
        <div class="tap-overlay-hit layer-hit"
          data-layer-owner=${this.trackId}
          data-layer-field="opacity"
          title="Layer opacity — wire a modulation output or rail here; click to select for automation"
          @pointerdown=${(e: PointerEvent) => {
            // A click-mode connect gesture completes HERE (mirrors the rail
            // lane's drop handler); stop propagation so the header drag/select
            // doesn't cancel it.
            if (WireConnect.active) {
              e.stopPropagation();
              e.preventDefault();
              WireConnect.active.completeOnLayer(this.trackId, 'opacity');
            }
          }}
          @click=${(e: Event) => {
            e.stopPropagation();
            // No gesture in flight: select the layer-opacity automation field.
            if (!WireConnect.active) {
              store.selectAutoField(`track/${this.trackId}`, LAYER_TARGET_ID, 'opacity');
            }
          }}></div>
      ` : nothing}
    `;
  }
}
