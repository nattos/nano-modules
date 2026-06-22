/**
 * <arr-grid> — the arrangement: left track headers + right lanes with the
 * warped grid drawn behind clips. The main-bus group is pinned to the bottom
 * (Ableton-style). Double-clicking an empty lane creates an empty effect-only
 * clip; dragging empty space marquee-selects; a plain click sets the play-from
 * marker. Automation lanes show when the global Automation mode is on.
 *
 * Horizontal navigation is entirely via the warped beat transform (zoom +
 * scrollUnits in the store); only vertical scrolling is native.
 */

import { html, css } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store, paths } from '../state/store';
import {
  buildBeatGrid,
  HEADER_WIDTH,
  ROW_HEIGHT,
  AUTO_LANE_HEIGHT,
} from './grid-shared';
import { Track, AutomationLane, derivedWarpSegments } from '../model/composition';
import { warpDeviationAt } from '../model/beat-grid';
import { evalCurveAt } from '../engine/automation-eval';
import { setAnchor, AnchorKeys } from './anchor-registry';
import '../../../widgets/editable-label';
import './arr-clip';
import './arr-mixer-strip';
import './arr-rail-lane';
import '../../../widgets/ui-icon';

@customElement('arr-grid')
export class ArrGrid extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      overflow: hidden;
    }
    .scroll {
      position: relative;
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .grid-canvas {
      position: absolute;
      top: 0;
      left: ${HEADER_WIDTH}px;
      pointer-events: none;
      z-index: 0;
    }
    /* Playhead + time-region composite ABOVE clips. */
    .grid-canvas-top {
      position: absolute;
      top: 0;
      left: ${HEADER_WIDTH}px;
      pointer-events: none;
      z-index: 4;
    }
    .rows {
      position: relative;
      z-index: 1;
    }
    .row {
      display: flex;
      height: ${ROW_HEIGHT}px;
      border-bottom: 1px solid var(--app-tint-2);
    }
    .row.auto {
      height: ${AUTO_LANE_HEIGHT}px;
      border-bottom: 1px solid var(--app-tint-2);
    }
    .row.bus {
      border-top: 2px solid var(--app-tint-4);
    }
    .header {
      width: ${HEADER_WIDTH}px;
      flex-shrink: 0;
      box-sizing: border-box;
      border-right: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
      padding: var(--app-sp-2) var(--app-sp-3);
      display: flex;
      flex-direction: column;
      gap: 3px;
      cursor: pointer;
      overflow: hidden;
    }
    .header.group {
      background: #20242c;
    }
    .header.selected {
      box-shadow: inset 2px 0 0 var(--app-hi-color2);
    }
    .h-top {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }
    .caret {
      background: none;
      border: none;
      color: var(--app-text-color2);
      cursor: pointer;
      width: 12px;
      flex-shrink: 0;
      padding: 0;
      --icon-size: 11px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .tname {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .sb {
      flex-shrink: 0;
      width: 16px;
      height: 14px;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      background: var(--app-bg-color1);
      color: var(--app-text-color2);
      font-size: 8px;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }
    .sb.solo.on {
      border-color: var(--app-warn);
      color: var(--app-warn);
      background: rgba(214, 161, 60, 0.15);
    }
    .sb.bypass.on {
      border-color: var(--app-error);
      color: var(--app-error);
      background: rgba(224, 108, 108, 0.12);
    }
    .h-bottom {
      display: flex;
      align-items: center;
      gap: 5px;
      overflow: hidden;
    }
    .h-bottom arr-mixer-strip {
      flex: 1;
      min-width: 0;
    }
    .fxcount {
      font-size: 8px;
      color: var(--app-text-color2);
      white-space: nowrap;
      flex-shrink: 0;
      opacity: 0.8;
    }
    .railico {
      --icon-size: 11px;
      color: var(--app-cat-mod);
      flex-shrink: 0;
    }
    .rtag {
      font-size: 8px;
      padding: 0 4px;
      border-radius: 2px;
      border: 1px solid var(--app-cat-mod);
      color: var(--app-cat-mod);
      flex-shrink: 0;
    }
    .railrange {
      font-size: 8px;
      color: var(--app-text-color2);
      font-variant-numeric: tabular-nums;
    }
    .lane.rail {
      background: rgba(70, 194, 194, 0.03);
    }
    .row.beatwarp {
      border-top: 1px solid var(--app-tint-3);
    }
    .lane.beatwarp-lane {
      position: relative;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      background: rgba(160, 124, 224, 0.05);
    }
    .lane.beatwarp-lane svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .dchip {
      font-size: 8px;
      padding: 0 4px;
      border-radius: 2px;
      background: var(--app-tint-2);
      color: var(--app-text-color2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .lane {
      position: relative;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .lane.bypassed {
      opacity: 0.4;
    }
    .lane.soloed {
      background: rgba(214, 161, 60, 0.05);
    }
    .lane.group {
      background: repeating-linear-gradient(
        -45deg,
        transparent,
        transparent 7px,
        var(--app-tint-1) 7px,
        var(--app-tint-1) 8px
      );
    }
    .auto-header {
      width: ${HEADER_WIDTH}px;
      flex-shrink: 0;
      box-sizing: border-box;
      border-right: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
      padding: 2px var(--app-sp-3) 2px 22px;
      display: flex;
      align-items: center;
      font-size: var(--app-fs-xs);
      color: var(--app-cat-mod);
      gap: 4px;
      --icon-size: 10px;
    }
    .auto-lane {
      position: relative;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }
    .auto-lane svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .empty-hint {
      position: absolute;
      left: 8px;
      top: 50%;
      transform: translateY(-50%);
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      opacity: 0.5;
      pointer-events: none;
    }
    .timebar {
      position: absolute;
      top: 6px;
      left: ${HEADER_WIDTH + 8}px;
      z-index: 40;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 3px 5px;
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      background: rgba(20, 22, 28, 0.94);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    }
    .timebar .trange {
      font-size: var(--app-fs-xs);
      color: var(--app-hi-color2);
      font-variant-numeric: tabular-nums;
      padding: 0 4px;
    }
    .timebar button {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 2px 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      --icon-size: 10px;
    }
    .timebar button:hover {
      background: var(--app-tint-2);
    }
  `;

  @query('.scroll') private scrollEl!: HTMLDivElement;
  @query('.grid-canvas') private canvas!: HTMLCanvasElement;
  @query('.grid-canvas-top') private canvasTop!: HTMLCanvasElement;
  private ro?: ResizeObserver;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.scrollEl);
    this.scrollEl.addEventListener('wheel', this.onWheel, { passive: false });
    this.draw();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
  }
  updated() {
    this.draw();
    // Wire anchors for the main bus lane and (when shown) the beat-warp lane.
    setAnchor(AnchorKeys.mainbus(), this.renderRoot.querySelector('.lane.group'));
    setAnchor(AnchorKeys.beatwarp(), this.renderRoot.querySelector('.beatwarp-lane'));
    const tgt = store.consumeScrollTarget();
    if (tgt) this.scrollClipIntoView(tgt);
  }

  private renderBeatWarpRow() {
    const grid = buildBeatGrid();
    const segs = derivedWarpSegments(store.composition);
    const w = this.scrollEl ? this.scrollEl.clientWidth - HEADER_WIDTH : 600;
    const h = ROW_HEIGHT;
    const pts: string[] = [];
    for (let x = 0; x <= w; x += 4) {
      const dev = warpDeviationAt(segs, grid.xToBeat(x));
      pts.push(`${x},${(h / 2 - dev * (h * 0.4)).toFixed(1)}`);
    }
    return html`
      <div class="row beatwarp">
        <div class="header">
          <span class="caret"></span>
          <span class="dot" style="background:var(--app-cat-warp)"></span>
          <span class="tname">Beat Warp</span>
          <span class="rtag" style="border-color:var(--app-cat-warp);color:var(--app-cat-warp)">warp</span>
        </div>
        <div class="lane beatwarp-lane">
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            <line x1="0" y1=${h / 2} x2=${w} y2=${h / 2} stroke="rgba(255,255,255,0.1)" />
            <polyline points=${pts.join(' ')} fill="none" stroke="var(--app-cat-warp)" stroke-width="1.5" />
          </svg>
        </div>
      </div>
    `;
  }

  private scrollClipIntoView(tgt: { clipPath: string }) {
    const el = Array.from(this.renderRoot.querySelectorAll('arr-clip')).find(
      (e: any) => e.clip && `clip/${e.trackId}/${e.clip.id}` === tgt.clipPath,
    ) as any;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    const grid = buildBeatGrid();
    const x = grid.beatToX(el.clip.startBeat);
    const laneW = this.scrollEl.clientWidth - HEADER_WIDTH;
    if (x < 0 || x > laneW - 60) {
      store.setScrollUnits(Math.max(0, grid.curve.unitsAt(el.clip.startBeat) - 2));
    }
  }

  private contentHeight(tracks: Track[]): number {
    let h = 0;
    for (const t of tracks) {
      h += ROW_HEIGHT;
      if (store.automationMode) h += t.automation.length * AUTO_LANE_HEIGHT;
    }
    if (store.automationMode) h += ROW_HEIGHT; // beat-warp row
    return h;
  }

  render() {
    void store.pxPerBeat;
    void store.scrollUnits;
    void store.positionBeat;
    void store.playFromBeat;
    void store.automationMode;
    void store.timeSelStart;
    void store.timeSelEnd;
    void store.timeSelTrackIds.length;
    void store.selectedWireId;
    void store.selection.size;

    const tracks = store.displayTracks;
    const totalH = this.contentHeight(tracks);

    return html`
      <div class="scroll">
        <canvas class="grid-canvas" style="height:${totalH}px"></canvas>
        <div class="rows">
          ${tracks.map((t) => this.renderTrack(t))}
          ${store.automationMode ? this.renderBeatWarpRow() : ''}
        </div>
        <canvas class="grid-canvas-top" style="height:${totalH}px"></canvas>
      </div>
      ${this.renderTimeToolbar()}
    `;
  }

  private renderTimeToolbar() {
    if (!store.hasTimeSelection) return '';
    const a = store.timeSelStart!;
    const b = store.timeSelEnd;
    const nScope = store.timeSelTrackIds.length;
    const scope = nScope === 0 ? 'all tracks' : `${nScope} track${nScope === 1 ? '' : 's'}`;
    return html`
      <div class="timebar">
        <span class="trange">
          ${a.toFixed(2)}–${b.toFixed(2)} · ${(b - a).toFixed(2)}b · ${scope}
        </span>
        <button @click=${() => store.splitAtRegion()} title="Split clips at region edges">
          <ui-icon icon="la-cut"></ui-icon> Split
        </button>
        <button @click=${() => store.clearTime()} title="Delete (leave empty time)">
          <ui-icon icon="la-eraser"></ui-icon> Delete
        </button>
        <button @click=${() => store.insertTime()} title="Insert blank time (ripple)">
          <ui-icon icon="la-arrows-alt-h"></ui-icon> Insert Time
        </button>
        <button @click=${() => store.deleteTime()} title="Delete time (ripple)">
          <ui-icon icon="la-backspace"></ui-icon> Delete Time
        </button>
        <button @click=${() => store.clearTimeSelection()} title="Clear region">
          <ui-icon icon="la-times"></ui-icon>
        </button>
      </div>
    `;
  }

  private renderTrack(track: Track) {
    const isGroup = track.kind === 'group';
    const isBus = store.isMainBus(track);
    const isRail = track.kind === 'rail';
    const depth = isBus ? 0 : store.trackDepth(track);
    const selected = store.isSelected(paths.track(track.id));
    const accent = track.color ?? 'var(--app-cat-control)';
    const devices = track.sketch.devices;
    const rail = isRail
      ? store.composition.rails.find((r) => r.id === track.railId)
      : undefined;

    return html`
      <div class="row ${isBus ? 'bus' : ''}">
        <div
          class="header ${isGroup ? 'group' : ''} ${selected ? 'selected' : ''}"
          style="padding-left:${8 + depth * 14}px"
          @pointerdown=${(e: PointerEvent) => this.onHeaderDown(e, track)}
        >
          <div class="h-top">
            ${isGroup && !isBus
              ? html`<button
                  class="caret"
                  @pointerdown=${(e: Event) => {
                    e.stopPropagation();
                    store.toggleGroupCollapse(track.id);
                  }}
                >
                  <ui-icon icon=${track.collapsed ? 'la-caret-right' : 'la-caret-down'}></ui-icon>
                </button>`
              : html`<span class="caret"></span>`}
            ${isRail
              ? html`<ui-icon class="railico" icon="la-exchange-alt"></ui-icon>`
              : ''}
            <span class="dot" style="background:${accent}"></span>
            ${isBus || isRail
              ? html`<span class="tname">${isBus ? '▸ ' + track.name : track.name}</span>`
              : html`<editable-label
                  class="tname"
                  .value=${track.name}
                  placeholder="Untitled track"
                  @commit=${(e: CustomEvent) => store.renameTrack(track.id, e.detail)}
                ></editable-label>`}
            ${isRail
              ? html`<span class="rtag">return</span>`
              : html`
                  <button
                    class="sb solo ${track.soloed ? 'on' : ''}"
                    title="Solo"
                    @pointerdown=${(e: Event) => { e.stopPropagation(); store.toggleSolo(track.id); }}
                  >S</button>
                  <button
                    class="sb bypass ${track.bypassed ? 'on' : ''}"
                    title="Bypass / activator"
                    @pointerdown=${(e: Event) => { e.stopPropagation(); store.toggleBypass(track.id); }}
                  >B</button>
                `}
          </div>
          <div class="h-bottom">
            ${isRail
              ? html`<span class="railrange"
                  >${rail ? `${rail.range.min} … ${rail.range.max}` : 'rail'} ·
                  ${store.railWriters(track.railId ?? '').length}w
                  ${store.railReaders(track.railId ?? '').length}r</span
                >`
              : html`
                  <span class="fxcount" title="${devices.length} device(s)">
                    ${devices.length} fx
                  </span>
                  <arr-mixer-strip .trackId=${track.id}></arr-mixer-strip>
                `}
          </div>
        </div>
        ${isRail
          ? html`<div
              class="lane rail"
              @pointerdown=${(e: PointerEvent) => this.onLaneDown(e)}
            >
              <arr-rail-lane .trackId=${track.id}></arr-rail-lane>
            </div>`
          : html`<div
              class="lane ${isGroup ? 'group' : ''} ${track.bypassed ? 'bypassed' : ''} ${track.soloed ? 'soloed' : ''}"
              @dblclick=${(e: MouseEvent) => this.onLaneDblClick(e, track)}
              @pointerdown=${(e: PointerEvent) => this.onLaneDown(e)}
            >
              ${isGroup
                ? html`<span class="empty-hint">main bus — all tracks sum here</span>`
                : track.clips.length === 0
                  ? html`<span class="empty-hint">double-click to add a clip · drag to select</span>`
                  : ''}
              ${track.clips.map(
                (clip) => html`<arr-clip
                  .trackId=${track.id}
                  .clip=${clip}
                  .accent=${accent}
                ></arr-clip>`,
              )}
            </div>`}
      </div>
      ${store.automationMode
        ? track.automation.map((lane) => this.renderAutoLane(track, lane))
        : ''}
    `;
  }

  private renderAutoLane(track: Track, lane: AutomationLane) {
    void track;
    const grid = buildBeatGrid();
    const SPAN = 32; // map normalized x∈[0,1] across 32 beats through the warp
    const w = this.scrollEl ? this.scrollEl.clientWidth - HEADER_WIDTH : 600;
    const h = AUTO_LANE_HEIGHT;
    const yOf = (v: number) => 4 + (1 - v) * (h - 8);
    // Dense sample so the EASED curve is drawn (straight segments between control
    // points would miss the per-segment bend); evaluated by the lock-step eval.
    const SAMPLES = 96;
    const curve: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const xn = i / SAMPLES;
      const x = grid.beatToX(xn * SPAN);
      curve.push(`${x.toFixed(1)},${yOf(evalCurveAt(lane.points, xn)).toFixed(1)}`);
    }
    const pts = curve.join(' ');
    // Live value at the playhead (a dot riding the curve).
    const headXn = store.positionBeat / SPAN;
    const showHead = headXn >= 0 && headXn <= 1;
    const headX = grid.beatToX(store.positionBeat);
    const headY = yOf(evalCurveAt(lane.points, headXn));
    return html`
      <div class="row auto">
        <div class="auto-header">
          <ui-icon icon="la-bezier-curve"></ui-icon><span>${lane.label}</span>
        </div>
        <div class="auto-lane">
          <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            <polyline points=${pts} fill="none" stroke="var(--app-cat-mod)" stroke-width="1.5" />
            ${lane.points.map((p) => {
              const x = grid.beatToX(p.x * SPAN);
              const y = yOf(p.y);
              return html`<circle cx=${x} cy=${y} r="2.5" fill="var(--app-cat-mod)"></circle>`;
            })}
            ${showHead
              ? html`<circle cx=${headX} cy=${headY} r="2.5" fill="#ff8c00" stroke="rgba(0,0,0,0.5)"></circle>`
              : ''}
          </svg>
        </div>
      </div>
    `;
  }

  /** Size a lane-area canvas to the content; returns ctx + dims, or null. */
  private prep(canvas: HTMLCanvasElement | undefined) {
    const scroll = this.scrollEl;
    if (!canvas || !scroll) return null;
    const w = scroll.clientWidth - HEADER_WIDTH;
    const h = Math.max(this.contentHeight(store.displayTracks), scroll.clientHeight);
    if (w <= 0 || h <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  private draw() {
    this.drawBack();
    this.drawTop();
  }

  /** Behind clips: warped grid lines + loop shading. */
  private drawBack() {
    const p = this.prep(this.canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const grid = buildBeatGrid();
    const beatsPerBar = store.composition.meta.timeSignature[0];

    if (store.loopEnabled) {
      const x0 = grid.beatToX(store.loopStartBeat);
      const x1 = grid.beatToX(store.loopEndBeat);
      ctx.fillStyle = 'rgba(65,105,225,0.05)';
      ctx.fillRect(x0, 0, x1 - x0, h);
    }

    const stride = store.pxPerBeat >= 13 ? 1 : beatsPerBar;
    for (const ln of grid.visibleBeatLines(w, beatsPerBar, stride)) {
      if (ln.x < 0 || ln.x > w) continue;
      ctx.strokeStyle = ln.isBar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(Math.round(ln.x) + 0.5, 0);
      ctx.lineTo(Math.round(ln.x) + 0.5, h);
      ctx.stroke();
    }
  }

  /** Above clips: time-region box, play-from marker, and playhead. */
  private drawTop() {
    const p = this.prep(this.canvasTop);
    if (!p) return;
    const { ctx, w, h } = p;
    const grid = buildBeatGrid();

    // Time-region selection. Global scope (empty trackIds) fills the full
    // height with no top/bottom edges; a track-range scope draws a bounded
    // rectangle (all four edges) spanning exactly the selected tracks.
    if (store.hasTimeSelection) {
      const rx0 = grid.beatToX(store.timeSelStart!);
      const rx1 = grid.beatToX(store.timeSelEnd);
      const scope = store.timeSelTrackIds;
      let yTop = 0;
      let yBottom = h;
      let bounded = false;
      if (scope.length > 0) {
        bounded = true;
        yTop = Infinity;
        yBottom = 0;
        for (const r of this.trackRowLayout()) {
          if (scope.includes(r.id)) {
            yTop = Math.min(yTop, r.top);
            yBottom = Math.max(yBottom, r.bottom);
          }
        }
        if (!isFinite(yTop)) {
          yTop = 0;
          yBottom = h;
        }
      }
      ctx.fillStyle = 'rgba(65,105,225,0.16)';
      ctx.fillRect(rx0, yTop, rx1 - rx0, yBottom - yTop);
      ctx.fillStyle = 'rgba(65,105,225,0.85)';
      ctx.fillRect(Math.round(rx0), yTop, 1, yBottom - yTop);
      ctx.fillRect(Math.round(rx1), yTop, 1, yBottom - yTop);
      if (bounded) {
        ctx.fillRect(rx0, Math.round(yTop), rx1 - rx0, 1);
        ctx.fillRect(rx0, Math.round(yBottom) - 1, rx1 - rx0, 1);
      }
    }

    // Play-from marker (dim) then playhead (bright).
    const fx = grid.beatToX(store.playFromBeat);
    if (fx >= 0 && fx <= w) {
      ctx.fillStyle = 'rgba(234,234,234,0.4)';
      ctx.fillRect(Math.round(fx), 0, 1, h);
    }
    const px = grid.beatToX(store.positionBeat);
    if (px >= 0 && px <= w) {
      ctx.fillStyle = 'rgba(255,140,0,0.95)';
      ctx.fillRect(Math.round(px), 0, 1.5, h);
    }
  }

  // ── Interaction ───────────────────────────────────────────────────────
  private onHeaderDown(e: PointerEvent, track: Track) {
    if (e.shiftKey) store.toggleSelect(paths.track(track.id));
    else store.select(paths.track(track.id));
  }

  private onLaneDblClick(e: MouseEvent, track: Track) {
    if (track.kind === 'group') return;
    if (e.target instanceof Element && e.target.closest('arr-clip')) return;
    const laneRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const grid = buildBeatGrid();
    const beat = store.quantize(grid.xToBeat(e.clientX - laneRect.left));
    store.createEmptyClip(track.id, beat);
  }

  // Drag selects a rectangular TIME × TRACK REGION (Ableton-style); a plain
  // click sets the play-from marker. Dragging that starts in the main bus
  // selects the whole time range across ALL tracks (rendered full-height).
  private drag: {
    x0: number;
    startBeat: number;
    laneLeft: number;
    startTrackId: string;
    active: boolean;
  } | null = null;

  /** Track-row vertical layout in content (scroll) coordinates. */
  private trackRowLayout(): Array<{ id: string; top: number; bottom: number }> {
    const out: Array<{ id: string; top: number; bottom: number }> = [];
    let y = 0;
    for (const t of store.displayTracks) {
      out.push({ id: t.id, top: y, bottom: y + ROW_HEIGHT });
      y += ROW_HEIGHT;
      if (store.automationMode) y += t.automation.length * AUTO_LANE_HEIGHT;
    }
    return out;
  }

  private trackIndexAtClientY(clientY: number): number {
    const rect = this.scrollEl.getBoundingClientRect();
    const contentY = clientY - rect.top + this.scrollEl.scrollTop;
    const layout = this.trackRowLayout();
    for (let i = 0; i < layout.length; i++) {
      if (contentY < layout[i].bottom) return i;
    }
    return Math.max(0, layout.length - 1);
  }

  /** Lane background pointerdown → start a region drag (unless on a clip). */
  private onLaneDown(e: PointerEvent) {
    if (e.target instanceof Element && e.target.closest('arr-clip')) return;
    this.beginRegionFromClient(e);
  }

  /**
   * Begin a time × track region drag from raw client coordinates. Public so a
   * clip body can delegate here (clicking a clip's film strip behaves exactly
   * like clicking the grid). The start track is derived from clientY.
   */
  beginRegionFromClient(e: PointerEvent) {
    store.closeTapPopup();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + HEADER_WIDTH;
    const grid = buildBeatGrid();
    const startTrack = store.displayTracks[this.trackIndexAtClientY(e.clientY)];
    this.drag = {
      x0: e.clientX,
      startBeat: grid.xToBeat(e.clientX - laneLeft),
      laneLeft,
      startTrackId: startTrack?.id ?? '',
      active: false,
    };
    window.addEventListener('pointermove', this.onRegionMove);
    window.addEventListener('pointerup', this.onRegionUp);
  }

  private onRegionMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!d.active && Math.abs(e.clientX - d.x0) > 4) d.active = true;
    if (!d.active) return;
    const grid = buildBeatGrid();
    const cur = grid.xToBeat(e.clientX - d.laneLeft);
    const free = e.altKey;
    const a = store.quantize(Math.min(d.startBeat, cur), free);
    const b = store.quantize(Math.max(d.startBeat, cur), free);

    // Track scope: starting in the main bus selects ALL tracks (global); any
    // other start selects the contiguous track range the drag spans.
    const startTrack = store.trackById(d.startTrackId);
    let trackIds: string[] = [];
    if (startTrack && !store.isMainBus(startTrack)) {
      const tracks = store.displayTracks;
      const startIdx = tracks.findIndex((t) => t.id === d.startTrackId);
      const endIdx = this.trackIndexAtClientY(e.clientY);
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      trackIds = tracks.slice(lo, hi + 1).map((t) => t.id);
    }
    store.setTimeSelection(a, b, trackIds);
    // The region also selects the clips it covers (no multi-edit yet).
    store.selectClipsInRegion();
  };

  private onRegionUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onRegionMove);
    window.removeEventListener('pointerup', this.onRegionUp);
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.active) {
      // Plain click on empty space → set play-from + collapse region + clear sel.
      const grid = buildBeatGrid();
      const beat = store.quantize(grid.xToBeat(e.clientX - d.laneLeft));
      store.setPlayFrom(beat);
      store.clearTimeSelection();
      store.clearSelection();
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const cursorX = e.clientX - this.scrollEl.getBoundingClientRect().left - HEADER_WIDTH;
      if (cursorX < 0) return;
      store.zoomAnchored(Math.exp(-e.deltaY * 0.002), cursorX);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      store.scrollBy(e.deltaX / store.pxPerBeat);
    }
  };
}
