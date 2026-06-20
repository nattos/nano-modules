/**
 * <ide-monitor> — Right-panel monitor for the IDE.
 *
 * Renders the current project's `sketch_output` trace via the existing
 * `<texture-monitor>` widget, plus transport controls (undo / redo /
 * pause / frame-step).
 *
 * Pause state lives in `userSettings.paused` so it survives reloads. The
 * engine command is sent through `appController.setPaused`, and `boot.ts`
 * re-applies the saved value at startup.
 */

import { html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';

import '../../widgets/texture-monitor';
import '../../widgets/ui-button';

/** Fixed internal capture resolution of the monitor (the canvas/trace size).
 *  Independent of the on-screen display size, which scales to fit. */
const CAPTURE_W = 640;
const CAPTURE_H = 360;
const ASPECT = CAPTURE_W / CAPTURE_H;
/** Magnification when the zoom toggle is active. */
const ZOOM_FACTOR = 4;
/** Selectable target framerates for the headroom estimate. */
const TARGET_FPS_OPTIONS = [30, 60, 120];

@customElement('ide-monitor')
export class IdeMonitor extends MobxLitElement {
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
      padding: 16px;
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
      font-size: 11px;
      text-align: center;
      padding: 32px;
    }
    .transport {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      background: var(--app-bg-color2);
      border-top: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .stat {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      color: var(--app-text-color2);
    }
    .stat .metric {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .stat .err {
      color: #e06c6c;
    }
    /* GPU headroom colour ramp: comfortable / tight / over budget. */
    .stat .headroom.ok {
      color: #6cc070;
    }
    .stat .headroom.tight {
      color: #d6a13c;
    }
    .stat .headroom.over {
      color: #e06c6c;
    }
    .stat .target {
      font-size: 10px;
      color: var(--app-text-color2);
      background: var(--app-bg-color);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 3px;
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
    const sel = appState.local.userSettings.selectedProjectId;
    const sketch = sel ? appState.database.sketches[sel] : null;
    const paused = appState.local.userSettings.paused;
    const fps = appState.local.engine.fps;
    const error = appState.local.engine.error;
    const gpuMs = appState.local.engine.gpuTimeMs;
    const targetFps = appState.local.userSettings.targetFps;
    const { w, h } = this.stageSize();
    return html`
      <div class="preview ${this.zoomed ? 'zoomed' : ''}">
        ${sel && sketch
          ? html`<div class="stage" style="width:${w}px;height:${h}px">
              <texture-monitor
                fit
                .traceId=${`ide_preview:${sel}`}
                .traceTarget=${{ type: 'sketch_output', sketchId: sel } as any}
                .width=${CAPTURE_W}
                .height=${CAPTURE_H}
                resolution="high"
              ></texture-monitor>
            </div>`
          : html`<div class="empty">No project selected.<br>Pick one in the explorer to begin.</div>`}
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
                <span class="metric">${fps} FPS</span>
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
    if (gpuMs <= 0) {
      return html`<span class="metric" title="No GPU timing yet">GPU —</span>`;
    }
    const budgetMs = 1000 / targetFps;
    const usage = gpuMs / budgetMs;
    const headroomPct = Math.max(0, Math.round((1 - usage) * 100));
    // green = comfortable, amber = tight, red = over budget.
    const level = usage >= 1 ? 'over' : usage >= 0.8 ? 'tight' : 'ok';
    return html`<span
      class="metric headroom ${level}"
      title="Est. GPU ${gpuMs.toFixed(1)} ms of ${budgetMs.toFixed(1)} ms budget (${targetFps} FPS) — ${headroomPct}% headroom"
      >GPU ${gpuMs.toFixed(1)}ms · ${headroomPct}% free</span
    >`;
  }

  private onTargetChange = (e: Event) => {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isNaN(v)) appController.setUserSetting('targetFps', v);
  };

  private onUndo = () => appController.undo();
  private onRedo = () => appController.redo();

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
