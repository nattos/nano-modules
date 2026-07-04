/**
 * <organize-tab> — the "Instances" tab: list instances, select, open in Edit.
 *
 * One code path for both modes: barrel mode lists the live NanoBarrel plugin
 * instances from the shared server; the playground lists its fake local
 * instances (each one sketch, all running in the worker) and adds create /
 * delete affordances.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { sketchChain } from '../sketch-types';

@customElement('organize-tab')
export class OrganizeTab extends MobxLitElement {
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
      padding: var(--app-sp-5);
    }
    .sketch-list { display: flex; flex-direction: column; gap: var(--app-sp-2); }
    .sketch-card {
      padding: 10px 12px;
      background: var(--app-tint-1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      cursor: pointer;
    }
    .sketch-card:hover { border-color: var(--app-tint-5); }
    .sketch-card[selected] {
      border-color: var(--app-hi-color2);
      background: rgba(65,105,225,0.08);
    }
    .sketch-card-name { font-size: var(--app-fs-lg); color: var(--app-text-color1); }
    .sketch-card-info { font-size: var(--app-fs-sm); color: var(--app-text-color2); margin-top: 2px; }
    .section-header {
      font-size: var(--app-fs-sm); text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .summary { font-size: var(--app-fs-md); color: var(--app-text-color2); margin-bottom: 12px; }
    .summary div { margin-bottom: 2px; }
    .btn {
      background: var(--app-tint-3);
      border: 1px solid var(--app-tint-4);
      color: var(--app-text-color1);
      font-size: var(--app-fs-sm); padding: var(--app-sp-3);
      border-radius: 1px; cursor: pointer;
      font-family: inherit; width: 100%; text-align: center;
    }
    .btn:hover { background: var(--app-tint-5); }
    .btn.danger { color: var(--app-error); border-color: var(--app-error); background: transparent; }
    .btn.danger:hover { background: rgba(255,80,80,0.10); }
    .btn + .btn { margin-top: var(--app-sp-2); }
    .new-instance { margin-bottom: var(--app-sp-4); width: auto; padding: var(--app-sp-3) 16px; }
    .empty-state { color: var(--app-text-color2); font-size: var(--app-fs-lg); text-align: center; padding: 32px 16px; }
  `;

  render() {
    const barrelMode = appState.local.barrelMode;
    const instances = appState.local.barrelInstances;
    const selectedKey = appState.local.selectedBarrelKey;
    const selected = instances.find(i => i.key === selectedKey) ?? null;

    const open = (key: string) => {
      appController.selectBarrelInstance(key);
      appController.setActiveTab('edit');
    };

    return html`
      <div class="main-area">
        ${barrelMode ? '' : html`
          <button class="btn new-instance"
            @click=${() => appController.createPlaygroundInstance()}>+ New instance</button>
        `}
        ${instances.length === 0
        ? (barrelMode
          ? html`<div class="empty-state">No NanoBarrel instances connected.<br>Add a NanoBarrel effect in Resolume.</div>`
          : html`<div class="empty-state">No playground instances yet.<br>Each instance stands in for one NanoBarrel effect in Resolume.</div>`)
        : html`
            <div class="sketch-list">
              ${instances.map(inst => html`
                <div class="sketch-card" ?selected=${inst.key === selectedKey}
                  @click=${() => appController.selectBarrelInstance(inst.key)}
                  @dblclick=${() => open(inst.key)}>
                  <div class="sketch-card-name">${inst.label}</div>
                  <div class="sketch-card-info">${this.instanceInfo(inst.key, barrelMode)}</div>
                </div>
              `)}
            </div>
          `}
      </div>
      <div class="right-panel">
        ${selected
        ? html`
            <div class="section-header">Instance: ${selected.label}</div>
            <div class="summary">
              <div>Key: ${selected.key}</div>
              ${barrelMode
                ? html`<div>Plugin: ${selected.id}</div>`
                : html`<div>${this.instanceInfo(selected.key, false)}</div>`}
            </div>
            <button class="btn" @click=${() => open(selected.key)}>Edit</button>
            ${barrelMode ? '' : html`
              <button class="btn danger" @click=${() => this.deleteInstance(selected.key, selected.label)}>Delete</button>
            `}
          `
        : html`<div class="empty-state" style="padding:16px 0">Select an instance to edit</div>`}
      </div>
    `;
  }

  /** Card info line: playground cards summarize their sketch; barrel cards
   *  show the instance key (the sketch lives on the server). */
  private instanceInfo(key: string, barrelMode: boolean) {
    if (barrelMode) return key;
    const sketch = appState.database.sketches[key];
    const n = sketch ? sketchChain(sketch).length : 0;
    return `${n} effect${n !== 1 ? 's' : ''}`;
  }

  private deleteInstance(key: string, label: string) {
    if (!confirm(`Delete playground instance "${label}"? (Undo restores it.)`)) return;
    appController.deletePlaygroundInstanceById(key);
  }
}
