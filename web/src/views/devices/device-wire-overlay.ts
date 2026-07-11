/**
 * <device-wire-overlay> — viewport-fixed SVG drawing the Devices tab's
 * cross-panel wires while W wire mode is on: committed device→field wires
 * (device hit zone → the editor field's tap hit/pip, resolved through the
 * shared field-anchor-lookup) and the live rubber band for an in-flight
 * gesture whose SOURCE is a device control.
 *
 * Purely visual (pointer-events: none): wire management (mod, combine,
 * removal) lives in the dest field's inspector like any other wire, and the
 * editor's own <taps-overlay> ignores midi:-sourced wires, so nothing draws
 * twice. Geometry runs on a rAF loop (anchors move with scrolling/layout);
 * Lit only reconciles the path list. Pattern: arrangement's arr-overlay.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { isMidiInstanceKey, midiInstanceIdFromKey } from '../../midi/midi-types';
import { sketchChain } from '../../sketch-types';
import { activeEditorFieldAnchor, activeEditorSketchId } from '../../widgets/field-anchor-lookup';
import { tapsConnect } from '../../widgets/taps-connect';
import { DeviceAnchorKeys, deviceAnchorRect } from './device-anchors';

interface DeviceWireVis {
  wireId: string;
  anchorKey: string;   // device endpoint anchor
  destKey: string;     // editor field key `${sketchId}/0/${chainIdx}/${field}`
}

function bowPath(x0: number, y0: number, x1: number, y1: number): string {
  // Horizontal bow toward each other — device grid (right) to editor (left).
  const dx = Math.max(40, Math.abs(x1 - x0) * 0.35);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} C ${(x0 - dx).toFixed(1)} ${y0.toFixed(1)}, ` +
         `${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

@customElement('device-wire-overlay')
export class DeviceWireOverlay extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 60;
      pointer-events: none;
      display: block;
    }
    svg { width: 100%; height: 100%; display: block; }
    .wire {
      fill: none;
      stroke: var(--app-io-output, #ff8c00);
      stroke-width: 1.5;
      opacity: 0.8;
    }
    .connect-line {
      fill: none;
      stroke: var(--app-hi-color2, #4169e1);
      stroke-width: 1.5;
      stroke-dasharray: 5 4;
    }
  `;

  private raf = 0;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => {
      this.position();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
  }

  private wires(): DeviceWireVis[] {
    const sketchId = activeEditorSketchId();
    if (!sketchId) return [];
    const sketch = appState.database.sketches[sketchId];
    if (!sketch?.wires) return [];
    const chainIdxByKey = new Map<string, number>();
    sketchChain(sketch).forEach((e, idx) => {
      if (e.type === 'module') chainIdxByKey.set(e.instance_key, idx);
    });
    const out: DeviceWireVis[] = [];
    for (const wire of sketch.wires) {
      if (!isMidiInstanceKey(wire.src.instanceKey)) continue;
      const chainIdx = chainIdxByKey.get(wire.dest.instanceKey);
      if (chainIdx === undefined) continue;
      out.push({
        wireId: wire.id,
        anchorKey: DeviceAnchorKeys.control(
          midiInstanceIdFromKey(wire.src.instanceKey)!, wire.src.field),
        destKey: `${sketchId}/0/${chainIdx}/${wire.dest.field}`,
      });
    }
    return out;
  }

  /** rAF geometry pass — reads anchors, writes path `d` attributes. */
  private position() {
    const svg = this.renderRoot.querySelector('svg');
    if (!svg) return;
    for (const path of svg.querySelectorAll<SVGPathElement>('.wire')) {
      const from = deviceAnchorRect(path.dataset.anchorKey!);
      const to = from ? activeEditorFieldAnchor(path.dataset.destKey!)?.getBoundingClientRect() : null;
      if (!from || !to) { path.setAttribute('d', ''); continue; }
      path.setAttribute('d', bowPath(
        from.left, from.top + from.height / 2, to.right, to.top + to.height / 2));
    }
    const line = svg.querySelector<SVGPathElement>('.connect-line');
    const s = tapsConnect.state;
    if (line) {
      const dc = s?.info.deviceControl;
      const from = dc ? deviceAnchorRect(DeviceAnchorKeys.control(dc.deviceInstanceId, dc.controlId)) : null;
      line.setAttribute('d', s && from
        ? bowPath(from.left, from.top + from.height / 2, s.pointerX, s.pointerY)
        : '');
    }
  }

  render() {
    if (!appState.local.tappingMode) return nothing;
    return html`
      <svg>
        ${this.wires().map(w => html`
          <path class="wire" data-anchor-key=${w.anchorKey} data-dest-key=${w.destKey} d=""></path>
        `)}
        <path class="connect-line" d=""></path>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'device-wire-overlay': DeviceWireOverlay;
  }
}
