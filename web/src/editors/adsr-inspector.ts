/**
 * Custom inspector for mod.source.adsr — the ADSR envelope generator.
 *
 * Reuses the mod.shaper.envelope curve machinery for VISUALIZATION + easier control: an
 * <adsr-graph> draws the live A-D-S-R shape (shaped by the same envelope.h
 * `applyEase` the effect uses) and lets you drag the phase handles / bend the
 * per-phase slope, with a live level meter riding the right edge.
 *
 * Zero-duration phases are the classic envelope-editor footgun — a phase at 0s
 * collapses its handle onto its neighbour and becomes un-grabbable. We solve it
 * two ways: (1) every visible phase is laid out with a MINIMUM display width so
 * handles never coincide, and (2) handle drags are RELATIVE (delta from where
 * the drag began), so dragging a floored-to-zero handle rightward grows its time
 * from 0. Every region stays clickable regardless of its actual duration.
 *
 * The graph edits the individual scalar params (attack/decay/sustain/release +
 * *_curve); mode / voices / retrigger / trigger surface live as widgets below.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from '../widgets/field-editor';
import { applyEase, clamp01 } from './envelope-math';
import '../widgets/scalar-slider';
import '../widgets/field-tab-bar';
import '../widgets/field-toggle';
import '../widgets/field-trigger';
import '../widgets/help-slot';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// Mode / retrigger ids — must match the native enums in env_adsr/main.cpp.
const MODE_D = 0, MODE_AD = 1, MODE_ADS = 2, MODE_ADSR = 3;
export const MODE_OPTIONS = [
  { label: 'Decay', value: MODE_D },
  { label: 'AD', value: MODE_AD },
  { label: 'ADS', value: MODE_ADS },
  { label: 'ADSR', value: MODE_ADSR },
];
export const RETRIG_OPTIONS = [
  { label: 'Reset', value: 0 },
  { label: 'Legato', value: 1 },
  { label: 'Poly', value: 2 },
];

interface AdsrParams {
  mode: number;
  attack: number; decay: number; sustain: number; release: number;
  aCurve: number; dCurve: number; rCurve: number;
}

// Param 0..1 → seconds — mirrors env_adsr's `seconds()` so phase widths scale
// the way the effect actually times them.
const seconds = (p: number) => { const c = clamp(p, 0, 1); return 0.003 + c * c * 4; };
const phasesFor = (mode: number) => ({
  attack: mode !== MODE_D,
  sustain: mode === MODE_ADS || mode === MODE_ADSR,
  release: mode === MODE_ADSR,
});

type SegKind = 'attack_curve' | 'decay_curve' | 'release_curve' | 'sustain';
interface Pt { x: number; y: number }
interface Layout {
  pts: Pt[];
  segKind: SegKind[];      // length pts.length-1
  segCurve: number[];      // ease per segment (0 for the sustain plateau)
  handles: { node: number; field: 'attack' | 'decay' | 'release' }[];
}

// Fixed, NON-LINEAR time axis: every phase boundary sits at timeToX(cumulative
// seconds), a saturating map that squishes longer times toward — but never onto —
// the right edge. So growing `decay` slides its handle visibly rightward (it
// asymptotes, never pinning at the edge), which makes "this node IS the decay
// time" obvious — important for the default Decay mode where it's the only knob.
// A MIN_GAP keeps a zero-duration phase's handle from collapsing onto its
// neighbour (every region stays clickable).
const TX_K = 0.6;            // timeToX reference: t/(t+K) → asymptotes to 1
const SUS_TIME = 0.6;        // display seconds for the (gate-held) sustain plateau
const MIN_GAP = 0.05;        // min x between consecutive handles
const MAX_X = 0.97;          // headroom so the axis visibly never reaches the end
const timeToX = (t: number) => t / (t + TX_K);

function layout(p: AdsrParams): Layout {
  const has = phasesFor(p.mode);
  const susLvl = has.sustain ? clamp01(p.sustain) : 0;

  const raw: Pt[] = [];
  const segKind: SegKind[] = [];
  let t = 0;
  if (has.attack) {
    raw.push({ x: timeToX(0), y: 0 });
    t += seconds(p.attack); raw.push({ x: timeToX(t), y: 1 }); segKind.push('attack_curve');
  } else {
    raw.push({ x: timeToX(0), y: 1 });                 // instant attack → start at peak
  }
  t += seconds(p.decay);
  // Decay-only mode special case: its single segment spans the whole height, so
  // riding the saturating axis felt wild. Use a LINEAR axis centred so decay 0.5
  // lands the handle dead-centre — even spread, predictable drag.
  const decayX = p.mode === MODE_D
    ? MIN_GAP + clamp01(p.decay) * (0.5 - MIN_GAP) * 2
    : timeToX(t);
  raw.push({ x: decayX, y: susLvl }); segKind.push('decay_curve');
  if (has.sustain) {
    t += SUS_TIME; raw.push({ x: timeToX(t), y: susLvl }); segKind.push('sustain');
    // ADS/ADSR show a release tail (ADS mirrors decay); D/AD already hit 0 at decay.
    t += seconds(has.release ? p.release : p.decay);
    raw.push({ x: timeToX(t), y: 0 }); segKind.push('release_curve');
  }

  // Keep handles grabbable (a zero-duration phase has coincident x) + leave the
  // end headroom that shows the axis never reaches 1.
  for (let i = 1; i < raw.length; i++)
    if (raw[i].x < raw[i - 1].x + MIN_GAP) raw[i].x = raw[i - 1].x + MIN_GAP;
  for (const n of raw) if (n.x > MAX_X) n.x = MAX_X;

  const pts = raw;
  const segCurve = segKind.map(k =>
    k === 'attack_curve' ? p.aCurve : k === 'decay_curve' ? p.dCurve : k === 'release_curve' ? p.rCurve : 0);

  const handles: Layout['handles'] = [];
  if (has.attack) handles.push({ node: 1, field: 'attack' });
  handles.push({ node: has.attack ? 2 : 1, field: 'decay' });
  if (has.release) handles.push({ node: pts.length - 1, field: 'release' });
  return { pts, segKind, segCurve, handles };
}

function evalShape(pts: Pt[], segCurve: number[], x: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[n - 1].x) return pts[n - 1].y;
  for (let i = 0; i < n - 1; i++) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const span = pts[i + 1].x - pts[i].x;
      const t = span > 0 ? (x - pts[i].x) / span : 0;
      return pts[i].y + applyEase(t, segCurve[i]) * (pts[i + 1].y - pts[i].y);
    }
  }
  return pts[n - 1].y;
}

// ----- The ADSR graph editor -------------------------------------------------

@customElement('adsr-graph')
export class AdsrGraph extends MobxLitElement {
  binding: FieldBinding | null = null;

  private rafId = 0;
  private readonly pad = 10;
  private layout: Layout = { pts: [], segKind: [], segCurve: [], handles: [] };

  // Drag state.
  private mode: 'none' | 'node' | 'seg' = 'none';
  private field = '';                 // param being edited
  private axis: 'x' | 'y' = 'x';
  private startVal = 0;
  private startPx = 0; private startPy = 0;
  private began = false;
  private edit: ContinuousEditHandle | null = null;
  get interacting() { return this.mode !== 'none'; }

  static styles = css`
    :host { display: block; }
    canvas {
      width: 100%; height: 140px; display: block;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 1px;
      touch-action: none; user-select: none; cursor: crosshair;
    }
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
  }

  private get canvas(): HTMLCanvasElement | null {
    return this.renderRoot?.querySelector('canvas') ?? null;
  }
  private dims() { const c = this.canvas!; return { w: c.clientWidth, h: c.clientHeight }; }
  private toPx(x: number, y: number): [number, number] {
    const { w, h } = this.dims();
    return [this.pad + x * (w - 2 * this.pad), (h - this.pad) - y * (h - 2 * this.pad)];
  }
  private yFromPx(py: number): number {
    const { h } = this.dims();
    return clamp01(((h - this.pad) - py) / (h - 2 * this.pad));
  }
  private eventXY(e: PointerEvent): [number, number] {
    const r = this.canvas!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private params(): AdsrParams {
    const b = this.binding;
    const g = (k: string, d = 0) => { const v = b?.getValue(k); return typeof v === 'number' ? v : d; };
    return {
      mode: g('mode', 0),
      attack: g('attack', 0.05), decay: g('decay', 0.3),
      sustain: g('sustain', 0.5), release: g('release', 0.3),
      aCurve: g('attack_curve', 0), dCurve: g('decay_curve', 0), rCurve: g('release_curve', 0),
    };
  }

  private hitHandle(px: number, py: number): { field: 'attack' | 'decay' | 'release' } | null {
    let best: { field: 'attack' | 'decay' | 'release' } | null = null, bestD = 13 * 13;
    for (const h of this.layout.handles) {
      const [hx, hy] = this.toPx(this.layout.pts[h.node].x, this.layout.pts[h.node].y);
      const d = (hx - px) ** 2 + (hy - py) ** 2;
      if (d < bestD) { bestD = d; best = { field: h.field }; }
    }
    return best;
  }
  private segAt(dataX: number): number {
    const pts = this.layout.pts;
    for (let i = 0; i < pts.length - 1; i++)
      if (dataX >= pts[i].x && dataX <= pts[i + 1].x) return i;
    return -1;
  }

  private onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !this.binding) return;
    const [px, py] = this.eventXY(e);
    this.canvas!.setPointerCapture(e.pointerId);
    this.began = false; this.startPx = px; this.startPy = py;
    const h = this.hitHandle(px, py);
    if (h) {
      this.mode = 'node'; this.field = h.field; this.axis = 'x';
      this.startVal = this.params()[h.field];
      return;
    }
    const { w } = this.dims();
    const dataX = clamp01((px - this.pad) / (w - 2 * this.pad));
    const seg = this.segAt(dataX);
    if (seg < 0) { this.mode = 'none'; return; }
    const kind = this.layout.segKind[seg];
    this.mode = 'seg'; this.axis = 'y';
    const p = this.params();
    if (kind === 'sustain') { this.field = 'sustain'; this.startVal = p.sustain; }
    else if (kind === 'attack_curve') { this.field = 'attack_curve'; this.startVal = p.aCurve; }
    else if (kind === 'decay_curve') { this.field = 'decay_curve'; this.startVal = p.dCurve; }
    else { this.field = 'release_curve'; this.startVal = p.rCurve; }
  }

  private onPointerMove(e: PointerEvent) {
    if (this.mode === 'none' || !this.binding) return;
    const [px, py] = this.eventXY(e);
    if (!this.began) {
      if (Math.abs(px - this.startPx) < 3 && Math.abs(py - this.startPy) < 3) return;
      this.began = true;
      this.edit = this.binding.beginContinuousEdit(this.field, this.startVal);
    }
    const { w } = this.dims();
    let next = this.startVal;
    if (this.mode === 'node') {
      if (this.field === 'decay' && this.params().mode === MODE_D) {
        // Decay-only uses a linear, invertible axis → track the cursor exactly
        // (the same mapping `layout` draws), so it never feels wild.
        const x = clamp01((px - this.pad) / (w - 2 * this.pad));
        next = clamp01((x - MIN_GAP) / ((0.5 - MIN_GAP) * 2));
      } else {
        // Relative x-drag → time. ~70% of the width sweeps the full 0..1 range, so
        // a floored-to-zero handle grows from 0 the moment you drag right.
        next = clamp01(this.startVal + (px - this.startPx) / (w - 2 * this.pad) * 1.4);
      }
    } else if (this.field === 'sustain') {
      next = this.yFromPx(py);                                   // absolute level
    } else {
      // Drag up = bend the curve UP (toward higher values). A falling segment
      // (decay/release) needs the opposite ease sign from the rising attack.
      const dir = this.field === 'attack_curve' ? -1 : 1;
      next = clamp(this.startVal + dir * (py - this.startPy) / 120, -1, 1);
    }
    this.edit?.update(next);
  }

  private onPointerUp() {
    if (this.began) this.edit?.accept();
    this.edit = null; this.mode = 'none'; this.began = false;
  }

  private draw() {
    const c = this.canvas;
    if (!c || !this.binding) return;
    this.layout = layout(this.params());
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    const { w: cw, h: ch } = this.dims();
    ctx.clearRect(0, 0, cw, ch);
    const accent = getComputedStyle(this).getPropertyValue('--app-hi-color1').trim() || '#ff4500';

    // Grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let q = 0; q <= 4; q++) {
      const [, gy] = this.toPx(0, q / 4);
      ctx.beginPath(); ctx.moveTo(this.pad, gy); ctx.lineTo(cw - this.pad, gy); ctx.stroke();
    }

    // Curve + fill.
    const { pts, segCurve } = this.layout;
    const N = 120;
    const samples: [number, number][] = [];
    for (let i = 0; i <= N; i++) { const x = i / N; samples.push(this.toPx(x, evalShape(pts, segCurve, x))); }
    const [, baseY] = this.toPx(0, 0);
    ctx.beginPath();
    ctx.moveTo(samples[0][0], baseY);
    for (const [sx, sy] of samples) ctx.lineTo(sx, sy);
    ctx.lineTo(samples[samples.length - 1][0], baseY);
    ctx.closePath();
    ctx.fillStyle = accent + '22'; ctx.fill();
    ctx.beginPath();
    samples.forEach(([sx, sy], i) => (i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy)));
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();

    // Live level meter — a bar + tick at the current output value.
    const lvRaw = this.binding.getValue('output');
    const lv = typeof lvRaw === 'number' ? clamp01(lvRaw) : 0;
    const [, ly] = this.toPx(0, lv);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(this.pad, ly); ctx.lineTo(cw - this.pad, ly); ctx.stroke();
    ctx.setLineDash([]);
    const [, by0] = this.toPx(0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(cw - this.pad - 3, ly, 3, by0 - ly);

    // Handles.
    for (const hnd of this.layout.handles) {
      const [nx, ny] = this.toPx(pts[hnd.node].x, pts[hnd.node].y);
      ctx.beginPath(); ctx.arc(nx, ny, 5, 0, Math.PI * 2);
      ctx.fillStyle = accent; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#0a0a0a'; ctx.stroke();
    }
    ctx.restore();
  }

  render() {
    return html`<canvas
      @pointerdown=${(e: PointerEvent) => this.onPointerDown(e)}
      @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
      @pointerup=${() => this.onPointerUp()}
      @pointercancel=${() => this.onPointerUp()}></canvas>`;
  }
}

// ----- The mod.source.adsr inspector -----------------------------------------------

@customElement('adsr-inspector')
export class AdsrInspector extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = 'mode';   // legacy single-field convention; we use controlledFields
  @property() label = 'Envelope';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() {
    return ['mode', 'attack', 'decay', 'sustain', 'release',
      'attack_curve', 'decay_curve', 'release_curve'];
  }
  getControlElements(): HTMLElement[] {
    const g = this.renderRoot?.querySelector('adsr-graph') as HTMLElement | null;
    return g ? [g] : [];
  }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  static styles = css`
    :host { display: block; }
    .label { font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding: 2px 0; }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); opacity: 0.7;
      padding: 4px 0 6px; line-height: 1.4;
    }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 8px 0 2px; opacity: 0.7;
    }
    .row { display: flex; gap: var(--app-sp-4); }
    .row > * { flex: 1; min-width: 0; }
  `;

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      ${this.label ? html`<div class="label">${this.label}</div>` : ''}
      <field-tab-bar .fieldPath=${'mode'} .label=${''} ?wrap=${true}
        .options=${MODE_OPTIONS} .defaultValue=${0} .binding=${b}></field-tab-bar>
      <adsr-graph .binding=${b}></adsr-graph>
      <div class="hint">drag a handle to set a phase time · drag a segment to bend its slope (or the sustain plateau to set its level)</div>

      <div class="section">Phases</div>
      <help-slot .binding=${b} .path=${'@group/shape'}></help-slot>
      <div class="row">
        <scalar-slider .fieldPath=${'attack'} .label=${'Attack'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.05} .binding=${b}></scalar-slider>
        <scalar-slider .fieldPath=${'decay'} .label=${'Decay'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
      </div>
      <div class="row">
        <scalar-slider .fieldPath=${'sustain'} .label=${'Sustain'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
        <scalar-slider .fieldPath=${'release'} .label=${'Release'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.3} .binding=${b}></scalar-slider>
      </div>

      <div class="section">Slope</div>
      <scalar-slider style="width:100%;" .fieldPath=${'attack_curve'} .label=${'Attack slope'} .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width:100%;" .fieldPath=${'decay_curve'} .label=${'Decay slope'} .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>
      <scalar-slider style="width:100%;" .fieldPath=${'release_curve'} .label=${'Release slope'} .min=${-1} .max=${1} .step=${0.01} .defaultValue=${0} .binding=${b}></scalar-slider>

      <div class="section">Voices</div>
      <help-slot .binding=${b} .path=${'@group/polyphony'}></help-slot>
      <div class="row">
        <scalar-slider .fieldPath=${'voices'} .label=${'Voices'} .min=${1} .max=${16} .step=${1} .defaultValue=${1} .binding=${b}></scalar-slider>
        <field-tab-bar .fieldPath=${'retrigger'} .label=${'Retrigger'} .options=${RETRIG_OPTIONS} .defaultValue=${0} .binding=${b}></field-tab-bar>
      </div>

      <div class="section">Trigger</div>
      <help-slot .binding=${b} .path=${'@group/trigger'}></help-slot>
      <scalar-slider style="width:100%;" .fieldPath=${'auto_rate'} .label=${'Auto rate'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.2} .binding=${b}></scalar-slider>
      <div class="row">
        <field-toggle .fieldPath=${'gate'} .label=${'Gate'} .defaultValue=${0} .binding=${b}></field-toggle>
        <field-trigger .fieldPath=${'trigger'} .label=${'Trigger'} .defaultValue=${0} .binding=${b}></field-trigger>
      </div>
    `;
  }
}

editorRegistry.register('mod.source.adsr', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('adsr-inspector') as AdsrInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
