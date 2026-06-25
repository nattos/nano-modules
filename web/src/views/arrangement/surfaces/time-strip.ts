/**
 * <time-strip> — reusable zoomable, gridded film strip with a playhead and
 * hover/scrub interaction. The transform (pxPerFrame + scrollFrames) is owned by
 * the parent and passed in; the strip handles pan/zoom/scrub/hover and emits:
 *   - 'viewchange' { pxPerFrame, scrollFrames }
 *   - 'scrub'      { frame }
 *   - 'hover'      { frame | null, clientX }
 *
 * Shared by the clip view's source + automation modes; built so the same
 * gridded-time-view treatment could back other surfaces later.
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { LitElement } from 'lit';
import { drawPlaceholderCell } from './film-reel';
import { thumbnailController } from '../media/thumbnail-controller';
import { levelForFramesPerThumb } from '../media/thumbnail-mip';

function niceStep(approx: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, approx))));
  for (const m of [1, 2, 5, 10]) if (m * pow >= approx) return m * pow;
  return 10 * pow;
}

@customElement('time-strip')
export class TimeStrip extends LitElement {
  @property({ attribute: false }) clipId = '';
  @property({ type: Number }) durationFrames = 300;
  @property({ type: Number }) pxPerFrame = 2;
  @property({ type: Number }) scrollFrames = 0;
  @property({ type: Number }) loopIn = 0;
  @property({ type: Number }) loopOut = 0;
  @property({ type: String }) playMode = 'time';
  @property({ type: Number }) playheadFrame = -1;
  @property({ type: Boolean }) showLabels = true;
  /** Optional real media — when set, cells draw decoded thumbnails (else the
   *  procedural placeholder). */
  @property({ attribute: false }) sourceKey = '';
  @property({ attribute: false }) url = '';
  @property({ type: Number }) fps = 30;

  static styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      touch-action: none;
      cursor: ew-resize;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
  `;

  @query('canvas') private canvas!: HTMLCanvasElement;
  private ro?: ResizeObserver;
  private dragging = false;
  private hoverFrame: number | null = null;
  private thumbOff?: () => void;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this);
    // Repaint as decoded tiles land for this source.
    this.thumbOff = thumbnailController.subscribe((sk) => {
      if (sk === this.sourceKey) this.draw();
    });
    this.draw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.thumbOff?.();
    if (this.clipId) thumbnailController.dropView(`tstrip:${this.clipId}`);
  }
  updated() {
    this.draw();
  }

  render() {
    return html`<canvas
      @wheel=${this.onWheel}
      @pointerdown=${this.onDown}
      @pointermove=${this.onMove}
      @pointerup=${this.onUp}
      @pointerleave=${this.onLeave}
    ></canvas>`;
  }

  private frameToX(f: number) {
    return (f - this.scrollFrames) * this.pxPerFrame;
  }
  private xToFrame(x: number) {
    return this.scrollFrames + x / this.pxPerFrame;
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

    const dur = Math.max(1, this.durationFrames);

    // Film cells: choose a frame step so cells are ~16:9.
    const cellW = Math.max(8, h * (16 / 9));
    const frameStep = Math.max(1, Math.round(cellW / this.pxPerFrame));
    const firstFrame = Math.max(0, Math.floor(this.xToFrame(0) / frameStep) * frameStep);

    // Real decoded thumbnails when a source is wired; else the procedural cell.
    const real = !!(this.sourceKey && this.url);
    const level = levelForFramesPerThumb(frameStep);
    if (real) {
      thumbnailController.registerMedia({ sourceKey: this.sourceKey, url: this.url, frameCount: dur, fps: this.fps });
      thumbnailController.setView(`tstrip:${this.clipId}`, {
        sourceKey: this.sourceKey,
        level,
        startFrame: Math.max(0, Math.floor(this.xToFrame(0))),
        endFrame: Math.min(dur - 1, Math.ceil(this.xToFrame(w))),
        pattern: 'window',
        readaheadFrames: 0,
      });
    }
    // The video occupies [x0, x1] in px; clip the cells to it so the strip never tiles
    // past the source, and the final/first panel's edge lands exactly on the end/start.
    const x0 = this.frameToX(0);
    const x1 = this.frameToX(dur);
    const clipL = Math.max(0, x0);
    const clipR = Math.min(w, x1);
    if (clipR > clipL) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipL, 0, clipR - clipL, h);
      ctx.clip();
      for (let f = firstFrame; f < dur; f += frameStep) {
        const x = this.frameToX(f);
        if (x > w) break;
        const cw = frameStep * this.pxPerFrame;
        if (x + cw < 0) continue;
        const hit = real ? thumbnailController.peek(this.sourceKey, Math.min(dur - 1, f), level) : null;
        if (hit) ctx.drawImage(hit.value, x, 0, cw, h);
        else drawPlaceholderCell(ctx, x, 0, cw - 1, h);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x, 0, 1, h);
      }
      ctx.restore();
    }
    // Past the video's ends (zoomed/panned beyond start or end) ⇒ solid black.
    ctx.fillStyle = '#000';
    if (x0 > 0) ctx.fillRect(0, 0, Math.min(w, x0), h);
    if (x1 < w) ctx.fillRect(Math.max(0, x1), 0, w - Math.max(0, x1), h);

    // Play-mode shading: dim outside the loop region.
    if (this.loopOut > this.loopIn) {
      ctx.fillStyle = 'rgba(8,9,12,0.62)';
      const xi = this.frameToX(this.loopIn);
      const xo = this.frameToX(this.loopOut);
      if (xi > 0) ctx.fillRect(0, 0, xi, h);
      if (xo < w) ctx.fillRect(xo, 0, w - xo, h);
      // Loop in/out markers.
      ctx.fillStyle = 'rgba(108,192,112,0.95)';
      ctx.fillRect(Math.round(xi), 0, 2, h);
      ctx.fillRect(Math.round(xo) - 2, 0, 2, h);
    }
    // random: scatter a few jump ticks.
    if (this.playMode === 'random') {
      ctx.fillStyle = 'rgba(255,218,99,0.7)';
      for (let i = 1; i <= 6; i++) {
        const fr = (dur * ((i * 6353) % 997)) / 997;
        const x = this.frameToX(fr);
        if (x >= 0 && x <= w) ctx.fillRect(Math.round(x), h - 6, 1, 6);
      }
    }

    // Grid ticks + labels.
    const step = niceStep(60 / this.pxPerFrame);
    ctx.font = "8px 'JetBrains Mono',monospace";
    ctx.textBaseline = 'top';
    const startTick = Math.ceil(this.xToFrame(0) / step) * step;
    for (let f = startTick; ; f += step) {
      const x = this.frameToX(f);
      if (x > w) break;
      if (x < 0 || f < 0 || f > dur) continue; // ticks only within the video
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      if (this.showLabels) {
        ctx.fillStyle = 'rgba(176,176,176,0.8)';
        ctx.fillText(String(f), Math.round(x) + 2, 1);
      }
    }

    // Hover marker.
    if (this.hoverFrame != null) {
      const x = this.frameToX(this.hoverFrame);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(Math.round(x), 0, 1, h);
    }
    // Playhead / scrub position.
    if (this.playheadFrame >= 0) {
      const x = this.frameToX(this.playheadFrame);
      ctx.fillStyle = 'rgba(255,140,0,0.95)';
      ctx.fillRect(Math.round(x), 0, 2, h);
    }
  }

  // ── Interaction ───────────────────────────────────────────────────────
  private localX(e: PointerEvent | WheelEvent) {
    return e.clientX - this.getBoundingClientRect().left;
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const dom = e.deltaX || e.deltaY;
      this.emitView(this.pxPerFrame, this.scrollFrames + dom / this.pxPerFrame);
    } else {
      const cx = this.localX(e);
      const anchor = this.scrollFrames + cx / this.pxPerFrame;
      const px = Math.max(0.05, Math.min(40, this.pxPerFrame * Math.exp(-e.deltaY * 0.0015)));
      this.emitView(px, anchor - cx / px);
    }
  };

  private onDown = (e: PointerEvent) => {
    this.dragging = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.scrub(e);
  };
  private onMove = (e: PointerEvent) => {
    const frame = Math.max(0, this.xToFrame(this.localX(e)));
    this.hoverFrame = frame;
    this.dispatchEvent(new CustomEvent('hover', { detail: { frame, clientX: e.clientX } }));
    if (this.dragging) this.scrub(e);
    else this.draw();
  };
  private onUp = (e: PointerEvent) => {
    this.dragging = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  private onLeave = () => {
    this.hoverFrame = null;
    this.dispatchEvent(new CustomEvent('hover', { detail: { frame: null, clientX: 0 } }));
    this.draw();
  };

  private scrub(e: PointerEvent) {
    const frame = Math.max(0, Math.min(this.durationFrames, this.xToFrame(this.localX(e))));
    this.dispatchEvent(new CustomEvent('scrub', { detail: { frame } }));
  }
  private emitView(pxPerFrame: number, scrollFrames: number) {
    this.dispatchEvent(
      new CustomEvent('viewchange', {
        detail: { pxPerFrame, scrollFrames: Math.max(0, scrollFrames) },
      }),
    );
  }
}
