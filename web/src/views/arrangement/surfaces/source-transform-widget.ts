/**
 * <source-transform-widget> — the placement editor for a video/image clip's source
 * frame within the output canvas, shown under the scale-mode tab bar (fit/cover/none).
 *
 * It draws two intersecting rectangles: the OUTPUT CANVAS (its aspect = the
 * composition resolution) and the SOURCE FRAME (its aspect = the video, placed per
 * the live scale mode + transform via the SAME `placeGeom` the compositor's blitter
 * uses, so the preview matches the render). Dragging the source rect repositions it
 * (anchor XY), clamped to the canvas unless Option/Alt is held. Anchor/scale are also
 * editable as text; rotation is a 0/90/180/270 enum; flip H/V are icon toggles.
 *
 * Pure presentation + gesture: it reads a resolved `transform` + aspects and emits
 * `onChange(patch, coalesceKey)`. The host (arr-clip-view) wires it to the store.
 */

import { LitElement, html, css, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { placeGeom, type BlitFit, type BlitTransform, type PlaceGeom } from '../../../video/frame-blitter';
import '../../../widgets/scalar-slider';
import '../../../widgets/editable-number';

@customElement('source-transform-widget')
export class SourceTransformWidget extends LitElement {
  /** Composition resolution (px) — the canvas rect's aspect + the 'none' logical size. */
  @property({ type: Number }) canvasW = 1920;
  @property({ type: Number }) canvasH = 1080;
  /** Source native pixel size — the frame rect's aspect. Falls back to canvas aspect. */
  @property({ type: Number }) videoW = 0;
  @property({ type: Number }) videoH = 0;
  @property() mode: BlitFit = 'fit';
  @property({ attribute: false }) transform: BlitTransform = {
    anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false,
  };
  /** Emit a transform patch. `coalesceKey` groups a drag into one undo entry. */
  @property({ attribute: false }) onChange?: (patch: Partial<BlitTransform>, coalesceKey?: string) => void;

  /** Drag state: pointer grab offset (canvas-normalised) from the frame's top-left. */
  private drag: { offX: number; offY: number; rectW: number; rectH: number } | null = null;

  static styles = css`
    :host { display: block; }
    .pad {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: var(--app-bg-color1, #1a1a1a);
      border: 1px solid var(--app-tint-4, #3a3a3a);
      border-radius: 3px;
      touch-action: none;
      cursor: grab;
      overflow: hidden;
    }
    .pad.grabbing { cursor: grabbing; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    .rows { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .row { display: flex; align-items: center; gap: 6px; font-size: var(--app-fs-xs, 11px); color: var(--app-text-color2, #aaa); }
    .row > span { min-width: 48px; }
    scalar-slider { flex: 1; min-width: 0; font-size: var(--app-fs-xs, 11px); }
    editable-number.num {
      font-size: var(--app-fs-xs, 11px); width: 56px;
      background: var(--app-bg-color1, #1a1a1a); color: var(--app-text-color1, #eee);
      border: 1px solid var(--app-tint-4, #3a3a3a); border-radius: 2px;
      --editable-text-pad: 1px 4px;
    }
    .seg { display: inline-flex; border: 1px solid var(--app-tint-4, #3a3a3a); border-radius: 2px; overflow: hidden; }
    .seg button {
      font-family: inherit; font-size: var(--app-fs-xs, 11px); border: none;
      background: var(--app-bg-color1, #1a1a1a); color: var(--app-text-color2, #aaa);
      padding: 2px 7px; cursor: pointer;
    }
    .seg button.on { background: var(--app-hi-color2, #4169e1); color: #fff; }
    .flip { display: inline-flex; gap: 4px; }
    .flip button {
      font-family: inherit; font-size: var(--app-fs-xs, 11px); display: inline-flex; align-items: center; gap: 3px;
      background: var(--app-bg-color1, #1a1a1a); color: var(--app-text-color2, #aaa);
      border: 1px solid var(--app-tint-4, #3a3a3a); border-radius: 2px; padding: 2px 7px; cursor: pointer;
    }
    .flip button.on { background: var(--app-hi-color2, #4169e1); color: #fff; }
  `;

  /** The frame's placement geometry. When the source aspect is KNOWN, this is the
   *  real `placeGeom` (matches the blit). When UNKNOWN (no probed dimensions), draw a
   *  centred square ~60% of the canvas's short side (× scale) instead of snapping to
   *  the canvas aspect — so it's not snug to either edge and the anchor stays
   *  draggable on both axes (the actual render still uses the real texture size). */
  private framePlaceGeom(): PlaceGeom {
    if (this.videoW > 0 && this.videoH > 0) {
      return placeGeom(this.videoW, this.videoH, this.canvasW, this.canvasH, this.mode, this.transform, this.canvasW, this.canvasH);
    }
    const side = 0.6 * Math.min(this.canvasW, this.canvasH) * Math.max(1e-3, this.transform.scale);
    const w = side / Math.max(1, this.canvasW);
    const h = side / Math.max(1, this.canvasH);
    return {
      rect: [this.transform.anchorX * (1 - w), this.transform.anchorY * (1 - h), w, h],
      rot: 0, flipH: this.transform.flipH, flipV: this.transform.flipV,
    };
  }

  updated(_c: PropertyValues) {
    this.draw();
  }

  /** The canvas box (px, in the pad) the output rect occupies — fit by aspect with
   *  margin so an overflowing source rect stays visible. */
  private canvasBox(W: number, H: number) {
    const ca = this.canvasW / this.canvasH;
    const margin = 0.62; // canvas occupies ~62% of the pad → overflow shows
    let bw = W * margin, bh = bw / ca;
    if (bh > H * margin) { bh = H * margin; bw = bh * ca; }
    return { x: (W - bw) / 2, y: (H - bh) / 2, w: bw, h: bh };
  }

  private draw() {
    const cvs = this.renderRoot.querySelector('canvas') as HTMLCanvasElement | null;
    if (!cvs) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = cvs.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    cvs.width = W * dpr; cvs.height = H * dpr;
    const ctx = cvs.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const box = this.canvasBox(W, H);
    const g = this.framePlaceGeom();
    // Source frame rect in pad px (may extend beyond the canvas box).
    const fx = box.x + g.rect[0] * box.w;
    const fy = box.y + g.rect[1] * box.h;
    const fw = g.rect[2] * box.w;
    const fh = g.rect[3] * box.h;

    // Source frame (filled, accent) — drawn first so the canvas outline sits on top.
    ctx.fillStyle = 'rgba(65,105,225,0.28)';
    ctx.strokeStyle = 'rgba(65,105,225,0.95)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(fx, fy, fw, fh);
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
    // A small arrow hint for rotation/flip orientation: a corner tick at the frame's
    // (post-transform) top-left source corner.
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(fx + 2, fy + 2, 6, 6);

    // Output canvas outline (on top, dashed white).
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    ctx.setLineDash([]);
  }

  // ── drag to set anchor ──
  private padBox() {
    const pad = this.renderRoot.querySelector('.pad') as HTMLElement;
    const r = pad.getBoundingClientRect();
    return { r, box: this.canvasBox(r.width, r.height) };
  }

  private onDown = (e: PointerEvent) => {
    const { r, box } = this.padBox();
    const px = (e.clientX - r.left - box.x) / box.w; // canvas-normalised pointer
    const py = (e.clientY - r.top - box.y) / box.h;
    const g = this.framePlaceGeom();
    this.drag = { offX: px - g.rect[0], offY: py - g.rect[1], rectW: g.rect[2], rectH: g.rect[3] };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    (this.renderRoot.querySelector('.pad') as HTMLElement)?.classList.add('grabbing');
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || !this.onChange) return;
    const { r, box } = this.padBox();
    const px = (e.clientX - r.left - box.x) / box.w;
    const py = (e.clientY - r.top - box.y) / box.h;
    // rect.left = anchor·(1 - rect.w) ⇒ anchor = rect.left / (1 - rect.w).
    const denomX = 1 - d.rectW, denomY = 1 - d.rectH;
    const free = e.altKey; // Option/Alt → leave the canvas bounds
    const clamp = (v: number) => (free ? v : Math.max(0, Math.min(1, v)));
    const patch: Partial<BlitTransform> = {};
    if (Math.abs(denomX) > 1e-4) patch.anchorX = clamp((px - d.offX) / denomX);
    if (Math.abs(denomY) > 1e-4) patch.anchorY = clamp((py - d.offY) / denomY);
    if (patch.anchorX !== undefined || patch.anchorY !== undefined) this.onChange(patch, `xform-drag:${this.mode}`);
  };

  private onUp = (e: PointerEvent) => {
    this.drag = null;
    (this.renderRoot.querySelector('.pad') as HTMLElement)?.classList.remove('grabbing');
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  /** A 0..1 anchor as a scalar-slider (text entry escapes the bounds, matching
   *  the Option-drag "leave the canvas" affordance). */
  private slider(label: string, val: number, key: keyof BlitTransform) {
    const apply = (e: Event) =>
      this.onChange?.({ [key]: (e as CustomEvent<number>).detail } as Partial<BlitTransform>, `xform-text:${key}`);
    return html`<scalar-slider
      label=${label}
      .value=${val}
      .min=${0}
      .max=${1}
      .step=${0.01}
      .defaultValue=${0.5}
      @input=${apply}
      @change=${apply}
    ></scalar-slider>`;
  }

  /** A range-free number (scale) as an editable-number with jog + text entry. */
  private num(label: string, val: number, key: keyof BlitTransform, step = 0.1) {
    return html`<span>${label}</span><editable-number class="num" .value=${val} .step=${step} .precision=${3} .min=${0}
      @input=${(e: CustomEvent<number>) =>
        this.onChange?.({ [key]: e.detail } as Partial<BlitTransform>, `xform-text:${key}`)}
    ></editable-number>`;
  }

  render() {
    const t = this.transform;
    return html`
      <div class="pad" @pointerdown=${this.onDown} @pointermove=${this.onMove}
        @pointerup=${this.onUp} @pointercancel=${this.onUp} title="Drag to reposition · hold Option to move past the canvas edge">
        <canvas></canvas>
      </div>
      <div class="rows">
        <div class="row">${this.slider('Anchor X', t.anchorX, 'anchorX')}</div>
        <div class="row">${this.slider('Anchor Y', t.anchorY, 'anchorY')}</div>
        <div class="row">${this.num('Scale', t.scale, 'scale', 0.1)}</div>
        <div class="row"><span>Rotation</span>
          <div class="seg">
            ${([0, 90, 180, 270] as const).map((r) => html`<button class=${t.rotation === r ? 'on' : ''}
              @click=${() => this.onChange?.({ rotation: r })}>${r}°</button>`)}
          </div>
        </div>
        <div class="row"><span>Flip</span>
          <div class="flip">
            <button class=${t.flipH ? 'on' : ''} @click=${() => this.onChange?.({ flipH: !t.flipH })}
              title="Flip horizontal">↔ flip</button>
            <button class=${t.flipV ? 'on' : ''} @click=${() => this.onChange?.({ flipV: !t.flipV })}
              title="Flip vertical">↕ flip</button>
          </div>
        </div>
      </div>
    `;
  }
}
