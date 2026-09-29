/**
 * <light-input-pip> — a placed light's INPUT: what it samples. Unrouted, that
 * is the main output; a route from any track's out port (Composition I/O)
 * replaces it. The pip is that route's endpoint, on the light's card in the
 * Devices view and on its row in the timeline:
 *
 *   - drag from it to an out port (or from a port onto it) to route;
 *   - click it to pick it up, then click a port (or pick a port up, then
 *     click here) — a gesture started elsewhere completes on a click here;
 *   - mid-drag, hovering the Timeline | Devices switch flips the view, so a
 *     track's port and a light's card can meet.
 *
 * In W mode (and during any connect gesture) it wears the input mask like a
 * field row. It registers its anchor for the view it sits in, so the overlay
 * draws the route to it.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import { connectGestureActive, lightInputInfo, WireConnect } from '../../../../widgets/taps-connect';
import { tapHitStyles } from '../../../../widgets/tap-hit-styles';
import { DeviceAnchorKeys, setDeviceAnchor } from '../../../devices/device-anchors';
import { store } from '../../state/store';
import { AnchorKeys, setAnchor } from '../anchor-registry';
import { portConnect, routeEndLabel } from '../arr-io';

@customElement('light-input-pip')
export class LightInputPip extends MobxLitElement {
  @property({ attribute: false }) placementId = '';
  /** Which view's anchor registry it registers in. */
  @property({ attribute: false }) scope: 'timeline' | 'devices' = 'devices';

  static styles = [tapHitStyles, css`
    :host { display: inline-flex; min-width: 0; }
    .pip {
      position: relative; display: inline-flex; align-items: center; gap: 4px; min-width: 0;
      height: 16px; padding: 0 6px 0 3px; border-radius: 8px; cursor: crosshair;
      border: 1px solid var(--app-tint-4); background: var(--app-bg-color1);
      font-size: var(--app-fs-xs); color: var(--app-text-color2); user-select: none;
    }
    .pip:hover { background: color-mix(in srgb, var(--io-color, #46d18c) 20%, transparent); }
    .pip.routed { color: var(--app-text-color1); border-color: color-mix(in srgb, var(--io-color, #46d18c) 60%, transparent); }
    .dot { flex: none; width: 4px; height: 4px; border-radius: 50%; border: 2px solid var(--io-color, #46d18c); }
    .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pip .tap-overlay-hit { inset: -1px; border-radius: 8px; cursor: crosshair; }
  `];

  updated() {
    const dot = this.renderRoot.querySelector('.dot');
    if (this.scope === 'timeline') setAnchor(AnchorKeys.lightInput(this.placementId), dot);
    else setDeviceAnchor(DeviceAnchorKeys.lightInput(this.placementId), dot);
  }

  render() {
    const route = store.lightInputRoute(this.placementId);
    const src = route ? routeEndLabel(route.src) : 'main output';
    const masked = store.wiresMode || connectGestureActive();
    return html`<span class="pip ${route ? 'routed' : ''}" data-light-pip=${this.placementId}
        title=${`Samples: ${src} — drag to (or from) a track's out port to change it`}
        @pointerdown=${this.onDown} @click=${this.onClick}>
      <span class="dot"></span><span class="nm">${src}</span>
      ${masked ? html`<span class="tap-overlay-hit" data-light-input=${this.placementId}></span>` : nothing}
    </span>`;
  }

  private eatClick = false;

  private onDown = (e: PointerEvent) => {
    e.stopPropagation();  // not a card click / row drag
    this.eatClick = false;
    if (WireConnect.active) {
      e.preventDefault();
      WireConnect.active.completeOnLightInput(this.placementId);
      this.eatClick = true;
      return;
    }
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    portConnect.beginFromFieldDrag(e, el, '', `light/${this.placementId}`,
      lightInputInfo(this.placementId, r.top + r.height / 2));
  };

  private onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (portConnect.consumeClickSuppression()) return;  // the end of a drag
    if (this.eatClick) { this.eatClick = false; return; }
    // Pick it up: the band follows the cursor until a port is clicked.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    portConnect.beginFromFieldClick('', `light/${this.placementId}`,
      lightInputInfo(this.placementId, r.top + r.height / 2));
    if (portConnect.state) {
      portConnect.state.pointerX = r.left + 6;
      portConnect.state.pointerY = r.top + r.height / 2;
    }
  };
}

declare global {
  interface HTMLElementTagNameMap { 'light-input-pip': LightInputPip }
}
