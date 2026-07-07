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

import { html, css, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

import './ui-icon';

/**
 * 'inline' tabs occupy only the left panel (the monitor stays visible on the
 * right); 'full-takeover' tabs occupy everything right of this bar (e.g. the
 * Instances grid or the Settings page).
 */
export type AppTabKind = 'inline' | 'full-takeover';

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
    ui-icon {
      --icon-size: 22px;
    }
  `;

  render() {
    const top = this.tabs.filter(t => (t.align ?? 'top') === 'top');
    const bottom = this.tabs.filter(t => t.align === 'bottom');
    return html`
      <div class="group">${top.map(t => this.renderTab(t))}</div>
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
}

declare global {
  interface HTMLElementTagNameMap {
    'app-tab-bar': AppTabBar;
  }
}
