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
import { thumbnailController } from '../media/thumbnail-controller';
import type { Clip } from '../model/composition';

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
  private thumbOff?: () => void;
  /** Active media-layer view ids (`monitor:<clipId>`) for cleanup. */
  private mediaViews = new Set<string>();

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.redraw());
    this.ro.observe(this);
    // Recomposite whenever the engine produces a new frame for any layer.
    this.compositeOff = engineBridge.setOnComposite(() => this.redraw());
    // Recomposite as decoded media tiles land for any active media layer.
    this.thumbOff = thumbnailController.subscribe((sk) => {
      const active = store.compositeLayersAtBeat(store.positionBeat);
      if (active.some((l) => l.kind === 'media' && l.clip.source?.sourceKey === sk)) this.redraw();
    });
    this.redraw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.compositeOff?.();
    this.thumbOff?.();
    for (const v of this.mediaViews) thumbnailController.dropView(v);
    this.mediaViews.clear();
  }
  updated() {
    // Reflect the TIMELINE at the playhead into the engine (deduped inside the
    // bridge), then repaint. Reading the observables in render() establishes
    // tracking so transport/edit changes drive these updates.
    engineBridge.showComposite(store.compositeClipsAtBeat(store.positionBeat));
    this.redraw();
  }

  render() {
    const res = store.composition.meta.resolution;
    // Tracked reads — drive reactive updates of the live engine + placeholder.
    void store.positionBeat;
    void store.primaryPath;
    void store.playing;
    // Track every ACTIVE composite clip's chain + param state so a real param
    // edit (on any layer) re-renders → showComposite rebuilds → engine update.
    for (const { clip } of store.compositeClipsAtBeat(store.positionBeat)) {
      void clip.kind;
      for (const d of clip.sketch.devices) {
        void d.moduleType;
        const st = d.state;
        if (st) for (const k in st) void (st as Record<string, unknown>)[k];
      }
    }
    // The active media clip drives the decoded-frame path.
    void store.topMediaClipAtBeat(store.positionBeat)?.source?.url;
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

  /**
   * Composite every active layer (bottom → top) at the playhead: engine layers
   * from the bridge's retained frames, media layers from decoded tiles, each at
   * its effective opacity. Unifies what used to be two exclusive paths so a
   * media clip can sit BETWEEN effect layers and per-track opacity is honoured.
   */
  private redraw() {
    const layers = store.compositeLayersAtBeat(store.positionBeat);
    this.syncMediaViews(layers);
    const s = this.sizedCtx();
    if (!s) return;
    const { ctx, w, h } = s;
    if (layers.length === 0) { this.drawPlaceholder(); return; }

    ctx.clearRect(0, 0, w, h);
    let drew = false;
    let pending = false;
    for (const layer of layers) {
      const bmp = layer.kind === 'engine'
        ? engineBridge.engineFrame(layer.clip.id)
        : this.mediaTile(layer.clip);
      if (!bmp) { pending = true; continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      this.drawCover(ctx, bmp, w, h);
      ctx.restore();
      drew = true;
    }
    // Nothing ready yet (engine booting / tiles decoding) → booting placeholder.
    if (!drew && pending) this.drawPlaceholder('booting…');
    else if (!drew) this.drawPlaceholder();
  }

  /** Cover-fit a bitmap into w×h centred. */
  private drawCover(ctx: CanvasRenderingContext2D, bmp: ImageBitmap, w: number, h: number) {
    const scale = Math.max(w / bmp.width, h / bmp.height);
    const dw = bmp.width * scale;
    const dh = bmp.height * scale;
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  /** Decoded frame for a media clip at the playhead (best-available; nullable). */
  private mediaTile(clip: Clip): ImageBitmap | null {
    const media = clip.source;
    if (!media?.url || !media.sourceKey) return null;
    const fc = Math.max(1, media.durationFrames);
    const u = clip.lengthBeat > 0 ? (store.positionBeat - clip.startBeat) / clip.lengthBeat : 0;
    const frame = Math.max(0, Math.min(fc - 1, Math.round(Math.max(0, Math.min(1, u)) * (fc - 1))));
    return thumbnailController.peek(media.sourceKey, frame, 0)?.value ?? null;
  }

  /** Register decode views for the active media layers; drop departed ones. */
  private syncMediaViews(layers: { kind: string; clip: Clip }[]) {
    const want = new Set<string>();
    for (const l of layers) {
      const media = l.clip.source;
      if (l.kind !== 'media' || !media?.url || !media.sourceKey) continue;
      const viewId = `monitor:${l.clip.id}`;
      want.add(viewId);
      const fc = Math.max(1, media.durationFrames);
      const u = l.clip.lengthBeat > 0 ? (store.positionBeat - l.clip.startBeat) / l.clip.lengthBeat : 0;
      const frame = Math.max(0, Math.min(fc - 1, Math.round(Math.max(0, Math.min(1, u)) * (fc - 1))));
      thumbnailController.registerMedia({ sourceKey: media.sourceKey, url: media.url, frameCount: fc, fps: media.fps });
      thumbnailController.setView(viewId, {
        sourceKey: media.sourceKey, level: 0, startFrame: frame, endFrame: frame,
        pattern: 'window', readaheadFrames: 1,
      });
    }
    for (const v of [...this.mediaViews]) {
      if (!want.has(v)) { thumbnailController.dropView(v); this.mediaViews.delete(v); }
    }
    for (const v of want) this.mediaViews.add(v);
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
