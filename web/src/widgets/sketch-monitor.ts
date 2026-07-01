/**
 * <sketch-monitor> — Main preview + transport panel, shared by the Effect
 * IDE (`effect-ide-app.ts`) and the Resolume sketch IDE's edit tab
 * (`edit-tab.ts`). Both render a single-column sketch on the left and this
 * monitor on the right, so the panel — and its bottom transport strip
 * (undo/redo/copy/cut/paste/pause/step/fps) — lives here once instead of
 * being hand-rolled per view.
 *
 * Callers own what to preview: pass `sketchId` (only used for the empty-state
 * check + default trace target) and `traceTarget` (defaults to that sketch's
 * `sketch_output` when omitted — pass an explicit target, e.g. one that
 * follows the current selection, to retarget dynamically). `traceTarget` is
 * sanitized before being handed to `<texture-monitor>` since it may come
 * straight off a MobX-observable selection, which can't cross the
 * postMessage boundary to the executor worker.
 *
 * Pause state lives in `userSettings.paused` so it survives reloads. The
 * engine command is sent through `appController.setPaused`, and `boot.ts`
 * re-applies the saved value at startup.
 */

import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { toJS } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { TracePoint } from '../engine-types';

import { computeHeadroom, fixedNum, TARGET_FPS_OPTIONS } from '../views/gpu-headroom';

import './texture-monitor';
import './ui-button';

/** Fixed internal capture resolution of the monitor (the canvas/trace size).
 *  Independent of the on-screen display size, which scales to fit. */
const CAPTURE_W = 640;
const CAPTURE_H = 360;
const ASPECT = CAPTURE_W / CAPTURE_H;
/** Magnification when the zoom toggle is active. */
const ZOOM_FACTOR = 4;

@customElement('sketch-monitor')
export class SketchMonitor extends MobxLitElement {
  /** Sketch being previewed. Only used for the empty-state check and the
   *  default trace target — pass `traceTarget` explicitly to retarget. */
  @property() sketchId: string | null = null;

  /** Unique trace registration id (must be unique across monitors on-screen). */
  @property() traceId = 'sketch_monitor';

  /** Trace target. Defaults to `{type:'sketch_output', sketchId}` when unset. */
  @property({ attribute: false }) traceTarget: TracePoint['target'] | null = null;

  /** Shown in the empty state when `sketchId` is null. */
  @property() emptyMessage = 'No sketch selected.';

  /** Content-box size of `.preview` (padding excluded), tracked via ResizeObserver. */
  @state() private availW = 0;
  @state() private availH = 0;

  /** When active, the monitor pops in at ZOOM_FACTOR and the preview scrolls. */
  @state() private zoomed = false;

  private resizeObserver: ResizeObserver | null = null;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .preview {
      flex: 1;
      display: flex;
      /* "safe" centering keeps the stage centered while it fits, but falls
         back to start-alignment when it overflows (zoom) — otherwise the
         top/left overflow is clipped and unreachable by the scrollbars. */
      align-items: safe center;
      justify-content: safe center;
      padding: var(--app-sp-6);
      background: #000;
      overflow: hidden;
      min-height: 0;
      min-width: 0;
    }
    .preview.zoomed {
      /* Pop-in mode: the stage is larger than the viewport, so scroll it. */
      overflow: auto;
    }
    /* The stage is sized to the exact contain-fit (× zoom) box, so the
       monitor inside fills it with no letterboxing. flex-shrink:0 keeps it
       at full size while zoomed (so the flex container can scroll past it). */
    .stage {
      flex-shrink: 0;
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--app-text-color2);
      font-size: var(--app-fs-md);
      text-align: center;
      padding: 32px;
    }
    .transport {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      padding: 8px 12px;
      background: var(--app-bg-color2);
      border-top: 1px solid var(--app-tint-3);
      flex-shrink: 0;
    }
    .stat {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--app-sp-4);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .stat .metric {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .stat .err {
      color: var(--app-error);
    }
    /* GPU headroom colour ramp: comfortable / tight / over budget. */
    .stat .headroom.ok {
      color: var(--app-ok);
    }
    .stat .headroom.tight {
      color: var(--app-warn);
    }
    .stat .headroom.over {
      color: var(--app-error);
    }
    .stat .target {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: var(--app-bg-color);
      border: 1px solid var(--app-tint-5);
      border-radius: 1px;
      padding: 1px 2px;
      cursor: pointer;
    }
  `;

  firstUpdated() {
    const preview = this.renderRoot.querySelector('.preview') as HTMLElement | null;
    if (!preview) return;
    this.resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      this.availW = box.width;
      this.availH = box.height;
    });
    this.resizeObserver.observe(preview);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  /** Largest box of the monitor's aspect ratio that fits the available area,
   *  scaled by the active zoom factor. */
  private stageSize(): { w: number; h: number } {
    let w = this.availW;
    let h = w / ASPECT;
    if (h > this.availH) {
      h = this.availH;
      w = h * ASPECT;
    }
    const z = this.zoomed ? ZOOM_FACTOR : 1;
    return { w: Math.max(1, Math.floor(w * z)), h: Math.max(1, Math.floor(h * z)) };
  }

  render() {
    const sketchId = this.sketchId;
    const paused = appState.local.userSettings.paused;
    const fps = appState.local.engine.fps;
    const error = appState.local.engine.error;
    const gpuMs = appState.local.engine.gpuTimeMs;
    const targetFps = appState.local.userSettings.targetFps;
    // Sanitize: `traceTarget` may be a MobX-observable pulled straight off the
    // current selection, which can't be structured-cloned across postMessage
    // to the executor worker (see CLAUDE.md's serialization-boundary rule).
    const target = this.traceTarget
      ? (JSON.parse(JSON.stringify(toJS(this.traceTarget))) as TracePoint['target'])
      : (sketchId ? ({ type: 'sketch_output', sketchId } as TracePoint['target']) : null);
    const { w, h } = this.stageSize();
    return html`
      <div class="preview ${this.zoomed ? 'zoomed' : ''}">
        ${sketchId && target
          ? html`<div class="stage" style="width:${w}px;height:${h}px">
              <texture-monitor
                fit
                .traceId=${this.traceId}
                .traceTarget=${target as any}
                .width=${CAPTURE_W}
                .height=${CAPTURE_H}
                resolution="high"
              ></texture-monitor>
            </div>`
          : html`<div class="empty">${this.emptyMessage}</div>`}
      </div>
      <div class="transport">
        <ui-button
          icon="la-search-plus"
          title=${this.zoomed ? 'Zoom out' : `Zoom ${ZOOM_FACTOR}×`}
          ?active=${this.zoomed}
          @click=${this.onToggleZoom}>
        </ui-button>
        <ui-button
          icon="la-undo"
          title="Undo"
          ?disabled=${!appController.history.canUndo}
          @click=${this.onUndo}>
        </ui-button>
        <ui-button
          icon="la-redo"
          title="Redo"
          ?disabled=${!appController.history.canRedo}
          @click=${this.onRedo}>
        </ui-button>
        <ui-button
          icon="la-copy"
          title="Copy effect (⌘C)"
          ?disabled=${!appController.canCopy}
          @click=${this.onCopy}>
        </ui-button>
        <ui-button
          icon="la-cut"
          title="Cut effect (⌘X)"
          ?disabled=${!appController.canCut}
          @click=${this.onCut}>
        </ui-button>
        <ui-button
          icon="la-paste"
          title="Paste effect (⌘V)"
          ?disabled=${!appController.canPaste}
          @click=${this.onPaste}>
        </ui-button>
        <ui-button
          .icon=${paused ? 'la-play' : 'la-pause'}
          title=${paused ? 'Resume engine' : 'Pause engine'}
          @click=${this.onTogglePause}>
        </ui-button>
        <ui-button
          icon="la-step-forward"
          title=${paused ? 'Step one frame' : 'Pause (then step)'}
          @click=${this.onStepFrame}>
        </ui-button>
        <span class="stat">
          ${error
            ? html`<span class="err">Error: ${error}</span>`
            : html`
                <span class="metric">${fixedNum(fps, 3)} FPS</span>
                ${this.renderHeadroom(gpuMs, targetFps)}
                <select
                  class="target"
                  title="Target framerate (the GPU headroom budget)"
                  .value=${String(targetFps)}
                  @change=${this.onTargetChange}>
                  ${TARGET_FPS_OPTIONS.map(
                    (t) => html`<option value=${t} ?selected=${t === targetFps}>${t}↑</option>`,
                  )}
                </select>
              `}
        </span>
      </div>
    `;
  }

  /** GPU usage / headroom badge. Usage = estimated GPU ms ÷ the target-frame
   *  budget; headroom is what's left. Colour-coded by how close to the budget
   *  we are. Reads "—" until the first live sample (or while paused/idle). */
  private renderHeadroom(gpuMs: number, targetFps: number) {
    const h = computeHeadroom(gpuMs, targetFps);
    if (!h.measured) {
      return html`<span class="metric" title="No GPU timing yet">GPU —</span>`;
    }
    return html`<span
      class="metric headroom ${h.level}"
      title="Est. GPU ${h.gpuMs.toFixed(1)} ms of ${h.budgetMs.toFixed(1)} ms budget (${targetFps} FPS) — ${h.headroomPct}% headroom"
      >GPU ${fixedNum(h.gpuMs.toFixed(1), 4)}ms · ${fixedNum(h.headroomPct, 3)}% free</span
    >`;
  }

  private onTargetChange = (e: Event) => {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isNaN(v)) appController.setUserSetting('targetFps', v);
  };

  private onUndo = () => appController.undo();
  private onRedo = () => appController.redo();
  private onCopy = () => appController.copySelection();
  private onCut = () => appController.cutSelection();
  private onPaste = () => appController.pasteClipboard();

  private onToggleZoom = () => {
    this.zoomed = !this.zoomed;
    if (this.zoomed) {
      // Center the scroll on the zoomed stage so the pop-in reveals the middle.
      this.updateComplete.then(() => {
        const preview = this.renderRoot.querySelector('.preview') as HTMLElement | null;
        if (!preview) return;
        preview.scrollLeft = (preview.scrollWidth - preview.clientWidth) / 2;
        preview.scrollTop = (preview.scrollHeight - preview.clientHeight) / 2;
      });
    }
  };

  private onTogglePause = () => {
    appController.setPaused(!appState.local.userSettings.paused);
  };

  // Frame-step: when running free, the first click pauses; subsequent clicks
  // (now paused) advance one frame at a time.
  private onStepFrame = () => {
    if (appState.local.userSettings.paused) {
      appController.stepFrame();
    } else {
      appController.setPaused(true);
    }
  };
}
