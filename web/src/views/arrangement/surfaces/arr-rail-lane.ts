/**
 * <arr-rail-lane> — value preview for a rail (return) track. Draws the rail's real
 * value curve: the base automation plus every active writer's modulation, evaluated
 * OFFLINE in a worker (off the main + composition threads) and folded into a mean
 * line. Stochastic writers can't yield one value per beat, so they contribute an
 * "error-bar" band (lo..hi) drawn behind the line. The curve is recomputed
 * asynchronously on scroll / zoom / edit; the playhead dot redraws live from cache.
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { buildBeatGrid } from './grid-shared';
import { compositionLengthBeats } from '../model/composition';
import { setAnchor, clearAnchor, AnchorKeys } from './anchor-registry';
import { WireConnect } from '../../../widgets/taps-connect';
import { offlineCurveService } from '../engine/offline-curve-service';
import { catalogEffect } from '../engine/effect-catalog';
import { railMeanAt, type RailCurve, type WriterSpec, type RailCombine } from '../engine/offline-curve-eval';

/** One screen-space sample per this many CSS px (the worker fills the rest). */
const SAMPLE_PX = 3;

@customElement('arr-rail-lane')
export class ArrRailLane extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;

  static styles = css`
    :host { position: absolute; inset: 0; display: block; overflow: hidden; }
    /* Over-rendered 2× (½ host width of margin each side) so a pan/zoom can be
       applied as a cheap GPU transform of the baked pixels without revealing empty
       edges. transform-origin sits at the host's left (25% of the 200%-wide canvas)
       so scaleX is exact. */
    canvas {
      position: absolute; top: 0; bottom: 0;
      left: -50%; width: 200%; height: 100%; display: block;
      transform-origin: 25% 0;
      will-change: transform;
    }
    /* Wires-mode drop target: drag a device field pip onto a return rail to export
       (output field) or read (input field) it. Highlights while hovered mid-drag. */
    .rail-drop { position: absolute; inset: 0; cursor: crosshair; }
    .rail-drop[tap-drop-target] {
      background: rgba(70, 194, 194, 0.18);
      box-shadow: inset 0 0 0 2px var(--app-cat-mod, #46c2c2);
    }
  `;

  @query('canvas') private canvas!: HTMLCanvasElement;
  private ro?: ResizeObserver;

  /** Latest offline-evaluated curve (mean + lo/hi band). */
  private curve: RailCurve | null = null;
  /** The beats each curve sample was evaluated at — reprojected through the CURRENT
   *  grid every draw so a continuous zoom/pan re-maps the cached curve immediately. */
  private curveBeats: Float32Array | null = null;
  /** The dispose handle for THIS lane's in-flight request listener. */
  private cancelReq: (() => void) | null = null;
  /** Signature of the inputs the last request was built from — re-request only when
   *  it changes (so the playhead moving redraws the dot without re-evaluating). */
  private lastReqSig = '';
  private reqTimer = 0;
  private rafId = 0;
  // ── Bake-and-transform state ──────────────────────────────────────────────
  // The canvas is "baked" (drawn) at one grid, then a continuous pan/light-zoom is
  // applied as a cheap CSS transform of those pixels every frame; we only re-bake
  // (redraw) when the transform drifts too far, the playhead moves on its own, or
  // it's time to settle. The wheel handler mutates pxPerBeat/scrollUnits in a tight
  // burst, so this rides the GPU compositor instead of redrawing the canvas.
  private bakedPp = 22;
  private bakedSu = 0;
  private bakedPos = -1;
  private bakedAt = 0;

  firstUpdated() {
    this.ro = new ResizeObserver(() => { this.lastReqSig = ''; this.scheduleRequest(); this.draw(); });
    this.ro.observe(this);
    this.scheduleRequest();
    this.draw();
    const tick = () => {
      this.rafId = requestAnimationFrame(tick);
      const pp = store.pxPerBeat, su = store.scrollUnits, pos = store.positionBeat;
      if (pp === this.bakedPp && su === this.bakedSu && pos === this.bakedPos) return; // idle
      // Keep coverage fresh during continuous motion (throttled re-sample).
      const reqSig = this.requestSig();
      if (reqSig !== this.lastReqSig) { this.lastReqSig = reqSig; this.scheduleRequest(); }
      // The exact affine that maps the baked grid → the current grid (origin at the
      // host's left, i.e. 25% of the over-rendered canvas): scaleX = pp/bakedPp,
      // translateX = (bakedSu − su)·pp. Holds even under a warp (the warp is baked
      // into the sampled x; only the units→px mapping changes here).
      const scaleX = pp / this.bakedPp;
      const tx = (this.bakedSu - su) * pp;
      const margin = (this.canvas?.clientWidth ?? 0) / 4; // ½ host width, in px
      const drifted = Math.abs(scaleX - 1) > 0.18 || Math.abs(tx) > margin * 0.85;
      const now = (globalThis.performance?.now?.() ?? 0);
      // Re-bake when the transform would stretch visibly / run past the over-render
      // margin, when the playhead moved INDEPENDENTLY (during a scroll the dot rides
      // the transform, so only a real transport move forces a redraw), or after a
      // short while to settle at full density. Otherwise just transform — no redraw.
      if (pos !== this.bakedPos || drifted || now - this.bakedAt > 250) {
        this.draw();
      } else {
        this.canvas.style.transform = `translateX(${tx}px) scaleX(${scaleX})`;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.cancelReq?.();
    if (this.reqTimer) clearTimeout(this.reqTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    const t = store.trackById(this.trackId);
    if (t?.railId) clearAnchor(AnchorKeys.rail(t.railId));
  }

  updated() {
    // Re-request when the curve's INPUTS changed (the worker callback then re-bakes
    // on the fresh data). Do NOT draw here: the rAF loop is the sole driver of
    // pan/zoom (transform-or-rebake) — re-baking from `updated()` on every Lit
    // update would clear the transform each microtask and defeat the trick.
    const sig = this.requestSig();
    if (sig !== this.lastReqSig) { this.lastReqSig = sig; this.scheduleRequest(); }
    const t = store.trackById(this.trackId);
    if (t?.railId) setAnchor(AnchorKeys.rail(t.railId), this);
  }

  render() {
    // Tracked reads: grid (pxPerBeat/scroll) + playhead drive redraws; the base curve
    // + writers drive re-requests (read here so MobX fires updated() on any change).
    void store.pxPerBeat; void store.scrollUnits; void store.positionBeat;
    const t = store.trackById(this.trackId);
    void t?.railSigned;
    if (t?.baseCurve) for (const p of t.baseCurve) { void p.x; void p.y; }
    for (const w of store.railWriters(t?.railId ?? '')) {
      void w.clip.startBeat; void w.clip.lengthBeat; void w.exp.combine; void w.exp.scale;
    }
    return html`<canvas></canvas>${store.wiresMode && t?.railId
      ? html`<div class="tap-overlay-hit rail-drop" data-rail-id=${t.railId}
          @pointerdown=${(e: PointerEvent) => this.onRailDown(e, t.railId!)}></div>`
      : ''}`;
  }

  private onRailDown(e: PointerEvent, railId: string) {
    const g = WireConnect.active;
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    g.completeOnRail(railId);
  }

  // ── offline curve request ───────────────────────────────────────────────

  /** Gather the active writers contributing to this rail (cheap store reads). For
   *  `mod.source.lfo` we transfer the instance params so the worker mirrors its real
   *  curve; other effects fall back to the generic seeded stub. */
  private writerSpecs(railId: string): WriterSpec[] {
    const out: WriterSpec[] = [];
    for (const { clip, exp } of store.railWriters(railId)) {
      const dev = clip.sketch.devices.find((d) => d.id === exp.sourceDeviceId);
      // Source output polarity from the catalog (a signed source like the LFO declares a
      // [-1,1] output) — drives the rail-domain conversion in the offline mirror.
      const srcOut = catalogEffect(dev?.moduleType ?? '')?.outputs?.find((o) => o.key === exp.sourceField);
      const spec: WriterSpec = {
        seed: hashStr(clip.id + '/' + exp.id),
        // TODO: read a declared `modulation_stochastic` capability. Heuristic for now.
        stochastic: /noise|random|spectral/i.test(dev?.moduleType ?? ''),
        combine: (exp.combine ?? 'add') as RailCombine,
        scale: exp.scale ?? 1,
        startBeat: clip.startBeat,
        endBeat: clip.startBeat + clip.lengthBeat,
        sourceSigned: (srcOut?.min ?? 0) < 0,
      };
      if (dev?.moduleType === 'mod.source.lfo') {
        const st = (dev.state ?? {}) as Record<string, unknown>;
        const num = (k: string, d: number) => (typeof st[k] === 'number' ? (st[k] as number) : d);
        spec.kind = 'lfo';
        spec.lfo = {
          mode: num('mode', 0), rate: num('rate', 0.5), period: num('period', 1),
          amplitude: num('amplitude', 1), waveform: num('waveform', 0),
          shape: num('shape', 0), invert: st['invert'] === true || st['invert'] === 1,
        };
        spec.stochastic = spec.lfo.waveform === 4 || spec.lfo.waveform === 5; // Random Walk/FM
      }
      out.push(spec);
    }
    return out;
  }

  private secondsPerBeat(): number {
    return 60 / Math.max(1e-3, store.composition.meta.baseBPM);
  }

  private signed(): boolean {
    return store.trackById(this.trackId)?.railSigned ?? false;
  }

  /** A fingerprint of everything the curve depends on EXCEPT the playhead. */
  private requestSig(): string {
    const t = store.trackById(this.trackId);
    if (!t?.railId) return '';
    const w = this.canvas?.clientWidth ?? 0;
    const writers = this.writerSpecs(t.railId)
      .map((s) => `${s.seed}:${s.combine}:${s.scale}:${s.startBeat}:${s.endBeat}:${s.stochastic ? 1 : 0}`
        + (s.lfo ? `:lfo(${s.lfo.mode},${s.lfo.rate},${s.lfo.period},${s.lfo.amplitude},${s.lfo.waveform},${s.lfo.shape},${s.lfo.invert ? 1 : 0})` : ''))
      .join(',');
    return `${w}|${store.pxPerBeat}|${store.scrollUnits}|${this.secondsPerBeat()}|${this.signed() ? 1 : 0}|${JSON.stringify(t.baseCurve)}|${writers}`;
  }

  private lastSentAt = -1e9;
  private scheduleRequest() {
    // THROTTLE (not debounce): during a continuous scroll/zoom the request must
    // keep firing so newly-revealed beats are sampled mid-motion — a debounce
    // would reset every frame and only fire once the gesture settled (the "only
    // redraws on dwell" bug). Fire on the leading edge if enough time has passed,
    // else schedule one trailing call. The service keeps only the latest per rail.
    if (this.reqTimer) return; // a trailing request is already queued
    const THROTTLE_MS = 60;
    const now = (globalThis.performance?.now?.() ?? 0);
    const since = now - this.lastSentAt;
    if (since >= THROTTLE_MS) {
      this.lastSentAt = now;
      this.sendRequest();
    } else {
      this.reqTimer = window.setTimeout(() => {
        this.reqTimer = 0;
        this.lastSentAt = (globalThis.performance?.now?.() ?? 0);
        this.sendRequest();
      }, THROTTLE_MS - since);
    }
  }

  private sendRequest() {
    const t = store.trackById(this.trackId);
    const canvas = this.canvas;
    if (!t?.railId || !canvas) return;
    const w = canvas.clientWidth; // over-rendered (2× host)
    if (w <= 0) return;
    const margin = w / 4; // host-x 0 sits at canvas-x `margin`
    const n = Math.max(2, Math.ceil(w / SAMPLE_PX) + 1);
    const grid = buildBeatGrid();
    const step = w / (n - 1);
    const beats = new Float32Array(n);
    // Sample across the FULL over-rendered canvas (host-x −margin … +margin beyond
    // each edge) so a pan within the margin always has baked curve to show.
    for (let i = 0; i < n; i++) beats[i] = grid.xToBeat(i * step - margin);
    this.cancelReq?.();
    this.cancelReq = offlineCurveService.request(
      t.railId,
      // Plain copies — MobX observable arrays/proxies can't be structured-cloned
      // across postMessage. `writerSpecs` already returns plain objects.
      { baseCurve: (t.baseCurve ?? [{ x: 0, y: 0 }]).map((p) => ({ x: p.x, y: p.y })),
        totalBeats: compositionLengthBeats(store.composition),
        secondsPerBeat: this.secondsPerBeat(), signed: this.signed(),
        writers: this.writerSpecs(t.railId), beats },
      (curve) => { this.curve = curve; this.curveBeats = beats; this.draw(); },
    );
  }

  // ── draw ────────────────────────────────────────────────────────────────

  private draw() {
    const track = store.trackById(this.trackId);
    const canvas = this.canvas;
    if (!track || !canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // This is a BAKE at the current grid: drop any pan/zoom transform and record the
    // grid we drew at, so the rAF loop transforms from here until the next re-bake.
    canvas.style.transform = '';
    this.bakedPp = store.pxPerBeat;
    this.bakedSu = store.scrollUnits;
    this.bakedPos = store.positionBeat;
    this.bakedAt = (globalThis.performance?.now?.() ?? 0);
    // The canvas is over-rendered 2× (½ host width of margin each side); host-x 0
    // sits at canvas-x `margin`, so every x is offset by it.
    const margin = w / 4;

    const grid = buildBeatGrid();
    const accent = track.color ?? 'var(--app-cat-mod)';
    const signed = this.signed();
    // Same drawing for both modes; only where 0 sits differs. Unsigned: 0 at the
    // bottom, 1 at the top. Signed: 0 centred, ±1 at the edges.
    const yOf = signed
      ? (v: number) => h / 2 - Math.max(-1, Math.min(1, v)) * (h / 2 - 4)
      : (v: number) => h - 4 - Math.max(0, Math.min(1, v)) * (h - 8);
    const zeroY = Math.round(yOf(0)) + 0.5; // the rail's rest reference (floor / centre)
    // Faint zero/floor reference line (both modes — keeps the look consistent).
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();
    const curve = this.curve;
    const beats = this.curveBeats;

    if (curve && curve.mean.length >= 2) {
      const n = curve.mean.length;
      // Project each cached sample by its BEAT through the current grid, so a live
      // zoom/pan re-maps the curve immediately (the worker re-samples after a
      // debounce to refill density). Fall back to even spacing if beats are absent
      // or out of sync with the sample count.
      const xOf = (beats && beats.length === n)
        ? (i: number) => grid.beatToX(beats[i]) + margin
        : (i: number) => (i / (n - 1)) * w;
      // Error-bar band (lo..hi) — only widens where a stochastic writer contributes.
      ctx.beginPath();
      for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(curve.hi[i]));
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(curve.lo[i]));
      ctx.closePath();
      ctx.fillStyle = 'rgba(70,194,194,0.16)';
      ctx.fill();
      // Filled mean envelope down to the rail's zero line (consistent in both modes).
      ctx.beginPath();
      ctx.moveTo(xOf(0), zeroY);
      for (let i = 0; i < n; i++) ctx.lineTo(xOf(i), yOf(curve.mean[i]));
      ctx.lineTo(xOf(n - 1), zeroY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(70,194,194,0.08)';
      ctx.fill();
      // Mean line on top.
      ctx.beginPath();
      for (let i = 0; i < n; i++) (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, xOf(i), yOf(curve.mean[i]));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // (No playhead tick / value dot on rail lanes — the curve alone reads cleaner.)
  }
}

/** Cheap deterministic string → small int hash (writer identity seed). */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}
