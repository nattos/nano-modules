/**
 * <device-encoder> — one rotary encoder in a device surface: LED ring (270°
 * track + value arc), cap disc, pointer line. Line-drawing styled (1px
 * strokes over tint colors; ring/cap colors from the device config).
 *
 * Deliberately NOT FieldBinding-backed (scalar-knob's text-edit/reset
 * semantics don't apply): the surface's single rAF loop pushes merged
 * live+sim values in imperatively via `setLive()` — no MobX/Lit re-render at
 * MIDI rate. Lit renders only structural bits (colors, label, selection).
 *
 * Pointer gestures (simulate-drag vs select-click) are resolved here and
 * surfaced as events; the surface decides what they mean:
 *   'control-drag'      detail: { value }        (vertical drag, 0..1)
 *   'control-drag-end'  detail: {}
 *   'control-click'     detail: { additive, range }
 * While W wire mode is on, pointer handling is disabled entirely — the
 * surface's tap-overlay hit zones sit above and own the pointer.
 */

import { html, css, svg, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { CancelReason, PointerDragOp } from '../../utils/pointer-drag-op';

const DRAG_RANGE_PX = 160;   // same feel as scalar-knob
const RING_R = 44;
const CAP_R = 27;
const START_DEG = 135;       // 270° sweep, gap at the bottom
const SWEEP_DEG = 270;

function polar(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [50 + r * Math.cos(rad), 50 + r * Math.sin(rad)];
}

function ringArc(fromDeg: number, toDeg: number, r: number): string {
  const [x0, y0] = polar(fromDeg, r);
  const [x1, y1] = polar(toDeg, r);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

@customElement('device-encoder')
export class DeviceEncoder extends MobxLitElement {
  /** CSS colors resolved by the surface from the device config. */
  @property() declare ringColor: string;
  @property() declare capColor: string;
  @property() declare label: string;
  @property({ type: Boolean, reflect: true }) declare selected: boolean;
  /** Ghost/deleted cards: render only, no pointer interaction. */
  @property({ type: Boolean }) declare interactive: boolean;

  @query('.value-arc') private declare valueArc: SVGPathElement;
  @query('.pointer-line') private declare pointerLine: SVGLineElement;
  @query('.cap') private declare cap: SVGCircleElement;

  private lastValue = -1;
  private lastPressed = false;
  private dragOp: PointerDragOp | null = null;
  private dragStartValue = 0;
  private dragged = false;

  constructor() {
    super();
    this.ringColor = 'var(--app-io-input, #4dc9f6)';
    this.capColor = 'var(--app-tint-3)';
    this.label = '';
    this.selected = false;
    this.interactive = true;
  }

  static styles = css`
    :host {
      display: block;
      position: relative;
      cursor: ns-resize;
    }
    :host(:not([interactive])) { cursor: default; }
    svg { display: block; width: 100%; height: 100%; }
    .track {
      fill: none;
      stroke: var(--app-tint-3);
      stroke-width: 2;
    }
    .value-arc {
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
    }
    .cap {
      stroke: var(--app-tint-5);
      stroke-width: 1;
      transition: filter 0.05s ease;
    }
    .cap.pressed { filter: brightness(1.8); }
    .pointer-line {
      stroke: var(--app-text-color1);
      stroke-width: 1.5;
    }
    .halo {
      fill: none;
      stroke: var(--app-hi-color2);
      stroke-width: 1;
      stroke-dasharray: 3 3;
      display: none;
    }
    :host([selected]) .halo { display: block; }
    .label {
      position: absolute;
      left: 0; right: 0;
      bottom: -2px;
      text-align: center;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      pointer-events: none;
      user-select: none;
    }
  `;

  /** rAF entry point — writes SVG attributes directly, no Lit render. */
  setLive(value: number, pressed: boolean): void {
    const v = Math.min(1, Math.max(0, value));
    if (v !== this.lastValue && this.valueArc) {
      this.lastValue = v;
      const deg = START_DEG + SWEEP_DEG * v;
      this.valueArc.setAttribute('d', v <= 0.001 ? '' : ringArc(START_DEG, deg, RING_R));
      const [x0, y0] = polar(deg, CAP_R - 6);
      const [x1, y1] = polar(deg, RING_R - 6);
      this.pointerLine.setAttribute('x1', x0.toFixed(2));
      this.pointerLine.setAttribute('y1', y0.toFixed(2));
      this.pointerLine.setAttribute('x2', x1.toFixed(2));
      this.pointerLine.setAttribute('y2', y1.toFixed(2));
    }
    if (pressed !== this.lastPressed && this.cap) {
      this.lastPressed = pressed;
      this.cap.classList.toggle('pressed', pressed);
    }
  }

  get liveValue(): number { return Math.max(0, this.lastValue); }

  private onPointerDown(e: PointerEvent) {
    // W mode: the surface's hit zones own the pointer (belt and braces —
    // they also sit above this element).
    if (!this.interactive || appState.local.tappingMode || e.button !== 0) return;
    e.stopPropagation();
    this.dragStartValue = this.liveValue;
    this.dragged = false;
    this.dragOp = new PointerDragOp(e, this, {
      threshold: 3,
      move: (ev, delta) => {
        this.dragged = true;
        const sens = ev.shiftKey ? 0.25 : 1;
        const value = this.dragStartValue - (delta[1] / DRAG_RANGE_PX) * sens;
        this.dispatchEvent(new CustomEvent('control-drag', {
          detail: { value: Math.min(1, Math.max(0, value)) }, bubbles: true, composed: true,
        }));
      },
      accept: () => this.endGesture(e),
      cancel: reason => {
        if (reason === CancelReason.NoChange) this.endGesture(e);
      },
      complete: () => { this.dragOp = null; },
    });
  }

  private endGesture(down: PointerEvent) {
    if (this.dragged) {
      this.dispatchEvent(new CustomEvent('control-drag-end', {
        detail: {}, bubbles: true, composed: true,
      }));
    } else {
      this.dispatchEvent(new CustomEvent('control-click', {
        detail: { additive: down.metaKey || down.ctrlKey, range: down.shiftKey },
        bubbles: true, composed: true,
      }));
    }
  }

  render() {
    return html`
      <svg viewBox="0 0 100 100" @pointerdown=${this.onPointerDown}>
        ${svg`
          <path class="track" d=${ringArc(START_DEG, START_DEG + SWEEP_DEG, RING_R)}></path>
          <path class="value-arc" d="" style="stroke: ${this.ringColor}"></path>
          <circle class="cap" cx="50" cy="50" r=${CAP_R} style="fill: ${this.capColor}"></circle>
          <line class="pointer-line" x1="50" y1="${50 - CAP_R + 6}" x2="50" y2="${50 - RING_R + 6}"></line>
          <circle class="halo" cx="50" cy="50" r="${RING_R + 4}"></circle>
        `}
      </svg>
      ${this.label ? html`<div class="label">${this.label}</div>` : nothing}
    `;
  }

  updated() {
    // Re-assert live visuals after any Lit render (e.g. color change rebuilds
    // the SVG subtree, dropping the imperative attribute writes).
    const v = this.lastValue;
    const p = this.lastPressed;
    this.lastValue = -1;
    this.lastPressed = false;
    this.setLive(Math.max(0, v), p);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-encoder': DeviceEncoder;
  }
}
