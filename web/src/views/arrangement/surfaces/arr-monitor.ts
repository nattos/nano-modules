/**
 * <arr-monitor> — output monitor pinned to the bottom of the inspector column
 * (same idea as the sketch IDE).
 *
 * Live (Component C): the selected clip is mapped to a real sketch and rendered
 * through executor.wasm by the shared `engineBridge`; traced frames paint here.
 * When the selection has no renderable content (empty / modulation-only clip, or
 * nothing selected) the monitor shows only the static composite backdrop (the
 * configured background color, or the stage checkerboard when transparent) — no
 * animated placeholder.
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
      position: relative;
      background: var(--app-bg-color1);
    }
    .mon-resize {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 5px;
      cursor: ns-resize;
      z-index: 3;
    }
    .mon-resize:hover {
      background: var(--app-hi-color2);
      opacity: 0.5;
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
      /* Stable height (the composite is contain-fit into it), so resizing the
         panel width changes the monitor's ASPECT rather than its height. */
      height: 180px;
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
      /* The canvas backing store is the COMPOSITION resolution (so a right-click
         "Save image as" yields a clean full-res frame); the browser letterboxes it
         into the stage at the composition aspect, checkerboard showing in the bars. */
      object-fit: contain;
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
    // Tracked reads — drive reactive updates of the live engine + backdrop.
    void store.positionBeat;
    void store.primaryPath;
    void store.playing;
    void store.backgroundMode;
    void store.backgroundColor;
    void store.monitorHeight;
    // Track every ACTIVE composite layer's chain + param state + opacity so a
    // real edit (param, device, or track level) re-renders → showComposite
    // rebuilds the combined sketch → engine update.
    for (const layer of store.compositeLayersAtBeat(store.positionBeat)) {
      void layer.opacity;
      void layer.blendMode;
      void layer.clip.source?.url;
      void layer.clip.source?.scaleMode;
      // Placement transform (anchor / scale / rotation / flip): read each field so a
      // widget drag re-issues the composite → the pump re-blits with the new transform.
      const tf = layer.clip.source?.transform;
      if (tf) { void tf.anchorX; void tf.anchorY; void tf.scale; void tf.rotation; void tf.flipH; void tf.flipV; }
      // Track wires so connecting/removing a modulation wire re-issues the
      // composite (the executor applies them natively).
      const ws = layer.clip.sketch.wires;
      if (ws) for (const w of ws) void w.id;
      // Track rail exports/reads: adding/removing a return wire must rebuild the
      // composite (rail links are folded into cross-clip wires by buildCompositeSketch).
      for (const ex of layer.clip.exports ?? []) { void ex.railId; void ex.sourceField; }
      for (const rd of layer.clip.reads ?? []) {
        void rd.railId; void rd.targetField; void rd.combine;
        void store.railTrackFor(rd.railId)?.railSigned; // return mode → rail wire magnitude
      }
      for (const d of layer.clip.sketch.devices) {
        void d.moduleType;
        const st = d.state;
        if (st) for (const k in st) void (st as Record<string, unknown>)[k];
      }
    }
    // The flat layers above are tracks-only and don't cover GROUP composite props
    // or the per-track(-group) FX bus. Walk the actual composite TREE so a paused
    // edit to a group's opacity / blend / INPUT mode, or to any track/group FX-chain
    // param, re-renders → showComposite rebuilds → engine update. Reading the tree
    // also tracks structure (parentId / bypass / solo) so group edits re-issue too.
    const trackComposite = (nodes: ReadonlyArray<Record<string, any>>) => {
      for (const n of nodes) {
        const sketch = n.type === 'group' ? n.group.sketch : n.track?.sketch;
        if (sketch) for (const d of sketch.devices) {
          void d.moduleType;
          const st = d.state;
          if (st) for (const k in st) void (st as Record<string, unknown>)[k];
        }
        if (n.type === 'group') {
          void n.group.level; void n.group.blendMode;
          void n.group.groupInput?.mode; void n.group.groupInput?.color;
          trackComposite(n.children);
        }
      }
    };
    trackComposite(store.compositeTreeAtBeat(store.positionBeat));
    return html`
      <div class="mon-resize" @pointerdown=${this.onResize}></div>
      <div class="head">
        <span>OUTPUT · ${this.sourceLabel()}</span>
        <span>${res.width}×${res.height}</span>
      </div>
      <div class="stage" style="height:${store.monitorHeight}px">
        <canvas></canvas>
      </div>
    `;
  }

  /** What the monitor is showing: the composition (MAIN BUS), or — when a track
   *  is soloed — that track (the soloed lineage is what actually renders). */
  private sourceLabel(): string {
    const soloed = store.composition.tracks.filter((t) => t.soloed);
    if (soloed.length === 1) return soloed[0].name.toUpperCase();
    if (soloed.length > 1) return `${soloed.length} SOLOED`;
    return 'MAIN BUS';
  }

  private onResize = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.target as HTMLElement;
    const startY = e.clientY;
    const startH = store.monitorHeight;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => store.setMonitorHeight(startH + (startY - ev.clientY));
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** Canvas 2D context, backing store sized to the COMPOSITION resolution (so the
   *  saved frame is full-res; the browser scales the canvas down for display via
   *  `object-fit: contain`). null if unsized. */
  private sizedCtx(): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
    const canvas = this.canvas;
    if (!canvas) return null;
    const res = store.composition.meta.resolution;
    const w = Math.max(1, Math.round(res.width));
    const h = Math.max(1, Math.round(res.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ctx, w, h };
  }

  /**
   * Draw the single combined composite (all active layers — effect chains AND
   * video clips — are folded into ONE GPU sketch by the bridge, with cross-track
   * effect input, per-track opacity, and blend modes already applied). The canvas
   * IS the composition frame (resolution + aspect), so the composite fills it
   * edge-to-edge — CSS `object-fit: contain` letterboxes it into the stage.
   */
  private redraw() {
    const s = this.sizedCtx();
    if (!s) return;
    const { ctx, w, h } = s;
    ctx.clearRect(0, 0, w, h);
    // Composite backdrop (per composition): opaque black by default, a custom
    // color, or transparent (canvas left clear → the stage checkerboard shows).
    const fill = this.bgFill();
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, w, h); }
    if (!engineBridge.hasContent) return;        // backdrop only — no clips yet
    const bmp = engineBridge.engineComposite();
    if (!bmp) return;                            // booting — backdrop only
    // Both the canvas and the engine output are at the composition aspect, so fill
    // the whole frame (opacity/blend already baked into bmp).
    ctx.drawImage(bmp, 0, 0, w, h);
  }

  /** The composite backdrop fill, or null for transparent (checkerboard). */
  private bgFill(): string | null {
    const mode = store.backgroundMode;
    if (mode === 'transparent') return null;
    if (mode === 'custom') return store.backgroundColor || '#000';
    return '#000';
  }
}
