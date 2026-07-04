/**
 * <organize-tab> — List sketches, select, view summary, launch editor.
 */

import { html, css, nothing } from 'lit';
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
    .empty-state { color: var(--app-text-color2); font-size: var(--app-fs-lg); text-align: center; padding: 32px 16px; }
  `;

  render() {
    if (appState.local.barrelMode) return this.renderBarrelInstances();

    const sketches = appState.database.sketches;
    const ids = Object.keys(sketches);
    const selectedId = appState.local.selectedSketchId;
    const selected = selectedId ? sketches[selectedId] : null;

    return html`
      <div class="main-area">
        ${ids.length === 0
        ? html`<div class="empty-state">No sketches yet.</div>`
        : html`
            <div class="sketch-list">
              ${ids.map(id => {
          const s = sketches[id];
          return html`
                  <div class="sketch-card" ?selected=${id === selectedId}
                    @click=${() => appController.selectSketch(id)}>
                    <div class="sketch-card-name">${id}</div>
                    <div class="sketch-card-info">
                      Anchor: ${s.anchor ?? 'none'}
                      · ${sketchChain(s).length} entr${sketchChain(s).length !== 1 ? 'ies' : 'y'}
                    </div>
                  </div>
                `;
        })}
            </div>
          `}
      </div>
      <div class="right-panel">
        ${selected && selectedId
        ? html`
            <div class="section-header">Sketch: ${selectedId}</div>
            <div class="summary">
              <div>Anchor: ${selected.anchor ?? 'none'}</div>
              <div>Chain entries: ${sketchChain(selected).length}</div>
            </div>
            <button class="btn" @click=${() => {
            appController.editSketch(selectedId);
            appController.setActiveTab('edit');
          }}>Edit</button>
          `
        : html`<div class="empty-state" style="padding:16px 0">Select a sketch to see details</div>`}
      </div>
    `;
  }

  /** Barrel mode: list the live NanoBarrel instances on the shared server. */
  private renderBarrelInstances() {
    const instances = appState.local.barrelInstances;
    const selectedKey = appState.local.selectedBarrelKey;
    const selected = instances.find(i => i.key === selectedKey) ?? null;

    const open = (key: string) => {
      appController.selectBarrelInstance(key);
      appController.setActiveTab('edit');
    };

    return html`
      <div class="main-area">
        ${instances.length === 0
        ? html`<div class="empty-state">No NanoBarrel instances connected.<br>Add a NanoBarrel effect in Resolume.</div>`
        : html`
            <div class="sketch-list">
              ${instances.map(inst => html`
                <div class="sketch-card" ?selected=${inst.key === selectedKey}
                  @click=${() => appController.selectBarrelInstance(inst.key)}
                  @dblclick=${() => open(inst.key)}>
                  <div class="sketch-card-name">${inst.label}</div>
                  <div class="sketch-card-info">${inst.key}</div>
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
              <div>Plugin: ${selected.id}</div>
            </div>
            <button class="btn" @click=${() => open(selected.key)}>Edit</button>
          `
        : html`<div class="empty-state" style="padding:16px 0">Select an instance to edit</div>`}
      </div>
    `;
  }
}
