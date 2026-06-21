/**
 * <sketch-app> — Root application shell.
 * Tab bar + content area.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { computeHeadroom, TARGET_FPS_OPTIONS } from './gpu-headroom';

import './create-tab';
import './organize-tab';
import './edit-tab';

@customElement('sketch-app')
export class SketchApp extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
    }
    .tab-bar {
      display: flex;
      align-items: center;
      background: var(--app-bg-color2);
      border-bottom: 1px solid var(--app-tint-3);
      padding: 0 12px;
      height: 36px;
      flex-shrink: 0;
      gap: var(--app-sp-1);
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--app-text-color2);
      font-family: inherit;
      font-size: var(--app-fs-md);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 8px 16px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover { color: var(--app-text-color1); }
    .tab-btn[active] {
      color: var(--app-text-color1);
      border-bottom-color: var(--app-hi-color2);
    }
    .tab-status {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--app-sp-4);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .tab-status .metric {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .tab-status .err {
      color: var(--app-error);
    }
    /* GPU headroom colour ramp: comfortable / tight / over budget. */
    .tab-status .headroom.ok { color: var(--app-ok); }
    .tab-status .headroom.tight { color: var(--app-warn); }
    .tab-status .headroom.over { color: var(--app-error); }
    .tab-status .target {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-5);
      border-radius: 1px;
      padding: 1px 2px;
      cursor: pointer;
    }
    .app-content {
      display: flex;
      flex: 1;
      min-height: 0;
    }
  `;

  render() {
    // Barrel mode: the editor is bound to a remote NanoBarrel sketch.
    // Lock to the edit tab and hide the Create / Organize tabs entirely
    // — there is only one sketch to edit, and it lives in the FFGL
    // plugin instance, not in IndexedDB.
    const barrelMode = appState.local.barrelMode;
    const tab = barrelMode ? 'edit' : appState.local.activeTab;
    return html`
      <div class="tab-bar">
        ${barrelMode ? '' : html`
          <button class="tab-btn" ?active=${tab === 'create'}
            @click=${() => appController.setActiveTab('create')}>Create</button>
          <button class="tab-btn" ?active=${tab === 'organize'}
            @click=${() => appController.setActiveTab('organize')}>Organize</button>
        `}
        <button class="tab-btn" ?active=${tab === 'edit'}
          @click=${() => appController.setActiveTab('edit')}>Edit</button>
        <div class="tab-status">
          ${this.renderStatus(barrelMode)}
        </div>
      </div>
      <div class="app-content">
        ${!barrelMode && tab === 'create' ? html`<create-tab></create-tab>` : ''}
        ${!barrelMode && tab === 'organize' ? html`<organize-tab></organize-tab>` : ''}
        ${tab === 'edit' ? html`<edit-tab></edit-tab>` : ''}
      </div>
    `;
  }

  /** FPS + (outside barrel mode) GPU headroom readout and target-fps picker.
   *  Barrel mode renders frames from the native plugin, not the local WebGPU
   *  loop, so there's no fence proxy to measure — show FPS only there. */
  private renderStatus(barrelMode: boolean) {
    const engine = appState.local.engine;
    if (engine.error) {
      return html`<span class="err">Error: ${engine.error}</span>`;
    }
    const fps = engine.fps;
    if (barrelMode) {
      return fps > 0 ? html`<span class="metric">${fps} FPS</span>` : '';
    }
    const targetFps = appState.local.userSettings.targetFps;
    const h = computeHeadroom(engine.gpuTimeMs, targetFps);
    return html`
      ${fps > 0 ? html`<span class="metric">${fps} FPS</span>` : ''}
      ${h.measured
        ? html`<span
            class="metric headroom ${h.level}"
            title="Est. GPU ${h.gpuMs.toFixed(1)} ms of ${h.budgetMs.toFixed(1)} ms budget (${targetFps} FPS) — ${h.headroomPct}% headroom"
            >GPU ${h.gpuMs.toFixed(1)}ms · ${h.headroomPct}% free</span
          >`
        : html`<span class="metric" title="No GPU timing yet">GPU —</span>`}
      <select
        class="target"
        title="Target framerate (the GPU headroom budget)"
        .value=${String(targetFps)}
        @change=${this.onTargetChange}>
        ${TARGET_FPS_OPTIONS.map(
          (t) => html`<option value=${t} ?selected=${t === targetFps}>${t}↑</option>`,
        )}
      </select>
    `;
  }

  private onTargetChange = (e: Event) => {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isNaN(v)) appController.setUserSetting('targetFps', v);
  };
}
