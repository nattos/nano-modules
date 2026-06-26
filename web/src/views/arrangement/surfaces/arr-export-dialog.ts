/**
 * <arr-export-dialog> — the modal that renders the composition to an MP4.
 *
 * Reads its defaults from the composition (resolution + fps), lets the user tweak
 * them for this export, then drives `exportComposition` (a second, paused engine
 * worker) with a live progress bar. On completion the file downloads automatically
 * and stays re-downloadable. Cancel aborts cleanly between frames.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import {
  exportComposition, canExport, planExportFrames, evenDim,
  type ExportResult,
} from '../engine/export-renderer';
import { makeWarpClock } from '../engine/warp-clock';
import { compositionLengthBeats, compositionFps } from '../model/composition';
import '../../../widgets/editable-number';
import '../../../widgets/ui-icon';

type Phase = 'idle' | 'rendering' | 'done' | 'error' | 'canceled';

@customElement('arr-export-dialog')
export class ArrExportDialog extends MobxLitElement {
  @property({ type: Boolean, reflect: true }) open = false;

  @state() private width = 1920;
  @state() private height = 1080;
  @state() private fps = 60;
  @state() private phase: Phase = 'idle';
  @state() private done = 0;
  @state() private totalFrames = 0;
  @state() private message = '';

  private abort: AbortController | null = null;
  private resultUrl: string | null = null;
  private result: ExportResult | null = null;

  static styles = css`
    :host { display: none; }
    :host([open]) { display: block; }
    .scrim {
      position: fixed; inset: 0; z-index: 200;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
    }
    .card {
      width: 360px; max-width: 92vw;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 6px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--app-sp-4) var(--app-sp-5);
      border-bottom: 1px solid var(--app-tint-4);
      font-weight: 600;
    }
    header .x { cursor: pointer; color: var(--app-text-color2); display: flex; }
    header .x:hover { color: var(--app-text-color1); }
    .body { padding: var(--app-sp-5); display: flex; flex-direction: column; gap: var(--app-sp-4); }
    .row { display: flex; align-items: center; gap: var(--app-sp-3); }
    .row > label { width: 92px; color: var(--app-text-color2); font-size: var(--app-fs-sm); }
    .row .val { display: flex; align-items: center; gap: var(--app-sp-2); }
    editable-number {
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      --editable-text-pad: 2px var(--app-sp-3);
      width: 64px;
    }
    .muted { color: var(--app-text-color2); font-size: var(--app-fs-sm); }
    .fmt { color: var(--app-text-color1); }
    .progress {
      height: 6px; border-radius: 3px; overflow: hidden;
      background: var(--app-tint-3);
    }
    .progress > i { display: block; height: 100%; background: var(--app-hi-color2); transition: width 0.1s linear; }
    .err { color: var(--app-hi-color1); font-size: var(--app-fs-sm); white-space: pre-wrap; }
    footer {
      display: flex; justify-content: flex-end; gap: var(--app-sp-3);
      padding: var(--app-sp-4) var(--app-sp-5);
      border-top: 1px solid var(--app-tint-4);
    }
    button {
      font-family: inherit; font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px; height: 28px; padding: 0 var(--app-sp-4);
      cursor: pointer;
    }
    button:hover { border-color: var(--app-tint-5); }
    button.primary { background: var(--app-hi-color2); border-color: var(--app-hi-color2); color: #fff; }
    button.primary:hover { filter: brightness(1.08); }
    button:disabled { opacity: 0.5; cursor: default; }
  `;

  /** Re-seed the editable fields from the composition each time we open. */
  updated(changed: Map<string, unknown>) {
    if (changed.has('open') && this.open && this.phase !== 'rendering') {
      const r = store.composition.meta.resolution;
      this.width = r.width;
      this.height = r.height;
      this.fps = compositionFps(store.composition);
      this.phase = 'idle';
      this.message = '';
      this.done = 0;
      this.clearResult();
    }
  }

  private clearResult() {
    if (this.resultUrl) { URL.revokeObjectURL(this.resultUrl); this.resultUrl = null; }
    this.result = null;
  }

  private close = () => {
    if (this.phase === 'rendering') return; // can't close mid-render (use Cancel)
    this.open = false;
    this.clearResult();
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  };

  /** Estimated output frame count for the current settings. */
  private get estimate(): { frames: number; seconds: number } {
    try {
      const clock = makeWarpClock(store.composition);
      const frames = planExportFrames(clock, Math.max(1, Math.round(this.fps)), 0, compositionLengthBeats(store.composition)).length;
      return { frames, seconds: frames / Math.max(1, this.fps) };
    } catch {
      return { frames: 0, seconds: 0 };
    }
  }

  private baseName(): string {
    const n = (store.currentName ?? 'arrangement').replace(/\.[^/.]+$/, '').split('/').pop() || 'arrangement';
    return n;
  }

  private download() {
    if (!this.resultUrl) return;
    const a = document.createElement('a');
    a.href = this.resultUrl;
    a.download = `${this.baseName()}.mp4`;
    a.click();
  }

  private startExport = async () => {
    if (!canExport()) {
      this.phase = 'error';
      this.message = 'This browser does not support video export (WebCodecs VideoEncoder).';
      return;
    }
    this.clearResult();
    this.phase = 'rendering';
    this.done = 0;
    this.message = '';
    this.abort = new AbortController();
    const t0 = performance.now();
    try {
      const result = await exportComposition({
        width: evenDim(this.width),
        height: evenDim(this.height),
        fps: Math.max(1, Math.round(this.fps)),
        signal: this.abort.signal,
        onProgress: (done, total) => { this.done = done; this.totalFrames = total; },
      });
      this.result = result;
      this.resultUrl = URL.createObjectURL(result.blob);
      this.phase = 'done';
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      const mb = (result.blob.size / (1024 * 1024)).toFixed(1);
      this.message = `${result.frames} frames · ${result.durationSec.toFixed(1)}s · ${mb} MB · rendered in ${secs}s`;
      this.download(); // auto-save; stays re-downloadable below
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        this.phase = 'canceled';
        this.message = 'Export canceled.';
      } else {
        this.phase = 'error';
        this.message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error('[export] failed', err);
      }
    } finally {
      this.abort = null;
    }
  };

  private cancel = () => { this.abort?.abort(); };

  render() {
    if (!this.open) return nothing;
    const rendering = this.phase === 'rendering';
    const pct = this.totalFrames > 0 ? Math.round((this.done / this.totalFrames) * 100) : 0;
    const est = this.estimate;
    return html`
      <div class="scrim" @click=${(e: Event) => { if (e.target === e.currentTarget) this.close(); }}>
        <div class="card" role="dialog" aria-label="Export video">
          <header>
            <span>Export video</span>
            <span class="x" title="Close" @click=${this.close}><ui-icon icon="la-times"></ui-icon></span>
          </header>
          <div class="body">
            <div class="row">
              <label>Resolution</label>
              <span class="val">
                <editable-number .value=${this.width} .step=${2} .min=${2} .precision=${0}
                  ?disabled=${rendering}
                  @input=${(e: CustomEvent<number>) => { this.width = e.detail; }}></editable-number>
                ×
                <editable-number .value=${this.height} .step=${2} .min=${2} .precision=${0}
                  ?disabled=${rendering}
                  @input=${(e: CustomEvent<number>) => { this.height = e.detail; }}></editable-number>
              </span>
            </div>
            <div class="row">
              <label>Frame rate</label>
              <span class="val">
                <editable-number .value=${this.fps} .step=${1} .min=${1} .max=${240} .precision=${0}
                  ?disabled=${rendering}
                  @input=${(e: CustomEvent<number>) => { this.fps = e.detail; }}></editable-number>
                <span class="muted">fps</span>
              </span>
            </div>
            <div class="row">
              <label>Format</label>
              <span class="val fmt">MP4 · H.264</span>
            </div>
            <div class="row">
              <label>Length</label>
              <span class="val muted">~${est.frames} frames · ${est.seconds.toFixed(1)}s</span>
            </div>

            ${rendering ? html`
              <div class="progress"><i style="width:${pct}%"></i></div>
              <div class="muted">${this.done} / ${this.totalFrames} frames (${pct}%)</div>
            ` : nothing}
            ${this.phase === 'done' ? html`<div class="muted">✓ ${this.message}</div>` : nothing}
            ${this.phase === 'canceled' ? html`<div class="muted">${this.message}</div>` : nothing}
            ${this.phase === 'error' ? html`<div class="err">${this.message}</div>` : nothing}
          </div>
          <footer>
            ${rendering ? html`
              <button @click=${this.cancel}>Cancel</button>
            ` : this.phase === 'done' ? html`
              <button @click=${() => this.download()}>Download again</button>
              <button class="primary" @click=${this.close}>Done</button>
            ` : html`
              <button @click=${this.close}>Cancel</button>
              <button class="primary" @click=${this.startExport} ?disabled=${est.frames === 0}>Export</button>
            `}
          </footer>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'arr-export-dialog': ArrExportDialog;
  }
}
