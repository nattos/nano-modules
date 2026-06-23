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
  private compositeOff?: () => void;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(this);
    // Recomposite whenever the engine produces a new composite frame.
    this.compositeOff = engineBridge.setOnComposite(() => this.redraw());
    this.redraw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.compositeOff?.();
  }
  updated() {
    // Reflect the TIMELINE at the playhead into the engine (deduped inside the
    // bridge), then repaint. Reading the observables in render() establishes
    // tracking so transport/edit changes drive these updates.
    engineBridge.showComposite(store.compositeLayersAtBeat(store.positionBeat));
    this.redraw();
  }

  render() {
    const res = store.composition.meta.resolution;
    // Tracked reads — drive reactive updates of the live engine + placeholder.
    void store.positionBeat;
    void store.primaryPath;
    void store.playing;
    // Track every ACTIVE composite layer's chain + param state + opacity so a
    // real edit (param, device, or track level) re-renders → showComposite
    // rebuilds the combined sketch → engine update.
    for (const layer of store.compositeLayersAtBeat(store.positionBeat)) {
      void layer.opacity;
      void layer.blendMode;
      void layer.clip.source?.url;
      for (const d of layer.clip.sketch.devices) {
        void d.moduleType;
        const st = d.state;
        if (st) for (const k in st) void (st as Record<string, unknown>)[k];
      }
    }
    return html`
      <div class="head">
        <span>OUTPUT</span>
        <span>${res.width}×${res.height}</span>
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

  /**
   * Draw the single combined composite (all active layers — effect chains AND
   * video clips — are folded into ONE GPU sketch by the bridge, with cross-track
   * effect input, per-track opacity, and blend modes already applied).
   */
  private redraw() {
    const s = this.sizedCtx();
    if (!s) return;
    const { ctx, w, h } = s;
    if (!engineBridge.hasContent) { this.drawPlaceholder(); return; }
    const bmp = engineBridge.engineComposite();
    if (!bmp) { this.drawPlaceholder('booting…'); return; }
    ctx.clearRect(0, 0, w, h);
    this.drawContain(ctx, bmp, w, h); // opacity/blend already baked into the composite
  }

  /**
   * Contain-fit (letterbox) a bitmap into w×h centred, so the WHOLE composition
   * frame is visible at its true aspect ratio (the engine renders at the
   * composition resolution's aspect) rather than cropping to fill.
   */
  private drawContain(ctx: CanvasRenderingContext2D, bmp: ImageBitmap, w: number, h: number) {
    const scale = Math.min(w / bmp.width, h / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
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
