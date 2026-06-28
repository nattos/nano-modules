/**
 * <arr-debug> — the Debug tab: live performance stats.
 *
 * While mounted it sets `debugPerf.active = true`, which is what gates the producers
 * (video compositor, monitor) from doing any per-frame snapshot/cache-stats work — so the
 * instrumentation costs nothing unless this tab is open. It polls the `debugPerf` bus a few
 * times a second and renders; no MobX so publishing from hot paths stays allocation-light.
 */

import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { debugPerf, type ClipPerf } from '../state/debug-perf';

@customElement('arr-debug')
export class ArrDebug extends LitElement {
  static styles = css`
    :host { display: block; padding: var(--app-sp-3, 12px); overflow-y: auto; height: 100%; box-sizing: border-box;
            font-family: var(--app-mono-font, ui-monospace, monospace); font-size: 11px; color: var(--app-text-color1); }
    h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--app-text-color2);
         margin: 14px 0 6px; font-family: var(--app-font, inherit); }
    h3:first-child { margin-top: 0; }
    .row { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
    .row .k { color: var(--app-text-color2); }
    .row .v { color: var(--app-text-color1); text-align: right; font-variant-numeric: tabular-nums; }
    .v.warn { color: var(--app-warn-color, #e0a030); }
    .v.bad { color: var(--app-err-color, #e05050); }
    .card { background: var(--app-bg-color2, rgba(255,255,255,0.03)); border: 1px solid var(--app-tint-2, rgba(255,255,255,0.06));
            border-radius: 6px; padding: 8px; margin-bottom: 8px; }
    .card .title { display: flex; justify-content: space-between; font-family: var(--app-font, inherit);
                   font-size: 11px; margin-bottom: 4px; }
    .badge { font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--app-tint-2, rgba(255,255,255,0.08));
             color: var(--app-text-color2); }
    .empty { color: var(--app-text-color2); padding: 12px 0; font-family: var(--app-font, inherit); }
    .note { color: var(--app-text-color2); font-size: 10px; margin-top: 10px; font-family: var(--app-font, inherit); }
  `;

  @state() private tick = 0;
  private timer = 0;

  connectedCallback() {
    super.connectedCallback();
    debugPerf.active = true; // turns ON the (otherwise free) per-frame collection
    this.timer = window.setInterval(() => { this.tick++; }, 333);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    debugPerf.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  private row(k: string, v: string, cls = ''): TemplateResult {
    return html`<div class="row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  }

  private clipCard(c: ClipPerf): TemplateResult {
    const fpsActual = c.injectAvgMs ? 1000 / c.injectAvgMs : 0;
    const jitter = (c.injectMaxMs ?? 0) > (c.injectAvgMs ?? 0) * 1.6 ? 'warn' : '';
    return html`
      <div class="card">
        <div class="title"><span>${c.label} · ${c.width}×${c.height}</span><span class="badge">${c.path}</span></div>
        ${this.row('source', `${c.fps.toFixed(2)}fps · ${c.frameCount}f`)}
        ${this.row('presented', `${fpsActual.toFixed(1)}fps`)}
        ${this.row('inject gap', `${(c.injectAvgMs ?? 0).toFixed(0)} / ${(c.injectMaxMs ?? 0).toFixed(0)}ms avg/max`, jitter)}
        ${c.path === 'cursor' ? html`
          ${this.row('actions', `play ${c.play} · seek ${c.seek} · hold ${c.hold}`, (c.seek ?? 0) > 1 ? 'warn' : '')}
          ${this.row('notReady', `${c.notReady}`, (c.notReady ?? 0) > 4 ? 'warn' : '')}
          ${this.row('drift', `${(c.driftAvgMs ?? 0).toFixed(0)} / ${(c.driftMaxMs ?? 0).toFixed(0)}ms avg/max`,
            (c.driftMaxMs ?? 0) > 200 ? 'bad' : (c.driftMaxMs ?? 0) > 60 ? 'warn' : '')}
          ${this.row('seeks', `${c.seeks} · ${(c.seekAvgMs ?? 0).toFixed(0)}ms`)}
          ${this.row('cache', `${c.cacheEntries}f · ${(c.cacheMB ?? 0).toFixed(0)}MB · ${((c.cacheHitRate ?? 0) * 100).toFixed(0)}% hit · ${c.cachePinned} pinned`)}
        ` : ''}
      </div>`;
  }

  render() {
    void this.tick; // establish tracking so the interval re-renders
    const m = debugPerf.monitor;
    const stale = debugPerf.updatedAt > 0 && performance.now() - debugPerf.updatedAt > 2000;
    return html`
      <h3>Output monitor</h3>
      ${m ? html`
        ${this.row('vsync draws', `${m.drawsPerSec.toFixed(0)}/s`)}
        ${this.row('new frames', `${m.newFramesPerSec.toFixed(0)}/s`)}
        ${this.row('composite gap', `${m.gapAvgMs.toFixed(1)} / ${m.gapMaxMs.toFixed(1)}ms avg/max`,
          m.gapMaxMs > m.gapAvgMs * 2 ? 'warn' : '')}
      ` : html`<div class="empty">No composite yet — start playback.</div>`}

      <h3>Video clips${stale ? ' (paused)' : ''}</h3>
      ${debugPerf.clips.length
        ? debugPerf.clips.map((c) => this.clipCard(c))
        : html`<div class="empty">No active video clips.</div>`}

      <div class="note">Collected only while this tab is open.</div>
    `;
  }
}
