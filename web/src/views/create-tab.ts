/**
 * <create-tab> — Browse composition, stage instances, create sketches.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { PluginInfo } from '../state/types';

function shortName(id: string) { return id.split('.').pop() ?? id; }

function moduleKind(p: PluginInfo): string {
  const texIn = p.io.filter(io => io.kind === 0).length;
  const texOut = p.io.filter(io => io.kind === 1).length;
  if (texIn === 0 && texOut > 0) return 'generator';
  if (texIn === 1 && texOut > 0) return 'effect';
  if (texIn >= 2 && texOut > 0) return 'mixer';
  return 'control';
}

@customElement('create-tab')
export class CreateTab extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .main-area {
      flex: 1;
      overflow-y: auto;
      padding: var(--app-sp-6);
      min-width: 0;
      width: 0;
    }
    .right-panel {
      width: 340px;
      min-width: 260px;
      background: var(--app-bg-color2);
      border-left: 1px solid var(--app-tint-3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: var(--app-sp-5);
    }
    .plugin-list { display: flex; flex-direction: column; gap: var(--app-sp-2); }
    .plugin-card {
      display: flex; align-items: center; gap: var(--app-sp-4);
      padding: 8px 12px;
      background: var(--app-tint-1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
    }
    .plugin-card-info { flex: 1; min-width: 0; }
    .plugin-card-name { font-size: var(--app-fs-lg); color: var(--app-text-color1); }
    .plugin-card-key { font-size: var(--app-fs-sm); color: var(--app-text-color2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .section-header {
      font-size: var(--app-fs-sm); text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .staging-list { display: flex; flex-direction: column; gap: var(--app-sp-2); margin-bottom: 12px; }
    .instance-row {
      display: flex; align-items: center; gap: var(--app-sp-3);
      padding: 6px 8px;
      background: var(--app-tint-1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      font-size: var(--app-fs-md);
    }
    .instance-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty-state { color: var(--app-text-color2); font-size: var(--app-fs-lg); text-align: center; padding: 32px 16px; }
    .btn {
      background: var(--app-tint-3);
      border: 1px solid var(--app-tint-4);
      color: var(--app-text-color1);
      font-size: var(--app-fs-sm); padding: 2px 8px;
      border-radius: 1px; cursor: pointer;
      font-family: inherit; flex-shrink: 0;
    }
    .btn:hover { background: var(--app-tint-5); }
    .btn-full { width: 100%; padding: var(--app-sp-3); text-align: center; }
    .toggle-btn {
      background: var(--app-tint-2);
      border: 1px solid var(--app-tint-4);
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs); padding: 2px 6px;
      border-radius: 1px; cursor: pointer;
      font-family: inherit; text-transform: uppercase;
    }
    .toggle-btn[active] {
      background: var(--app-hi-color2);
      border-color: var(--app-hi-color2);
      color: #fff;
    }
    .remove-btn {
      background: none; border: none;
      color: var(--app-text-color2); cursor: pointer;
      font-size: var(--app-fs-xl); padding: 0 4px; line-height: 1;
    }
    .remove-btn:hover { color: var(--app-hi-color1); }
  `;

  render() {
    const plugins = appState.local.plugins;
    const staging = appState.local.staging;

    return html`
      <div class="main-area">
        ${plugins.length === 0
        ? html`<div class="empty-state">No modules loaded.<br>Loading...</div>`
        : html`
            <div class="plugin-list">
              ${plugins.map((p, i) => html`
                <div class="plugin-card">
                  <div class="plugin-card-info">
                    <div class="plugin-card-name">${shortName(p.id)}</div>
                    <div class="plugin-card-key">${p.key} · ${moduleKind(p)} · ${p.params.length} params</div>
                  </div>
                  <button class="btn" @click=${() => appController.addToStaging(p)}>Add</button>
                </div>
              `)}
            </div>
          `}
      </div>
      <div class="right-panel">
        <div class="section-header">New Sketch</div>
        ${staging.length === 0
        ? html`<div class="empty-state" style="padding:16px 0">Add instances from the left panel</div>`
        : html`
            <div class="staging-list">
              ${staging.map((s, i) => html`
                <div class="instance-row">
                  <span class="instance-row-name">${s.name}</span>
                  <button class="toggle-btn" ?active=${s.textureIn}
                    @click=${() => appController.toggleStagingIn(i)}>In</button>
                  <button class="toggle-btn" ?active=${s.textureOut}
                    @click=${() => appController.toggleStagingOut(i)}>Out</button>
                  <button class="remove-btn" @click=${() => appController.removeFromStaging(i)}>×</button>
                </div>
              `)}
            </div>
            <button class="btn btn-full" @click=${this.onCreateSketch}>Create Sketch</button>
          `}
      </div>
    `;
  }

  private onCreateSketch() {
    const sketchId = appController.createSketch([...appState.local.staging]);
    appController.clearStaging();
    appController.selectSketch(sketchId);
    appController.setActiveTab('organize');
  }
}
