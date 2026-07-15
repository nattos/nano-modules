/**
 * <xfade-curve> — the blend crossfade-shape graph widget.
 *
 * Draws the two fade weight curves wA/wB (blend-xfade-math.ts, the TS mirror
 * of native xfade_shape.h) over the fader domain, plus a playhead at the live
 * fader position. The curve itself IS the editor: dragging LEFT/RIGHT anywhere
 * on the canvas edits the bound `shape` field (full widget width = the full
 * 0..1 range), through the same beginContinuousEdit/update/accept protocol a
 * <scalar-slider> uses. Canvas redraws imperatively on a rAF loop (the
 * envelope-graph pattern) so live modulation of shape/opacity shows without
 * Lit re-renders.
 *
 * Reusable across bindings: `fieldPath` names the shape field ('shape' on
 * composite.blend, '__xfade_shape__' on the per-effect gear) and
 * `opacityField` names the fader whose position the playhead tracks.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, ContinuousEditHandle } from '../widgets/field-editor';
import { xfadeWeightA, xfadeWeightB } from './blend-xfade-math';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

@customElement('xfade-curve')
export class XfadeCurve extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;
  @property() fieldPath = 'shape';
  @property() opacityField = 'opacity';
  @property() label = 'Crossfade Shape';
  @property({ type: Number }) defaultValue = 0;

  private rafId = 0;
  private edit: ContinuousEditHandle | null = null;
  private dragStartX = 0;
  private dragStartValue = 0;
  private dragValue: number | null = null;   // live value while dragging

  static styles = css`
    :host { display: block; }
    .row {
      display: flex; align-items: baseline; justify-content: space-between;
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0);
      padding: 4px 1px 2px;
    }
    .val { font-variant-numeric: tabular-nums; opacity: 0.85; }
    canvas {
      width: 100%; height: 56px; display: block;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 1px;
      touch-action: none; user-select: none; cursor: ew-resize;
    }
    :host([compact]) canvas { height: 36px; }
    :host([compact]) .row { padding-top: 2px; }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.draw(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.edit?.cancel();
    this.edit = null;
  }

  /** Effective shape value: the in-progress drag, else modulated, else state. */
  private shapeValue(): number {
    if (this.dragValue !== null) return this.dragValue;
    const mod = this.binding?.getModulation?.(this.fieldPath);
    if (mod) return clamp01(mod.value);
    const v = this.binding?.getValue(this.fieldPath);
    return clamp01(typeof v === 'number' ? v : this.defaultValue);
  }

  private faderValue(): number | null {
    const mod = this.binding?.getModulation?.(this.opacityField);
    const v = mod ? mod.value : this.binding?.getValue(this.opacityField);
    return typeof v === 'number' ? clamp01(v) : null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.binding || e.button !== 0) return;
    // Synthetic pointer events (tests) have no active pointer to capture.
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    this.dragStartX = e.clientX;
    this.dragStartValue = this.shapeValue();
    this.dragValue = this.dragStartValue;
    this.edit = this.binding.beginContinuousEdit(this.fieldPath, this.dragStartValue);
    e.preventDefault();
    e.stopPropagation();
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.edit) return;
    const w = (this.canvas?.clientWidth ?? 200) || 200;
    this.dragValue = clamp01(this.dragStartValue + (e.clientX - this.dragStartX) / w);
    this.edit.update(this.dragValue);
  };
  private onPointerUp = () => {
    if (!this.edit) return;
    this.edit.accept();
    this.edit = null;
    this.dragValue = null;
  };
  private onPointerCancel = () => {
    if (!this.edit) return;
    this.edit.cancel();
    this.edit = null;
    this.dragValue = null;
  };
  private onDblClick = () => {
    this.binding?.setValue(this.fieldPath, this.defaultValue);   // reset, like a slider
  };

  private get canvas(): HTMLCanvasElement | null {
    return this.renderRoot?.querySelector('canvas') ?? null;
  }

  private draw() {
    const c = this.canvas;
    if (!c) return;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cw * dpr));
    const h = Math.max(1, Math.round(ch * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    const accent = getComputedStyle(this).getPropertyValue('--app-hi-color1').trim() || '#ff4500';
    const s = this.shapeValue();
    const pad = 3;                              // keep full-weight lines visible
    const toX = (t: number) => t * cw;
    const toY = (v: number) => pad + (1 - v) * (ch - 2 * pad);

    // Grid: quarters + the half-strength midline.
    ctx.lineWidth = 1;
    for (let q = 1; q < 4; q++) {
      ctx.strokeStyle = q === 2 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(toX(q / 4), 0); ctx.lineTo(toX(q / 4), ch); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(0, toY(q / 4)); ctx.lineTo(cw, toY(q / 4)); ctx.stroke();
    }

    // The two fade curves: A (dim) fading out, B (accent) fading in.
    const N = 64;
    const trace = (weight: (t: number, s: number) => number) => {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const [x, y] = [toX(t), toY(weight(t, s))];
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    };
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.38)';
    trace(xfadeWeightA); ctx.stroke();
    ctx.strokeStyle = accent;
    trace(xfadeWeightB); ctx.stroke();

    // Playhead: the live fader position, with dots at each curve's weight.
    const fader = this.faderValue();
    if (fader !== null) {
      const px = toX(fader);
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ch); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath(); ctx.arc(px, toY(xfadeWeightA(fader, s)), 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(px, toY(xfadeWeightB(fader, s)), 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  render() {
    return html`
      <div class="row">
        <span>${this.label}</span>
        <span class="val">${this.shapeValue().toFixed(2)}</span>
      </div>
      <canvas
        title="Drag left/right to edit; double-click to reset"
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointercancel=${this.onPointerCancel}
        @dblclick=${this.onDblClick}
      ></canvas>
    `;
  }
}
