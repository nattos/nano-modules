/**
 * <arr-clip> — a clip rectangle on a track lane. Positions itself in WARPED
 * beat space, shows kind (video/effect), device chips, and warp/export/mod
 * badges. Handles drag-move and edge-resize (snapped to ¼ beat).
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { drawFilmReel, drawFrameCell } from './film-reel';
import { thumbnailController, reelLayout } from '../media/thumbnail-controller';
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
      drawFilmReel(ctx, w, h, this.reelSeed());
    }
  }

  /**
   * Draw the strip from real decoded thumbnails (Component D): declare the
   * visible frame range as a view (so the cache prefetches), then paint each
   * cell from `peek()` — exact tile, nearest substitute (stretched), or the
   * procedural cell as a placeholder until the real frame lands.
   */
  private drawRealReel(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    media: NonNullable<Clip['source']>,
  ) {
    const sourceKey = media.sourceKey!;
    const frameCount = Math.max(1, media.durationFrames);
    thumbnailController.registerMedia({ sourceKey, url: media.url!, frameCount, fps: media.fps });

    const layout = reelLayout(w, h, frameCount);
    if (layout.cells === 0) return;
    thumbnailController.setView(`clip:${this.clip.id}`, {
      sourceKey,
      level: layout.level,
      startFrame: 0,
      endFrame: frameCount - 1,
      pattern: 'window',
      readaheadFrames: 0,
    });

    const step = w / layout.cells;
    const seed = this.reelSeed();
    for (let i = 0; i < layout.cells; i++) {
      const x = i * step;
      const hit = thumbnailController.peek(sourceKey, layout.frames[i], layout.level);
      if (hit) {
        ctx.drawImage(hit.value, x, 0, step, h);
      } else {
        drawFrameCell(ctx, x + 0.5, 0, step - 1, h, seed, (i + 0.5) / layout.cells);
      }
      if (i > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(x, 0, 1, h);
      }
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

    return html`
      <div class="clip ${selected ? 'selected' : ''} ${this.mode ? 'dragging' : ''} ${clip.bypassed ? 'bypassed' : ''}">
        <div
          class="bar"
          style="background:${barBg}"
          @pointerdown=${this.onHeaderDown}
          @dblclick=${this.onHeaderDblClick}
        >
          <ui-icon
            class="ico"
            icon=${isVideo ? 'la-film' : modOnly ? 'la-wave-square' : 'la-layer-group'}
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
   * Clicking the HEADER selects the clip (grabbing its time box, unless a time
   * box already covers it — then keep that box so the drag splits/moves its
   * content) and starts a move drag. The move is driven by the GRID (it survives
   * the element being reparented to another track mid-drag).
   */
  private onHeaderDown = (e: PointerEvent) => {
    e.stopPropagation();
    const path = paths.clip(this.trackId, this.clip.id);
    // Header click always sets the time box to span this clip (even if a box
    // already exists), so the box tracks the focused clip.
    if (e.shiftKey) store.toggleSelect(path);
    else store.select(path);
    this.gridHost()?.beginClipMove?.(e, this.trackId, this.clip, true);
  };

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

  private onHandleDown(e: PointerEvent, mode: DragMode) {
    e.stopPropagation();
    store.select(paths.clip(this.trackId, this.clip.id));
    this.beginDrag(e, mode);
  }

  /** Edge-resize drag (move drags live in the grid; resizing never reparents). */
  private beginDrag(e: PointerEvent, mode: DragMode) {
    this.mode = mode;
    this.origStart = this.clip.startBeat;
    this.origLen = this.clip.lengthBeat;
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
    window.removeEventListener('pointermove', this.onWinMove);
    window.removeEventListener('pointerup', this.onWinUp);
    this.requestUpdate();
  };
}
