/**
 * <arr-mixer-strip> — per-track opacity/level control (the "fader" into the bus).
 * In a video tool the "level" is opacity, so this is a field-editor-style
 * <scalar-slider> in its gradient variant (a solid filled bar), shown as a percent.
 * Used in BOTH the track header and the inspector Opacity row.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import '../../../widgets/scalar-slider';

const DEFAULT_LEVEL = 0.85;

@customElement('arr-mixer-strip')
export class ArrMixerStrip extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;

  static styles = css`
    :host { display: block; }
    scalar-slider { width: 100%; font-size: var(--app-fs-xs); }
  `;

  render() {
    const track = store.trackById(this.trackId);
    if (!track) return html``;
    const level = track.level ?? DEFAULT_LEVEL;
    const set = (e: CustomEvent<number>) => store.setTrackLevel(this.trackId, e.detail / 100);
    return html`
      <scalar-slider
        gradient
        title="Opacity into the bus"
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
    `;
  }
}
