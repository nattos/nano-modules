/**
 * <arr-rail-lane> — value preview for a rail (return) track. Draws the base
 * automation curve plus the contributions layered on top from modulation
 * "writers" (clips that export to this rail), summed into a result envelope.
 * Spans the full warped timeline. Editing the base curve isn't prototyped.
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { buildBeatGrid } from './grid-shared';
import { compositionLengthBeats } from '../model/composition';
import { evalCurveAt } from '../engine/automation-eval';
import { setAnchor, clearAnchor, AnchorKeys } from './anchor-registry';

@customElement('arr-rail-lane')
export class ArrRailLane extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      display: block;
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

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this);
    this.draw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    const t = store.trackById(this.trackId);
    if (t?.railId) clearAnchor(AnchorKeys.rail(t.railId));
  }
  updated() {
    this.draw();
    const t = store.trackById(this.trackId);
    if (t?.railId) setAnchor(AnchorKeys.rail(t.railId), this);
  }

  render() {
    // Touch observables that affect the curve so it redraws.
    void store.pxPerBeat;
    void store.scrollUnits;
    return html`<canvas></canvas>`;
  }

  private draw() {
    const track = store.trackById(this.trackId);
    const canvas = this.canvas;
    if (!track || !canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const grid = buildBeatGrid();
    const totalBeats = compositionLengthBeats(store.composition);
    const base = track.baseCurve ?? [{ x: 0, y: 0.3 }];
    const accent = track.color ?? 'var(--app-cat-mod)';
    const writers = store.railWriters(track.railId ?? '');

    const yOf = (v: number) => h - 4 - Math.max(0, Math.min(1, v)) * (h - 8);
    const contribAt = (beat: number) => {
      let sum = 0;
      for (let i = 0; i < writers.length; i++) {
        const c = writers[i].clip;
        const end = c.startBeat + c.lengthBeat;
        if (beat < c.startBeat || beat > end) continue;
        const seed = (i + 1) * 1.3;
        // Smooth fade-in/out window × a slow oscillation (mock writer signal).
        const tt = (beat - c.startBeat) / Math.max(0.001, c.lengthBeat);
        const win = Math.sin(tt * Math.PI); // 0→1→0 across the clip
        sum += 0.32 * win * (0.55 + 0.45 * Math.sin(beat * 0.7 + seed));
      }
      return sum;
    };

    // Filled result envelope (base + contributions).
    ctx.beginPath();
    ctx.moveTo(0, h);
    let started = false;
    for (let x = 0; x <= w; x += 2) {
      const beat = grid.xToBeat(x);
      const v = evalCurveAt(base, beat / totalBeats) + contribAt(beat);
      const y = yOf(v);
      if (!started) {
        ctx.lineTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(70,194,194,0.10)';
    ctx.fill();

    // Result line on top.
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const beat = grid.xToBeat(x);
      const v = evalCurveAt(base, beat / totalBeats) + contribAt(beat);
      const y = yOf(v);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Base curve (dashed, dim) so contributions read as "on top".
    ctx.beginPath();
    for (let x = 0; x <= w; x += 3) {
      const beat = grid.xToBeat(x);
      const y = yOf(evalCurveAt(base, beat / totalBeats));
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Playhead tick + the live evaluated value at the playhead (a dot on the
    // result line — the value this rail currently carries).
    const px = grid.beatToX(store.positionBeat);
    if (px >= 0 && px <= w) {
      ctx.fillStyle = 'rgba(255,140,0,0.7)';
      ctx.fillRect(Math.round(px), 0, 1, h);
      const vNow = evalCurveAt(base, store.positionBeat / totalBeats) + contribAt(store.positionBeat);
      ctx.beginPath();
      ctx.arc(px, yOf(vNow), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
