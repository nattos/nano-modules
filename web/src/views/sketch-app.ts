/**
 * <sketch-app> — Root application shell for Resolume Playground/Live.
 *
 * Builds a `ShellConfig` (see `widgets/app-shell.ts`) and renders the shared
 * `<app-shell>` — the vertical tab bar, left-panel/splitter/monitor layout is
 * common chrome shared with the Effect IDE shell (`views/effect-ide/effect-ide-app.ts`).
 * "Instances" and "Edit" (formerly a horizontal `.tab-bar`) now live in the
 * shared vertical tab bar; "Edit" renders the same `<sketch-column-editor>`
 * the Effect IDE uses for its own Project Editor tab.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { computeHeadroom, fixedNum, TARGET_FPS_OPTIONS } from './gpu-headroom';
import type { ShellConfig } from '../widgets/app-shell';

import '../widgets/app-shell';
import '../widgets/sketch-column-editor';
import '../widgets/sketch-monitor';
import '../widgets/snackbars';
import './organize-tab';
import './app-settings';
import './reconcile-dialog';

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
    .status-strip {
      display: flex;
      align-items: center;
      gap: var(--app-sp-4);
      padding: 6px 16px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      border-top: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
    }
    .status-strip .metric {
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .status-strip .err {
      color: var(--app-error);
    }
    /* GPU headroom colour ramp: comfortable / tight / over budget. */
    .status-strip .headroom.ok { color: var(--app-ok); }
    .status-strip .headroom.tight { color: var(--app-warn); }
    .status-strip .headroom.over { color: var(--app-error); }
    .status-strip .target {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-5);
      border-radius: 1px;
      padding: 1px 2px;
      cursor: pointer;
    }
  `;

  render() {
    const barrelMode = appState.local.barrelMode;
    const sketchId = appState.local.editingSketchId;
    const traceTarget = appState.local.selection?.traceTarget
      ?? ({ type: 'sketch_output', sketchId } as any);

    const config: ShellConfig = {
      tabs: [
        { id: 'organize', icon: 'la-th-large', title: 'Instances', kind: 'full-takeover', render: () => html`<organize-tab></organize-tab>` },
        {
          id: 'edit', icon: 'la-stream', title: 'Edit', kind: 'inline', render: () => html`
          <sketch-column-editor
            .sketchId=${sketchId}
            emptyMessage="No sketch selected for editing. Go to Instances and pick one."
          ></sketch-column-editor>
        `,
        },
        { id: 'settings', icon: 'la-cog', title: 'Settings', kind: 'full-takeover', align: 'bottom', render: () => html`<app-settings></app-settings>` },
      ],
      activeTabSettingKey: 'activeTab',
      panelWidthSettingKey: 'editLeftPanelWidth',
      onSelectTab: (id) => appController.setActiveTab(id as 'organize' | 'edit' | 'settings'),
      renderMonitor: () => html`
        <sketch-monitor
          .sketchId=${sketchId}
          traceId="edit_preview"
          .traceTarget=${traceTarget}
          emptyMessage="No sketch selected for editing."
        ></sketch-monitor>
      `,
      renderStatus: () => this.renderStatusMetrics(barrelMode),
    };

    return html`
      <app-shell .config=${config}></app-shell>
      <snackbar-host></snackbar-host>
      <reconcile-dialog></reconcile-dialog>
    `;
  }

  /** FPS + (outside barrel mode) GPU headroom readout and target-fps picker.
   *  Barrel mode renders frames from the native plugin, not the local WebGPU
   *  loop, so there's no fence proxy to measure — show FPS only there. */
  private renderStatusMetrics(barrelMode: boolean) {
    const engine = appState.local.engine;
    if (engine.error) {
      return html`<div class="status-strip"><span class="err">Error: ${engine.error}</span></div>`;
    }
    const fps = engine.fps;
    if (barrelMode) {
      return html`<div class="status-strip">${fps > 0 ? html`<span class="metric">${fixedNum(fps, 3)} FPS</span>` : ''}</div>`;
    }
    const targetFps = appState.local.userSettings.targetFps;
    const h = computeHeadroom(engine.gpuTimeMs, targetFps);
    return html`
      <div class="status-strip">
        ${fps > 0 ? html`<span class="metric">${fixedNum(fps, 3)} FPS</span>` : ''}
        ${h.measured
          ? html`<span
              class="metric headroom ${h.level}"
              title="Est. GPU ${h.gpuMs.toFixed(1)} ms of ${h.budgetMs.toFixed(1)} ms budget (${targetFps} FPS) — ${h.headroomPct}% headroom"
              >GPU ${fixedNum(h.gpuMs.toFixed(1), 4)}ms · ${fixedNum(h.headroomPct, 3)}% free</span
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
      </div>
    `;
  }

  private onTargetChange = (e: Event) => {
    const v = parseInt((e.target as HTMLSelectElement).value, 10);
    if (!Number.isNaN(v)) appController.setUserSetting('targetFps', v);
  };
}
