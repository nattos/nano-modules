/**
 * <devices-float-monitor> — the main output, popped out to a fixed
 * bottom-right overlay while the Devices tab occupies the monitor area
 * (arrangement-mode pattern: aspect-locked edge/corner resize, height
 * persisted). Body is the SAME <sketch-monitor> + trace target the inline
 * monitor uses ('edit_preview'), so no extra trace point is created.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';

import '../../widgets/sketch-monitor';

const MIN_H = 90;
const MAX_H = 520;

@customElement('devices-float-monitor')
export class DevicesFloatMonitor extends MobxLitElement {
  /** Surface overrides: the effect IDE passes its own sketch + trace point
   *  (`ide_preview:<project>`); unset (unified surface) falls back to the
   *  editing sketch + the Edit tab's 'edit_preview' trace. */
  @property({ attribute: false }) sketchId?: string;
  @property({ attribute: false }) traceId?: string;
  static styles = css`
    :host {
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 200;
      display: block;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    sketch-monitor { display: flex; width: 100%; height: 100%; }
    .fm-edge { position: absolute; z-index: 2; }
    .fm-edge.top { top: -3px; left: 8px; right: 8px; height: 7px; cursor: ns-resize; }
    .fm-edge.left { left: -3px; top: 8px; bottom: 8px; width: 7px; cursor: ew-resize; }
    .fm-edge.corner { left: -4px; top: -4px; width: 12px; height: 12px; cursor: nwse-resize; }
  `;

  /** Aspect from the latest traced output frame; 16:9 until one arrives. */
  private aspect(): number {
    const frame = appState.local.engine.tracedFrames[this.traceId ?? 'edit_preview'];
    return frame && frame.height > 0 ? frame.width / frame.height : 16 / 9;
  }

  /** Aspect-locked resize — every gesture resolves to a new HEIGHT
   *  (arrangement-app's onFloatResize, persisted to user settings). */
  private onResize(e: PointerEvent, top: boolean, left: boolean) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startH = appState.local.userSettings.devicesMonitorHeight;
    const aspect = this.aspect();
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const deltas: number[] = [];
      if (top) deltas.push(y0 - ev.clientY);
      if (left) deltas.push((x0 - ev.clientX) / aspect);
      const dH = deltas.length ? Math.max(...deltas) : 0;
      appController.setUserSetting('devicesMonitorHeight',
        Math.min(MAX_H, Math.max(MIN_H, Math.round(startH + dH))));
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  render() {
    const sketchId = this.sketchId ?? appState.local.editingSketchId;
    const traceId = this.traceId ?? 'edit_preview';
    const h = appState.local.userSettings.devicesMonitorHeight;
    const w = Math.round(h * this.aspect());
    this.style.width = `${w}px`;
    this.style.height = `${h}px`;
    return html`
      <div class="fm-edge top" @pointerdown=${(e: PointerEvent) => this.onResize(e, true, false)}></div>
      <div class="fm-edge left" @pointerdown=${(e: PointerEvent) => this.onResize(e, false, true)}></div>
      <div class="fm-edge corner" @pointerdown=${(e: PointerEvent) => this.onResize(e, true, true)}></div>
      <sketch-monitor
        .sketchId=${sketchId}
        .traceId=${traceId}
        .traceTarget=${(this.traceId ? undefined : { type: 'sketch_output', sketchId }) as never}
        emptyMessage="No sketch selected."
      ></sketch-monitor>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devices-float-monitor': DevicesFloatMonitor;
  }
}
