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

/** Percentile of an ASCENDING-sorted array (nearest-rank). */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

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
    /* Stale = stopped updating (clip ended / playback stopped) but still remembered (~60s). */
    .card.stale { border-style: dashed; border-color: var(--app-tint-3, rgba(255,255,255,0.14)); opacity: 0.6; }
    .card.warnborder { border-color: var(--app-warn-color, #e0a030); }
    .card .title { display: flex; justify-content: space-between; font-family: var(--app-font, inherit);
                   font-size: 11px; margin-bottom: 4px; }
    .badge { font-size: 9px; padding: 1px 5px; border-radius: 4px; background: var(--app-tint-2, rgba(255,255,255,0.08));
             color: var(--app-text-color2); }
    .badge.age { background: none; }
    .empty { color: var(--app-text-color2); padding: 12px 0; font-family: var(--app-font, inherit); }
    .note { color: var(--app-text-color2); font-size: 10px; margin-top: 10px; font-family: var(--app-font, inherit); }
  `;

  /** Stale once a producer hasn't published for this long (it publishes ≈2×/s). */
  private static readonly STALE_MS = 1500;
  /** Drop a remembered clip after this long with no update. */
  private static readonly FORGET_MS = 60_000;

  @state() private tick = 0;
  private timer = 0;
  /** Remembered clips (incl. recently-ended ones), keyed by clipId. */
  private history = new Map<string, { perf: ClipPerf; lastSeen: number }>();
  private lastClipsAt = 0;

  connectedCallback() {
    super.connectedCallback();
    debugPerf.active = true; // turns ON the (otherwise free) per-frame collection
    this.timer = window.setInterval(() => { this.collect(); this.tick++; }, 333);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    debugPerf.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
    this.history.clear();
  }

  /** Fold each fresh publish into the 60s history; expire old entries. */
  private collect() {
    const now = performance.now();
    if (debugPerf.clipsAt > this.lastClipsAt) { // a fresh clips publish
      this.lastClipsAt = debugPerf.clipsAt;
      for (const c of debugPerf.clips) this.history.set(c.clipId, { perf: c, lastSeen: now });
    }
    for (const [id, e] of this.history) if (now - e.lastSeen > ArrDebug.FORGET_MS) this.history.delete(id);
  }

  private row(k: string, v: string, cls = ''): TemplateResult {
    return html`<div class="row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
  }

  private clipCard(c: ClipPerf, stale: boolean, ageMs: number): TemplateResult {
    const fpsActual = c.injectAvgMs ? 1000 / c.injectAvgMs : 0;
    const jitter = !stale && (c.injectMaxMs ?? 0) > (c.injectAvgMs ?? 0) * 1.6 ? 'warn' : '';
    return html`
      <div class="card ${stale ? 'stale' : ''}">
        <div class="title">
          <span>${c.label} · ${c.width}×${c.height}</span>
          <span class="badge ${stale ? 'age' : ''}">${stale ? `${(ageMs / 1000).toFixed(0)}s ago` : c.path}</span>
        </div>
        ${this.row('source', `${c.fps.toFixed(2)}fps · ${c.frameCount}f`)}
        ${this.row('presented', `${fpsActual.toFixed(1)}fps`)}
        ${this.row('inject gap', `${(c.injectAvgMs ?? 0).toFixed(0)} / ${(c.injectMaxMs ?? 0).toFixed(0)}ms avg/max`, jitter)}
        ${c.path === 'cursor' ? html`
          ${this.row('actions', `play ${c.play} · seek ${c.seek} · hold ${c.hold}`, !stale && (c.seek ?? 0) > 1 ? 'warn' : '')}
          ${this.row('notReady', `${c.notReady}`, !stale && (c.notReady ?? 0) > 4 ? 'warn' : '')}
          ${this.row('drift', `${(c.driftAvgMs ?? 0).toFixed(0)} / ${(c.driftMaxMs ?? 0).toFixed(0)}ms avg/max`,
            stale ? '' : (c.driftMaxMs ?? 0) > 200 ? 'bad' : (c.driftMaxMs ?? 0) > 60 ? 'warn' : '')}
          ${this.row('seeks', `${c.seeks} · ${(c.seekAvgMs ?? 0).toFixed(0)}ms`)}
          ${this.row('cache', `${c.cacheEntries}f · ${(c.cacheMB ?? 0).toFixed(0)}MB · ${((c.cacheHitRate ?? 0) * 100).toFixed(0)}% hit · ${c.cachePinned} pinned`)}
        ` : ''}
      </div>`;
  }

  /** Summarise the 60s system-timing ring: percentiles of the on-screen frame interval, the
   *  worst frame + its concurrent GPU time (so a spike can be attributed to GPU vs not), and
   *  a jank count. This is the "did the SYSTEM hitch?" view — independent of any one clip. */
  private renderSystem(now: number): TemplateResult {
    const frames = debugPerf.frames;
    if (frames.length < 4) return html`<div class="empty">Gathering frames — start playback.</div>`;
    const gaps = frames.map((f) => f.gapMs).sort((a, b) => a - b);
    const n = gaps.length;
    const avg = gaps.reduce((a, b) => a + b, 0) / n;
    const p50 = pct(gaps, 0.5), p90 = pct(gaps, 0.9), p99 = pct(gaps, 0.99), max = gaps[n - 1];
    const gpus = frames.map((f) => f.gpuMs).sort((a, b) => a - b);
    const gpuP90 = pct(gpus, 0.9), gpuMax = gpus[n - 1];
    const jankMs = Math.max(p50 * 2, 20); // a frame longer than 2× median (or >20ms) is "janky"
    const jank = frames.reduce((c, f) => c + (f.gapMs > jankMs ? 1 : 0), 0);
    const worst = frames.reduce((w, f) => (f.gapMs > w.gapMs ? f : w), frames[0]);
    const fpsNow = frames[frames.length - 1].fps;
    let fpsMin = Infinity; for (const f of frames) if (f.fps > 0 && f.fps < fpsMin) fpsMin = f.fps;
    const spanS = (now - frames[0].t) / 1000;
    // Attribute the worst frame: GPU-bound if its concurrent GPU time was most of the stall.
    const cause = worst.gpuMs > worst.gapMs * 0.5 ? 'GPU-bound'
      : worst.gpuMs > Math.max(8, avg) ? 'GPU + other'
      : 'main / engine / transfer';
    const hitchy = p99 > p50 * 2 || max > jankMs;
    return html`
      <div class="card ${hitchy ? 'warnborder' : ''}">
        ${this.row('frame interval', `avg ${avg.toFixed(1)} · p50 ${p50.toFixed(1)} · p90 ${p90.toFixed(1)}ms`)}
        ${this.row('· tail', `p99 ${p99.toFixed(1)} · max ${max.toFixed(1)}ms`, max > jankMs ? 'bad' : '')}
        ${this.row('janky frames', `${jank} / ${n} (${((jank / n) * 100).toFixed(1)}%) over ${spanS.toFixed(0)}s`,
          jank > 0 ? (jank / n > 0.02 ? 'bad' : 'warn') : '')}
        ${this.row('engine fps', `${fpsNow.toFixed(0)} now · ${Number.isFinite(fpsMin) ? fpsMin.toFixed(0) : '—'} min`,
          Number.isFinite(fpsMin) && fpsMin < fpsNow * 0.7 ? 'warn' : '')}
        ${this.row('gpu time', `p90 ${gpuP90.toFixed(1)} · max ${gpuMax.toFixed(1)}ms`, gpuMax > 12 ? 'warn' : '')}
        ${this.row('worst frame', `${worst.gapMs.toFixed(0)}ms · ${((now - worst.t) / 1000).toFixed(0)}s ago · gpu ${worst.gpuMs.toFixed(1)}ms`,
          max > jankMs ? 'bad' : '')}
        ${max > jankMs ? this.row('→ likely cause', cause, 'warn') : ''}
      </div>`;
  }

  render() {
    void this.tick; // establish tracking so the interval re-renders
    const now = performance.now();
    const m = debugPerf.monitor;
    const monStale = !m || now - debugPerf.monitorAt > ArrDebug.STALE_MS;
    // Most-recently-seen first → active clips on top, recently-ended ones (dashed) below.
    const clips = [...this.history.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    return html`
      <h3>System · last 60s</h3>
      ${this.renderSystem(now)}

      <h3>Output monitor</h3>
      ${m ? html`
        <div class="card ${monStale ? 'stale' : ''}">
          ${this.row('vsync draws', `${m.drawsPerSec.toFixed(0)}/s`)}
          ${this.row('new frames', `${m.newFramesPerSec.toFixed(0)}/s`)}
          ${this.row('composite gap', `${m.gapAvgMs.toFixed(1)} / ${m.gapMaxMs.toFixed(1)}ms avg/max`,
            !monStale && m.gapMaxMs > m.gapAvgMs * 2 ? 'warn' : '')}
        </div>
      ` : html`<div class="empty">No composite yet — start playback.</div>`}

      <h3>Video clips</h3>
      ${clips.length
        ? clips.map((e) => this.clipCard(e.perf, now - e.lastSeen > ArrDebug.STALE_MS, now - e.lastSeen))
        : html`<div class="empty">No video clips played yet.</div>`}

      <div class="note">Collected only while this tab is open · ended clips kept ~60s (dashed).</div>
    `;
  }
}
