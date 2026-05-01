/**
 * <ide-icon-bar> — VSCode-style vertical icon column on the left edge of the IDE.
 *
 * Reads the active tab from `appState.local.userSettings.ideLeftTab` and
 * dispatches `setUserSetting` on click. Icons are placeholder text labels for
 * now — replace with SVGs when we have a real icon set.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import type { UserSettings } from '../../state/types';

interface IconTabDef {
  id: UserSettings['ideLeftTab'];
  label: string;
  title: string;
}

const TABS: IconTabDef[] = [
  { id: 'explorer',       label: 'Ex', title: 'Explorer' },
  { id: 'project_editor', label: 'Pr', title: 'Project Editor' },
];

@customElement('ide-icon-bar')
export class IdeIconBar extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 48px;
      flex-shrink: 0;
      background: var(--app-bg-color2);
      border-right: 1px solid rgba(255,255,255,0.08);
    }
    .icon-btn {
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-left: 2px solid transparent;
      color: var(--app-text-color2);
      font-family: inherit;
      font-size: 12px;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .icon-btn:hover {
      color: var(--app-text-color1);
    }
    .icon-btn[active] {
      color: var(--app-text-color1);
      border-left-color: var(--app-hi-color2);
    }
  `;

  render() {
    const active = appState.local.userSettings.ideLeftTab;
    return html`
      ${TABS.map(t => html`
        <button class="icon-btn"
          ?active=${active === t.id}
          title=${t.title}
          @click=${() => appController.setUserSetting('ideLeftTab', t.id)}>
          ${t.label}
        </button>
      `)}
    `;
  }
}
