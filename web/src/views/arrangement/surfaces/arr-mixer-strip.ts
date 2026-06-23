/**
 * <arr-mixer-strip> — compact per-track mixer control for the track header: an
 * output-level fader (drag to set). In a video tool the "level" is opacity/gain
 * into the bus. (No audio meter — this is a video tool.)
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
  `;

  render() {
    const track = store.trackById(this.trackId);
    if (!track) return html``;
    const level = track.level ?? DEFAULT_LEVEL;

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
