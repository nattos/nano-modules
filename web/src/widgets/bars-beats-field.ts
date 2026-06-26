/**
 * <bars-beats-field> — an Ableton-style `bar.beat.sixteenth` position field.
 *
 * Three focusable segments sharing one underlying beat value:
 *  - Each segment focuses independently (Tab / click) and JOGS with the arrow
 *    keys (Up/Right +, Down/Left −) by its own musical amount — a bar, a beat,
 *    or a sixteenth. Jogging past a bound carries into the neighbour naturally
 *    (the math is linear; see bbs.ts).
 *  - Typing a digit or pressing Enter on a segment edits THAT segment inline.
 *  - DOUBLE-CLICK edits the whole value as one `bar.beat.sixteenth` string.
 *
 * Carries the position as a single `value` in beats and emits `input`
 * (detail: number, beats) on every change. Edit boxes reuse <editable-text>.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import './editable-text';
import type { EditableText } from './editable-text';
import { beatsToBBS, bbsToBeats, formatBBS, parseBBS, type BBS } from './bbs';

type EditTarget = 'whole' | 0 | 1 | 2 | null;

@customElement('bars-beats-field')
export class BarsBeatsField extends LitElement {
  @property({ type: Number }) value = 0;
  @property({ type: Number }) beatsPerBar = 4;
  /** Sixteenths per beat (4 for a quarter-note beat). */
  @property({ type: Number }) sixPerBeat = 4;
  @property({ type: Number }) min = 0;
  @property({ type: Boolean }) disabled = false;

  @state() private edit: EditTarget = null;

  private editSeed = '';
  private selectOnEdit = false;
  /** Segment to refocus after an inline edit ends, or to focus after render. */
  private pendingFocusSeg: number | null = null;
  private pendingFocusEdit = false;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: baseline;
      font-variant-numeric: tabular-nums;
      gap: 0;
    }
    .seg {
      cursor: ns-resize;
      padding: 1px 2px;
      border: 1px solid transparent;
      border-radius: 1px;
      outline: none;
      min-width: 1ch;
      text-align: center;
    }
    .seg:hover { background: var(--app-tint-3, rgba(255, 255, 255, 0.06)); }
    .seg:focus-visible,
    .seg.focused {
      border-color: var(--app-hi-color2, #4169E1);
      background: var(--editable-text-bg, rgba(0, 0, 0, 0.3));
    }
    .sep { opacity: 0.5; padding: 0 1px; }
    :host([disabled]) .seg { opacity: 0.5; pointer-events: none; }
    editable-text { display: inline-flex; }
    editable-text.seg-edit { width: 3ch; --editable-text-pad: 1px 2px; }
    editable-text.seg-edit::part(control) { text-align: center; }
    editable-text.whole-edit { width: 7ch; --editable-text-pad: 1px 2px; }
    editable-text::part(control) { font-variant-numeric: tabular-nums; }
  `;

  private get bbs(): BBS {
    return beatsToBBS(this.value, this.beatsPerBar, this.sixPerBeat);
  }
  /** Beat delta represented by ±1 of segment `i` (bar / beat / sixteenth). */
  private segBeatDelta(i: number): number {
    return i === 0 ? this.beatsPerBar : i === 1 ? 1 : 1 / this.sixPerBeat;
  }

  /** Snap to the sixteenth grid, clamp to min, emit `input` on a real change. */
  private setValue(beats: number) {
    const grid = this.sixPerBeat;
    const snapped = Math.max(this.min, Math.round(beats * grid) / grid);
    if (snapped === this.value) return;
    this.value = snapped;
    this.dispatchEvent(new CustomEvent('input', { detail: snapped, composed: true }));
  }

  private jog(i: number, dir: number) {
    this.setValue(this.value + dir * this.segBeatDelta(i));
  }

  /** Replace a single 1-based segment, recompose (carry-aware), commit. */
  private setSegment(i: number, raw: number) {
    const n = Math.max(1, Math.floor(raw));
    const cur = this.bbs;
    const next: BBS = { ...cur };
    if (i === 0) next.bar = n; else if (i === 1) next.beat = n; else next.six = n;
    this.setValue(bbsToBeats(next, this.beatsPerBar, this.sixPerBeat));
  }

  private enterSegEdit(i: number, seed: string, selectAll: boolean) {
    if (this.disabled) return;
    this.editSeed = seed;
    this.selectOnEdit = selectAll;
    this.edit = i as EditTarget;
    this.pendingFocusEdit = true;
  }
  private enterWholeEdit() {
    if (this.disabled) return;
    this.editSeed = formatBBS(this.bbs);
    this.selectOnEdit = true;
    this.edit = 'whole';
    this.pendingFocusEdit = true;
  }

  private onSegKeydown(i: number, e: KeyboardEvent) {
    if (this.disabled) return;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': e.preventDefault(); this.jog(i, 1); return;
      case 'ArrowDown': case 'ArrowLeft': e.preventDefault(); this.jog(i, -1); return;
      case 'Enter': {
        const cur = this.bbs;
        const v = i === 0 ? cur.bar : i === 1 ? cur.beat : cur.six;
        e.preventDefault(); this.enterSegEdit(i, String(v), true); return;
      }
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /[0-9]/.test(e.key)) {
      e.preventDefault();
      this.enterSegEdit(i, e.key, false);
    }
  }

  private endEdit(refocusSeg: number) {
    this.edit = null;
    this.pendingFocusSeg = refocusSeg;
  }
  private onSegCommit(i: number, e: Event) {
    const raw = (e as CustomEvent<string>).detail.trim();
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) this.setSegment(i, n);
    this.endEdit(i);
  }
  private onWholeCommit(e: Event) {
    const bbs = parseBBS((e as CustomEvent<string>).detail);
    if (bbs) this.setValue(bbsToBeats(bbs, this.beatsPerBar, this.sixPerBeat));
    this.endEdit(0);
  }

  protected updated() {
    if (this.pendingFocusEdit) {
      this.pendingFocusEdit = false;
      const et = this.renderRoot.querySelector('editable-text') as EditableText | null;
      if (this.selectOnEdit) et?.selectAll(); else et?.focus();
      return;
    }
    if (this.pendingFocusSeg != null) {
      const i = this.pendingFocusSeg;
      this.pendingFocusSeg = null;
      (this.renderRoot.querySelectorAll('.seg')[i] as HTMLElement | undefined)?.focus();
    }
  }

  private renderSeg(i: number, val: number) {
    if (this.edit === i) {
      return html`
        <editable-text
          class="seg-edit"
          .value=${this.editSeed}
          ?selectOnFocus=${this.selectOnEdit}
          @commit=${(e: Event) => this.onSegCommit(i, e)}
          @cancel=${() => this.endEdit(i)}
        ></editable-text>
      `;
    }
    return html`
      <span
        class="seg"
        role="spinbutton"
        tabindex=${this.disabled ? -1 : 0}
        aria-valuenow=${val}
        @keydown=${(e: KeyboardEvent) => this.onSegKeydown(i, e)}
        @dblclick=${() => this.enterWholeEdit()}
      >${val}</span>
    `;
  }

  render() {
    if (this.edit === 'whole') {
      return html`
        <editable-text
          class="whole-edit"
          .value=${this.editSeed}
          selectOnFocus
          @commit=${(e: Event) => this.onWholeCommit(e)}
          @cancel=${() => this.endEdit(0)}
        ></editable-text>
      `;
    }
    const { bar, beat, six } = this.bbs;
    return html`
      ${this.renderSeg(0, bar)}<span class="sep">.</span>${this.renderSeg(1, beat)}<span
        class="sep"
        >.</span
      >${this.renderSeg(2, six)}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bars-beats-field': BarsBeatsField;
  }
}
