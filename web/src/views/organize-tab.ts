/**
 * <organize-tab> — the "Instances" tab: a flow grid of instance cards with
 * live output thumbnails; select, open in Edit.
 *
 * One code path for both modes: barrel mode lists the live NanoBarrel plugin
 * instances from the shared server; the playground lists its fake local
 * instances (each one sketch, all running in the worker) and adds create /
 * delete affordances.
 *
 * Every instance renders constantly (playground: all `pg:` sketches run in
 * the worker; barrel: Resolume renders each plugin), so each card carries a
 * live `sketch_output` thumbnail via `<texture-monitor>`. The trace id embeds
 * the instance key (`instanceThumbTraceId`) — in barrel mode that's what
 * routes the request to the instance's own /preview_requests and its NBPV
 * frames back past the selected-instance filter. Cards register only while
 * on-screen (texture-monitor's IntersectionObserver) and the whole tab
 * unmounts on tab switch, so thumbnails cost nothing while editing.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { sketchChain } from '../sketch-types';
import { instanceThumbTraceId } from '../resolume-mode';
import '../widgets/texture-monitor';

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
    .instance-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: var(--app-sp-4);
    }
    .instance-card {
      background: var(--app-tint-1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      cursor: pointer;
      overflow: hidden;
    }
    .instance-card:hover { border-color: var(--app-tint-5); }
    .instance-card[selected] {
      border-color: var(--app-hi-color2);
      background: rgba(65,105,225,0.08);
    }
    .thumb {
      aspect-ratio: 16 / 9;
      background: #000;
    }
    .card-meta { padding: 8px 12px 10px; }
    .card-name { font-size: var(--app-fs-lg); color: var(--app-text-color1); }
    .card-info { font-size: var(--app-fs-sm); color: var(--app-text-color2); margin-top: 2px; }
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
            <div class="instance-grid">
              ${instances.map(inst => html`
                <div class="instance-card" ?selected=${inst.key === selectedKey}
                  @click=${() => appController.selectBarrelInstance(inst.key)}
                  @dblclick=${() => open(inst.key)}>
                  <div class="thumb">
                    <texture-monitor
                      fit
                      thumbnail
                      .traceId=${instanceThumbTraceId(inst.key)}
                      .traceTarget=${{ type: 'sketch_output', sketchId: inst.key } as any}
                      resolution="low"
                    ></texture-monitor>
                  </div>
                  <div class="card-meta">
                    <div class="card-name">${inst.label}</div>
                    <div class="card-info">${this.instanceInfo(inst.key, barrelMode)}</div>
                  </div>
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
