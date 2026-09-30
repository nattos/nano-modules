/**
 * <display-surface> — a display drawn as what it is: a flat panel at its
 * screen's aspect (the screen it lands on, or its window, else 16:9), with the
 * show's frame placed on it per the placement's fit — Fit leaves black bars,
 * Fill overhangs (cropped), Stretch covers it. Dimmed when it shows nothing
 * (off, no screen, an engine that can't output).
 *
 * `compact` (a timeline display row) fits the panel to the host's HEIGHT.
 */

import { html, css, svg } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import { displayMode, displayModeShares, type DisplayFit } from '../../../../displays/display-types';
import { displayController } from '../../state/display-controller';
import { store } from '../../state/store';
import { frameAspect } from '../lights/light-draw';

let clipSeq = 0;

@customElement('display-surface')
export class DisplaySurface extends MobxLitElement {
  @property({ attribute: false }) slotId = '';
  /** Draw this show's fit and live state. */
  @property({ attribute: false }) placementId = '';
  @property({ type: Boolean, reflect: true }) compact = false;

  static styles = css`
    :host { display: block; }
    svg { display: block; width: 100%; height: auto; }
    :host([compact]) { height: 100%; }
    :host([compact]) svg { width: auto; height: 100%; }
    .dim { opacity: 0.4; }
  `;

  private clipId = `dsclip${++clipSeq}`;

  render() {
    const slot = displayController.slot(this.slotId);
    const p = this.placementId ? store.placementById(this.placementId) : undefined;
    const st = this.placementId ? displayController.status[this.placementId] : undefined;
    const screen = slot ? (st?.screen ?? displayController.screenFor(slot)) : null;
    const mode = slot ? displayMode(slot) : 'fullscreen';
    const win = mode === 'window' ? slot?.windowFrame : undefined;
    // A shared (Syphon / Spout) frame IS the show's frame.
    const aspect = displayModeShares(mode) ? frameAspect()
      : screen && screen.w > 0 && screen.h > 0 ? screen.w / screen.h
      : win && win.w > 0 && win.h > 0 ? win.w / win.h : 16 / 9;
    const fit: DisplayFit = p?.fit ?? 'fit';
    const r = fittedRect(frameAspect(), aspect, fit);
    const live = !!st && (st.state === 'showing' || st.state === 'window' || st.state === 'syphon'
      || st.state === 'spout');
    const hi = 'var(--app-hi-color2, #4169e1)';
    return html`<svg viewBox="-0.04 -0.04 ${aspect + 0.08} 1.08" class=${live || !p ? '' : 'dim'}>
      <defs><clipPath id=${this.clipId}><rect x="0" y="0" width=${aspect} height="1"></rect></clipPath></defs>
      <rect x="0" y="0" width=${aspect} height="1" rx="0.02" fill="#050507"
        stroke="rgba(255,255,255,0.35)" stroke-width="1.5" vector-effect="non-scaling-stroke"></rect>
      <g clip-path="url(#${this.clipId})">
        <rect x=${r.x} y=${r.y} width=${r.w} height=${r.h}
          fill=${live ? 'rgba(65,105,225,0.45)' : 'rgba(255,255,255,0.12)'}></rect>
        ${svg`<line x1=${r.x} y1=${r.y} x2=${r.x + r.w} y2=${r.y + r.h} stroke=${live ? hi : 'rgba(255,255,255,0.2)'}
          stroke-width="1" vector-effect="non-scaling-stroke"></line>
        <line x1=${r.x + r.w} y1=${r.y} x2=${r.x} y2=${r.y + r.h} stroke=${live ? hi : 'rgba(255,255,255,0.2)'}
          stroke-width="1" vector-effect="non-scaling-stroke"></line>`}
      </g>
    </svg>`;
  }
}

/** Where a frame of aspect `frame` lands on a screen of aspect `screen`
 *  (panel units: width `screen`, height 1). */
export function fittedRect(frame: number, screen: number, fit: DisplayFit): { x: number; y: number; w: number; h: number } {
  if (fit === 'stretch') return { x: 0, y: 0, w: screen, h: 1 };
  const byHeight = fit === 'fit' ? frame <= screen : frame > screen;
  const h = byHeight ? 1 : screen / frame;
  const w = h * frame;
  return { x: (screen - w) / 2, y: (1 - h) / 2, w, h };
}

declare global {
  interface HTMLElementTagNameMap { 'display-surface': DisplaySurface }
}
