/**
 * <arr-mixer-strip> — compact per-track mixer controls for the track header:
 * an output-level fader (drag to set) and an animated level meter. Prototypes
 * the channel-strip feel; in a video tool the "level" is opacity/gain into the
 * bus. The meter is a fake reading driven by transport position (mockup).
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';

const DEFAULT_LEVEL = 0.85;

@customElement('arr-mixer-strip')
export class ArrMixerStrip extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;

  static styles = css`
    :host {
      display: block;
    }
    .strip {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .fline {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .fader {
      position: relative;
      flex: 1;
      height: 9px;
      border-radius: 2px;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3);
      cursor: ew-resize;
      overflow: hidden;
      touch-action: none;
    }
    .fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: linear-gradient(90deg, var(--app-tint-5), var(--app-hi-color2));
      opacity: 0.7;
    }
    .knob {
      position: absolute;
      top: -2px;
      width: 2px;
      height: 13px;
      background: var(--app-text-color1);
      border-radius: 1px;
    }
    .val {
      font-size: 8px;
      color: var(--app-text-color2);
      width: 22px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .meter {
      height: 4px;
      border-radius: 2px;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-2);
      overflow: hidden;
    }
    .mfill {
      height: 100%;
      transition: width 60ms linear;
    }
  `;

  render() {
    const track = store.trackById(this.trackId);
    if (!track) return html``;
    const level = track.level ?? DEFAULT_LEVEL;

    // Fake meter level from transport position (deterministic per track).
    const seed = this.trackId.length * 1.7 + this.trackId.charCodeAt(0);
    const env = store.playing
      ? 0.25 + 0.65 * Math.abs(Math.sin(store.positionBeat * 1.8 + seed))
      : 0.04;
    const meter = Math.min(1, env * level);
    const mColor =
      meter > 0.9 ? 'var(--app-error)' : meter > 0.7 ? 'var(--app-warn)' : 'var(--app-ok)';

    return html`
      <div class="strip">
        <div class="fline">
          <div
            class="fader"
            title="Level"
            @pointerdown=${this.onDown}
          >
            <div class="fill" style="width:${level * 100}%"></div>
            <div class="knob" style="left:calc(${level * 100}% - 1px)"></div>
          </div>
          <span class="val">${Math.round(level * 100)}</span>
        </div>
        <div class="meter">
          <div class="mfill" style="width:${meter * 100}%; background:${mColor}"></div>
        </div>
      </div>
    `;
  }

  private faderEl(e: Event): HTMLElement {
    return (e.currentTarget as HTMLElement);
  }

  private onDown = (e: PointerEvent) => {
    e.stopPropagation(); // don't trigger header selection
    const el = this.faderEl(e);
    el.setPointerCapture(e.pointerId);
    this.setFromEvent(e, el);
    const move = (ev: PointerEvent) => this.setFromEvent(ev, el);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  private setFromEvent(e: PointerEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    store.setTrackLevel(this.trackId, (e.clientX - r.left) / r.width);
  }
}
