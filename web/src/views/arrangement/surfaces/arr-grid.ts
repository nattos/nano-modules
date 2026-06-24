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
import { customElement, query, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store, paths } from '../state/store';
import {
  buildBeatGrid,
  ROW_HEIGHT,
  AUTO_LANE_HEIGHT,
} from './grid-shared';
import { Track, Clip, AutomationLane, derivedWarpSegments } from '../model/composition';
import { warpDeviationAt } from '../model/beat-grid';
import { evalCurveAt } from '../engine/automation-eval';
import { setAnchor, AnchorKeys } from './anchor-registry';
import '../../../widgets/editable-label';
import './arr-clip';
import './arr-mixer-strip';
import './arr-rail-lane';
import './arr-automation-editor';

/** Beats spanned by a track automation lane / overlay (mapped through the warp). */
const AUTO_SPAN = 32;
import '../../../widgets/ui-icon';

@customElement('arr-grid')
export class ArrGrid extends MobxLitElement {
  static styles = css`
    :host {
      display: block;
      overflow: hidden;
      position: relative;
    }
    .scroll {
      position: relative;
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
    }
    /* Drag handle to resize the track-header column. */
    .header-resize {
      position: absolute;
      top: 0;
      bottom: 0;
      left: var(--arr-hw, 184px);
      width: 7px;
      margin-left: -3px;
      cursor: ew-resize;
      z-index: 6;
    }
    .header-resize:hover {
      background: var(--app-hi-color2);
      opacity: 0.4;
    }
    .grid-canvas {
      position: absolute;
      top: 0;
      left: var(--arr-hw, 184px);
      pointer-events: none;
      z-index: 0;
    }
    /* Playhead + time-region composite ABOVE clips. */
    .grid-canvas-top {
      position: absolute;
      top: 0;
      left: var(--arr-hw, 184px);
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
      width: var(--arr-hw, 184px);
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
    /* Automation-mode header: selected field label + pin button. */
    .auto-pick {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--app-cat-mod);
      font-size: var(--app-fs-xs);
    }
    .auto-pick .apf {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sb.pin {
      --icon-size: 11px;
      color: var(--app-cat-mod);
      border-color: var(--app-cat-mod);
    }
    .sb.pin:hover { background: rgba(120, 110, 200, 0.18); }
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
    /* Selected track-field automation envelope, drawn over the clips. */
    .track-auto-overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 3;
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
      width: var(--arr-hw, 184px);
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
      bottom: 8px;
      top: auto;
      left: calc(var(--arr-hw, 184px) + 8px);
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
    .header.dragsrc {
      opacity: 0.5;
    }
    /* Insertion indicator while reordering track headers. */
    .reorder-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--app-hi-color2);
      box-shadow: 0 0 4px var(--app-hi-color2);
      z-index: 6;
      pointer-events: none;
    }
    /* Clip cross-track drop target highlight. */
    .lane.dropok {
      box-shadow: inset 0 0 0 1px var(--app-hi-color2);
      background: rgba(65, 105, 225, 0.06);
    }
  `;

  /** Insertion target while dragging a track header to reorder (display id / null = end). */
  @state() private reorderBeforeId: string | null = null;
  @state() private reorderActive = false;
  /** Lane highlighted as the destination of a cross-track clip drag. */
  @state() private clipDropTrackId: string | null = null;

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
    // Drive the (drag-resizable) track-header column width through a CSS var the
    // styles read (var(--arr-hw)); the canvas geometry reads store.headerWidth.
    this.style.setProperty('--arr-hw', `${store.headerWidth}px`);
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
    const w = this.scrollEl ? this.scrollEl.clientWidth - store.headerWidth : 600;
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
    const laneW = this.scrollEl.clientWidth - store.headerWidth;
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
    void store.headerWidth; // re-render (→ updated() resets --arr-hw) on resize

    const tracks = store.displayTracks;
    const totalH = this.contentHeight(tracks);

    return html`
      <div class="scroll" @pointerdown=${this.onScrollDown}>
        <canvas class="grid-canvas" style="height:${totalH}px"></canvas>
        <div class="rows">
          ${tracks.map((t) => this.renderTrack(t))}
          ${store.automationMode ? this.renderBeatWarpRow() : ''}
          ${this.reorderActive ? this.renderReorderLine() : ''}
        </div>
        <canvas class="grid-canvas-top" style="height:${totalH}px"></canvas>
      </div>
      <div class="header-resize" @pointerdown=${this.onHeaderResize}></div>
      ${this.renderTimeToolbar()}
    `;
  }

  private onHeaderResize = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement;
    const left = this.getBoundingClientRect().left;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => store.setHeaderWidth(ev.clientX - left);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  private renderTimeToolbar() {
    // Always visible, pinned to the bottom of the timeline (above the clip
    // panel when open). With no time selection it shows the play-from cursor.
    if (!store.hasTimeSelection) {
      const nScope = store.caretTrackIds.length;
      const slice = nScope === 0 ? 'all tracks' : `${nScope} track${nScope === 1 ? '' : 's'}`;
      return html`
        <div class="timebar">
          <span class="trange">▸ play from ${store.playFromBeat.toFixed(2)}b · ${slice}</span>
          <button @click=${() => store.splitAtCursor()} title="Split clips at the cursor">
            <ui-icon icon="la-cut"></ui-icon> Split
          </button>
        </div>
      `;
    }
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
    const selected = store.isTrackShownSelected(track.id);
    const dragSrc = this.reorderActive && this.draggedTrackId === track.id;
    const accent = track.color ?? 'var(--app-cat-control)';
    // Touch the clips array structure SYNCHRONOUSLY so the MobX reaction tracks
    // add/remove/move/undo — the repeat() directive below evaluates its template
    // lazily (during commit), which is outside the reaction's tracking window.
    for (const c of track.clips) void c.id;

    return html`
      <div class="row ${isBus ? 'bus' : ''}">
        <div
          class="header ${isGroup ? 'group' : ''} ${selected ? 'selected' : ''} ${dragSrc ? 'dragsrc' : ''}"
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
            ${this.renderHeaderBottom(track, isRail, isBus)}
          </div>
        </div>
        ${isRail
          ? html`<div class="lane rail">
              <arr-rail-lane .trackId=${track.id}></arr-rail-lane>
            </div>`
          : html`<div
              class="lane ${isGroup ? 'group' : ''} ${track.bypassed ? 'bypassed' : ''} ${track.soloed ? 'soloed' : ''} ${this.clipDropTrackId === track.id ? 'dropok' : ''}"
              @dblclick=${(e: MouseEvent) => this.onLaneDblClick(e, track)}
            >
              ${isGroup
                ? html`<span class="empty-hint">main bus — all tracks sum here</span>`
                : track.clips.length === 0
                  ? html`<span class="empty-hint">double-click to add a clip · drag to select</span>`
                  : ''}
              ${repeat(
                track.clips,
                (clip) => clip.id, // keyed: element identity tracks clip identity
                (clip) => html`<arr-clip
                  .trackId=${track.id}
                  .clip=${clip}
                  .accent=${accent}
                ></arr-clip>`,
              )}
              ${this.renderTrackAutoOverlay(track)}
            </div>`}
      </div>
      ${store.automationMode
        ? track.automation.map((lane) => this.renderAutoLane(track, lane))
        : ''}
    `;
  }

  /** Track header bottom row: in automation mode with a selected field, show the
   *  param label + a Pin button (which moves it into a dedicated lane); otherwise
   *  the mixer strip. */
  private renderHeaderBottom(track: Track, isRail: boolean, isBus: boolean) {
    if (isRail) return '';
    const sel = store.automationMode && !isBus ? store.autoField(`track/${track.id}`) : null;
    if (sel) {
      return html`<div class="auto-pick" title=${sel.label}>
        <ui-icon icon="la-bezier-curve"></ui-icon>
        <span class="apf">${sel.label}</span>
        <button
          class="sb pin"
          title="Pin to a new automation lane"
          @pointerdown=${(e: Event) => { e.stopPropagation(); store.pinTrackAutomation(track.id); }}
        ><ui-icon icon="la-thumbtack"></ui-icon></button>
      </div>`;
    }
    return html`<arr-mixer-strip .trackId=${track.id}></arr-mixer-strip>`;
  }

  /** The selected track-field's envelope drawn ON TOP of the clip lane (only in
   *  automation mode, before it's pinned to its own lane). Display-only; a flat
   *  default is shown until the field gets a lane. */
  private renderTrackAutoOverlay(track: Track) {
    if (!store.automationMode) return '';
    const sel = store.autoField(`track/${track.id}`);
    if (!sel) return '';
    const lane = store.selectedTrackLane(track.id);
    const points = lane?.points ?? [{ x: 0, y: 0.5, bend: 0 }, { x: 1, y: 0.5, bend: 0 }];
    const grid = buildBeatGrid();
    const SPAN = AUTO_SPAN;
    const w = this.scrollEl ? this.scrollEl.clientWidth - store.headerWidth : 600;
    const h = ROW_HEIGHT;
    const yOf = (v: number) => 4 + (1 - v) * (h - 8);
    const SAMPLES = 96;
    const curve: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const xn = i / SAMPLES;
      curve.push(`${grid.beatToX(xn * SPAN).toFixed(1)},${yOf(evalCurveAt(points, xn)).toFixed(1)}`);
    }
    return html`<svg class="track-auto-overlay" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points=${curve.join(' ')} fill="none" stroke="var(--app-cat-mod)" stroke-width="1.5" />
      ${points.map((p) => html`<circle cx=${grid.beatToX(p.x * SPAN)} cy=${yOf(p.y)} r="2.5" fill="var(--app-cat-mod)"></circle>`)}
    </svg>`;
  }

  private renderAutoLane(track: Track, lane: AutomationLane) {
    void track;
    // EDITABLE: the same shared <arr-automation-editor> the clip view uses, here
    // mapped onto the live MAIN-TIMELINE beat grid (warp + zoom/pan + playhead).
    return html`
      <div class="row auto">
        <div class="auto-header">
          <ui-icon icon="la-bezier-curve"></ui-icon><span>${lane.label}</span>
        </div>
        <div class="auto-lane">
          <arr-automation-editor
            gridded
            .lane=${lane}
            .ensureLaneId=${() => lane.id}
            .timelineSpan=${AUTO_SPAN}
            .beatsPerBar=${store.composition.meta.timeSignature?.[0] ?? 4}
          ></arr-automation-editor>
        </div>
      </div>
    `;
  }

  /** Size a lane-area canvas to the content; returns ctx + dims, or null. */
  private prep(canvas: HTMLCanvasElement | undefined) {
    const scroll = this.scrollEl;
    if (!canvas || !scroll) return null;
    const w = scroll.clientWidth - store.headerWidth;
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

    // The 2D caret: an I-beam spanning its vertical track slice + an orange
    // inverted triangle at the top (the head). When PAUSED this is all that's
    // drawn — no sweeping orange line (it would just sit under the triangle).
    const fx = grid.beatToX(store.playFromBeat);
    if (fx >= -2 && fx <= w + 2) {
      const [yTop, yBottom] = this.caretSpanY(h);
      ctx.fillStyle = 'rgba(234,234,234,0.5)';
      ctx.fillRect(Math.round(fx), yTop, 1, yBottom - yTop);
      ctx.fillStyle = 'rgba(255,140,0,0.95)';
      ctx.beginPath();
      ctx.moveTo(fx - 4, 0);
      ctx.lineTo(fx + 5, 0);
      ctx.lineTo(fx + 0.5, 6);
      ctx.closePath();
      ctx.fill();
    }
    // Playhead: the bright orange sweeping line, only WHILE PLAYING.
    if (store.playing) {
      const px = grid.beatToX(store.positionBeat);
      if (px >= 0 && px <= w) {
        ctx.fillStyle = 'rgba(255,140,0,0.95)';
        ctx.fillRect(Math.round(px), 0, 1.5, h);
      }
    }
  }

  /** Vertical pixel span [top,bottom] of the caret's track slice; full height
   *  for a global span. */
  private caretSpanY(h: number): [number, number] {
    const ids = store.caretTrackIds;
    if (!ids.length) return [0, h];
    let yTop = Infinity;
    let yBottom = 0;
    for (const r of this.trackRowLayout()) {
      if (ids.includes(r.id)) {
        yTop = Math.min(yTop, r.top);
        yBottom = Math.max(yBottom, r.bottom);
      }
    }
    return isFinite(yTop) ? [yTop, yBottom] : [0, h];
  }

  // ── Interaction ───────────────────────────────────────────────────────
  private draggedTrackId: string | null = null;
  private headerDrag: { y0: number; trackId: string } | null = null;

  private onHeaderDown(e: PointerEvent, track: Track) {
    // Select immediately (a plain click just selects).
    if (e.shiftKey) store.toggleSelect(paths.track(track.id));
    else store.select(paths.track(track.id));
    // Arm a reorder drag — but not from an inline rename field or a control,
    // and never for the main bus (pinned).
    if (!store.canReorderTrack(track.id)) return;
    if (e.target instanceof Element && e.target.closest('editable-label, button')) return;
    this.headerDrag = { y0: e.clientY, trackId: track.id };
    window.addEventListener('pointermove', this.onHeaderMove);
    window.addEventListener('pointerup', this.onHeaderUp);
  }

  private onHeaderMove = (e: PointerEvent) => {
    const d = this.headerDrag;
    if (!d) return;
    if (!this.reorderActive) {
      if (Math.abs(e.clientY - d.y0) < 5) return;
      this.reorderActive = true;
      this.draggedTrackId = d.trackId;
    }
    this.reorderBeforeId = this.insertionBeforeId(e.clientY);
  };

  private onHeaderUp = () => {
    window.removeEventListener('pointermove', this.onHeaderMove);
    window.removeEventListener('pointerup', this.onHeaderUp);
    const d = this.headerDrag;
    this.headerDrag = null;
    if (this.reorderActive && d) store.moveTrack(d.trackId, this.reorderBeforeId);
    this.reorderActive = false;
    this.draggedTrackId = null;
    this.reorderBeforeId = null;
  };

  /** Display track id to insert before for a header drag at `clientY` (null = end). */
  private insertionBeforeId(clientY: number): string | null {
    const rect = this.scrollEl.getBoundingClientRect();
    const contentY = clientY - rect.top + this.scrollEl.scrollTop;
    const layout = this.trackRowLayout();
    const tracks = store.displayTracks;
    for (let i = 0; i < tracks.length; i++) {
      if (store.isMainBus(tracks[i])) return null; // bus is pinned last → insert at end
      const mid = (layout[i].top + layout[i].bottom) / 2;
      if (contentY < mid) return tracks[i].id;
    }
    return null;
  }

  private renderReorderLine() {
    const layout = this.trackRowLayout();
    const tracks = store.displayTracks;
    let y = 0;
    if (this.reorderBeforeId) {
      y = layout.find((x) => x.id === this.reorderBeforeId)?.top ?? 0;
    } else {
      const busIdx = tracks.findIndex((t) => store.isMainBus(t));
      y = busIdx >= 0
        ? layout[busIdx].top
        : layout.length
          ? layout[layout.length - 1].bottom
          : 0;
    }
    return html`<div class="reorder-line" style="top:${y}px"></div>`;
  }

  /** Eligible (plain) display track id nearest a clientY, or null if none exist. */
  eligibleTrackAtClientY(clientY: number): string | null {
    const rect = this.scrollEl.getBoundingClientRect();
    const contentY = clientY - rect.top + this.scrollEl.scrollTop;
    const layout = this.trackRowLayout();
    const tracks = store.displayTracks;
    let best: string | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].kind !== 'track') continue;
      const r = layout[i];
      if (contentY >= r.top && contentY < r.bottom) return tracks[i].id;
      const dist = Math.abs(contentY - (r.top + r.bottom) / 2);
      if (dist < bestDist) { bestDist = dist; best = tracks[i].id; }
    }
    return best;
  }

  /** Highlight (or clear) a lane as the destination of a cross-track clip drag. */
  setClipDropTarget(trackId: string | null) {
    this.clipDropTrackId = trackId;
  }

  /**
   * Resolve a file-drop position: the eligible track + quantized start beat.
   * On the timeline → the beat under the cursor; off it → the play position.
   * Always lands on the nearest eligible (plain) track. Null if none exist.
   */
  resolveDropTarget(clientX: number, clientY: number): { trackId: string; startBeat: number } | null {
    const trackId = this.eligibleTrackAtClientY(clientY);
    if (!trackId) return null;
    const rect = this.scrollEl.getBoundingClientRect();
    const laneLeft = rect.left + store.headerWidth;
    const onTimeline =
      clientX >= laneLeft && clientX <= rect.right &&
      clientY >= rect.top && clientY <= rect.bottom;
    const beat = onTimeline ? buildBeatGrid().xToBeat(clientX - laneLeft) : store.positionBeat;
    return { trackId, startBeat: store.quantize(beat) };
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
    /** Gesture started on the main bus ⇒ the caret spans ALL plain tracks. */
    startIsBus: boolean;
    active: boolean;
    /** Set when the gesture began on a clip BODY: a plain click focuses this clip
     *  (no time box); a drag still does a region selection. */
    clickFocusPath?: string;
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

  /**
   * Pointerdown anywhere in the scroll area → start a time×track region drag.
   * Skips headers (select/reorder), clips (own handlers), and overlays. Clicking
   * empty space BELOW the main bus lands here too, so it gets the same global
   * time-slice selection as the main-bus lane.
   */
  private onScrollDown = (e: PointerEvent) => {
    const t = e.target;
    if (t instanceof Element && t.closest('.header, .auto-header, arr-clip, .timebar, .reorder-line')) {
      return;
    }
    this.beginRegionFromClient(e);
  };

  // ── Clip move drag (driven by the grid so it survives the clip element being
  //    reparented to another track mid-drag). Cross-track + time-box split-move.
  private clipMove: {
    trackId: string;
    clipId: string;
    startBeat: number;
    grabBeat: number;
    x0: number;
    y0: number;
    active: boolean;
    timebox: boolean;
    /** The time box at gesture start (so coalesced frames don't drift as the
     *  box follows the move). Null unless this is a time-box drag. */
    baseSel: { start: number; end: number; scope: string[] } | null;
  } | null = null;

  /** Begin moving `clip` (from arr-clip). `fromHeader` enables time-box split-move. */
  beginClipMove(e: PointerEvent, trackId: string, clip: Clip, fromHeader: boolean) {
    const grid = buildBeatGrid();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + store.headerWidth;
    const timebox = fromHeader && store.timeBoxCoversClip(trackId, clip.id);
    this.clipMove = {
      trackId,
      clipId: clip.id,
      startBeat: clip.startBeat,
      grabBeat: grid.xToBeat(e.clientX - laneLeft),
      x0: e.clientX,
      y0: e.clientY,
      active: false,
      // A header drag moves the in-box content (split at the box edges) — incl.
      // between tracks — and the box follows. For a single clip the box is just
      // that clip, so this is also how a plain header drag moves one clip.
      timebox,
      baseSel: timebox
        ? { start: store.timeSelStart!, end: store.timeSelEnd, scope: [...store.timeSelTrackIds] }
        : null,
    };
    // One coalesced undo entry for the whole drag — immune to pointer dwell.
    store.beginGesture();
    window.addEventListener('pointermove', this.onClipMove);
    window.addEventListener('pointerup', this.onClipUp);
  }

  // The drag is DELTA-based: the clip shifts by how far the cursor moved from
  // pointer-down — NOT to the absolute cursor position. In X, the shift is
  // quantized to the snap grid (round to nearest step). In Y, the clip moves to
  // whichever eligible track's center the shifted clip-center lands nearest. So
  // grabbing a clip anywhere (not just its center) shifts it cleanly by whole
  // tracks / grid steps.
  private onClipMove = (e: PointerEvent) => {
    const d = this.clipMove;
    if (!d) return;
    if (!d.active) {
      // Activate on motion in EITHER axis (a pure vertical between-tracks drag
      // must start too — an X-only threshold silently dropped those).
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
      d.active = true;
    }
    const grid = buildBeatGrid();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + store.headerWidth;
    const free = e.altKey;

    // X: shift in beats from pointer-down, quantized to the snap grid.
    const deltaBeat = grid.xToBeat(e.clientX - laneLeft) - d.grabBeat;
    const snap = store.snapStep;
    const shiftBeat = free ? deltaBeat : Math.round(deltaBeat / snap) * snap;

    if (d.timebox && d.baseSel) {
      // Move the in-box content by the X shift AND across tracks (Y); the box
      // follows. Track delta = source→dest in the plain-track order.
      const dest = this.trackByCenterShift(d.trackId, e.clientY - d.y0);
      const plain = store.composition.tracks.filter((t) => t.kind === 'track').map((t) => t.id);
      const td = plain.indexOf(dest) - plain.indexOf(d.trackId);
      this.clipDropTrackId = td !== 0 ? dest : null;
      store.moveTimeBoxContent(shiftBeat, td, d.baseSel);
      return;
    }

    const beat = Math.max(0, d.startBeat + shiftBeat);
    const dest = this.trackByCenterShift(d.trackId, e.clientY - d.y0);
    this.clipDropTrackId = dest !== d.trackId ? dest : null;
    // Always pass the ORIGINAL source track: coalescing reverts to the gesture's
    // base each frame (clip back on its source), then re-applies the move.
    store.moveClipToTrack(d.trackId, d.clipId, dest, beat);
  };

  /**
   * Delta-based target track: shift the SOURCE track's row center by `dy` px and
   * return whichever eligible (plain) track's center is nearest. So the clip
   * only changes tracks once the cursor has moved ~half a row, regardless of
   * where on the clip it was grabbed.
   */
  private trackByCenterShift(sourceTrackId: string, dy: number): string {
    const layout = this.trackRowLayout();
    const tracks = store.displayTracks;
    const srcIdx = tracks.findIndex((t) => t.id === sourceTrackId);
    if (srcIdx < 0) return sourceTrackId;
    const center = (r: { top: number; bottom: number }) => (r.top + r.bottom) / 2;
    const target = center(layout[srcIdx]) + dy;
    let best = sourceTrackId;
    let bestDist = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].kind !== 'track') continue;
      const dist = Math.abs(center(layout[i]) - target);
      if (dist < bestDist) { bestDist = dist; best = tracks[i].id; }
    }
    return best;
  }

  private onClipUp = () => {
    window.removeEventListener('pointermove', this.onClipMove);
    window.removeEventListener('pointerup', this.onClipUp);
    store.endGesture();
    this.clipMove = null;
    this.clipDropTrackId = null;
  };

  /**
   * Begin a time × track region drag from raw client coordinates. Public so a
   * clip body can delegate here (clicking a clip's film strip behaves exactly
   * like clicking the grid). The start track is derived from clientY.
   */
  beginRegionFromClient(e: PointerEvent, clickFocusPath?: string) {
    if (this.drag) return;
    store.closeTapPopup();
    const laneLeft = this.scrollEl.getBoundingClientRect().left + store.headerWidth;
    const grid = buildBeatGrid();
    const startBeat = grid.xToBeat(e.clientX - laneLeft);
    const startTrack = store.displayTracks[this.trackIndexAtClientY(e.clientY)];
    const startIsBus = !!startTrack && store.isMainBus(startTrack);
    const qBeat = store.quantize(startBeat, e.altKey);
    // Set the 2D caret to a zero-width slice at the clicked time + track (a bus
    // start spans all plain tracks). A drag below extends it into a box/slice.
    const trackId = startIsBus ? '' : startTrack?.id ?? '';
    store.setCaret({ anchorBeat: qBeat, anchorTrackId: trackId, headBeat: qBeat, headTrackId: trackId });
    // Clicking a clip body focuses it right away; a drag below overrides this.
    if (clickFocusPath) store.selectClipOnly(clickFocusPath);
    this.drag = {
      x0: e.clientX,
      startBeat,
      laneLeft,
      startTrackId: startTrack?.id ?? '',
      startIsBus,
      active: false,
      clickFocusPath,
    };
    window.addEventListener('pointermove', this.onRegionMove);
    window.addEventListener('pointerup', this.onRegionUp);
  }

  /** Nearest PLAIN track id at a clientY (clamps off the pinned main bus). */
  private plainTrackIdAtClientY(clientY: number): string {
    const order = store.displayTracks;
    let i = this.trackIndexAtClientY(clientY);
    while (i > 0 && order[i] && order[i].kind !== 'track') i--;
    return order[i]?.kind === 'track' ? order[i].id : '';
  }

  private onRegionMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!d.active && Math.abs(e.clientX - d.x0) > 4) d.active = true;
    if (!d.active) return;
    const grid = buildBeatGrid();
    const cur = grid.xToBeat(e.clientX - d.laneLeft);
    const free = e.altKey;
    const headBeat = cur < 0 ? 0 : store.quantize(cur, free);
    const anchorBeat = store.quantize(d.startBeat, free);
    // Vertical span: a bus start stays global; otherwise anchor track → the
    // track currently under the cursor (clamped to plain tracks).
    const anchorTrackId = d.startIsBus ? '' : d.startTrackId;
    const headTrackId = d.startIsBus ? '' : this.plainTrackIdAtClientY(e.clientY);
    store.setCaret({ anchorBeat, anchorTrackId, headBeat, headTrackId });
    // The caret (box OR vertical slice) selects the clips it intersects.
    store.selectClipsInCaret();
  };

  private onRegionUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', this.onRegionMove);
    window.removeEventListener('pointerup', this.onRegionUp);
    const d = this.drag;
    this.drag = null;
    if (!d || d.active) return;
    // Plain click (no drag): the caret was set on pointerdown. A clip body stays
    // focused; otherwise select what's under the head — a clip if present, else
    // the track underneath (text-caret: the cursor always lands somewhere).
    if (d.clickFocusPath) return;
    if (d.startIsBus || !d.startTrackId) {
      store.clearSelection();
      return;
    }
    const clip = store.clipAtBeat(d.startTrackId, store.playFromBeat);
    store.selectClipOnly(clip ? paths.clip(d.startTrackId, clip.id) : paths.track(d.startTrackId));
  };

  private onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const cursorX = e.clientX - this.scrollEl.getBoundingClientRect().left - store.headerWidth;
      if (cursorX < 0) return;
      store.zoomAnchored(Math.exp(-e.deltaY * 0.002), cursorX);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      store.scrollBy(e.deltaX / store.pxPerBeat);
    }
  };
}
