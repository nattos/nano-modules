/**
 * <app-shell> — shared root chrome for every top-level surface (Effect IDE,
 * Resolume Playground/Live): the vertical `<app-tab-bar>`, plus per-tab
 * layout — 'inline' tabs get a resizable left panel + splitter + a monitor
 * area on the right; 'full-takeover' tabs get everything right of the tab
 * bar to themselves (e.g. Instances, Settings).
 *
 * Each tab's `render()` callback runs INSIDE this component's own render
 * (which `MobxLitElement` wraps in a MobX autorun), so its observable reads
 * are tracked here — the root surface component never needs to know when a
 * tab's content changes underneath it.
 */

import { html, css, nothing, TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { UserSettings } from '../state/types';
import type { AppTabDef, AppToggleDef } from './app-tab-bar';

import './app-tab-bar';
import './splitter';

export interface ShellTabConfig extends AppTabDef {
  render: () => TemplateResult | typeof nothing;
  /**
   * 'inline' tabs only: replaces the shared `renderMonitor()` content in the
   * right panel while this tab is active (the left panel + splitter stay).
   * Used by tabs that take over the monitor AREA but still need the left
   * editor panel alive (e.g. Devices, whose W-mode wires drag between the
   * device grid and the editor's fields).
   */
  renderRight?: () => TemplateResult;
  /**
   * Mode pills for the tab rail, live only while THIS tab is active — a mode
   * that changes nothing on the other tabs shouldn't sit lit next to them.
   * Built fresh each render, so `active` tracks the observable it reads.
   */
  toggles?: AppToggleDef[];
}

export interface ShellConfig {
  tabs: ShellTabConfig[];
  /** Which UserSettings field holds the active tab id for this surface. */
  activeTabSettingKey: keyof UserSettings;
  /** Which UserSettings field holds the left-panel width for this surface. */
  panelWidthSettingKey: keyof UserSettings;
  /** Override how a tab click is applied. Default: setUserSetting(activeTabSettingKey, id). */
  onSelectTab?: (id: string) => void;
  /** Right panel content for 'inline' tabs. */
  renderMonitor: () => TemplateResult;
  /** Optional content below the monitor, for 'inline' tabs. */
  renderStatus?: () => TemplateResult | typeof nothing;
}

@customElement('app-shell')
export class AppShell extends MobxLitElement {
  @property({ attribute: false }) config: ShellConfig | null = null;

  static styles = css`
    /* A flexible child, not a fixed 100vw/100vh box — the root surface
       component (effect-ide-app, sketch-app) owns the viewport-sized flex
       column and may stack other chrome (e.g. an offer banner) above this. */
    :host {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
    }
    .full-area {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .left-panel {
      background: var(--app-bg-color2);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .right-panel {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .status-strip {
      padding: 6px 16px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      border-top: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
    }
  `;

  render() {
    const cfg = this.config;
    if (!cfg) return nothing;
    const settings = appState.local.userSettings;
    const activeId = settings[cfg.activeTabSettingKey] as unknown as string;
    const active = cfg.tabs.find(t => t.id === activeId) ?? cfg.tabs[0];
    const width = settings[cfg.panelWidthSettingKey] as unknown as number;

    const onSelect = (id: string) => {
      if (cfg.onSelectTab) cfg.onSelectTab(id);
      else appController.setUserSetting(cfg.activeTabSettingKey, id as UserSettings[typeof cfg.activeTabSettingKey]);
    };
    const onResize = (e: CustomEvent<{ width: number }>) => {
      appController.setUserSetting(cfg.panelWidthSettingKey, e.detail.width as UserSettings[typeof cfg.panelWidthSettingKey]);
    };

    return html`
      <app-tab-bar
        .tabs=${cfg.tabs}
        .activeId=${active?.id ?? ''}
        .toggles=${active?.toggles ?? []}
        @tab-select=${(e: CustomEvent<{ id: string }>) => onSelect(e.detail.id)}
      ></app-tab-bar>
      ${active?.kind === 'full-takeover'
        ? html`<div class="full-area">${active.render()}</div>`
        : html`
          <div class="left-panel" style="width: ${width}px">${active?.render() ?? nothing}</div>
          <ide-splitter .width=${width} @resize=${onResize}></ide-splitter>
          <div class="right-panel">
            ${active?.renderRight?.() ?? cfg.renderMonitor()}
            ${cfg.renderStatus?.() ?? nothing}
          </div>
        `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-shell': AppShell;
  }
}
