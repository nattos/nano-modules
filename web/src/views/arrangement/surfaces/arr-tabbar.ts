/**
 * <arr-tabbar> — right vertical tab bar. Each tab renders into the inspector
 * area (Settings combines composition + app-wide settings; Export is offline
 * render). The Inspector tab shows the current selection.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store, RightTab } from '../state/store';
import '../../../widgets/ui-icon';

const TABS: Array<{ id: RightTab; icon: string; label: string }> = [
  { id: 'inspector', icon: 'la-sliders-h', label: 'Inspector' },
  { id: 'settings', icon: 'la-cog', label: 'Settings' },
  { id: 'export', icon: 'la-file-export', label: 'Export' },
];

@customElement('arr-tabbar')
export class ArrTabbar extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 44px;
      height: 100%;
      background: var(--app-bg-color2);
      border-left: 1px solid var(--app-tint-3);
      padding-top: var(--app-sp-2);
      gap: 2px;
    }
    button {
      width: 100%;
      height: 40px;
      background: none;
      border: none;
      border-left: 2px solid transparent;
      color: var(--app-text-color2);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      font-family: inherit;
    }
    button ui-icon {
      --icon-size: 16px;
    }
    button span {
      font-size: 7px;
      letter-spacing: 0.02em;
    }
    button:hover {
      color: var(--app-text-color1);
      background: var(--app-tint-1);
    }
    button.active {
      color: var(--app-hi-color2);
      border-left-color: var(--app-hi-color2);
      background: var(--app-tint-1);
    }
    button.bottom {
      margin-top: auto;
      margin-bottom: var(--app-sp-2);
    }
  `;

  render() {
    return html`
      ${TABS.map(
        (t) => html`
          <button
            class=${store.activeRightTab === t.id ? 'active' : ''}
            title=${t.label}
            @click=${() => store.setRightTab(t.id)}
          >
            <ui-icon icon=${t.icon}></ui-icon>
            <span>${t.label}</span>
          </button>
        `,
      )}
      <button
        class="bottom ${store.clipViewOpen ? 'active' : ''}"
        title="Clip view"
        @click=${() => store.toggleClipView()}
      >
        <ui-icon icon="la-window-maximize"></ui-icon>
        <span>Clip</span>
      </button>
    `;
  }
}
