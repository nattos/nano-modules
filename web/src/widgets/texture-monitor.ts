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

  /**
   * Capture width in pixels — the internal canvas/trace resolution. In the
   * default (non-`fit`) mode this is ALSO the CSS display width.
   */
  @property({ type: Number }) width = 64;

  /** Capture height in pixels — see `width`. */
  @property({ type: Number }) height = 36;

  /**
   * Fit mode. When set, the canvas fills the host (which fills its parent)
   * and scales the captured bitmap with `object-fit: contain`, decoupling the
   * on-screen size from the capture resolution (`width`/`height`). The parent
   * sizes the host; `width`/`height` only drive the trace resolution.
   */
  @property({ type: Boolean, reflect: true }) fit = false;

  /**
   * Trace capture resolution. `'low'` snapshots a small thumbnail (128x72);
   * `'high'` captures at the source's native size — use this for the main
   * monitor where you want the actual output, not a downsample.
   */
  @property() resolution: 'low' | 'high' = 'low';

  private frameDisposer: IReactionDisposer | null = null;

  static styles = css`
    :host {
      display: inline-block;
      /* line-height: 0 prevents inline-block descender alignment from
         adding a sub-pixel of whitespace below the canvas. */
      line-height: 0;
    }
    /* Fit mode: host fills its parent; the canvas scales to contain. */
    :host([fit]) {
      display: block;
      width: 100%;
      height: 100%;
    }
    :host([fit]) canvas {
      width: 100%;
      height: 100%;
      /* "fill", not "contain": the parent already sizes the host to the exact
         contain-fit box of the (fixed-aspect) capture, so the canvas and its
         bitmap share an aspect ratio. The only deviation is the parent's
         independent integer-flooring of width vs height — with "contain" that
         sub-pixel gap letterboxes the bitmap and exposes the canvas's own
         checkerboard background as a 1px sliver at certain widths. "fill"
         absorbs that sub-pixel difference (invisible) and removes the sliver;
         genuinely transparent pixels still reveal the checkerboard within the
         image, since the drawing buffer keeps its alpha either way. */
      object-fit: fill;
    }
    /* Photoshop-style transparency checkerboard. The canvas is drawn
       with alpha (default 2d context), so transparent pixels in the
       traced texture reveal this pattern instead of solid black. Two
       neutral greys keep it readable without competing with the actual
       output.

       No border / border-radius: the canvas's default background-clip
       is border-box, so a translucent border would expose a ring of
       checkerboard around the image and read as a margin. */
    canvas {
      display: block;
      background-color: #999;
      background-image:
        linear-gradient(45deg,  #777 25%, transparent 25%),
        linear-gradient(-45deg, #777 25%, transparent 25%),
        linear-gradient(45deg,  transparent 75%, #777 75%),
        linear-gradient(-45deg, transparent 75%, #777 75%);
      background-size: 16px 16px;
      background-position: 0 0, 0 8px, 8px -8px, -8px 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Register via the trace controller in both modes. In barrel mode
    // the controller routes the flush to a bridge JSON-patch (see
    // `setBarrelPreviewPusher`); the barrel captures the matching
    // textures and ships them back as binary WS frames, which land in
    // the same `tracedFrames` map that the autorun below drives.
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
    if (changed.has('traceId') || changed.has('traceTarget') || changed.has('resolution')) {
      // Re-register if target, ID, or resolution changed
      if (changed.has('traceId')) {
        const oldId = changed.get('traceId') as string;
        if (oldId) traceController.unregister(oldId);
      }
      this.registerTrace();
    }
  }

  private registerTrace() {
    if (!this.traceId || !this.traceTarget) return;
    // Ask for exactly the pixel count we'll display. devicePixelRatio
    // can drift (multi-monitor moves, browser zoom) but a one-frame
    // mismatch on a thumbnail is harmless and the next register() call
    // will refresh it.
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    traceController.register({
      id: this.traceId,
      target: this.traceTarget,
      resolution: this.resolution,
      size: { width: this.width * dpr, height: this.height * dpr },
    });
  }

  render() {
    // In fit mode the CSS sizing comes from the stylesheet (`:host([fit])`);
    // otherwise the canvas is pinned to the capture dimensions.
    const style = this.fit ? '' : `width:${this.width}px;height:${this.height}px`;
    return html`<canvas style="${style}"></canvas>`;
  }
}
