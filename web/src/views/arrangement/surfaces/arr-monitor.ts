/**
 * <arr-monitor> — output monitor pinned to the bottom of the inspector column
 * (same idea as the sketch IDE). Mockup: a placeholder render with a Photoshop
 * checkerboard alpha backing and the composition resolution label. Real trace
 * frames arrive in Milestone 2.
 */

import { html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';

@customElement('arr-monitor')
export class ArrMonitor extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      background: var(--app-bg-color1);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px var(--app-sp-4);
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      border-bottom: 1px solid var(--app-tint-2);
    }
    .stage {
      position: relative;
      aspect-ratio: 16 / 9;
      width: 100%;
      /* Photoshop-style transparency checkerboard. */
      background-color: #777;
      background-image: linear-gradient(45deg, #999 25%, transparent 25%),
        linear-gradient(-45deg, #999 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #999 75%),
        linear-gradient(-45deg, transparent 75%, #999 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .label {
      position: absolute;
      left: 6px;
      bottom: 5px;
      font-size: var(--app-fs-xs);
      color: rgba(255, 255, 255, 0.85);
      text-shadow: 0 1px 2px #000;
      pointer-events: none;
    }
  `;

  @query('canvas') private canvas!: HTMLCanvasElement;
  private ro?: ResizeObserver;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this);
    this.draw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }
  updated() {
    this.draw();
  }

  render() {
    const res = store.composition.meta.resolution;
    void store.positionBeat;
    void store.primaryPath;
    return html`
      <div class="head">
        <span>OUTPUT</span>
        <span>${res.width}×${res.height} · Precise</span>
      </div>
      <div class="stage">
        <canvas></canvas>
        <div class="label">${this.targetLabel()}</div>
      </div>
    `;
  }

  private targetLabel(): string {
    const p = store.primaryPath;
    if (p?.startsWith('clip/')) {
      const f = store.clipByPath(p);
      if (f) return `▸ ${f.clip.name}`;
    }
    return '▸ Composition';
  }

  private draw() {
    const canvas = this.canvas;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Placeholder "render": a slow gradient that drifts with the playhead so
    // the monitor visibly reflects transport — stands in for a real frame.
    const t = store.positionBeat * 0.1;
    const g = ctx.createLinearGradient(0, 0, w, h);
    const hue = (t * 40) % 360;
    g.addColorStop(0, `hsl(${hue}, 45%, 22%)`);
    g.addColorStop(1, `hsl(${(hue + 60) % 360}, 45%, 12%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  }
}
