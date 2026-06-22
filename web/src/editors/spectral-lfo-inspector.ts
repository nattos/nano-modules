/**
 * Custom inspector for mod.source.spectral_lfo — the spectral-morph LFO generator.
 *
 * Headline control is an XY pad over the t-SNE manifold: the shape atlas is
 * drawn as a faint scatter (per metric) with the Delaunay mesh overlaid and the
 * active triangle highlighted, and the user drags to set morph_x / morph_y.
 * Below it, a live preview draws the final morphed envelope (ghosting the three
 * source shapes + the raw pre-straighten blend), with a playhead riding the
 * curve at the module's broadcast phase. Same spirit as the *_fold inspectors
 * and the original web prototype.
 *
 * The pad is a real FieldEditorElement (controlledFields = morph_x + morph_y),
 * so taps / rails / layout / selection line up like the standard widgets.
 *
 * Mesh + preview need the control points + triangulation, which load lazily
 * from a fetched binary (spectral-lfo-data); the scatter dots come from the
 * small inline module so the pad paints instantly. Autopilot is non-destructive:
 * when on, the effect orbits internally and broadcasts autopilot_x/y; the pad
 * and preview follow that live position.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, MultiContinuousEditHandle } from '../widgets/field-editor';
import { decodeScatter, SCATTER_NUM_METRICS, SCATTER_NUM_POINTS } from './spectral-lfo-scatter-data';
import { loadSpectralLfoData, SpectralLfoData, type MorphResult } from './spectral-lfo-data';
import '../widgets/scalar-slider';
import '../widgets/field-tab-bar';
import '../widgets/field-toggle';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const METRIC_OPTIONS = [
  { label: 'FFT Magnitude', value: 0 },
  { label: 'Phase Coherence', value: 1 },
  { label: 'Roughness', value: 2 },
  { label: 'Spectral vs TD', value: 3 },
  { label: 'Combined', value: 4 },
];

// Decoded once, shared by every pad instance (fast first-paint scatter).
const SCATTER = decodeScatter();

// Shared lazy load of the full editor data (control points + triangulation).
let sharedData: SpectralLfoData | null = null;
loadSpectralLfoData().then(d => { sharedData = d; }).catch(() => {});

function effPos(b: FieldBinding): [number, number] {
  const ax = b.getValue('autopilot_x'), ay = b.getValue('autopilot_y');
  const auto = Number(b.getValue('autopilot') ?? 0) !== 0;
  const x = auto && typeof ax === 'number' ? ax : Number(b.getValue('morph_x') ?? 0.5);
  const y = auto && typeof ay === 'number' ? ay : Number(b.getValue('morph_y') ?? 0.5);
  return [clamp01(x), clamp01(y)];
}
function metricOf(b: FieldBinding): number {
  const m = Number(b.getValue('metric') ?? 0);
  return m >= 0 && m < SCATTER_NUM_METRICS ? (m | 0) : 0;
}

// Satellite layout — must match satellite_xy() in the native module.
const SAT_RADIUS_MAX = 0.45;
const SAT_COLORS = ['#ff9944', '#44ccff', '#aaff44'];
function satellitesEnabled(b: FieldBinding): boolean {
  return Number(b.getValue('satellites') ?? 0) !== 0;
}
// Three taps in a triangle around (cx, cy). Mirrors native satellite_xy():
// quadratic spread → orbit radius, rotation a full turn, clamped to the pad.
function satelliteLayout(cx: number, cy: number, spread: number, rotation: number): [number, number][] {
  const radius = spread * spread * SAT_RADIUS_MAX;
  const clampPad = (v: number) => (v < 0.02 ? 0.02 : v > 0.98 ? 0.98 : v);
  const pts: [number, number][] = [];
  for (let k = 0; k < 3; k++) {
    const ang = rotation * Math.PI * 2 + k * ((Math.PI * 2) / 3);
    pts.push([clampPad(cx + radius * Math.cos(ang)), clampPad(cy + radius * Math.sin(ang))]);
  }
  return pts;
}
function satellitePositions(b: FieldBinding, center?: [number, number]): [number, number][] {
  const [cx, cy] = center ?? effPos(b);
  return satelliteLayout(cx, cy, Number(b.getValue('sat_spread') ?? 0.3), Number(b.getValue('sat_rotation') ?? 0));
}

/**
 * The draggable manifold XY pad — a multi-field FieldEditorElement controlling
 * `morph_x` (x) and `morph_y` (y). Static layer (scatter + Delaunay mesh) on one
 * canvas; the active triangle on an overlay canvas redrawn as the point moves.
 */
@customElement('spectral-lfo-xy-pad')
export class SpectralLfoXyPad extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'morph_x';   // primary controlled field
  @property() label = 'Manifold';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return ['morph_x', 'morph_y']; }
  getControlElements(): HTMLElement[] {
    const pad = this.renderRoot?.querySelector('.pad') as HTMLElement | null;
    return pad ? [pad] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  private rafId = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private edit: MultiContinuousEditHandle | null = null;
  // Backdrop redraw memo.
  private bgMetric = -1; private bgW = 0; private bgH = 0; private bgHadData = false;
  // Overlay redraw memo.
  private ovKey = '';

  static styles = css`
    :host { display: block; }
    .group-label { font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px; }
    .pad {
      position: relative; width: 100%; aspect-ratio: 1 / 1; margin: 2px 0 6px;
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 1px;
      background-color: var(--app-bg-color1); overflow: hidden;
      cursor: crosshair; touch-action: none; user-select: none;
    }
    canvas.layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; display: block; }
    .handle {
      position: absolute; width: 14px; height: 14px; border-radius: 50%;
      border: 2px solid #fff; box-shadow: 0 0 0 1px #000, 0 0 6px #000;
      transform: translate(-50%, -50%); pointer-events: none; left: 50%; top: 50%;
    }
    .pad-caption { text-align: center; font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); margin: -4px 0 2px; }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.frame(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame() {
    this.drawBackdrop();
    this.drawOverlay();
    this.syncHandle();
  }

  private interp(): boolean { return Number(this.binding?.getValue('interpolation') ?? 1) !== 0; }

  // Scatter + Delaunay mesh — repainted only when metric / size / data changes.
  private drawBackdrop() {
    const canvas = this.renderRoot?.querySelector('canvas.scatter') as HTMLCanvasElement | null;
    if (!canvas || !this.binding) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    const metric = metricOf(this.binding);
    const hasData = !!sharedData;
    if (metric === this.bgMetric && w === this.bgW && h === this.bgH && hasData === this.bgHadData) return;
    this.bgMetric = metric; this.bgW = w; this.bgH = h; this.bgHadData = hasData;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    // Delaunay mesh (only meaningful when interpolating, but cheap to always show).
    if (sharedData && this.interp()) {
      const mesh = sharedData.mesh(metric);
      ctx.strokeStyle = 'rgba(110,110,170,0.22)';
      ctx.lineWidth = Math.max(0.5, dpr * 0.5);
      ctx.beginPath();
      for (let t = 0; t < mesh.numTris; t++) {
        const a = mesh.tris[t * 3], b = mesh.tris[t * 3 + 1], c = mesh.tris[t * 3 + 2];
        const ax = mesh.coords[a * 2] * w, ay = (1 - mesh.coords[a * 2 + 1]) * h;
        const bx = mesh.coords[b * 2] * w, by = (1 - mesh.coords[b * 2 + 1]) * h;
        const cx = mesh.coords[c * 2] * w, cy = (1 - mesh.coords[c * 2 + 1]) * h;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.lineTo(ax, ay);
      }
      ctx.stroke();
    }

    // Scatter dots — from the full data once loaded, else the inline fallback.
    ctx.fillStyle = 'rgba(150,180,255,0.6)';
    const r = Math.max(1, Math.round(dpr));
    if (sharedData) {
      const mesh = sharedData.mesh(metric);
      for (let i = 0; i < sharedData.numEntries; i++) {
        const x = mesh.coords[i * 2] * w, y = (1 - mesh.coords[i * 2 + 1]) * h;
        ctx.fillRect(x - r * 0.5, y - r * 0.5, r, r);
      }
    } else {
      const base = metric * SCATTER_NUM_POINTS * 2;
      for (let i = 0; i < SCATTER_NUM_POINTS; i++) {
        const x = (SCATTER[base + i * 2] / 255) * w, y = (1 - SCATTER[base + i * 2 + 1] / 255) * h;
        ctx.fillRect(x - r * 0.5, y - r * 0.5, r, r);
      }
    }
  }

  // Active triangle — redrawn when the resolved point crosses a triangle.
  private drawOverlay() {
    const canvas = this.renderRoot?.querySelector('canvas.overlay') as HTMLCanvasElement | null;
    if (!canvas || !this.binding) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const metric = metricOf(this.binding);
    const interp = this.interp();
    // Resolve from the live drag center while dragging, else the committed pos.
    const [ex, ey] = this.dragging ? [this.dragX, this.dragY] : effPos(this.binding);
    const sats = satellitesEnabled(this.binding);
    const satPts = sats ? satellitePositions(this.binding, [ex, ey]) : null;
    const key = `${metric}|${interp}|${sharedData ? 1 : 0}|${ex.toFixed(4)}|${ey.toFixed(4)}` +
      `|${sats ? satPts!.map(p => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(';') : '-'}`;
    if (key === this.ovKey) return;
    this.ovKey = key;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const sx = (p: [number, number]) => p[0] * w, sy = (p: [number, number]) => (1 - p[1]) * h;

    // Active triangle for the center tap.
    if (sharedData && interp) {
      const tri = sharedData.triangleAt(metric, ex, ey);
      if (tri) {
        ctx.beginPath();
        ctx.moveTo(sx(tri[0]), sy(tri[0]));
        ctx.lineTo(sx(tri[1]), sy(tri[1]));
        ctx.lineTo(sx(tri[2]), sy(tri[2]));
        ctx.closePath();
        ctx.fillStyle = 'rgba(120,120,230,0.18)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,150,235,0.7)';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.stroke();
      }
    }

    // Satellite taps — a faint triangle joining the three, plus colored markers.
    if (sats && satPts) {
      ctx.beginPath();
      ctx.moveTo(sx(satPts[0]), sy(satPts[0]));
      ctx.lineTo(sx(satPts[1]), sy(satPts[1]));
      ctx.lineTo(sx(satPts[2]), sy(satPts[2]));
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();
      const cxp = ex * w, cyp = (1 - ey) * h;
      for (let k = 0; k < 3; k++) {
        const px = sx(satPts[k]), py = sy(satPts[k]);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = Math.max(0.5, dpr * 0.5);
        ctx.beginPath(); ctx.moveTo(cxp, cyp); ctx.lineTo(px, py); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, 4 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = SAT_COLORS[k]; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = dpr; ctx.stroke();
      }
    }
  }

  private syncHandle() {
    const handle = this.renderRoot?.querySelector('.handle') as HTMLElement | null;
    if (!handle || !this.binding) return;
    const [x, y] = this.dragging ? [this.dragX, this.dragY] : effPos(this.binding);
    handle.style.left = x * 100 + '%';
    handle.style.top = (1 - y) * 100 + '%';
  }

  private xyFromEvent(e: PointerEvent, pad: HTMLElement): [number, number] {
    const r = pad.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01(1 - (e.clientY - r.top) / r.height)];
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    pad.setPointerCapture(e.pointerId);
    this.dragging = true;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    this.edit = this.binding.beginContinuousEditMulti?.({ morph_x: x, morph_y: y }) ?? null;
    if (!this.edit) { this.binding.setValue('morph_x', x); this.binding.setValue('morph_y', y); }
  }
  private onPointerMove(e: PointerEvent) {
    if (!this.dragging || !this.binding) return;
    const pad = e.currentTarget as HTMLElement;
    const [x, y] = this.xyFromEvent(e, pad);
    this.dragX = x; this.dragY = y;
    if (this.edit) this.edit.update({ morph_x: x, morph_y: y });
    else { this.binding.setValue('morph_x', x); this.binding.setValue('morph_y', y); }
  }
  private onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    this.edit?.accept();
    this.edit = null;
  }

  render() {
    return html`
      ${this.label ? html`<div class="group-label">${this.label}</div>` : ''}
      <div class="pad"
        @pointerdown=${(e: PointerEvent) => this.onPointerDown(e)}
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${() => this.onPointerUp()}
        @pointercancel=${() => this.onPointerUp()}>
        <canvas class="layer scatter"></canvas>
        <canvas class="layer overlay"></canvas>
        <div class="handle"></div>
      </div>
      <div class="pad-caption">spectral manifold</div>
    `;
  }
}

/**
 * Live preview of the final morphed envelope. Recomputes (client-side, same
 * pipeline as the module) when the resolved position / metric / interpolation
 * changes; draws the source-shape ghosts, the raw pre-straighten blend, the
 * cleaned curve, and a playhead at the module's broadcast phase.
 */
@customElement('spectral-lfo-preview')
export class SpectralLfoPreview extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;
  // Playhead x ∈ [0,1]. When null the LFO's live `phase` output is used; a
  // consumer (e.g. mod.shaper.spectral, which indexes the curve by its INPUT rather
  // than time) can set this imperatively to park the head at that value.
  cursor: number | null = null;

  private rafId = 0;
  private key = '';
  private result: MorphResult | null = null;
  private satCurves: Float32Array[] | null = null;

  static styles = css`
    :host { display: block; }
    .group-label { font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding: 2px 0; }
    canvas { width: 100%; aspect-ratio: 3 / 1; display: block; border-radius: 1px;
             border: 1px solid var(--app-border-color, #3a3346); }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.frame(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame() {
    if (!this.binding || !sharedData) return;
    const metric = metricOf(this.binding);
    const interp = Number(this.binding.getValue('interpolation') ?? 1) !== 0;
    const [x, y] = effPos(this.binding);
    const sats = satellitesEnabled(this.binding);
    const satPts = sats ? satellitePositions(this.binding) : null;
    const satKey = satPts ? satPts.map(p => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(';') : '-';
    const key = `${metric}|${interp}|${x.toFixed(4)}|${y.toFixed(4)}|${satKey}`;
    if (key !== this.key) {
      this.key = key;
      this.result = sharedData.computeMorph(metric, x, y, interp);
      this.satCurves = satPts
        ? satPts.map(p => sharedData!.computeMorph(metric, p[0], p[1], interp).curve)
        : null;
    }
    this.draw();
  }

  private draw() {
    const canvas = this.renderRoot?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas || !this.result || !this.binding) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const pad = 4 * dpr;
    const px = (i: number, n: number) => (i / (n - 1)) * w;
    const py = (v: number) => pad + (1 - clamp01(v)) * (h - 2 * pad);

    ctx.fillStyle = '#121418'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(110,110,170,0.18)'; ctx.lineWidth = Math.max(0.5, dpr * 0.5);
    for (let i = 0; i <= 4; i++) {
      const gy = (i / 4) * h, gx = (i / 4) * w;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }

    const r = this.result;
    const stroke = (curve: Float32Array, style: string, lw: number) => {
      ctx.beginPath();
      for (let i = 0; i < curve.length; i++) {
        const X = px(i, curve.length), Y = py(curve[i]);
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      }
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.stroke();
    };

    // Satellite envelopes — just the final curves (no source ghosts), drawn
    // under the center curve in their pad-marker colors.
    if (this.satCurves) {
      for (let k = 0; k < this.satCurves.length; k++) stroke(this.satCurves[k], SAT_COLORS[k], 1.3 * dpr);
    }

    if (r.single) {
      stroke(r.curve, '#4488ff', 2 * dpr);
    } else {
      // Hide the interpolation-source ghosts when satellites are on — three
      // extra curves plus the source shapes gets too noisy; keep it clean.
      if (!this.satCurves) {
        const ghosts = ['rgba(255,102,102,0.27)', 'rgba(102,255,102,0.27)', 'rgba(102,102,255,0.27)'];
        for (let v = 0; v < 3; v++) stroke(r.sources[v], ghosts[v], dpr);
        stroke(r.raw, 'rgba(204,102,255,0.27)', dpr);
      }
      stroke(r.curve, '#cc66ff', 2 * dpr);
    }

    // Playhead at the explicit cursor (mod.shaper.spectral's input index) or, when
    // unset, the module's live broadcast phase (mod.source.spectral_lfo).
    const ph = this.cursor != null ? this.cursor : this.binding.getValue('phase');
    if (typeof ph === 'number') {
      const xph = clamp01(ph) * w;
      const i = Math.min(r.curve.length - 1, Math.round(clamp01(ph) * (r.curve.length - 1)));
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(xph, 0); ctx.lineTo(xph, h); ctx.stroke();
      ctx.beginPath(); ctx.arc(xph, py(r.curve[i]), 3 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
    }
  }

  render() { return html`<div class="group-label">Envelope</div><canvas></canvas>`; }
}

@customElement('spectral-lfo-inspector')
export class SpectralLfoInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 6px 0 2px; opacity: 0.7;
    }
  `;

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <div class="section">Shape</div>
      <spectral-lfo-xy-pad .label=${''} .binding=${b}></spectral-lfo-xy-pad>
      <spectral-lfo-preview .binding=${b}></spectral-lfo-preview>
      <field-tab-bar .fieldPath=${'metric'} .label=${'Metric'} ?wrap=${true}
        .options=${METRIC_OPTIONS} .defaultValue=${0} .binding=${b}></field-tab-bar>
      <field-toggle .fieldPath=${'interpolation'} .label=${'Interpolation'}
        .defaultValue=${1} .binding=${b}></field-toggle>

      <div class="section">Output</div>
      <scalar-slider style="width: 100%;" .fieldPath=${'rate'} .label=${'Rate'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.4} .binding=${b}></scalar-slider>
      <scalar-slider style="width: 100%;" .fieldPath=${'amplitude'} .label=${'Amplitude'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      <div class="section">Satellites</div>
      <field-toggle .fieldPath=${'satellites'} .label=${'Satellites'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      ${Number(b.getValue('satellites') ?? 0) !== 0 ? html`
        <scalar-slider style="width: 100%;" .fieldPath=${'sat_spread'} .label=${'Spread'}
          .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
        <scalar-slider style="width: 100%;" .fieldPath=${'sat_rotation'} .label=${'Rotation'}
          .min=${0} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      ` : ''}

      <div class="section">Autopilot</div>
      <field-toggle .fieldPath=${'autopilot'} .label=${'Autopilot'}
        .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width: 100%;" .fieldPath=${'ap_speed'} .label=${'AP Speed'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
    `;
  }
}

editorRegistry.register('mod.source.spectral_lfo', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('spectral-lfo-inspector') as SpectralLfoInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
