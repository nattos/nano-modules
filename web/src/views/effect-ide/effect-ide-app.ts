/**
 * <effect-ide-app> — Root shell of the Effect IDE page.
 *
 * Layout:
 *   ┌──┬──────────────┬─┬───────────────────────────┐
 *   │ic│ left tab     │s│  monitor + transport       │
 *   │on│ content      │p│                            │
 *   │  │              │l│                            │
 *   └──┴──────────────┴─┴───────────────────────────┘
 *      (icon bar)      (splitter — drag to resize)
 *
 * Phase 3 ships the structural shell with placeholder tab content. The
 * Explorer (Phase 4) and Project Editor (Phase 5) replace those placeholders
 * later.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';

import './ide-icon-bar';
import './ide-explorer';
import './ide-project-editor';
import './ide-debug-info';
import './ide-monitor';
import '../../widgets/splitter';

@customElement('effect-ide-app')
export class EffectIdeApp extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
    }
    .left-panel {
      background: var(--app-bg-color2);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .right-panel {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .placeholder {
      padding: 16px;
      font-size: 11px;
      color: var(--app-text-color2);
      line-height: 1.6;
    }
    .placeholder code {
      background: var(--app-bg-color1);
      padding: 1px 6px;
      border-radius: 3px;
    }
    .status-strip {
      padding: 6px 16px;
      font-size: 10px;
      color: var(--app-text-color2);
      border-top: 1px solid rgba(255,255,255,0.08);
      background: var(--app-bg-color2);
    }
  `;

  render() {
    const settings = appState.local.userSettings;
    const leftWidth = settings.ideLeftPanelWidth;
    const tab = settings.ideLeftTab;
    const fps = appState.local.engine.fps;
    const error = appState.local.engine.error;
    const effectCount = appState.local.availableEffects.length;
    return html`
      <ide-icon-bar></ide-icon-bar>
      <div class="left-panel" style="width: ${leftWidth}px">
        ${tab === 'explorer'
          ? html`<ide-explorer></ide-explorer>`
          : nothing}
        ${tab === 'project_editor'
          ? html`<ide-project-editor></ide-project-editor>`
          : nothing}
        ${tab === 'debug_info'
          ? html`<ide-debug-info></ide-debug-info>`
          : nothing}
      </div>
      <ide-splitter
        .width=${leftWidth}
        @resize=${this.onResize}
      ></ide-splitter>
      <div class="right-panel">
        <ide-monitor></ide-monitor>
        <div class="status-strip">
          ${error ? `Error: ${error}` : `${effectCount} effect${effectCount === 1 ? '' : 's'} discovered · ${fps} FPS`}
        </div>
      </div>
    `;
  }

  private onResize = (e: CustomEvent<{ width: number }>) => {
    appController.setUserSetting('ideLeftPanelWidth', e.detail.width);
  };
}
