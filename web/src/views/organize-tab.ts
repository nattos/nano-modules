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
import { instanceThumbTraceId, sidechannelThumbTraceId } from '../resolume-mode';
import {
  sidechannelDefaultLabel, sidechannelDisplayLabel, sidechannelWriterLabel,
} from '../state/sidechannel-labels';
import { instanceDefaultLabel, instanceDisplayLabel } from '../state/instance-labels';
import { buildInstanceRows } from '../state/instance-rows';
import type { BarrelInstanceInfo } from '../state/types';
import '../widgets/texture-monitor';
import '../widgets/editable-text';

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
    /* Composition-shaped layout: a vertical stack of rows (one per group /
       track, then Main), each a horizontal wrap of cards. */
    .inst-rows { display: flex; flex-direction: column; gap: var(--app-sp-6); }
    .inst-row-head {
      font-size: var(--app-fs-sm); text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .inst-row-cards { display: flex; flex-wrap: wrap; gap: var(--app-sp-4); align-items: flex-start; }
    .inst-row-cards .instance-card { flex: 0 0 200px; width: 200px; }
    /* Separates a group/track's own effects (leading) from its clips. */
    .row-divider {
      flex: 0 0 auto; align-self: stretch; width: 1px;
      background: var(--app-tint-4); margin: 0 var(--app-sp-2);
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
    /* A composition-resident instance Resolume hasn't launched yet: read-only,
       no live thumbnail (black), dimmed like an idle trigger-channel clip. */
    .instance-card.unlaunched { opacity: 0.55; }
    .instance-card.unlaunched:hover { opacity: 0.8; }
    .unlaunched-badge {
      display: inline-block; font-size: var(--app-fs-sm); color: var(--app-text-color2);
      border: 1px solid var(--app-tint-4); border-radius: 1px;
      padding: 0 5px; margin-top: 2px;
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
    .sc-section { margin-top: var(--app-sp-6); }
    .sc-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: var(--app-sp-3);
    }
    .sc-card {
      background: var(--app-tint-1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      cursor: pointer;
      overflow: hidden;
    }
    .sc-card:hover { border-color: var(--app-tint-5); }
    .sc-card[selected] {
      border-color: var(--app-hi-color2);
      background: rgba(65,105,225,0.08);
    }
    .sc-card .card-meta { padding: 8px 12px 10px; }
    .sc-card-name {
      font-size: var(--app-fs-md); color: var(--app-text-color1);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sc-card-info { font-size: var(--app-fs-sm); color: var(--app-text-color2); margin-top: 2px; }
    .name-row { display: flex; flex-direction: column; gap: var(--app-sp-2); margin-bottom: 12px; }
    .name-row label { font-size: var(--app-fs-sm); color: var(--app-text-color2); }
    .name-row editable-text { font-size: var(--app-fs-md); }
    .name-hint { font-size: var(--app-fs-sm); color: var(--app-text-color2); }
    .trig-card .card-meta { padding: 10px 12px; }
    .trig-dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: var(--app-tint-4); margin-right: 6px; vertical-align: middle;
    }
    .trig-dot.on { background: var(--app-hi-color2); box-shadow: 0 0 6px var(--app-hi-color2); }
    /* Trigger Channels grid: 8 channel columns that wrap to the next row; each
       column is a vertical stack of its registered clips. */
    .chan-grid {
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      gap: var(--app-sp-3);
    }
    .chan-col { display: flex; flex-direction: column; gap: var(--app-sp-2); min-width: 0; }
    .chan-col-head {
      font-size: var(--app-fs-md); color: var(--app-text-color1);
      padding: 2px 2px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .chan-clip { cursor: default; }
    .chan-clip .thumb { aspect-ratio: 16 / 9; background: #000; }
    .chan-clip.disconnected { opacity: 0.55; }
    @media (max-width: 1100px) { .chan-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    @media (max-width: 640px) { .chan-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `;

  render() {
    const barrelMode = appState.local.barrelMode;
    // Neither a connected barrel instance NOR a Live-offline cached one has
    // a "create new" story — both are real Resolume instance identities, not
    // fabricatable from here (unlike Playground's throwaway `pg:` ones).
    const instancesFixed = barrelMode || appState.local.liveOfflineMode;
    const instances = appState.local.barrelInstances;
    const selectedKey = appState.local.selectedBarrelKey;
    const selected = instances.find(i => i.key === selectedKey) ?? null;
    const selectedChannel = appState.local.selectedSidechannel;

    const open = (key: string) => {
      appController.selectBarrelInstance(key);
      appController.setActiveTab('edit');
    };
    const pickInstance = (key: string) => {
      appController.selectSidechannel(null);  // panel back to the instance
      appController.selectBarrelInstance(key);
    };
    const card = (inst: BarrelInstanceInfo) =>
      this.renderCard(inst, selectedKey, selectedChannel, barrelMode, pickInstance, open);

    // Organize into composition-ordered rows when placement is known (Live /
    // offline with a scanned composition); fall back to the plain flow grid
    // otherwise (playground, or a legacy cache without placement).
    const rows = buildInstanceRows(instances);

    return html`
      <div class="main-area">
        ${instancesFixed ? '' : html`
          <button class="btn new-instance"
            @click=${() => appController.createPlaygroundInstance()}>+ New instance</button>
        `}
        ${instances.length === 0
        ? (barrelMode
          ? html`<div class="empty-state">No NanoBarrel instances connected.<br>Add a NanoBarrel effect in Resolume.</div>`
          : appState.local.liveOfflineMode
          ? html`<div class="empty-state">Nothing cached from a previous session yet.<br>Connect to Resolume once to start building a recoverable offline copy.</div>`
          : html`<div class="empty-state">No playground instances yet.<br>Each instance stands in for one NanoBarrel effect in Resolume.</div>`)
        : rows
        ? html`
            <div class="inst-rows">
              ${rows.map(row => html`
                <div class="inst-row">
                  <div class="inst-row-head">${row.label}</div>
                  <div class="inst-row-cards">
                    ${row.leading.map(card)}
                    ${row.leading.length && row.clips.length ? html`<div class="row-divider"></div>` : ''}
                    ${row.clips.map(card)}
                  </div>
                </div>
              `)}
            </div>
          `
        : html`
            <div class="instance-grid">
              ${instances.map(card)}
            </div>
          `}
        ${this.renderSidechannels(selectedChannel)}
        ${this.renderTriggerChannels()}
      </div>
      <div class="right-panel">
        ${selectedChannel && appState.local.engine.sidechannels[selectedChannel]
        ? this.renderSidechannelPanel(selectedChannel)
        : selected
        ? html`
            <div class="section-header">Instance: ${instanceDisplayLabel(selected.key)}</div>
            <div class="summary">
              <div>Key: ${selected.key}</div>
              ${barrelMode
                ? html`<div>Plugin: ${selected.id}</div>`
                : html`<div>${this.instanceInfo(selected.key, false)}</div>`}
            </div>
            <div class="name-row">
              <label>Display Name</label>
              <editable-text id="inst-name" selectOnFocus
                .value=${appState.local.userSettings.instanceNames[selected.key] ?? '#'}
                @commit=${(e: CustomEvent<string>) =>
                  appController.setInstanceDisplayName(selected.key, e.detail)}
              ></editable-text>
              <div class="name-hint">"#" stands for the auto-name
                (${instanceDefaultLabel(selected.key)})</div>
            </div>
            ${selected.unlaunched
              ? html`<div class="name-hint" style="margin-bottom:12px">Not launched — launch this
                  clip in Resolume to edit. Opening shows a read-only preview.</div>`
              : ''}
            <button class="btn" @click=${() => open(selected.key)}>
              ${selected.unlaunched ? 'Open (read-only)' : 'Edit'}</button>
            ${instancesFixed ? '' : html`
              <button class="btn danger" @click=${() => this.deleteInstance(selected.key, instanceDisplayLabel(selected.key))}>Delete</button>
            `}
          `
        : html`<div class="empty-state" style="padding:16px 0">Select an instance to edit</div>`}
      </div>
    `;
  }

  /** One instance card — shared by the composition-ordered rows and the
   *  fallback flow grid. */
  private renderCard(
    inst: BarrelInstanceInfo,
    selectedKey: string | null,
    selectedChannel: string | null,
    barrelMode: boolean,
    pickInstance: (key: string) => void,
    open: (key: string) => void,
  ) {
    return html`
      <div class="instance-card ${inst.unlaunched ? 'unlaunched' : ''}"
        ?selected=${inst.key === selectedKey && !selectedChannel}
        @click=${() => pickInstance(inst.key)}
        @dblclick=${() => open(inst.key)}>
        <div class="thumb">
          <texture-monitor
            fit
            thumbnail
            eager
            .traceId=${instanceThumbTraceId(inst.key)}
            .traceTarget=${{ type: 'sketch_output', sketchId: inst.key } as any}
            resolution="low"
          ></texture-monitor>
        </div>
        <div class="card-meta">
          <div class="card-name">${instanceDisplayLabel(inst.key)}</div>
          ${inst.unlaunched
            ? html`<div class="unlaunched-badge">Not launched</div>`
            : html`<div class="card-info">${this.instanceInfo(inst.key, barrelMode)}</div>`}
        </div>
      </div>
    `;
  }

  /**
   * Grid of the environment's active sidechannels (one card per channel that
   * has been written to — the bus metadata that also feeds the effect
   * inspector's dropdown), sorted numerics-first. Clicking a card selects the
   * channel; its inspector (rename etc.) shows in the right panel.
   */
  private renderSidechannels(selectedChannel: string | null) {
    const channels = appState.local.engine.sidechannels;
    const names = Object.keys(channels).sort((a, b) => {
      const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
      if (an && bn) return Number(a) - Number(b);
      if (an !== bn) return an ? -1 : 1;
      return a.localeCompare(b);
    });
    if (names.length === 0) return '';
    return html`
      <div class="sc-section">
        <div class="section-header">Sidechannels</div>
        <div class="sc-grid">
          ${names.map(name => html`
            <div class="sc-card" ?selected=${name === selectedChannel}
              @click=${() => appController.selectSidechannel(name)}>
              <div class="thumb">
                <texture-monitor
                  fit
                  thumbnail
                  eager
                  .traceId=${sidechannelThumbTraceId(name)}
                  .traceTarget=${{ type: 'sidechannel', channel: name } as any}
                  resolution="low"
                ></texture-monitor>
              </div>
              <div class="card-meta">
                <div class="sc-card-name">${sidechannelDisplayLabel(name)}</div>
                <div class="sc-card-info">
                  from ${sidechannelWriterLabel(channels[name].writer) || '—'}
                  · ${channels[name].w}×${channels[name].h}
                </div>
              </div>
            </div>
          `)}
        </div>
      </div>
    `;
  }

  /**
   * Grid of trigger channels: one column per channel that has registered clips
   * (from the shared server's /global/channels), wrapping after 8 columns. Each
   * column stacks its clips vertically, each showing a live thumbnail (captured
   * on-demand by its NanoLooper Ch marker) + name + connected state. The column
   * header shows the channel's cosmetic name and its live trigger-rail activity
   * dot (from /global/triggerRails), so this doubles as the rail monitor.
   */
  private renderTriggerChannels() {
    const channels = appState.local.engine.triggerChannels;
    const rails = appState.local.engine.triggerRails;
    const nums = Object.keys(channels).sort((a, b) => Number(a) - Number(b));
    if (nums.length === 0) return '';
    // A channel is "live" if any rail currently reports it on (numeric match).
    const railOn = (ch: string) =>
      Object.values(rails).some(r => r[ch]?.on);
    return html`
      <div class="sc-section">
        <div class="section-header">Trigger Channels</div>
        <div class="chan-grid">
          ${nums.map(ch => {
            const col = channels[ch];
            const label = col.name?.trim() ? col.name : `Channel ${ch}`;
            return html`
              <div class="chan-col">
                <div class="chan-col-head" title=${label}>
                  <span class="trig-dot ${railOn(ch) ? 'on' : ''}"></span>${label}
                </div>
                ${(col.clips ?? []).map(clip => html`
                  <div class="sc-card chan-clip ${clip.connected ? '' : 'disconnected'}">
                    <div class="thumb">
                      <texture-monitor
                        fit
                        thumbnail
                        eager
                        .traceId=${instanceThumbTraceId(clip.key)}
                        .traceTarget=${{ type: 'sketch_output', sketchId: clip.key } as any}
                        resolution="low"
                      ></texture-monitor>
                    </div>
                    <div class="card-meta">
                      <div class="sc-card-name">${clip.clip || '(clip)'}</div>
                      <div class="sc-card-info">${clip.connected ? 'connected' : 'idle'}</div>
                    </div>
                  </div>
                `)}
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  /** Right-panel inspector for the selected sidechannel. */
  private renderSidechannelPanel(channel: string) {
    const info = appState.local.engine.sidechannels[channel];
    const stored = appState.local.userSettings.sidechannelNames[channel] ?? '#';
    return html`
      <div class="section-header">Sidechannel: ${sidechannelDisplayLabel(channel)}</div>
      <div class="summary">
        <div>Channel: ${channel}</div>
        <div>From: ${sidechannelWriterLabel(info.writer) || '—'}</div>
        <div>Size: ${info.w}×${info.h}</div>
      </div>
      <div class="name-row">
        <label>Display Name</label>
        <editable-text id="sc-name" .value=${stored} selectOnFocus
          @commit=${(e: CustomEvent<string>) =>
            appController.setSidechannelDisplayName(channel, e.detail)}
        ></editable-text>
        <div class="name-hint">"#" stands for the default label
          (${sidechannelDefaultLabel(channel)})</div>
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
