/**
 * <texture-monitor> — Displays a live thumbnail preview of a traced texture.
 *
 * Registers a trace point via the TraceController on connect, unregisters on disconnect.
 * Reads the captured ImageBitmap from appState and draws it to a canvas.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { autorun, IReactionDisposer } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { traceController } from '../state/trace-controller';
import type { TracePoint } from '../engine-types';

@customElement('texture-monitor')
export class TextureMonitor extends MobxLitElement {
  /** Unique trace registration ID. Must be unique across all texture-monitors. */
  @property() traceId = '';

  /** The trace target to capture. */
  @property({ attribute: false }) traceTarget: TracePoint['target'] | null = null;

  /** Canvas display width in CSS pixels. */
  @property({ type: Number }) width = 64;

  /** Canvas display height in CSS pixels. */
  @property({ type: Number }) height = 36;

  private frameDisposer: IReactionDisposer | null = null;

  static styles = css`
    :host {
      display: inline-block;
    }
    canvas {
      display: block;
      background: #000;
      border-radius: 2px;
      border: 1px solid rgba(255,255,255,0.06);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.registerTrace();

    this.frameDisposer = autorun(() => {
      const _gen = appState.local.engine.frameGeneration;
      const bitmap = appState.local.engine.tracedFrames[this.traceId];
      if (!bitmap) return;
      const canvas = this.renderRoot.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(bitmap, 0, 0);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.frameDisposer?.();
    this.frameDisposer = null;
    traceController.unregister(this.traceId);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('traceId') || changed.has('traceTarget')) {
      // Re-register if target or ID changed
      if (changed.has('traceId')) {
        const oldId = changed.get('traceId') as string;
        if (oldId) traceController.unregister(oldId);
      }
      this.registerTrace();
    }
  }

  private registerTrace() {
    if (!this.traceId || !this.traceTarget) return;
    traceController.register({
      id: this.traceId,
      target: this.traceTarget,
      resolution: 'low',
    });
  }

  render() {
    return html`<canvas style="width:${this.width}px;height:${this.height}px"></canvas>`;
  }
}
