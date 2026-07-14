/**
 * Custom inspector for control.nanolooper — the 4-channel looper (1/2/4 bars
 * of 16th-note steps).
 *
 * The top half is a live <nanolooper-grid> canvas that mirrors the effect's own
 * on-video debug overlay: four lanes of continuous note bars (onset + gate
 * length, wrap-aware), a sweeping playhead, per-channel gate highlight, and the
 * trigger-state dots. It's a pure VISUALIZER (like the overlay) — it reads the
 * effect's live published state each frame via `binding.getValue(...)`:
 *   notes:      [{ch,start,length}, …]  recorded pattern (dim when loop_mode=Off)
 *   live_notes: [{ch,start,length}, …]  Off-mode transient live taps (bright)
 *   phase:      0..loop_steps            playhead position in steps
 *   loop_steps: 16/32/64                 loop length in steps (bars × 16)
 *   loop_mode:  0=Off 1=Overdub 2=Latch  header badge + disabled-pattern styling
 *   gates:      [g0,g1,g2,g3]            live per-channel gate (exact, no fade)
 * (published by nanolooper/main.cpp publish_state()).
 *
 * Below the canvas are the looper's controls, grouped exactly like the schema /
 * FFGL param panel, so the effect stays fully editable in the IDE.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import '../widgets/scalar-slider';
import '../widgets/field-tab-bar';
import '../widgets/field-toggle';
import '../widgets/field-trigger';
import '../widgets/help-slot';

const NUM_STEPS = 16;
const NUM_CHANNELS = 4;

// Per-channel colours — must match CH_R/CH_G/CH_B in nanolooper/main.cpp so the
// inspector reads identically to the on-video overlay.
const CH_RGB: [number, number, number][] = [
  [1.0, 0.33, 0.33],  // 1 — red
  [0.33, 1.0, 0.33],  // 2 — green
  [1.0, 1.0, 0.33],   // 3 — yellow
  [0.33, 1.0, 1.0],   // 4 — cyan
];

const ANCHOR_OPTIONS = [
  { label: 'Top Left', value: 0 },
  { label: 'Bottom Left', value: 1 },
  { label: 'Top Right', value: 2 },
  { label: 'Bottom Right', value: 3 },
];

// Loop mode enum — must match LOOP_OFF/OVERDUB/LATCH in nanolooper/main.cpp.
const LOOP_OFF = 0, LOOP_OVERDUB = 1, LOOP_LATCH = 2;
const LOOP_OPTIONS = [
  { label: 'Off', value: LOOP_OFF },
  { label: 'Overdub', value: LOOP_OVERDUB },
  { label: 'Latch', value: LOOP_LATCH },
];

// Loop length in bars — values must match the native `bars` selectField.
const BARS_OPTIONS = [
  { label: '1 Bar', value: 1 },
  { label: '2 Bars', value: 2 },
  { label: '4 Bars', value: 4 },
];

const rgba = (c: [number, number, number], a: number) =>
  `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;

interface Note { ch: number; start: number; length: number; }

// Wrap-aware "is this note sounding at `phase`?" — mirrors note_active() in the
// native overlay so exactly the note(s) under the playhead light up.
function noteActive(n: Note, phase: number, loop: number): boolean {
  if (!(n.length > 0)) return false;
  const len = Math.min(n.length, loop);
  let d = (phase - n.start) % loop;
  if (d < 0) d += loop;
  return d < len;
}

// ---------------------------------------------------------------------------
// The live grid visualization (canvas + rAF), a compact twin of the overlay.
// ---------------------------------------------------------------------------
@customElement('nanolooper-grid')
export class NanolooperGrid extends MobxLitElement {
  binding: FieldBinding | null = null;
  private rafId = 0;

  static styles = css`
    :host { display: block; }
    /* The canvas is absolutely positioned inside a fixed-height wrapper so its
       backing-store width (canvas.width, set to clientWidth*dpr each frame) does
       NOT contribute to the inspector's min-content width. Without this a plain
       width:100% canvas both (a) pins a large minimum panel width and (b) feeds
       back — clientWidth→canvas.width→intrinsic→clientWidth — creeping wider. */
    .wrap {
      position: relative; width: 100%; height: 176px;
      background: rgba(8, 10, 16, 0.55);
      border: 1px solid var(--app-border-color, #3a3346); border-radius: 2px;
    }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
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

  private num(field: string, dflt: number): number {
    const v = this.binding?.getValue(field);
    return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  }

  private notes(): Note[] {
    const v = this.binding?.getValue('notes');
    if (!Array.isArray(v)) return [];
    const out: Note[] = [];
    for (const e of v) {
      if (e && typeof e.ch === 'number') out.push({ ch: e.ch, start: +e.start || 0, length: +e.length || 0 });
    }
    return out;
  }

  private gates(): number[] {
    const v = this.binding?.getValue('gates');
    if (Array.isArray(v)) return v.map((x) => (x ? 1 : 0));
    return [0, 0, 0, 0];
  }

  private liveNotes(): Note[] {
    const v = this.binding?.getValue('live_notes');
    if (!Array.isArray(v)) return [];
    const out: Note[] = [];
    for (const e of v) {
      if (e && typeof e.ch === 'number') out.push({ ch: e.ch, start: +e.start || 0, length: +e.length || 0 });
    }
    return out;
  }

  private draw() {
    const c = this.canvas;
    if (!c || !this.binding) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const cw = c.clientWidth, chh = c.clientHeight;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, chh);

    const phase = this.num('phase', 0);
    const loopSteps = Math.max(this.num('loop_steps', NUM_STEPS), 1);
    const loopMode = this.num('loop_mode', LOOP_OVERDUB);
    const disabled = loopMode === LOOP_OFF;   // pattern kept but not playing
    const gates = this.gates();
    const notes = this.notes();
    const liveNotes = this.liveNotes();

    // --- Layout -----------------------------------------------------------
    const pad = 10;
    const headerH = 22;
    const dotsH = 20;
    const labelW = 26;                         // channel-number column
    const trackX = pad + labelW;
    const trackW = Math.max(40, cw - trackX - pad);
    const lanesTop = pad + headerH;
    const lanesH = chh - lanesTop - dotsH - pad;
    const laneGap = 4;
    const laneH = (lanesH - laneGap * (NUM_CHANNELS - 1)) / NUM_CHANNELS;

    // --- Header: LOOPER + loop-mode badge --------------------------------
    ctx.textBaseline = 'top';
    ctx.font = '700 14px sans-serif';
    ctx.fillStyle = 'rgba(230,235,242,0.95)';
    ctx.fillText('LOOPER', pad, pad);
    ctx.font = '700 11px sans-serif';
    if (loopMode === LOOP_OVERDUB) { ctx.fillStyle = 'rgba(255,72,72,1)'; ctx.fillText('● OVERDUB', pad + 74, pad + 2); }
    else if (loopMode === LOOP_LATCH) { ctx.fillStyle = 'rgba(115,255,153,0.95)'; ctx.fillText('◉ LATCH', pad + 74, pad + 2); }
    else { ctx.fillStyle = 'rgba(158,168,184,0.8)'; ctx.fillText('■ OFF', pad + 74, pad + 2); }

    // --- Beat gridlines (4 beats / bar; bar lines brighter) --------------
    const nBeats = Math.max(Math.round(loopSteps / 4), 1);
    for (let beat = 0; beat <= nBeats; beat++) {
      const gx = trackX + (beat / nBeats) * trackW;
      ctx.fillStyle = `rgba(153,168,199,${beat % 4 === 0 ? 0.32 : 0.13})`;
      ctx.fillRect(gx, lanesTop, 1, lanesH);
    }

    // --- Lanes ------------------------------------------------------------
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      const ly = lanesTop + ch * (laneH + laneGap);
      const col = CH_RGB[ch];
      const gated = gates[ch] !== 0;

      // Lane track (channel highlight while gated — no fade).
      ctx.fillStyle = rgba(col, gated ? 0.16 : 0.05);
      ctx.fillRect(trackX, ly, trackW, laneH);

      // Channel number.
      ctx.font = '700 13px sans-serif';
      ctx.fillStyle = rgba(col, 1);
      ctx.textBaseline = 'middle';
      ctx.fillText(String(ch + 1), pad + 6, ly + laneH / 2);
      ctx.textBaseline = 'top';

      // Recorded note bars — only the note under the playhead flashes bright.
      // In Off mode the pattern is drawn DISABLED (dim); the transient live
      // notes (below) draw bright and vanish on release.
      const barPad = Math.min(4, laneH * 0.12);
      for (const n of notes) {
        if (n.ch !== ch) continue;
        this.drawNoteBar(ctx, n, loopSteps, trackX, trackW, ly + barPad, laneH - 2 * barPad, col,
          !disabled && noteActive(n, phase, loopSteps), disabled);
      }
      for (const n of liveNotes) {
        if (n.ch !== ch) continue;
        this.drawNoteBar(ctx, n, loopSteps, trackX, trackW, ly + barPad, laneH - 2 * barPad, col, true, false);
      }
    }

    // --- Latch capture bar (green progress above the lanes, Latch mode) ---
    // A press while it's showing ADDS to the phrase; it vanishes once a press
    // would instead CLEAR + restart. Mirrors the on-video overlay.
    const latchProg = this.num('latch_capture', -1);
    if (latchProg >= 0) {
      const by = lanesTop - 6;
      ctx.fillStyle = 'rgba(51,102,64,0.4)';
      ctx.fillRect(trackX, by, trackW, 3);
      ctx.fillStyle = 'rgba(115,255,153,0.9)';
      ctx.fillRect(trackX, by, trackW * Math.max(0, Math.min(1, latchProg)), 3);
    }

    // --- Playhead ---------------------------------------------------------
    let ph = phase / loopSteps;
    ph = ph < 0 ? 0 : ph > 1 ? 1 : ph;
    const px = trackX + ph * trackW;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(px - 1, lanesTop - 3, 2, lanesH + 6);

    // --- Trigger-state dots (exact, no hold) -----------------------------
    const dotY = chh - dotsH + 2;
    const dot = 14;
    for (let i = 0; i < NUM_CHANNELS; i++) {
      ctx.fillStyle = rgba(CH_RGB[i], gates[i] ? 1 : 0.28);
      ctx.fillRect(pad + i * (dot + 8), dotY, dot, dot);
    }
    ctx.restore();
  }

  // One note as a continuous bar (up to two segments across the loop seam),
  // bright leading edge on the true onset — mirrors draw_note_bar(). `disabled`
  // (Off mode) draws the recorded pattern dim + desaturated.
  private drawNoteBar(
    ctx: CanvasRenderingContext2D, n: Note, loop: number, trackX: number, trackW: number,
    barY: number, barH: number, col: [number, number, number], playing: boolean,
    disabled = false,
  ) {
    let s0 = n.start % loop; if (s0 < 0) s0 += loop;
    let rem = Math.min(n.length, loop);
    const bodyA = disabled ? 0.26 : (playing ? 0.95 : 0.72);
    const edgeA = disabled ? 0.4 : 1;
    const bf = disabled ? 0.42 : (playing ? 0.85 : 0.55);
    const body: [number, number, number] = [col[0] * bf, col[1] * bf, col[2] * bf];
    const minW = 4;
    let first = true;
    let guard = 0;
    while (rem > 1e-4 && guard++ < 4) {
      let seg = rem;
      if (s0 + seg > loop) seg = loop - s0;
      const x = trackX + (s0 / loop) * trackW;
      const wRaw = (seg / loop) * trackW;
      const wDraw = Math.max(wRaw, minW);
      ctx.fillStyle = rgba(body, bodyA);
      ctx.fillRect(x, barY, wDraw, barH);
      if (first) { ctx.fillStyle = rgba(col, edgeA); ctx.fillRect(x, barY, 2.5, barH); }
      rem -= seg; s0 += seg; if (s0 >= loop) s0 -= loop; first = false;
    }
  }

  render() {
    return html`<div class="wrap"><canvas></canvas></div>`;
  }
}

// ---------------------------------------------------------------------------
// The inspector: live grid on top, grouped controls below.
// ---------------------------------------------------------------------------
@customElement('nanolooper-inspector')
export class NanolooperInspector extends MobxLitElement {
  @property() label = 'Looper';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
    .hint {
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); opacity: 0.7;
      padding: 4px 0 6px; line-height: 1.4;
    }
    .section {
      font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0); padding: 8px 0 2px; opacity: 0.7;
    }
    .row { display: flex; gap: var(--app-sp-4); flex-wrap: wrap; }
    .row > * { flex: 1; min-width: 0; }
    .pads { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--app-sp-4); }
  `;

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      <nanolooper-grid .binding=${b}></nanolooper-grid>
      <div class="hint">live view of the recorded loop — tap the pads to play/record, exactly like the on-video overlay</div>

      <div class="section">Triggers</div>
      <help-slot .binding=${b} .path=${'@group/triggers'}></help-slot>
      <div class="pads">
        <field-trigger ?labelButton=${true} ?tall=${true} .accent=${rgba(CH_RGB[0], 1)} .fieldPath=${'trigger_1'} .label=${'1'} .defaultValue=${0} .binding=${b}></field-trigger>
        <field-trigger ?labelButton=${true} ?tall=${true} .accent=${rgba(CH_RGB[1], 1)} .fieldPath=${'trigger_2'} .label=${'2'} .defaultValue=${0} .binding=${b}></field-trigger>
        <field-trigger ?labelButton=${true} ?tall=${true} .accent=${rgba(CH_RGB[2], 1)} .fieldPath=${'trigger_3'} .label=${'3'} .defaultValue=${0} .binding=${b}></field-trigger>
        <field-trigger ?labelButton=${true} ?tall=${true} .accent=${rgba(CH_RGB[3], 1)} .fieldPath=${'trigger_4'} .label=${'4'} .defaultValue=${0} .binding=${b}></field-trigger>
      </div>

      <div class="section">Editing</div>
      <help-slot .binding=${b} .path=${'@group/editing'}></help-slot>
      <div class="pads">
        <field-trigger ?labelButton=${true} ?tall=${true} .icon=${'la-trash'} .fieldPath=${'delete'} .label=${'Delete'} .defaultValue=${0} .binding=${b}></field-trigger>
        <field-toggle ?labelButton=${true} ?tall=${true} .icon=${'la-volume-mute'} .fieldPath=${'mute'} .label=${'Mute'} .defaultValue=${0} .binding=${b}></field-toggle>
        <field-trigger ?labelButton=${true} ?tall=${true} .icon=${'la-undo'} .fieldPath=${'undo'} .label=${'Undo'} .defaultValue=${0} .binding=${b}></field-trigger>
        <field-trigger ?labelButton=${true} ?tall=${true} .icon=${'la-redo'} .fieldPath=${'redo'} .label=${'Redo'} .defaultValue=${0} .binding=${b}></field-trigger>
      </div>

      <div class="section">Loop</div>
      <help-slot .binding=${b} .path=${'@group/loop'}></help-slot>
      <field-tab-bar .fieldPath=${'loop_mode'} .label=${''}
        .options=${LOOP_OPTIONS} .defaultValue=${1} .binding=${b}></field-tab-bar>
      <field-tab-bar .fieldPath=${'bars'} .label=${'Bars'}
        .options=${BARS_OPTIONS} .defaultValue=${1} .binding=${b}></field-tab-bar>

      <div class="section">Quantize</div>
      <help-slot .binding=${b} .path=${'@group/quantize'}></help-slot>
      <div class="row">
        <field-toggle ?labelButton=${true} .fieldPath=${'quantize_start'} .label=${'Q Start'} .defaultValue=${0} .binding=${b}></field-toggle>
        <field-toggle ?labelButton=${true} .fieldPath=${'quantize_length'} .label=${'Q Length'} .defaultValue=${0} .binding=${b}></field-toggle>
      </div>
      <scalar-slider style="width:100%;" .fieldPath=${'quantize_start_amount'} .label=${'Quantize Amount'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>
      <scalar-slider style="width:100%;" .fieldPath=${'grace'} .label=${'Grace'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.0625} .binding=${b}></scalar-slider>

      <div class="section">Output</div>
      <help-slot .binding=${b} .path=${'@group/output'}></help-slot>
      <field-toggle ?labelButton=${true} .fieldPath=${'send_to_rail'} .label=${'Send To Rail'} .defaultValue=${1} .binding=${b}></field-toggle>
      <scalar-slider style="width:100%;" .fieldPath=${'strict_deadline'} .label=${'Strict Deadline'} .min=${0} .max=${250} .step=${5} .defaultValue=${0} .binding=${b}></scalar-slider>

      <div class="section">Display</div>
      <help-slot .binding=${b} .path=${'@group/display'}></help-slot>
      <field-toggle ?labelButton=${true} .fieldPath=${'show_overlay'} .label=${'Show Overlay'} .defaultValue=${1} .binding=${b}></field-toggle>
      <field-tab-bar .fieldPath=${'anchor'} .label=${'Anchor'} ?wrap=${true}
        .options=${ANCHOR_OPTIONS} .defaultValue=${0} .binding=${b}></field-tab-bar>
      <scalar-slider style="width:100%;" .fieldPath=${'overlay_opacity'} .label=${'Overlay Opacity'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${1} .binding=${b}></scalar-slider>

      <div class="section">Synth</div>
      <help-slot .binding=${b} .path=${'@group/synth'}></help-slot>
      <field-toggle ?labelButton=${true} .fieldPath=${'synth'} .label=${'Synth'} .defaultValue=${0} .binding=${b}></field-toggle>
      <scalar-slider style="width:100%;" .fieldPath=${'synth_gain'} .label=${'Synth Gain'} .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
    `;
  }
}

editorRegistry.register('control.nanolooper', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('nanolooper-inspector') as NanolooperInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
