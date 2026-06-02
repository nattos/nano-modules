/**
 * <ide-debug-info> — Debug Info sidebar tab.
 *
 * Two sections:
 *   - "Frame Stats" — live per-frame counters from the executor:
 *     effects executed, dispatches issued, fused runs, dispatches
 *     saved by fusion, and dispatches skipped because an effect was a
 *     pure passthrough (identity). Highlights the win the coalescing +
 *     identity-skip optimizations produce in the current scene.
 *   - "Console" — recent console-log entries from any WASM effect.
 *     Reversed (newest at top); auto-trimmed to 500 entries.
 *
 * Mounting this tab toggles `engine.setDebugMode(true)` (via the
 * controller's setUserSetting hook). Closing the tab toggles it off
 * — the worker stops broadcasting and the UI buffer is cleared.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';

@customElement('ide-debug-info')
export class IdeDebugInfo extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .section {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--app-text-color2);
      padding: 12px 12px 6px;
      flex-shrink: 0;
    }
    .stats {
      padding: 0 12px 8px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px 12px;
      font-size: 11px;
      color: var(--app-text-color1);
      flex-shrink: 0;
    }
    .stats .label {
      color: var(--app-text-color2);
    }
    .stats .value {
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .stats .saved-row .value {
      color: var(--app-hi-color2);
    }
    .console {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 0 16px;
      border-top: 1px solid rgba(255,255,255,0.08);
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      font-size: 11px;
      line-height: 1.4;
    }
    .empty {
      padding: 16px 12px;
      color: var(--app-text-color2);
      font-size: 11px;
      font-style: italic;
    }
    .log-row {
      padding: 2px 12px;
      display: flex;
      gap: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .log-row[level="warn"] { color: #e0c060; }
    .log-row[level="error"] { color: #e07060; }
    .log-time {
      color: var(--app-text-color2);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .log-source {
      color: var(--app-text-color2);
      flex-shrink: 0;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .log-msg {
      flex: 1;
      word-break: break-word;
    }
    .clear-btn {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.16);
      color: var(--app-text-color2);
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 2px;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .clear-btn:hover {
      color: var(--app-text-color1);
      border-color: rgba(255,255,255,0.32);
    }
  `;

  render() {
    const engine = appState.local.engine;
    const stats = engine.debugStats;
    const log = engine.debugConsoleLog;
    return html`
      <div class="section-header">Frame Stats</div>
      <div class="stats">
        <span class="label">FPS</span>
        <span class="value">${engine.fps}</span>
        <span class="label">Effects executed</span>
        <span class="value">${stats?.effectsExecuted ?? '–'}</span>
        <span class="label">GPU dispatches</span>
        <span class="value">${stats?.gpuDispatches ?? '–'}</span>
        <span class="label">Standalone dispatches</span>
        <span class="value">${stats?.standaloneDispatches ?? '–'}</span>
        <span class="label">Fused runs</span>
        <span class="value">${stats?.fusedRuns ?? '–'}</span>
        <span class="label">Stages in fused runs</span>
        <span class="value">${stats?.fusedStages ?? '–'}</span>
        <span class="label saved-row">Dispatches saved by fusion</span>
        <span class="value saved-row">${stats?.dispatchesSaved ?? '–'}</span>
        <span class="label saved-row">Dispatches skipped (identity)</span>
        <span class="value saved-row">${stats?.identitySkipped ?? '–'}</span>
      </div>

      <div class="section-header">
        Console (${log.length})
        ${log.length > 0
          ? html`<button class="clear-btn" @click=${this.onClear}>Clear</button>`
          : nothing}
      </div>
      <div class="console">
        ${log.length === 0
          ? html`<div class="empty">No console output yet. Effects can call <code>state::log()</code> to write here.</div>`
          : log.slice().reverse().map(entry => html`
              <div class="log-row" level=${entry.level}>
                <span class="log-time">${entry.timestamp.toFixed(2)}</span>
                <span class="log-source" title=${entry.moduleId}>${entry.moduleId}</span>
                <span class="log-msg">${entry.message}</span>
              </div>
            `)}
      </div>
    `;
  }

  private onClear = () => {
    appController.clearDebugConsoleLog();
  };
}
