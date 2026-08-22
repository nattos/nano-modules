/**
 * <app-tab-bar> — VSCode-style vertical icon column, shared chrome for every
 * top-level surface (Effect IDE, Resolume Playground/Live).
 *
 * Purely presentational and data-driven (generalizes the old per-surface
 * hardcoded tab lists — `ide-icon-bar`'s fixed `TABS` array and
 * `sketch-app`'s horizontal `.tab-bar`): the caller supplies `tabs` +
 * `activeId` and listens for `tab-select`. No settings/MobX knowledge here —
 * `<app-shell>` owns reading/writing the active tab.
 */

import { html, css, nothing, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import './ui-icon';

/**
 * 'inline' tabs occupy only the left panel (the monitor stays visible on the
 * right); 'full-takeover' tabs occupy everything right of this bar (e.g. the
 * Instances grid or the Settings page).
 */
export type AppTabKind = 'inline' | 'full-takeover';

/**
 * A MODE toggle in the rail — not a tab: it doesn't change what's rendered on
 * the left, it changes how the current surface behaves (the sidecar canvas).
 * Styled as the arrangement's `autobtn` mode pills (transport-bar's A/W/?), so
 * the two surfaces agree on what a mode button looks like; the rail's own tab
 * icons stay visually distinct from them.
 *
 * The caller owns `active` and applies the click — this component stays
 * presentational, exactly as it is for tabs.
 */
export interface AppToggleDef {
  id: string;
  icon: string;
  /** The letter on the pill — matches the keyboard shortcut that does the same. */
  letter: string;
  title: string;
  active: boolean;
  onToggle: () => void;
  /** Colour when lit. Defaults to the rail's own active accent. */
  accent?: string;
}

export interface AppTabDef {
  id: string;
  icon: string;
  title: string;
  kind: AppTabKind;
  /** Which end of the bar to render in. Default 'top'. */
  align?: 'top' | 'bottom';
}

@customElement('app-tab-bar')
export class AppTabBar extends LitElement {
  @property({ attribute: false }) tabs: AppTabDef[] = [];
  @property({ attribute: false }) activeId = '';
  /** Mode pills rendered under the top tab group. Usually the ACTIVE tab's — a
   *  mode that only means something on one surface shouldn't outlive it. */
  @property({ attribute: false }) toggles: AppToggleDef[] = [];

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 48px;
      flex-shrink: 0;
      background: var(--app-bg-color2);
      border-right: 1px solid var(--app-tint-3);
    }
    .group {
      display: flex;
      flex-direction: column;
    }
    .spacer {
      flex: 1;
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
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
      padding: 0;
    }
    .icon-btn:hover {
      color: var(--app-text-color1);
    }
    .icon-btn[active] {
      color: var(--app-text-color1);
      border-left-color: var(--app-hi-color2);
    }
    .icon-btn ui-icon {
      --icon-size: 22px;
    }
    /* Mode pills, below the tabs and set off from them by a rule. Same shape as
       the arrangement transport's autobtn pills, narrowed to fit the 48px rail. */
    .toggles {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--app-sp-2);
      padding: var(--app-sp-3) 0;
      margin-top: var(--app-sp-2);
      border-top: 1px solid var(--app-tint-3);
    }
    .mode-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      height: 24px;
      padding: 0 var(--app-sp-2);
      font-family: inherit;
      font-size: var(--app-fs-sm);
      font-weight: 600;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .mode-btn:hover {
      background: var(--app-tint-2);
    }
    .mode-btn[active] {
      color: var(--mode-accent);
      border-color: var(--mode-accent);
    }
    .mode-btn ui-icon {
      --icon-size: 13px;
    }
  `;

  render() {
    const top = this.tabs.filter(t => (t.align ?? 'top') === 'top');
    const bottom = this.tabs.filter(t => t.align === 'bottom');
    return html`
      <div class="group">${top.map(t => this.renderTab(t))}</div>
      ${this.toggles.length
        ? html`<div class="toggles">${this.toggles.map(t => this.renderToggle(t))}</div>`
        : nothing}
      <div class="spacer"></div>
      <div class="group">${bottom.map(t => this.renderTab(t))}</div>
    `;
  }

  private renderTab(t: AppTabDef) {
    return html`
      <button class="icon-btn"
        ?active=${this.activeId === t.id}
        title=${t.title}
        @click=${() => this.dispatchEvent(new CustomEvent('tab-select', {
          detail: { id: t.id },
          bubbles: true,
          composed: true,
        }))}>
        <ui-icon .icon=${t.icon}></ui-icon>
      </button>
    `;
  }

  private renderToggle(t: AppToggleDef) {
    return html`
      <button class="mode-btn"
        ?active=${t.active}
        title=${t.title}
        style=${`--mode-accent: ${t.accent ?? 'var(--app-hi-color2)'}`}
        @click=${() => t.onToggle()}>
        <ui-icon .icon=${t.icon}></ui-icon>${t.letter}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-tab-bar': AppTabBar;
  }
}
