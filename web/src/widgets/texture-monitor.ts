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
import { traceController, type TraceSource } from '../state/trace-controller';
import type { TracePoint } from '../engine-types';

@customElement('texture-monitor')
export class TextureMonitor extends MobxLitElement {
  /** Unique trace registration ID. Must be unique across all texture-monitors. */
  @property() traceId = '';

  /** The trace target to capture. */
  @property({ attribute: false }) traceTarget: TracePoint['target'] | null = null;

  /**
   * Injectable trace seam (register + frame source). Defaults to the IDE's
   * global controller + appState; the arrangement injects its own (own engine,
   * own frame store).
   */
  @property({ attribute: false }) traceSource: TraceSource | null = null;

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

  /**
   * Fixed low-res capture: register WITHOUT a size request so the trace
   * controller's LOW_RES thumbnail default (128×72) applies, decoupling the
   * transmitted bytes from display size × devicePixelRatio. For grids of
   * always-live thumbnails (the Instances tab) where per-frame IPC/WS
   * bandwidth matters more than crispness. Only meaningful with
   * `resolution="low"` (the LOW_RES fallback is low-only).
   */
  @property({ type: Boolean }) thumbnail = false;

  /**
   * Full-source capture: register WITHOUT a size request so a `'high'`
   * registration falls through to source resolution (the trace controller
   * emits no size; barrel mode serializes width/height 0 and the native side
   * reads back the comp at its own size). The canvas's internal resolution
   * follows the received bitmap, so save-as and browser zoom see the true
   * pixels. Only meaningful with `resolution="high"`.
   */
  @property({ type: Boolean }) fullRes = false;

  /**
   * Register the trace as soon as the element first renders, instead of waiting
   * for the async IntersectionObserver callback to confirm visibility. Set this
   * for monitors that are known to be on-screen the moment they mount — e.g.
   * Instances-tab cards, where a newly-appeared instance is appended last and
   * gets a freshly-created DOM node; without `eager` its thumbnail's trace
   * registration (→ observe → preview request → first frame) waits a visible
   * beat for the IO to fire. The IntersectionObserver still runs and will
   * unregister the trace if the element turns out to be scrolled off-screen.
   */
  @property({ type: Boolean }) eager = false;

  private frameDisposer: IReactionDisposer | null = null;
  /** Viewport-visibility gate: we only register a trace while on-screen. */
  private io: IntersectionObserver | null = null;
  private visible = false;

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
    // Only register a trace while the monitor is actually on-screen. Each
    // registration becomes a /preview_requests entry the barrel reads back +
    // ships every (rate-limited) frame; an off-screen monitor scrolled out of a
    // long chain would otherwise keep its trace live, costing GPU readback on
    // the render thread for pixels nobody can see. The IntersectionObserver
    // (rootMargin pre-warms so scrolling doesn't pop in blank) registers on
    // enter and unregisters on exit. In barrel mode the controller routes the
    // flush to a bridge JSON-patch (see `setBarrelPreviewPusher`); the barrel
    // ships the matching textures back as binary WS frames into the same
    // `tracedFrames` map the autorun below draws from.
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver(
        (entries) => {
          const vis = entries[entries.length - 1]?.isIntersecting ?? false;
          if (vis === this.visible) return;
          this.visible = vis;
          if (vis) this.registerTrace();
          else (this.traceSource ?? traceController).unregister(this.traceId);
        },
        { rootMargin: '200px' },
      );
      this.io.observe(this);
    } else {
      // No IntersectionObserver (jsdom tests / unsupported env): always-on.
      this.visible = true;
      this.registerTrace();
    }

    this.frameDisposer = autorun(() => {
      const bitmap = this.traceSource
        ? (this.traceSource.generation, this.traceSource.frame(this.traceId))
        : (appState.local.engine.frameGeneration, appState.local.engine.tracedFrames[this.traceId]);
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
    this.io?.disconnect();
    this.io = null;
    this.visible = false;
    this.frameDisposer?.();
    this.frameDisposer = null;
    (this.traceSource ?? traceController).unregister(this.traceId);
  }

  firstUpdated() {
    // Eager monitors register on first render rather than waiting for the async
    // IntersectionObserver. `traceId`/`traceTarget` are set by now (firstUpdated
    // runs after properties are committed), so registerTrace() won't no-op on
    // missing target the way a connectedCallback call could. The IO still owns
    // subsequent enter/exit — if this element is actually off-screen its first
    // callback will unregister.
    if (this.eager && !this.visible) {
      this.visible = true;
      this.registerTrace();
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('traceId') || changed.has('traceTarget') || changed.has('resolution') || changed.has('traceSource') || changed.has('thumbnail') || changed.has('fullRes') || changed.has('width') || changed.has('height')) {
      // Re-register if target, ID, resolution, requested size, or the source
      // changed (the main monitor resizes its capture request with its panel).
      if (changed.has('traceId')) {
        const oldId = changed.get('traceId') as string;
        if (oldId) (this.traceSource ?? traceController).unregister(oldId);
      }
      this.registerTrace();
    }
  }

  private registerTrace() {
    // Gated on viewport visibility — see connectedCallback. updated() also calls
    // this on target/id/resolution changes; off-screen, it stays a no-op until
    // the IntersectionObserver brings us back on-screen.
    if (!this.visible) return;
    if (!this.traceId || !this.traceTarget) return;
    if (this.thumbnail || this.fullRes) {
      // No size request: thumbnails get the controller's LOW_RES default;
      // fullRes 'high' registrations fall through to source resolution.
      (this.traceSource ?? traceController).register({
        id: this.traceId,
        target: this.traceTarget,
        resolution: this.resolution,
      });
      return;
    }
    // Ask for exactly the pixel count we'll display. devicePixelRatio
    // can drift (multi-monitor moves, browser zoom) but a one-frame
    // mismatch on a thumbnail is harmless and the next register() call
    // will refresh it.
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    (this.traceSource ?? traceController).register({
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
