/**
 * <organize-tab> — List sketches, select, view summary, launch editor.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';

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
      padding: 16px;
      min-width: 0;
      width: 0;
    }
    .right-panel {
      width: 340px;
      min-width: 260px;
      background: var(--app-bg-color2);
      border-left: 1px solid rgba(255,255,255,0.08);
      padding: 12px;
    }
    .sketch-list { display: flex; flex-direction: column; gap: 4px; }
    .sketch-card {
      padding: 10px 12px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      cursor: pointer;
    }
    .sketch-card:hover { border-color: rgba(255,255,255,0.15); }
    .sketch-card[selected] {
      border-color: var(--app-hi-color2);
      background: rgba(65,105,225,0.08);
    }
    .sketch-card-name { font-size: 12px; color: var(--app-text-color1); }
    .sketch-card-info { font-size: 10px; color: var(--app-text-color2); margin-top: 2px; }
    .section-header {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .summary { font-size: 11px; color: var(--app-text-color2); margin-bottom: 12px; }
    .summary div { margin-bottom: 2px; }
    .btn {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--app-text-color1);
      font-size: 10px; padding: 6px;
      border-radius: 3px; cursor: pointer;
      font-family: inherit; width: 100%; text-align: center;
    }
    .btn:hover { background: rgba(255,255,255,0.15); }
    .empty-state { color: var(--app-text-color2); font-size: 12px; text-align: center; padding: 32px 16px; }
  `;

  render() {
    const sketches = appState.database.sketches;
    const ids = Object.keys(sketches);
    const selectedId = appState.local.selectedSketchId;
    const selected = selectedId ? sketches[selectedId] : null;

    return html`
      <div class="main-area">
        ${ids.length === 0
        ? html`<div class="empty-state">No sketches yet.<br>Go to Create to make one.</div>`
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
                      · ${s.columns.length} column${s.columns.length !== 1 ? 's' : ''}
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
              <div>Columns: ${selected.columns.length}</div>
              <div>Chain entries: ${selected.columns.reduce((s, c) => s + c.chain.length, 0)}</div>
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
}
