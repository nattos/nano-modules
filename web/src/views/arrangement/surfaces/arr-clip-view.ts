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
import { drawFrameCell, reelSeedFor } from './film-reel';
import './time-strip';
import './arr-automation-editor';
import '../../../widgets/ui-icon';

@customElement('arr-clip-view')
export class ArrClipView extends MobxLitElement {
  static styles = css`
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
  `;

  @state() private pxPerFrame = 2;
  @state() private scrollFrames = 0;
  @state() private scrubFrame = 0;
  @state() private hoverFrame: number | null = null;
  @state() private hoverClientX = 0;
  private lastClipId = '';

  @query('.top canvas') private topCanvas?: HTMLCanvasElement;
  @query('.mini') private miniCanvas?: HTMLCanvasElement;
  @query('.body') private bodyEl?: HTMLDivElement;

  private duration(): number {
    const sel = store.selectedClip;
    return sel?.clip.source?.durationFrames ?? 300;
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
          ${short
            ? ''
            : html`<div class="top">
                ${mode === 'automation'
                  ? html`<arr-automation-editor
                      class="autoedit"
                      .lane=${clip.automation?.[0]}
                      .ensureLaneId=${() => store.ensureClipAutomationLane(sel.track.id, clip.id)}
                      .cursor=${this.autoCursor()}
                      .pxPerFrame=${this.pxPerFrame}
                      .scrollFrames=${this.scrollFrames}
                      .durationFrames=${this.duration()}
                    ></arr-automation-editor>`
                  : html`<canvas></canvas>`}
                <span class="plabel">${this.topLabel(clip, mode)}</span>
              </div>`}
          ${isVideo || mode === 'automation'
            ? html`<time-strip
                .clipId=${clip.id}
                .durationFrames=${this.duration()}
                .pxPerFrame=${this.pxPerFrame}
                .scrollFrames=${this.scrollFrames}
                .loopIn=${clip.loop.inFrame ?? 0}
                .loopOut=${clip.loop.outFrame ?? this.duration()}
                .playMode=${clip.loop.mode}
                .playheadFrame=${this.scrubFrame}
                @viewchange=${this.onView}
                @scrub=${this.onScrub}
                @hover=${this.onHover}
              ></time-strip>`
            : html`<div class="empty">Generator sources aren't supported in the clip view yet.</div>`}
        </div>
      </div>
      <canvas class="mini"></canvas>
    `;
  }

  private renderSourceCtl(clip: any, isVideo: boolean) {
    return html`
      <div class="ctl"><span>Source</span><span class="v">${clip.source?.label ?? (isVideo ? 'video' : 'none')}</span></div>
      <div class="ctl"><span>Play mode</span><span class="v">${clip.loop.mode}</span></div>
      <div class="ctl"><span>In / Out</span><span class="v">${clip.loop.inFrame ?? 0} – ${clip.loop.outFrame ?? this.duration()}</span></div>
      <div class="ctl" style="opacity:.6"><span>Markers are display-only here.</span></div>
    `;
  }

  private renderAutoCtl(clip: any) {
    const lane = clip.automation?.[0];
    return html`
      <div class="ctl"><span>Parameter</span><span class="v">${lane?.label ?? 'Saturate · amount'}</span></div>
      <div class="ctl">
        <span>Timing</span>
        <div class="seg">
          <button class=${store.clipAutoTiming === 'loop' ? 'on' : ''} @click=${() => store.setClipAutoTiming('loop')}>loop</button>
          <button class=${store.clipAutoTiming === 'clip' ? 'on' : ''} @click=${() => store.setClipAutoTiming('clip')}>clip</button>
        </div>
      </div>
      <div class="ctl" style="opacity:.6"><span>${store.clipAutoTiming === 'loop' ? 'Envelope loops with the source.' : 'Envelope spans the clip length.'}</span></div>
    `;
  }

  private topLabel(clip: any, mode: string) {
    if (mode === 'automation') return `${clip.automation?.[0]?.label ?? 'amount'} · ${store.clipAutoTiming}`;
    return `frame ${Math.round(this.scrubFrame)}`;
  }

  // ── Events ──────────────────────────────────────────────────────────────
  private onView = (e: CustomEvent) => {
    this.pxPerFrame = e.detail.pxPerFrame;
    this.scrollFrames = e.detail.scrollFrames;
  };
  private onScrub = (e: CustomEvent) => {
    this.scrubFrame = e.detail.frame;
    // Scrubbing the strip scrubs BOTH the film strip and the automation curve
    // (they share scrubFrame), and moves the timeline playhead so the monitor +
    // arrangement follow too.
    const sel = store.selectedClip;
    const dur = this.duration();
    if (sel && dur > 0) {
      const beat = sel.clip.startBeat + (this.scrubFrame / dur) * sel.clip.lengthBeat;
      store.setPlayFrom(beat);
    }
  };
  private onHover = (e: CustomEvent) => {
    this.hoverFrame = e.detail.frame;
    this.hoverClientX = e.detail.clientX;
  };

  // ── Drawing ──────────────────────────────────────────────────────────────
  updated() {
    // Reset the transform to fit when the selected clip changes.
    const sel = store.selectedClip;
    if (sel && sel.clip.id !== this.lastClipId) {
      this.lastClipId = sel.clip.id;
      const w = this.bodyEl?.clientWidth ?? 600;
      this.pxPerFrame = Math.max(0.2, w / this.duration());
      this.scrollFrames = 0;
      this.scrubFrame = sel.clip.loop.inFrame ?? 0;
    }
    // During playback the timeline playhead drives the shared scrub (so the film
    // strip + automation cursor track the transport). Paused, the user's scrub
    // owns it (see onScrub). Reading positionBeat here also keeps this reactive.
    if (sel && store.playing && sel.clip.lengthBeat > 0) {
      const frac = (store.positionBeat - sel.clip.startBeat) / sel.clip.lengthBeat;
      if (frac >= 0 && frac <= 1) this.scrubFrame = frac * this.duration();
    }
    this.drawTop();
    this.drawMini();
  }

  private frameToX(f: number) {
    return (f - this.scrollFrames) * this.pxPerFrame;
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
    const clip = sel.clip;
    const seed = reelSeedFor(clip.id);
    // Automation mode renders the editable <arr-automation-editor> (no canvas);
    // this canvas only exists in source mode → big preview at the scrub frame.
    drawFrameCell(ctx, 0, 0, w, h, seed, Math.min(1, this.scrubFrame / this.duration()));
  }

  /** Cursor as normalized x∈[0,1] on the SHARED frame axis (so the curve cursor
   *  sits exactly under the film-strip playhead). Null if outside the source. */
  private autoCursor(): number | null {
    const dur = this.duration();
    if (dur <= 0) return null;
    const x = this.scrubFrame / dur;
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
    drawFrameCell(ctx, 0, 0, w, h, reelSeedFor(sel.clip.id), Math.min(1, this.hoverFrame / this.duration()));
  }
}
