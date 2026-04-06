/**
 * <sketch-app> — Root application shell.
 * Tab bar + content area.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';

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
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 0 12px;
      height: 36px;
      flex-shrink: 0;
      gap: 2px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--app-text-color2);
      font-family: inherit;
      font-size: 11px;
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
      font-size: 10px;
      color: var(--app-text-color2);
    }
    .app-content {
      display: flex;
      flex: 1;
      min-height: 0;
    }
  `;

  render() {
    const tab = appState.local.activeTab;
    return html`
      <div class="tab-bar">
        <button class="tab-btn" ?active=${tab === 'create'}
          @click=${() => appController.setActiveTab('create')}>Create</button>
        <button class="tab-btn" ?active=${tab === 'organize'}
          @click=${() => appController.setActiveTab('organize')}>Organize</button>
        <button class="tab-btn" ?active=${tab === 'edit'}
          @click=${() => appController.setActiveTab('edit')}>Edit</button>
        <div class="tab-status">
          ${appState.local.engine.error
            ? `Error: ${appState.local.engine.error}`
            : appState.local.engine.fps > 0
              ? `${appState.local.engine.fps} FPS`
              : ''}
        </div>
      </div>
      <div class="app-content">
        ${tab === 'create' ? html`<create-tab></create-tab>` : ''}
        ${tab === 'organize' ? html`<organize-tab></organize-tab>` : ''}
        ${tab === 'edit' ? html`<edit-tab></edit-tab>` : ''}
      </div>
    `;
  }
}
