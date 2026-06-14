/**
 * <ide-explorer> — Project list panel.
 *
 * Two sections:
 *   - "Defaults" — one row per discovered effect, with the canonical id
 *     `default:<effectId>`. The row appears regardless of whether the
 *     project has been saved to IndexedDB yet; selecting it lazily
 *     synthesizes the in-memory entry. First edit promotes the entry to
 *     "saved" (see `mutate` in controller.ts).
 *   - "User Projects" — `user:<uuid>` projects (legacy data from the
 *     prior model, or future manually-created projects). Hidden while
 *     empty.
 *
 * Click a row to select it. Selection lives in `userSettings.selectedProjectId`.
 * The "×" button on a user row deletes it.
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

import '../../widgets/ui-icon';

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
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 3px;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s, background 0.15s;
      padding: 0;
      --icon-size: 14px;
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
    // Templates are virtual, browse-only entries — keep them out of the
    // User Projects list.
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
                @click=${() => this.openProject(id)}>
                <div class="row-name">${e.name}</div>
                <div class="row-id">${e.id}</div>
              </div>
            `;
          })}

      ${userIds.length === 0 ? nothing : html`
        <div class="section-header">User Projects</div>
        ${userIds.map(id => {
          const name = id;
          return html`
            <div class="row" ?selected=${selectedId === id}
              @click=${() => this.openProject(id)}>
              <div class="row-name">${name}</div>
              <div class="row-id">${id}</div>
              <button class="row-delete" title="Delete project"
                @click=${(ev: Event) => this.onDelete(ev, id)}>
                <ui-icon icon="la-times"></ui-icon>
              </button>
            </div>
          `;
        })}
      `}
    `;
  }

  private onDelete(ev: Event, id: string) {
    ev.stopPropagation();
    appController.deleteProject(id);
  }

  /** Picking a project from the explorer also focuses the project editor tab. */
  private openProject(id: string) {
    appController.selectProject(id);
    appController.setUserSetting('ideLeftTab', 'project_editor');
  }
}
