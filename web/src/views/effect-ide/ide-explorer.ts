/**
 * <ide-explorer> — Project list panel.
 *
 * Two sections:
 *   - "Defaults" — one row per discovered effect (virtual `default:<effectId>`).
 *   - "User Projects" — rows for `user:<uuid>` sketches loaded from IndexedDB.
 *
 * Click a row to select it. Selection lives in `userSettings.selectedProjectId`.
 * The "×" button on a user row deletes it (via undoable mutate).
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import {
  defaultProjectIdForEffect,
  isUserProjectId,
} from '../../state/default-projects';

@customElement('ide-explorer')
export class IdeExplorer extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 0 16px;
    }
    .section-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--app-text-color2);
      padding: 12px 12px 6px;
    }
    .row {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 1px;
      padding: 6px 12px;
      cursor: pointer;
      border-left: 2px solid transparent;
    }
    .row:hover {
      background: rgba(255,255,255,0.04);
    }
    .row[selected] {
      background: rgba(65,105,225,0.12);
      border-left-color: var(--app-hi-color2);
    }
    .row-name {
      font-size: 12px;
      color: var(--app-text-color1);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 24px;
    }
    .row-id {
      font-size: 10px;
      color: var(--app-text-color2);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-delete {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: var(--app-text-color2);
      font-size: 14px;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s, background 0.15s;
    }
    .row:hover .row-delete { opacity: 1; }
    .row-delete:hover {
      color: var(--app-hi-color1);
      background: rgba(255,69,0,0.1);
    }
    .empty {
      padding: 8px 12px;
      font-size: 11px;
      color: var(--app-text-color2);
      font-style: italic;
    }
  `;

  render() {
    const selectedId = appState.local.userSettings.selectedProjectId;
    const effects = appState.local.availableEffects;
    const sketches = appState.database.sketches;
    // Hide template (un-edited) user copies — they show up only after the
    // first real edit promotes them to "real" projects.
    const userIds = Object.keys(sketches)
      .filter(id => isUserProjectId(id) && !sketches[id]?.isTemplate)
      .sort();

    return html`
      <div class="section-header">Defaults</div>
      ${effects.length === 0
        ? html`<div class="empty">Loading effects…</div>`
        : effects.map(e => {
            const id = defaultProjectIdForEffect(e.id);
            return html`
              <div class="row" ?selected=${selectedId === id}
                @click=${() => appController.selectProject(id)}>
                <div class="row-name">${e.name}</div>
                <div class="row-id">${e.id}</div>
              </div>
            `;
          })}

      <div class="section-header">User Projects</div>
      ${userIds.length === 0
        ? html`<div class="empty">No user projects yet. Edit a default to create one.</div>`
        : userIds.map(id => {
            const sk = sketches[id];
            const name = sk?.columns?.[0]?.name ?? id;
            return html`
              <div class="row" ?selected=${selectedId === id}
                @click=${() => appController.selectProject(id)}>
                <div class="row-name">${name}</div>
                <div class="row-id">${id}</div>
                <button class="row-delete" title="Delete project"
                  @click=${(ev: Event) => this.onDelete(ev, id)}>×</button>
              </div>
            `;
          })}
      ${nothing}
    `;
  }

  private onDelete(ev: Event, id: string) {
    ev.stopPropagation();
    appController.deleteProject(id);
  }
}
