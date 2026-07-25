/**
 * <arr-scene> — one scene cell on a scene track's lane. Scenes are GRID-PLACED
 * like clips (they scroll + zoom with the timeline) but RIGID: fixed one-bar
 * width, and moves push overlapping siblings aside instead of carving. The
 * cell is a launch pad — a header (channel badge + editable name, drag to
 * move) over a body with a SINGLE thumbnail. Clicking the BODY launches the
 * scene (clicking the playing scene retriggers it); playback ignores the grid
 * position — a launched scene anchors at its LAUNCH beat.
 */

import { html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store, paths } from '../state/store';
import { buildBeatGrid } from './grid-shared';
import type { BeatGrid } from '../model/beat-grid';
import type { Clip } from '../model/composition';
import { sceneChannelAssignments } from '../model/composition';
import { drawPlaceholderCell } from './film-reel';
import { thumbnailController } from '../media/thumbnail-controller';
import { generatorThumbCache } from '../media/generator-thumb-cache';
import {
  generatorFingerprint,
  isGeneratorClip,
} from '../engine/generator-fingerprint';
import { WireConnect } from '../../../widgets/taps-connect';
import '../../../widgets/editable-label';

@customElement('arr-scene')
export class ArrScene extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;
  @property({ attribute: false }) clip!: Clip;
  @property({ attribute: false }) accent = 'var(--app-cat-source)';

  static styles = css`
    :host {
      position: absolute;
      top: 4px;
      bottom: 4px;
      display: flex;
      flex-direction: column;
      border-radius: 4px;
      overflow: hidden;
      background: var(--app-bg-2, #121318);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-sizing: border-box;
    }
    :host(.selected) {
      border-color: var(--app-accent, #7aa2ff);
    }
    :host(.playing) {
      border-color: var(--app-cat-source, #57b47a);
      box-shadow: 0 0 0 1px var(--app-cat-source, #57b47a);
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 16px;
      padding: 0 4px;
      font-size: 10px;
      color: rgba(0, 0, 0, 0.85);
      cursor: default;
      flex: 0 0 auto;
    }
    .ch {
      flex: 0 0 auto;
      min-width: 12px;
      padding: 0 2px;
      border-radius: 2px;
      background: rgba(0, 0, 0, 0.28);
      color: rgba(255, 255, 255, 0.92);
      text-align: center;
      font-weight: 600;
    }
    .name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .body {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      cursor: pointer;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
    }
    /* Wires-mode drop target: attach a return rail as this scene's trigger
       LISTEN (which rail launches it). Covers the body so a mid-gesture click
       lands here instead of launching. */
    .trigger-drop {
      position: absolute;
      inset: 0;
      cursor: crosshair;
    }
    .trigger-drop[tap-drop-target],
    .trigger-drop:hover {
      background: rgba(70, 194, 194, 0.18);
      box-shadow: inset 0 0 0 2px var(--app-cat-mod, #46c2c2);
    }
    .listen-tag {
      position: absolute;
      left: 4px;
      bottom: 4px;
      font-size: 9px;
      padding: 0 3px;
      border-radius: 2px;
      background: rgba(70, 194, 194, 0.25);
      color: var(--app-cat-mod, #46c2c2);
      pointer-events: none;
    }
    .play {
      position: absolute;
      right: 4px;
      bottom: 4px;
      width: 0;
      height: 0;
      border-style: solid;
      border-width: 5px 0 5px 8px;
      border-color: transparent transparent transparent rgba(255, 255, 255, 0.55);
      pointer-events: none;
    }
    :host(.playing) .play {
      border-left-color: var(--app-cat-source, #57b47a);
    }
  `;

  @query('canvas') private canvas!: HTMLCanvasElement;
  private ro?: ResizeObserver;
  private thumbOff?: () => void;
  private genThumbOff?: () => void;
  private redrawQueued = false;

  firstUpdated() {
    this.ro = new ResizeObserver(() => this.drawThumb());
    this.ro.observe(this);
    this.thumbOff = thumbnailController.subscribe((sk) => {
      if (this.clip?.source?.sourceKey === sk) this.queueRedraw();
    });
    this.genThumbOff = generatorThumbCache.subscribe(() => {
      if (this.clip && isGeneratorClip(this.clip)) this.queueRedraw();
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.ro?.disconnect();
    this.thumbOff?.();
    this.genThumbOff?.();
    if (this.clip) thumbnailController.dropView(`scene:${this.clip.id}`);
  }

  private queueRedraw() {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.drawThumb();
    });
  }

  updated() {
    this.drawThumb();
  }

  /** True when this scene is the track's launched scene (engine mirror). */
  private get playing(): boolean {
    return store.sceneLaunchState[this.trackId]?.sceneId === this.clip.id;
  }

  render() {
    const clip = this.clip;
    // Tracked reads for the thumbnail: generator fingerprints key off device
    // params, so an inspector edit must re-render (same trick as arr-clip).
    for (const d of clip.sketch.devices) {
      if (d.state) void Object.values(d.state).join('|');
      void store.enginePlugin(d.moduleType);
    }
    // Grid placement: scenes scroll + zoom with the timeline like any clip
    // (fixed one-bar width — the store pins lengthBeat).
    const grid = this.gridProvider();
    this.style.left = `${grid.beatToX(clip.startBeat)}px`;
    this.style.width = `${Math.max(24, grid.spanWidth(clip.startBeat, clip.lengthBeat))}px`;
    const selected = store.isSelected(paths.clip(this.trackId, clip.id));
    const playing = this.playing;
    this.classList.toggle('selected', selected);
    this.classList.toggle('playing', playing);

    const track = store.laneById(this.trackId);
    const idx = track ? track.clips.indexOf(clip) : -1;
    const channel = track && idx >= 0 ? sceneChannelAssignments(track)[idx] : 0;
    // Channel display name from the LISTEN rail's per-return names (P4 wiring);
    // the global default rail has no names — fall back to the number.
    const railId = clip.triggerRead?.railId ?? track?.triggerRead?.railId;
    const railTrack = railId ? store.railTrackFor(railId) : undefined;
    const chLabel = railTrack?.triggerChannelNames?.[String(channel)] ?? String(channel);

    return html`
      <div
        class="bar"
        style="background:${this.accent}"
        @pointerdown=${this.onHeaderDown}
        @dblclick=${this.onHeaderDblClick}
      >
        <span class="ch" title="Trigger channel${clip.triggerChannel == null ? ' (auto)' : ''}"
          >${chLabel}</span
        >
        <editable-label
          class="name"
          .value=${clip.name}
          .displayValue=${store.clipDisplayName(clip)}
          placeholder="Scene"
          @commit=${(e: CustomEvent) => store.renameClip(this.trackId, clip.id, e.detail)}
        ></editable-label>
      </div>
      <div
        class="body"
        title=${playing ? 'Playing — click to retrigger' : 'Click to launch'}
        @pointerdown=${this.onBodyDown}
      >
        <canvas></canvas>
        ${clip.triggerRead
          ? html`<span class="listen-tag"
              title="Listens on ${store.railTrackFor(clip.triggerRead.railId)?.name ?? 'a return'} (click in wires mode to detach)"
              >⇐ ${store.railTrackFor(clip.triggerRead.railId)?.name ?? 'return'}</span>`
          : ''}
        <div class="play"></div>
        ${store.wiresMode
          ? html`<div
              class="tap-overlay-hit trigger-drop"
              title="Drop a return here: this scene launches from that rail's triggers"
              data-trigger-track=${this.trackId}
              data-trigger-scene=${clip.id}
              @pointerdown=${this.onTriggerDown}
            ></div>`
          : ''}
      </div>
    `;
  }

  private onTriggerDown = (e: PointerEvent) => {
    const g = WireConnect.active;
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    g.completeOnTriggerListen(this.trackId, this.clip.id);
  };

  private onHeaderDown = (e: PointerEvent) => {
    e.stopPropagation();
    const path = paths.clip(this.trackId, this.clip.id);
    if (e.shiftKey) {
      store.toggleSelect(path);
    } else if (this.grabWithinTimeBox(e)) {
      // Grabbed inside an existing multi-cell time box: keep the box so the
      // drag moves the whole in-box group (arr-clip parity) — a plain select()
      // here would collapse it to this one cell and only it would move.
      store.selectClipOnly(path);
    } else {
      // select() sets the caret-box over the cell (play-from at its start,
      // box rides the caret) — arr-clip parity.
      store.select(path);
    }
    // Header drag moves the scene on the grid (rigid: siblings push aside) —
    // the same grid-driven machinery as arr-clip, incl. cross-track drags.
    this.gridHost()?.beginClipMove?.(e, this.trackId, this.clip, true);
  };

  /** True when the pointer grabbed a part of the header inside the current time
   *  box (and this track is in the box's scope) — the arr-clip rule verbatim. */
  private grabWithinTimeBox(e: PointerEvent): boolean {
    if (!store.hasTimeSelection) return false;
    if (store.primaryPath?.startsWith('track/')) return false;
    const scope = store.timeSelTrackIds;
    if (scope.length && !scope.includes(this.trackId)) return false;
    const beat = this.gridProvider().xToBeat(e.clientX - this.laneRect().left);
    return beat >= store.timeSelStart! && beat <= store.timeSelEnd;
  }

  private laneRect(): DOMRect {
    return (this.parentElement as HTMLElement).getBoundingClientRect();
  }

  /** Double-clicking the header opens the bottom clip panel (arr-clip parity). */
  private onHeaderDblClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!store.clipViewOpen) store.toggleClipView();
  };

  /** Beat↔px transform for the lane (see <arr-clip>.gridProvider). */
  @property({ attribute: false }) gridProvider: () => BeatGrid = buildBeatGrid;

  private gridHost(): any {
    return this.getRootNode() instanceof ShadowRoot
      ? ((this.getRootNode() as ShadowRoot).host as any)
      : null;
  }

  private onBodyDown = (e: PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    store.launchScene(this.trackId, this.clip.id);
    // Launching also focuses the scene (the inspector follows the gesture).
    store.select(paths.clip(this.trackId, this.clip.id));
  };

  // ── single-cell thumbnail ─────────────────────────────────────────────────

  private drawThumb() {
    const canvas = this.canvas;
    const clip = this.clip;
    if (!canvas || !clip) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const media = clip.source;
    if (media?.url && media.sourceKey) {
      // Video scene: the frame at the slice start (what a launch shows first).
      const sourceKey = media.sourceKey;
      const real = thumbnailController.realInfo(sourceKey);
      const frameCount = Math.max(1, real?.frameCount ?? media.durationFrames);
      const fps = real?.fps && real.fps > 0 ? real.fps : media.fps && media.fps > 0 ? media.fps : 30;
      thumbnailController.registerMedia({ sourceKey, url: media.url, frameCount, fps });
      const frame = Math.max(0, Math.min(frameCount - 1, Math.round((clip.loop?.startSec ?? 0) * fps)));
      thumbnailController.setView(`scene:${clip.id}`, {
        sourceKey,
        level: 0,
        startFrame: frame,
        endFrame: frame,
        pattern: 'window',
        readaheadFrames: 0,
      });
      const hit = thumbnailController.peek(sourceKey, frame, 0);
      if (hit) ctx.drawImage(hit.value, 0, 0, w, h);
      else drawPlaceholderCell(ctx, 0, 0, w, h);
      return;
    }
    if (isGeneratorClip(clip)) {
      const fp = generatorFingerprint(clip);
      if (fp) {
        generatorThumbCache.prefetch(fp, [0]);
        const hit = generatorThumbCache.peekBest([fp], 0);
        if (hit) {
          ctx.drawImage(hit.bitmap, 0, 0, w, h);
          return;
        }
      }
    }
    drawPlaceholderCell(ctx, 0, 0, w, h);
  }
}
