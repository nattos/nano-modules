/**
 * <arr-clip> — a clip rectangle on a track lane. Positions itself in WARPED
 * beat space, shows kind (video/effect), device chips, and warp/export/mod
 * badges. Handles drag-move and edge-resize (snapped to ¼ beat).
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { drawFilmReel, drawPlaceholderCell } from './film-reel';
import { thumbnailController, reelLayout } from '../media/thumbnail-controller';
import { clipSourceFrameAt, type ClipTimeCtx } from '../engine/clip-time';
import { setAnchor, clearAnchor, AnchorKeys } from './anchor-registry';
import { store, paths } from '../state/store';
import { buildBeatGrid } from './grid-shared';
import {
  Clip,
  clipProcessesTexture,
  deviceProcessesTexture,
} from '../model/composition';
import '../../../widgets/ui-icon';

type DragMode = 'resize-l' | 'resize-r' | null;

@customElement('arr-clip')
export class ArrClip extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;
  @property({ attribute: false }) clip!: Clip;
  @property({ attribute: false }) accent = 'var(--app-cat-source)';

  static styles = css`
    :host {
      position: absolute;
      top: 4px;
      bottom: 4px;
      box-sizing: border-box;
    }
    .clip {
      position: absolute;
      inset: 0;
      border-radius: 3px;
      border: 1px solid var(--app-tint-4);
      background: var(--app-bg-color1);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-width: 8px;
      user-select: none;
    }
    .clip.selected {
      border-color: var(--app-hi-color2);
      box-shadow: 0 0 0 1px var(--app-hi-color2);
    }
    .clip.dragging .bar {
      cursor: grabbing;
    }
    .bar {
      height: 15px;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 5px;
      font-size: var(--app-fs-xs);
      color: #11131a;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      cursor: grab;
    }
    .bar .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .bar .ico {
      --icon-size: 10px;
      flex-shrink: 0;
      color: #11131a;
    }
    /* Bypassed (disabled) clip: grayed, semi-transparent header. */
    .clip.bypassed .bar {
      background: var(--app-tint-4) !important;
      color: var(--app-text-color2);
      opacity: 0.55;
    }
    .clip.bypassed .bar .ico { color: var(--app-text-color2); }
    .clip.bypassed .body { opacity: 0.5; }
    /* Missing / inaccessible source: disabled look + a warning tint. */
    .clip.missing {
      outline: 1px dashed var(--app-error, #e0564a);
      outline-offset: -1px;
    }
    .clip.missing .bar {
      background: var(--app-tint-4) !important;
      color: var(--app-error, #e0564a);
      opacity: 0.7;
    }
    .clip.missing .bar .ico { color: var(--app-error, #e0564a); }
    .clip.missing .body { opacity: 0.35; }
    .body {
      flex: 1;
      display: flex;
      align-items: flex-end;
      gap: 3px;
      padding: 3px 5px;
      overflow: hidden;
    }
    .body.reel {
      padding: 0;
      position: relative;
    }
    .body.reel canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    .chip {
      font-size: 8px;
      line-height: 1.4;
      padding: 0 4px;
      border-radius: 2px;
      background: var(--app-tint-3);
      color: var(--app-text-color1);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .badges {
      position: absolute;
      right: 4px;
      bottom: 3px;
      display: flex;
      gap: 3px;
      pointer-events: none;
    }
    /* Output trace card — appears at the clip bottom when selected and the clip
       exports to a rail. The writer wire reroutes to this card. */
    .trace-card {
      position: absolute;
      left: 4px;
      bottom: 4px;
      height: 16px;
      width: 84px;
      max-width: calc(100% - 8px);
      border-radius: 2px;
      background: rgba(12, 14, 18, 0.9);
      border: 1px solid var(--app-io-output);
      display: flex;
      align-items: center;
      pointer-events: none;
      overflow: hidden;
    }
    .trace-card canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    .trace-card .tlabel {
      position: absolute;
      left: 3px;
      font-size: 7px;
      color: var(--app-io-output);
      letter-spacing: 0.04em;
    }
    /* Read target — small param badge the reader wire points at when selected. */
    .read-target {
      position: absolute;
      right: 4px;
      top: 17px;
      font-size: 7px;
      padding: 0 4px;
      border-radius: 2px;
      background: rgba(12, 14, 18, 0.9);
      border: 1px solid var(--app-io-input);
      color: var(--app-io-input);
      pointer-events: none;
    }
    .badge {
      font-size: 8px;
      line-height: 1.3;
      padding: 0 3px;
      border-radius: 2px;
      font-weight: 600;
    }
    .badge.warp {
      background: var(--app-cat-warp);
      color: #fff;
    }
    .badge.rail {
      background: var(--app-io-output);
      color: #11131a;
    }
    .badge.mod {
      background: var(--app-cat-mod);
      color: #11131a;
    }
    .handle {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: ew-resize;
    }
    .handle.l {
      left: 0;
    }
    .handle.r {
      right: 0;
    }
  `;

  private mode: DragMode = null;
  private origStart = 0;
  private origLen = 0;

  /** The host <arr-grid> (this clip lives in its shadow root). */
  private gridHost(): any {
    return this.getRootNode() instanceof ShadowRoot
      ? ((this.getRootNode() as ShadowRoot).host as any)
      : null;
  }

  @query('.body.reel canvas') private reelCanvas?: HTMLCanvasElement;
  @query('.trace-card canvas') private traceCanvas?: HTMLCanvasElement;
  private ro?: ResizeObserver;
  private thumbOff?: () => void;
  private reelRedrawQueued = false;

  firstUpdated() {
    this.ro = new ResizeObserver(() => {
      this.drawReel();
      this.drawTrace();
    });
    this.ro.observe(this);
    // Redraw the strip as real thumbnails land for this clip's media.
    this.thumbOff = thumbnailController.subscribe((sk) => {
      if (this.clip?.source?.sourceKey === sk) this.queueReelRedraw();
    });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.thumbOff?.();
    if (this.clip) {
      thumbnailController.dropView(`clip:${this.clip.id}`);
      clearAnchor(AnchorKeys.clip(this.clip.id));
      clearAnchor(AnchorKeys.trace(this.clip.id));
    }
  }

  /** Coalesce thumbnail-fill redraws to at most one per frame. */
  private queueReelRedraw() {
    if (this.reelRedrawQueued) return;
    this.reelRedrawQueued = true;
    requestAnimationFrame(() => {
      this.reelRedrawQueued = false;
      this.drawReel();
    });
  }
  updated() {
    this.drawReel();
    this.drawTrace();
    // Register wire anchors: the clip body and (when present) the trace card.
    setAnchor(AnchorKeys.clip(this.clip.id), this.shadowRoot?.querySelector('.clip'));
    setAnchor(AnchorKeys.trace(this.clip.id), this.shadowRoot?.querySelector('.trace-card'));
  }

  private drawTrace() {
    const canvas = this.traceCanvas;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Mock output trace: a small oscillation reading the clip's exported value.
    const seed = this.reelSeed();
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const t = x / w;
      const v = 0.5 + 0.4 * Math.sin(t * Math.PI * 4 + seed);
      const y = h - 2 - v * (h - 4);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ff8c00';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawReel() {
    if (this.clip?.kind !== 'video') return;
    const canvas = this.reelCanvas;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const media = this.clip.source;
    if (media?.url && media.sourceKey) {
      this.drawRealReel(ctx, w, h, media);
    } else {
      drawFilmReel(ctx, w, h);
    }
  }

  /**
   * Draw the strip from real decoded thumbnails (Component D), REFLECTING the clip's
   * play mode AND its loops. Thumbnails keep their native aspect (never stretched):
   * each panel is `h·aspect` wide and tiled LOOP-AWARELY — the layout resets at every
   * loop marker, so two panels meet edge-to-edge there (one ending the loop, one
   * starting the next). When a segment is narrower than a panel the panel is cropped
   * (overflow-hidden), not squashed. Each panel's centre beat picks the source frame
   * the engine actually shows there (clipSourceFrameAt). Vertical bars mark the loops.
   */
  private drawRealReel(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    media: NonNullable<Clip['source']>,
  ) {
    const sourceKey = media.sourceKey!;
    const frameCount = Math.max(1, media.durationFrames);
    const fps = media.fps && media.fps > 0 ? media.fps : 30;
    thumbnailController.registerMedia({ sourceKey, url: media.url!, frameCount, fps: media.fps });

    const layout = reelLayout(w, h, frameCount);
    if (layout.cells === 0) return;
    const level = layout.level;

    const loop = this.clip.loop;
    const spb = 60 / Math.max(1, store.composition.meta.baseBPM);
    const startBeat = this.clip.startBeat;
    const lengthBeat = Math.max(1e-6, this.clip.lengthBeat);
    // Linear (warp-approx) clock — the strip is a visual aid; exact warp isn't needed.
    const timeCtx: ClipTimeCtx = { startBeat, lengthBeat, videoDurSec: frameCount / fps, secondsAt: (b) => b * spb };

    // Aspect-correct panel width (default 16:9 until the first tile lands, then refined).
    const probe = thumbnailController.peek(sourceKey, 0, level);
    const aspect = probe ? probe.value.width / Math.max(1, probe.value.height) : 16 / 9;
    const panelW = Math.max(4, h * aspect);

    const beatAtX = (cx: number) => startBeat + (cx / w) * lengthBeat;
    const frameAtBeat = (beat: number): number | null =>
      loop
        ? clipSourceFrameAt(loop, timeCtx, beat, fps, frameCount)
        : Math.round(((beat - startBeat) / lengthBeat) * (frameCount - 1));
    const frameAtX = (cx: number) => frameAtBeat(beatAtX(cx));

    // Sample the boundary thumbnails just INSIDE the loop (not AT the wrap): a sample
    // exactly at a marker is the wrap point, where round-off flips between the loop
    // START and END frames — and if the slice runs to the file end, the END side reads
    // vt ≈ videoDurSec and clipSourceTimeAt returns null ⇒ a black flicker. frameEps =
    // half a source frame in beats (loop-derived, so it's identical at every zoom).
    const loopStart = loop?.startSec ?? 0;
    const loopEnd = loop?.endSec ?? timeCtx.videoDurSec;
    const loopLen = loopEnd - loopStart;
    let perBeat = (loop?.speed ?? 1) * spb;
    if (loop?.mode === 'beat-sync') {
      const vb = loop.syncUseBpm ? loopLen * ((loop.syncBpm ?? 120) / 60) : loop.syncBeats ?? 4;
      perBeat = vb > 1e-9 ? loopLen / vb : perBeat;
    }
    const frameEps = perBeat > 1e-9 && fps > 0 ? 0.5 / fps / perBeat : 1e-4;

    // Loop-aware segments: clip edges + each loop marker. Within a segment, tile panels
    // left-anchored from its start, plus one right-anchored panel ending at its end —
    // so both segment edges (= markers) land a panel edge. The boundary thumbnails are
    // PINNED to the boundary content (loop start/end frames) so they don't change as the
    // panels reflow on zoom/resize.
    const markerXs = this.loopMarkerBeats(loop, timeCtx, spb, w).map((b) => (b / lengthBeat) * w);
    const bounds = [0, ...markerXs, w];
    const panels: Array<{ x: number; cl: number; cr: number; frame: number | null }> = [];
    for (let s = 0; s < bounds.length - 1; s++) {
      const L = bounds[s];
      const R = bounds[s + 1];
      const segW = R - L;
      if (segW <= 0.5) continue;
      const startFrame = frameAtBeat(beatAtX(L) + frameEps); // loop/clip start, just past the wrap
      const endFrame = frameAtBeat(beatAtX(R) - frameEps); // loop/clip end, just before the wrap
      if (segW <= panelW) {
        // Too tight: one aspect-correct panel centred on the segment, cropped to it.
        panels.push({ x: (L + R) / 2 - panelW / 2, cl: L, cr: R, frame: startFrame });
      } else {
        const nFull = Math.floor(segW / panelW);
        for (let i = 0; i < nFull; i++) {
          const px = L + i * panelW;
          panels.push({ x: px, cl: L, cr: R, frame: i === 0 ? startFrame : frameAtX(px + panelW / 2) });
        }
        const px = R - panelW; // right-anchored final panel (may overlap the last full one)
        panels.push({ x: px, cl: L, cr: R, frame: endFrame });
      }
    }

    // Prefetch only the source range actually shown.
    let minF = Infinity;
    let maxF = -Infinity;
    for (const p of panels) if (p.frame != null) { minF = Math.min(minF, p.frame); maxF = Math.max(maxF, p.frame); }
    thumbnailController.setView(`clip:${this.clip.id}`, {
      sourceKey,
      level,
      startFrame: minF <= maxF ? Math.max(0, Math.floor(minF)) : 0,
      endFrame: minF <= maxF ? Math.min(frameCount - 1, Math.ceil(maxF)) : frameCount - 1,
      pattern: 'window',
      readaheadFrames: 0,
    });

    for (const p of panels) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.cl, 0, p.cr - p.cl, h); // clip to the segment → crop, never stretch
      ctx.clip();
      if (p.frame == null) {
        ctx.fillStyle = 'rgba(8,9,12,0.6)'; // off-slice (one-shot past the source) → dark
        ctx.fillRect(p.cl, 0, p.cr - p.cl, h);
      } else {
        const hit = thumbnailController.peek(sourceKey, p.frame, level);
        if (hit) ctx.drawImage(hit.value, p.x, 0, panelW, h);
        else drawPlaceholderCell(ctx, p.x, 0, panelW, h);
      }
      // A subtle seam at the panel's left edge (skip the segment start = a marker/edge).
      if (p.x > p.cl + 0.5) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(p.x, 0, 1, h);
      }
      ctx.restore();
    }

    this.drawLoopBars(ctx, w, h, markerXs);
  }

  /**
   * Local beats of each loop RESTART within (0, lengthBeat), offset by the play-start
   * phase. Empty for one-shot/random, or when loops are sub-pixel dense (so we don't
   * draw a blur). Shared by the strip layout + the loop bars.
   */
  private loopMarkerBeats(loop: Clip['loop'] | undefined, timeCtx: ClipTimeCtx, spb: number, w: number): number[] {
    if (!loop) return [];
    const loopStart = loop.startSec ?? 0;
    const loopEnd = loop.endSec ?? timeCtx.videoDurSec;
    const loopLen = loopEnd - loopStart;
    let periodBeats = 0;
    if (loop.mode === 'time') {
      const speed = loop.speed ?? 1;
      if (loopLen > 1e-6 && speed > 1e-6 && spb > 1e-9) periodBeats = loopLen / speed / spb;
    } else if (loop.mode === 'beat-sync') {
      periodBeats = loop.syncUseBpm ? loopLen * ((loop.syncBpm ?? 120) / 60) : loop.syncBeats ?? 4;
    } else {
      return [];
    }
    if (periodBeats <= 1e-3 || loopLen <= 1e-6) return [];
    if ((periodBeats / timeCtx.lengthBeat) * w < 3) return []; // sub-pixel loops → don't segment
    const playStart = loop.playStartSec ?? loopStart;
    let first = ((loopEnd - playStart) / loopLen) * periodBeats;
    while (first <= 1e-6) first += periodBeats; // first restart strictly inside the clip
    const out: number[] = [];
    // Compute each marker as first + k·period (not accumulated) to avoid FP drift.
    for (let k = 0; first + k * periodBeats < timeCtx.lengthBeat - 1e-6; k++) {
      out.push(first + k * periodBeats);
    }
    return out;
  }

  /** Vertical bars at the loop restarts. Drawn at the EXACT (un-rounded) x so they
   *  don't snap/jump by a pixel as the clip's fractional offset shifts on zoom/resize. */
  private drawLoopBars(ctx: CanvasRenderingContext2D, w: number, h: number, markerXs: number[]) {
    ctx.fillStyle = 'rgba(108,192,112,0.85)';
    for (const mx of markerXs) {
      if (mx <= 0 || mx >= w) continue;
      ctx.fillRect(mx, 0, 1, h);
    }
  }

  private reelSeed(): number {
    let s = 0;
    for (const c of this.clip.id) s = (s * 31 + c.charCodeAt(0)) >>> 0;
    return (s % 1000) / 7;
  }

  private laneRect(): DOMRect {
    return (this.parentElement as HTMLElement).getBoundingClientRect();
  }

  render() {
    const clip = this.clip;
    const grid = buildBeatGrid();
    const left = grid.beatToX(clip.startBeat);
    const width = Math.max(8, grid.spanWidth(clip.startBeat, clip.lengthBeat));
    this.style.left = `${left}px`;
    this.style.width = `${width}px`;

    const selected = store.isSelected(paths.clip(this.trackId, clip.id));
    const isVideo = clip.kind === 'video';
    const modOnly = !clipProcessesTexture(clip) && clip.sketch.devices.length > 0;
    const hasWarp = clip.warps.length > 0;
    const hasExport = clip.exports.length > 0;

    // Tint the title bar by accent; body stays dark.
    const barBg = this.accent;

    const devices = clip.sketch.devices;
    const shown = devices.slice(0, 3);
    const extra = devices.length - shown.length;
    const missing = store.sourceMissing(clip.source?.sourceKey);

    return html`
      <div class="clip ${selected ? 'selected' : ''} ${this.mode ? 'dragging' : ''} ${clip.bypassed ? 'bypassed' : ''} ${missing ? 'missing' : ''}">
        <div
          class="bar"
          style="background:${barBg}"
          @pointerdown=${this.onHeaderDown}
          @dblclick=${this.onHeaderDblClick}
        >
          <ui-icon
            class="ico"
            icon=${missing ? 'la-exclamation-triangle' : isVideo ? 'la-film' : modOnly ? 'la-wave-square' : 'la-layer-group'}
          ></ui-icon>
          <span class="name">${clip.name}</span>
        </div>
        ${isVideo
          ? html`<div class="body reel" @pointerdown=${this.onBodyDown}><canvas></canvas></div>`
          : html`<div class="body" @pointerdown=${this.onBodyDown}>
              ${shown.map(
                (d) =>
                  html`<span
                    class="chip"
                    title=${d.moduleType}
                    style=${deviceProcessesTexture(d) ? '' : 'color:var(--app-cat-mod)'}
                    >${d.name}</span
                  >`,
              )}
              ${extra > 0 ? html`<span class="chip">+${extra}</span>` : ''}
              ${devices.length === 0
                ? html`<span class="chip" style="opacity:.6">empty</span>`
                : ''}
            </div>`}
        <div class="badges">
          ${hasWarp ? html`<span class="badge warp" title="Warps the beat grid">⥲</span>` : ''}
          ${hasExport ? html`<span class="badge rail" title="Exports to a rail">→</span>` : ''}
          ${modOnly ? html`<span class="badge mod" title="Modulation-only (no frames)">m</span>` : ''}
        </div>
        ${selected && clip.exports.length
          ? html`<div class="trace-card">
              <canvas class="tcv"></canvas><span class="tlabel">out</span>
            </div>`
          : ''}
        <div class="handle l" @pointerdown=${(e: PointerEvent) => this.onHandleDown(e, 'resize-l')}></div>
        <div class="handle r" @pointerdown=${(e: PointerEvent) => this.onHandleDown(e, 'resize-r')}></div>
      </div>
    `;
  }

  /**
   * Clicking the HEADER selects the clip and starts a move drag. Normally the
   * time box snaps to span this clip (so it tracks the focused clip) — BUT if the
   * grabbed part of the header is inside an EXISTING time box, keep that box so
   * the drag splits the clips at the box edges and moves only the in-box region.
   * The move is driven by the GRID (it survives reparenting mid-drag).
   */
  private onHeaderDown = (e: PointerEvent) => {
    e.stopPropagation();
    const path = paths.clip(this.trackId, this.clip.id);
    if (e.shiftKey) {
      store.toggleSelect(path);
    } else if (this.grabWithinTimeBox(e)) {
      store.selectClipOnly(path); // keep the box → split + move region
    } else {
      store.select(path); // box tracks the clip
      // …and the play-from cursor (+ playhead, if paused) jumps to the clip start.
      store.setPlayFrom(this.clip.startBeat);
    }
    this.gridHost()?.beginClipMove?.(e, this.trackId, this.clip, true);
  };

  /** True when the pointer grabbed a part of the header inside the current time
   *  box (and this track is in the box's scope). */
  private grabWithinTimeBox(e: PointerEvent): boolean {
    if (!store.hasTimeSelection) return false;
    const scope = store.timeSelTrackIds;
    if (scope.length && !scope.includes(this.trackId)) return false;
    const beat = buildBeatGrid().xToBeat(e.clientX - this.laneRect().left);
    return beat >= store.timeSelStart! && beat <= store.timeSelEnd;
  }

  /** Double-clicking the header opens the bottom clip panel (if not already open). */
  private onHeaderDblClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!store.clipViewOpen) store.toggleClipView();
  };

  /** Clicking the BODY focuses the clip (inspector + clip view) and re-arms the
   *  play-from marker, WITHOUT grabbing a time box. DRAGGING the body still does
   *  a time×track region selection. Only the header moves the clip. */
  private onBodyDown = (e: PointerEvent) => {
    e.stopPropagation();
    this.gridHost()?.beginRegionFromClient?.(e, paths.clip(this.trackId, this.clip.id));
  };

  /**
   * Clicking a RESIZE EDGE focuses the clip and drops a zero-width caret AT that
   * edge — left handle → clip start, right handle → clip end — instead of selecting
   * the whole clip span. `selectClipOnly` focuses the clip without grabbing a time
   * box; `setCaret` (anchor == head) collapses any existing box to a caret on this
   * clip's track. A DRAG still resizes the clip — `beginDrag` is armed unchanged.
   */
  private onHandleDown(e: PointerEvent, mode: DragMode) {
    e.stopPropagation();
    store.selectClipOnly(paths.clip(this.trackId, this.clip.id));
    const edgeBeat =
      mode === 'resize-l' ? this.clip.startBeat : this.clip.startBeat + this.clip.lengthBeat;
    store.setCaret({
      anchorBeat: edgeBeat,
      anchorTrackId: this.trackId,
      headBeat: edgeBeat,
      headTrackId: this.trackId,
    });
    this.beginDrag(e, mode);
  }

  /** Edge-resize drag (move drags live in the grid; resizing never reparents). */
  private beginDrag(e: PointerEvent, mode: DragMode) {
    this.mode = mode;
    this.origStart = this.clip.startBeat;
    this.origLen = this.clip.lengthBeat;
    store.beginGesture(); // one coalesced undo entry for the whole resize
    window.addEventListener('pointermove', this.onWinMove);
    window.addEventListener('pointerup', this.onWinUp);
  }

  private onWinMove = (e: PointerEvent) => {
    if (!this.mode) return;
    const free = e.altKey;
    const q = (b: number) => store.quantize(b, free);
    const grid = buildBeatGrid();
    const beatAtCursor = grid.xToBeat(e.clientX - this.laneRect().left);
    if (this.mode === 'resize-r') {
      const len = q(beatAtCursor) - this.clip.startBeat;
      store.resizeClip(this.trackId, this.clip.id, this.clip.startBeat, Math.max(0.5, len));
    } else if (this.mode === 'resize-l') {
      const newStart = q(beatAtCursor);
      const end = this.origStart + this.origLen;
      if (newStart < end - 0.5) {
        store.resizeClip(this.trackId, this.clip.id, newStart, end - newStart);
      }
    }
  };

  private onWinUp = () => {
    this.mode = null;
    store.endGesture();
    window.removeEventListener('pointermove', this.onWinMove);
    window.removeEventListener('pointerup', this.onWinUp);
    this.requestUpdate();
  };
}
