/**
 * <arr-clip-view> — bottom clip-view panel. Empty when nothing is selected.
 * For a selected clip it offers modes via a left panel:
 *   - source: large preview + zoomable film strip; hover shows a mini preview,
 *     drag scrubs the big preview. Play-mode (loop) region shading.
 *   - automation: an automation curve editor + film strip, with a param label
 *     and a loop/clip timing toggle.
 * The film strip is the shared <time-strip>; this panel owns the time transform.
 * When the panel is short, the top area hides and the strip fills.
 */

import { html, css } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import { drawPlaceholderCell } from './film-reel';
import { renderPlayModeControls, playModeControlsStyles } from './play-mode-controls';
import { thumbnailController } from '../media/thumbnail-controller';
import { levelForFramesPerThumb } from '../media/thumbnail-mip';
import { clipSourceFrameAt, clipNoiseSeed, type ClipTimeCtx } from '../engine/clip-time';
import './time-strip';
import './arr-automation-editor';
import './arr-ruler';
import { ClipTimelineView, type ClipViewContext } from './timeline-view';
import '../../../widgets/ui-icon';

@customElement('arr-clip-view')
export class ArrClipView extends MobxLitElement {
  static styles = [playModeControlsStyles, css`
    :host {
      display: block;
      height: 100%;
      background: var(--app-bg-color2);
      border-top: 1px solid var(--app-tint-3);
      color: var(--app-text-color1);
      overflow: hidden;
    }
    .wrap {
      display: flex;
      height: 100%;
    }
    .left {
      width: 158px;
      flex-shrink: 0;
      border-right: 1px solid var(--app-tint-3);
      padding: var(--app-sp-3);
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-3);
      overflow: hidden;
    }
    .modes {
      display: flex;
      gap: 3px;
    }
    .modes button {
      flex: 1;
      font-family: inherit;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 4px;
      cursor: pointer;
    }
    .modes button.on {
      border-color: var(--app-hi-color2);
      color: var(--app-hi-color2);
    }
    .ctl {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .ctl .v {
      color: var(--app-text-color1);
    }
    .seg {
      display: inline-flex;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      overflow: hidden;
      width: fit-content;
    }
    .seg button {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      border: none;
      background: var(--app-bg-color1);
      color: var(--app-text-color2);
      padding: 2px 7px;
      cursor: pointer;
    }
    .seg button.on {
      background: var(--app-hi-color2);
      color: #fff;
    }
    .ctl .num {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      width: 64px;
      background: var(--app-bg-color1);
      color: var(--app-text-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 1px 4px;
    }
    .ctl > button {
      font-family: inherit;
      font-size: var(--app-fs-xs);
      width: fit-content;
      background: var(--app-bg-color1);
      color: var(--app-text-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 2px 7px;
      cursor: pointer;
    }
    .ctl > button.on {
      background: var(--app-hi-color2);
      color: #fff;
    }
    .body {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .top {
      position: relative;
      flex: 1;
      min-height: 0;
      border-bottom: 1px solid var(--app-tint-3);
      background: var(--app-bg-color1);
    }
    .top canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .top .autoedit {
      /* No horizontal padding so the curve's frame axis lines up exactly with
         the film strip below (one shared time grid). */
      position: absolute;
      inset: 0;
      display: block;
      box-sizing: border-box;
    }
    .plabel {
      position: absolute;
      left: 6px;
      top: 5px;
      font-size: var(--app-fs-xs);
      color: rgba(255, 255, 255, 0.85);
      text-shadow: 0 1px 2px #000;
      pointer-events: none;
    }
    time-strip {
      flex-shrink: 0;
      height: 66px;
    }
    .strip-fill time-strip {
      flex: 1;
      height: auto;
    }
    .mini {
      position: fixed;
      width: 96px;
      height: 54px;
      border: 1px solid var(--app-hi-color2);
      border-radius: 2px;
      pointer-events: none;
      z-index: 5;
      display: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      color: var(--app-text-color2);
      opacity: 0.6;
      font-size: var(--app-fs-md);
    }
  `];

  /** Clip-local, straight zoom/pan axis shared by the ruler + envelope editor. */
  private clipView = new ClipTimelineView(() => this.clipCtx());
  /** Stable grid provider (same ref each render) for the envelope editor. */
  private clipGrid = (): import('../model/beat-grid').BeatGrid => this.clipView.grid();
  private clipCtx(): ClipViewContext {
    const clip = store.selectedClip?.clip;
    return {
      startBeat: clip?.startBeat ?? 0,
      lengthBeat: clip?.lengthBeat ?? 4,
      spanBeats: this.editorBeats(),
      loopMode: store.clipAutoTiming === 'loop',
      beatsPerBar: this.beatsPerBar(),
    };
  }

  @state() private scrubFrame = 0;
  @state() private hoverFrame: number | null = null;
  @state() private hoverClientX = 0;
  private lastClipId = '';
  private lastMode = '';

  @query('.top canvas') private topCanvas?: HTMLCanvasElement;
  @query('.mini') private miniCanvas?: HTMLCanvasElement;
  @query('.body') private bodyEl?: HTMLDivElement;
  private thumbOff?: () => void;

  connectedCallback() {
    super.connectedCallback();
    // Repaint the preview/mini as decoded thumbnails land (async, no MobX change).
    this.thumbOff = thumbnailController.subscribe(() => this.requestUpdate());
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.thumbOff?.();
    if (this.lastClipId) thumbnailController.dropView(`clipview:${this.lastClipId}`);
  }

  private duration(): number {
    const sel = store.selectedClip;
    return sel?.clip.source?.durationFrames ?? 300;
  }

  private fpsOf(clip: any): number {
    return clip?.source?.fps && clip.source.fps > 0 ? clip.source.fps : 30;
  }

  /** The play-mode slice [startSec,endSec] mapped to source FRAMES (clamped to the
   *  file), for the film strip + clip-local ruler. one-shot's open-ended slice
   *  falls back to the whole source. */
  private sliceFrames(clip: any): { inFrame: number; outFrame: number } {
    const fps = this.fpsOf(clip);
    const dur = this.duration();
    const startSec = clip?.loop?.startSec ?? 0;
    const endSec = clip?.loop?.endSec ?? dur / fps;
    const inFrame = Math.max(0, Math.min(dur, Math.round(startSec * fps)));
    const outFrame = Math.max(inFrame + 1, Math.min(dur, Math.round(endSec * fps)));
    return { inFrame, outFrame };
  }

  render() {
    void store.positionBeat; // track: during playback the playhead drives the scrub
    const sel = store.selectedClip;
    if (!sel) return html`<div class="empty">Select a clip to inspect it here.</div>`;
    const { clip } = sel;
    const mode = store.clipViewMode;
    const short = store.clipViewHeight < 150;
    const isVideo = clip.kind === 'video' && !!clip.source;

    return html`
      <div class="wrap">
        <div class="left">
          <div class="modes">
            <button class=${mode === 'source' ? 'on' : ''} @click=${() => store.setClipViewMode('source')}>
              Source
            </button>
            <button class=${mode === 'automation' ? 'on' : ''} @click=${() => store.setClipViewMode('automation')}>
              Automation
            </button>
          </div>
          ${mode === 'source' ? this.renderSourceCtl(clip, isVideo) : this.renderAutoCtl(clip)}
        </div>
        <div class="body ${short ? 'strip-fill' : ''}">
          ${!short && (mode === 'automation' || isVideo)
            ? html`<arr-ruler compact .view=${this.clipView}></arr-ruler>`
            : ''}
          ${short
            ? ''
            : html`<div class="top">
                ${mode === 'automation'
                  ? html`<arr-automation-editor
                      class="autoedit"
                      .lane=${store.autoField(`clip/${sel.track.id}/${clip.id}`)
                        ? store.selectedClipLane(sel.track.id, clip.id) // selected field → ITS lane (undefined ⇒ empty default curve)
                        : clip.automation?.[0]}                          // nothing selected → the first lane
                      .ensureLaneId=${() => (store.autoField(`clip/${sel.track.id}/${clip.id}`)
                        ? store.ensureSelectedClipLane(sel.track.id, clip.id)
                        : store.ensureClipAutomationLane(sel.track.id, clip.id))}
                      .cursor=${this.autoCursor()}
                      .beats=${this.editorBeats()}
                      .beatsPerBar=${this.beatsPerBar()}
                      .gridProvider=${this.clipGrid}
                      .selection=${this.autoSelection()}
                      .timeboxGestures=${true}
                      .onSelect=${this.onEnvSelect}
                    ></arr-automation-editor>`
                  : html`<canvas></canvas>`}
                <span class="plabel">${this.topLabel(clip, mode)}</span>
              </div>`}
          ${mode === 'source'
            ? (isVideo
              ? html`<time-strip
                  .clipId=${clip.id}
                  .durationFrames=${this.duration()}
                  .pxPerFrame=${this.stripPxPerFrame()}
                  .scrollFrames=${this.stripScrollFrames()}
                  .loopIn=${this.sliceFrames(clip).inFrame}
                  .loopOut=${this.sliceFrames(clip).outFrame}
                  .playMode=${clip.loop.mode}
                  .sourceKey=${clip.source?.sourceKey ?? ''}
                  .url=${clip.source?.url ?? ''}
                  .fps=${this.fpsOf(clip)}
                  .playheadFrame=${this.stripPlayheadFrame()}
                  @viewchange=${this.onView}
                  @scrub=${this.onScrub}
                  @hover=${this.onHover}
                ></time-strip>`
              : html`<div class="empty">Generator sources aren't supported in the clip view yet.</div>`)
            : ''}
        </div>
      </div>
      <canvas class="mini"></canvas>
    `;
  }

  /** Editable play-mode timing — the shared controls (also used in the inspector),
   *  routed through the undoable store action. */
  private renderPlayMode(clip: any) {
    const tid = store.selectedClip?.track.id;
    const videoDurSec = clip.source ? this.duration() / this.fpsOf(clip) : 0;
    return renderPlayModeControls(clip.loop, videoDurSec, (patch) => {
      if (tid) store.updateClipLoop(tid, clip.id, patch);
    });
  }

  private renderSourceCtl(clip: any, isVideo: boolean) {
    const scale = clip.source?.scaleMode ?? 'fit';
    return html`
      <div class="ctl"><span>Source</span><span class="v">${clip.source?.label ?? (isVideo ? 'video' : 'none')}</span></div>
      ${this.renderPlayMode(clip)}
      ${clip.source
        ? html`<div class="ctl">
            <span>Scale</span>
            <div class="seg">
              ${(['fit', 'cover', 'stretch', 'none'] as const).map(
                (m) => html`<button
                  class=${scale === m ? 'on' : ''}
                  @click=${() => {
                    const sel = store.selectedClip;
                    if (sel) store.setClipScaleMode(sel.track.id, clip.id, m);
                  }}
                >${m}</button>`,
              )}
            </div>
          </div>`
        : ''}
    `;
  }

  /** Label for the clip's selected automation field (falls back to its 1st lane). */
  private clipAutoLabel(): string {
    const sel = store.selectedClip;
    if (!sel) return 'amount';
    const f = store.autoField(`clip/${sel.track.id}/${sel.clip.id}`);
    return f?.label
      ?? store.selectedClipLane(sel.track.id, sel.clip.id)?.label
      ?? sel.clip.automation?.[0]?.label
      ?? 'no field selected';
  }

  private renderAutoCtl(clip: any) {
    void clip;
    return html`
      <div class="ctl"><span>Parameter</span><span class="v">${this.clipAutoLabel()}</span></div>
      <div class="ctl">
        <span>Timing</span>
        <div class="seg">
          <button class=${store.clipAutoTiming === 'loop' ? 'on' : ''} @click=${() => store.setClipAutoTiming('loop')}>loop</button>
          <button class=${store.clipAutoTiming === 'clip' ? 'on' : ''} @click=${() => store.setClipAutoTiming('clip')}>clip</button>
        </div>
      </div>
      <div class="ctl"><span>Length</span><span class="v">${this.lengthLabel()}</span></div>
      <div class="ctl" style="opacity:.6"><span>${store.clipAutoTiming === 'loop' ? 'Envelope loops with the source.' : 'Envelope spans the clip length.'}</span></div>
    `;
  }

  /** "<bars> bars · <beats> beats" for the automation editor's span. */
  private lengthLabel(): string {
    const beats = this.editorBeats();
    const bars = beats / this.beatsPerBar();
    const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 1e-3 ? String(Math.round(n)) : n.toFixed(2));
    return `${fmt(bars)} bars · ${fmt(beats)} beats`;
  }

  private topLabel(clip: any, mode: string) {
    void clip;
    if (mode === 'automation') return `${this.clipAutoLabel()} · ${store.clipAutoTiming}`;
    return `frame ${Math.round(this.scrubFrame)}`;
  }

  // ── Events ──────────────────────────────────────────────────────────────
  private onView = (e: CustomEvent) => {
    // Wheel-zoom over the film strip drives the SHARED clip-local view (inverse
    // of stripPxPerFrame/stripScrollFrames), so strip + ruler stay locked.
    const { inFrame, framesPerBeat } = this.frameMap();
    this.clipView.setZoom(e.detail.pxPerFrame * framesPerBeat);
    this.clipView.setScrollUnits((e.detail.scrollFrames - inFrame) / framesPerBeat);
  };
  private onScrub = (e: CustomEvent) => {
    this.scrubFrame = e.detail.frame;
    // Scrubbing the strip moves the timeline playhead (frame → clip-local beat →
    // arrangement beat) so the monitor + arrangement follow.
    const sel = store.selectedClip;
    if (sel) {
      const { inFrame, framesPerBeat } = this.frameMap();
      const localBeat = (this.scrubFrame - inFrame) / framesPerBeat;
      // Keep the transport within the clip (the source view spans the whole video,
      // which is far longer than the clip).
      store.setPlayFrom(sel.clip.startBeat + Math.max(0, Math.min(sel.clip.lengthBeat, localBeat)));
    }
  };
  private onHover = (e: CustomEvent) => {
    this.hoverFrame = e.detail.frame;
    this.hoverClientX = e.detail.clientX;
  };

  // ── Drawing ──────────────────────────────────────────────────────────────
  updated() {
    // Re-fit the shared view when the clip OR the mode changes (the source view spans
    // the whole video, the automation view spans the loop/clip — different extents).
    const sel = store.selectedClip;
    const clipChanged = !!sel && sel.clip.id !== this.lastClipId;
    const modeChanged = store.clipViewMode !== this.lastMode;
    if (sel && (clipChanged || modeChanged)) {
      this.lastClipId = sel.clip.id;
      this.lastMode = store.clipViewMode;
      this.clipView.fitTo(this.bodyEl?.clientWidth ?? 600);
      if (clipChanged) this.scrubFrame = this.sliceFrames(sel.clip).inFrame;
    }
    // During playback the preview tracks the actual played source frame (play mode
    // applied). Paused, the user's scrub owns it (see onScrub). Reading positionBeat
    // here also keeps this reactive.
    if (sel && store.playing && sel.clip.lengthBeat > 0) {
      const f = this.currentSourceFrame();
      if (f != null) this.scrubFrame = f;
    }
    this.drawTop();
    this.drawMini();
  }

  private drawTop() {
    const canvas = this.topCanvas;
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

    const sel = store.selectedClip;
    if (!sel) return;
    // Automation mode renders the editable <arr-automation-editor> (no canvas);
    // this canvas only exists in source mode → big preview at the scrub frame.
    this.drawSourceFrame(ctx, w, h, sel.clip, this.scrubFrame);
  }

  /** Draw one source frame: a real decoded thumbnail when available, else a
   *  static neutral placeholder. Used by the big preview + the hover mini. */
  private drawSourceFrame(ctx: CanvasRenderingContext2D, w: number, h: number, clip: any, frame: number) {
    const src = clip.source;
    if (src?.url && src.sourceKey) {
      const frameCount = Math.max(1, src.durationFrames);
      const f = Math.max(0, Math.min(frameCount - 1, Math.round(frame)));
      const level = levelForFramesPerThumb(1); // finest level for a single big frame
      thumbnailController.registerMedia({ sourceKey: src.sourceKey, url: src.url, frameCount, fps: src.fps });
      thumbnailController.setView(`clipview:${clip.id}`, {
        sourceKey: src.sourceKey,
        level,
        startFrame: Math.max(0, f - 2),
        endFrame: Math.min(frameCount - 1, f + 2),
        pattern: 'window',
        readaheadFrames: 0,
      });
      const hit = thumbnailController.peek(src.sourceKey, f, level);
      if (hit) {
        // FIT (preserve aspect, letterbox) — never stretch/cover.
        const bmp = hit.value;
        const ar = bmp.width / Math.max(1, bmp.height);
        let dw = w;
        let dh = w / ar;
        if (dh > h) { dh = h; dw = h * ar; }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
        return;
      }
    }
    drawPlaceholderCell(ctx, 0, 0, w, h);
  }

  /** The source frame the engine is actually showing at the transport position (play
   *  mode applied), or null when the playhead is off this clip. */
  private currentSourceFrame(): number | null {
    const sel = store.selectedClip;
    const clip = sel?.clip;
    if (!clip?.source) return null;
    const beat = store.positionBeat;
    if (beat < clip.startBeat - 1e-6 || beat >= clip.startBeat + clip.lengthBeat) return null;
    const fps = this.fpsOf(clip);
    const frameCount = this.duration();
    const spb = 60 / Math.max(1, store.composition.meta.baseBPM);
    const ctx: ClipTimeCtx = {
      startBeat: clip.startBeat,
      lengthBeat: clip.lengthBeat,
      videoDurSec: frameCount / fps,
      secondsAt: (b) => b * spb,
      seed: clipNoiseSeed(clip.id),
    };
    return clipSourceFrameAt(clip.loop, ctx, beat, fps, frameCount);
  }

  /** Beats spanned by the shared clip-local view. In SOURCE mode the strip + ruler
   *  span the WHOLE video (its inherent start→end), so the active slice is just a
   *  sub-region and you can always pan to the real video start. In AUTOMATION mode it's
   *  the source-loop length (loop timing) or the clip's arrangement length. */
  private editorBeats(): number {
    const sel = store.selectedClip;
    if (!sel) return 4;
    const clip = sel.clip;
    if (store.clipViewMode === 'source' && clip.source) {
      // The whole source video, in beats at the project tempo.
      return Math.max(0.25, (this.duration() / this.fpsOf(clip)) * (store.composition.meta.baseBPM / 60));
    }
    if (store.clipAutoTiming === 'loop' && clip.source) {
      const fps = clip.source.fps ?? 30;
      const { inFrame, outFrame } = this.sliceFrames(clip);
      const loopFrames = Math.max(1, outFrame - inFrame);
      return Math.max(0.25, (loopFrames / Math.max(1, fps)) * (store.composition.meta.baseBPM / 60));
    }
    return Math.max(0.25, clip.lengthBeat);
  }
  private beatsPerBar(): number {
    return store.composition.meta.timeSignature?.[0] ?? 4;
  }

  /** The clip-local selection mapped to envelope data-x [0,1], or null. */
  private autoSelection(): { x0: number; x1: number } | null {
    const sel = this.clipView.timeSel;
    const span = this.editorBeats();
    if (!sel || span <= 0) return null;
    return { x0: sel.start / span, x1: sel.end / span };
  }

  /** Delete the envelope nodes inside the clip-local selection. Returns true if
   *  there was a selection to act on (so the key is consumed). */
  deleteSelectedAutoNodes(): boolean {
    const sel = store.selectedClip;
    const range = this.clipView.timeSel;
    const span = this.editorBeats();
    if (!sel || !range || span <= 0 || store.clipViewMode !== 'automation') return false;
    const lane = store.selectedClipLane(sel.track.id, sel.clip.id) ?? sel.clip.automation?.[0];
    if (!lane) return false;
    store.deleteAutoPointsInRange(lane.id, range.start / span, range.end / span);
    return true;
  }

  /** Envelope drag off the curve → a grid-quantized clip-local selection. */
  private onEnvSelect = (anchorX: number, headX: number) => {
    const span = this.editorBeats();
    this.clipView.setSelection(
      this.clipView.quantize(anchorX * span),
      this.clipView.quantize(headX * span),
    );
  };

  /** Linear map between the editor's clip-local beats and source frames: the
   *  editor span [0,spanBeats] covers the loop's [inFrame, inFrame+loopFrames].
   *  Lets the SOURCE film strip share the clip-local ruler's zoom/pan exactly. */
  private frameMap(): { inFrame: number; framesPerBeat: number } {
    const clip = store.selectedClip?.clip;
    if (store.clipViewMode === 'source' && clip?.source) {
      // Whole-video span: [0 beats, videoBeats] ↔ [frame 0, durationFrames].
      return { inFrame: 0, framesPerBeat: (this.fpsOf(clip) * 60) / store.composition.meta.baseBPM };
    }
    const { inFrame, outFrame } = this.sliceFrames(clip);
    const loopFrames = Math.max(1, outFrame - inFrame);
    return { inFrame, framesPerBeat: loopFrames / this.editorBeats() };
  }
  /** Film-strip transform DERIVED from the clip-local view, so frameToX lines up
   *  with the ruler's beatToX (zoom/pan/playhead all shared). */
  private stripPxPerFrame(): number {
    return this.clipView.pxPerBeat / this.frameMap().framesPerBeat;
  }
  private stripScrollFrames(): number {
    const { inFrame, framesPerBeat } = this.frameMap();
    return inFrame + this.clipView.scrollUnits * framesPerBeat;
  }
  private stripPlayheadFrame(): number {
    // The actual played source frame (play mode applied) — tracks the loop, not a
    // linear sweep across the whole video. Falls back to the scrub when off-clip.
    const live = store.playing ? this.currentSourceFrame() : null;
    return live != null ? live : Math.max(0, this.scrubFrame);
  }

  /** Cursor as normalized x∈[0,1] along the editor's BEAT axis (under the
   *  playhead). Null when the playhead isn't over the clip. */
  private autoCursor(): number | null {
    const sel = store.selectedClip;
    if (!sel) return null;
    const clip = sel.clip;
    const beats = this.editorBeats();
    if (beats <= 0) return null;
    const elapsed = store.positionBeat - clip.startBeat;
    if (elapsed < -1e-6 || store.positionBeat >= clip.startBeat + clip.lengthBeat) return null;
    // Clip mode: position within the clip; loop mode: phase within the loop.
    const x = store.clipAutoTiming === 'loop'
      ? (elapsed % beats) / beats
      : elapsed / clip.lengthBeat;
    return x >= 0 && x <= 1 ? x : null;
  }

  private drawMini() {
    const canvas = this.miniCanvas;
    const body = this.bodyEl;
    if (!canvas || !body) return;
    if (this.hoverFrame == null || store.clipViewMode !== 'source') {
      canvas.style.display = 'none';
      return;
    }
    const bodyRect = body.getBoundingClientRect();
    // Place above the strip, following the cursor x.
    canvas.style.display = 'block';
    canvas.style.left = `${Math.min(Math.max(this.hoverClientX - 48, bodyRect.left), bodyRect.right - 96)}px`;
    canvas.style.top = `${bodyRect.bottom - 66 - 58}px`;
    const w = 96;
    const h = 54;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sel = store.selectedClip;
    if (!sel) return;
    this.drawSourceFrame(ctx, w, h, sel.clip, this.hoverFrame);
  }
}
