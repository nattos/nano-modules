/**
 * <arr-monitor> — output monitor pinned to the bottom of the inspector column
 * (same idea as the sketch IDE).
 *
 * Live (Component C): the selected clip is mapped to a real sketch and rendered
 * through executor.wasm by the shared `engineBridge`; traced frames paint here.
 * When the selection has no renderable content (empty / modulation-only clip, or
 * nothing selected) the monitor falls back to the placeholder render that drifts
 * with the transport playhead.
 *
 * The engine free-runs a live preview; the warped transport clock drives the
 * playhead/grid. Precise pause-and-seek-to-beat (freezing the exact frame at the
 * playhead) needs a worker seek command and is a later step.
 */

import { html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { engineBridge } from '../engine/engine-bridge';

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
  private frameSinkOff?: () => void;
  /** A real engine frame has painted the canvas (so don't stomp it). */
  private haveFrame = false;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(this);
    this.frameSinkOff = engineBridge.setFrameSink((bmp) => this.onFrame(bmp));
    this.redraw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.frameSinkOff?.();
  }
  updated() {
    // Reflect the current selection into the engine (deduped inside the bridge),
    // then repaint. Reading the observables in render() establishes tracking so
    // selection/transport changes drive these updates.
    engineBridge.showClip(store.selectedClip?.clip ?? null);
    this.redraw();
  }

  render() {
    const res = store.composition.meta.resolution;
    // Tracked reads — drive reactive updates of the live engine + placeholder.
    void store.positionBeat;
    void store.primaryPath;
    void store.playing;
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

  /** Canvas 2D context sized to the element (DPR-aware). null if unsized. */
  private sizedCtx(): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const canvas = this.canvas;
    if (!canvas) return null;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.floor(w * dpr);
    const bh = Math.floor(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /** Paint a traced engine frame (scaled to fit), then drop the bitmap. */
  private onFrame(bmp: ImageBitmap) {
    if (!engineBridge.hasContent) return; // selection changed mid-flight
    const s = this.sizedCtx();
    if (!s) return;
    s.ctx.clearRect(0, 0, s.w, s.h);
    s.ctx.drawImage(bmp, 0, 0, s.w, s.h);
    this.haveFrame = true;
  }

  /** Placeholder paint — only while there's no live engine frame to show. */
  private redraw() {
    // Live frames own the canvas once content is up.
    if (engineBridge.hasContent) {
      if (!this.haveFrame) this.drawPlaceholder('booting…');
      return;
    }
    this.haveFrame = false;
    this.drawPlaceholder();
  }

  private drawPlaceholder(_note?: string) {
    const s = this.sizedCtx();
    if (!s) return;
    const { ctx, w, h } = s;
    ctx.clearRect(0, 0, w, h);
    // A slow gradient that drifts with the playhead so the monitor visibly
    // reflects transport even with no clip selected.
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
