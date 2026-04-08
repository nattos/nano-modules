/**
 * <spark-chart> — Mini sparkline chart for monitoring float values over time.
 *
 * Polls a FieldBinding each animation frame and renders a scrolling sparkline.
 * No trace points needed — reads values directly from the binding.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding } from './field-editor';

@customElement('spark-chart')
export class SparkChart extends MobxLitElement {
  /** Field path to read from the binding. */
  @property() fieldPath = '';

  /** The field binding providing getValue(). */
  @property({ attribute: false }) binding: FieldBinding | null = null;

  /** Number of samples in the ring buffer. */
  @property({ type: Number }) samples = 64;

  /** Expected min value for vertical scaling. */
  @property({ type: Number }) min = 0;

  /** Expected max value for vertical scaling. */
  @property({ type: Number }) max = 1;

  /** Canvas display width in CSS pixels. */
  @property({ type: Number }) width = 64;

  /** Canvas display height in CSS pixels. */
  @property({ type: Number }) height = 24;

  private history: number[] = [];
  private writeIndex = 0;
  private animFrameId = 0;

  static styles = css`
    :host {
      display: inline-block;
    }
    canvas {
      display: block;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 2px;
      border: 1px solid rgba(255,255,255,0.06);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.history = new Array(this.samples).fill(0);
    this.writeIndex = 0;
    this.startPolling();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
  }

  private startPolling() {
    const tick = () => {
      this.animFrameId = requestAnimationFrame(tick);
      this.sampleAndDraw();
    };
    this.animFrameId = requestAnimationFrame(tick);
  }

  private sampleAndDraw() {
    if (!this.binding) return;

    const value = this.binding.getValue(this.fieldPath);
    const num = typeof value === 'number' ? value : 0;
    this.history[this.writeIndex % this.samples] = num;
    this.writeIndex++;

    const canvas = this.renderRoot.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = this.width * dpr;
    const ch = this.height * dpr;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, cw, ch);

    const range = this.max - this.min || 1;
    const n = Math.min(this.writeIndex, this.samples);
    const startIdx = this.writeIndex - n;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(65, 105, 225, 0.8)';
    ctx.lineWidth = dpr;

    for (let i = 0; i < n; i++) {
      const val = this.history[(startIdx + i) % this.samples];
      const x = (i / (this.samples - 1)) * cw;
      const y = ch - ((val - this.min) / range) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw current value as a dot at the right edge
    if (n > 0) {
      const lastVal = this.history[(this.writeIndex - 1) % this.samples];
      const ly = ch - ((lastVal - this.min) / range) * ch;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(65, 105, 225, 1)';
      ctx.arc(cw - 1, ly, 2 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  render() {
    return html`<canvas style="width:${this.width}px;height:${this.height}px"></canvas>`;
  }
}
