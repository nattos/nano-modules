/**
 * <app-settings> — the universal "Settings" tab, mounted (full-takeover) on
 * every top-level surface: Effect Dev, Playground, Live.
 *
 * Houses cross-surface preferences that don't belong to any one surface:
 *   - The mode selector (which of the three surfaces this session prefers).
 *   - The Resolume-remote on/off kill-switch (`barrelRemoteEnabled`).
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { LIVE_OFFLINE_KEY, type AppMode } from '../resolume-mode';

const MODE_OPTIONS: { id: AppMode; label: string; description: string }[] = [
  { id: 'effect-dev', label: 'Effect Dev', description: 'Author and test individual effects in isolation.' },
  { id: 'live', label: 'Live', description: 'Bound to the shared NanoBarrel server (Resolume).' },
  { id: 'playground', label: 'Playground', description: 'Simulate the shared server locally, without Resolume.' },
];

@customElement('app-settings')
export class AppSettings extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .page {
      max-width: 640px;
      margin: 0 auto;
      padding: var(--app-sp-6);
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-6);
    }
    h1 {
      font-size: var(--app-fs-lg);
      color: var(--app-text-color1);
      margin: 0;
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-3);
    }
    h2 {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      margin: 0;
    }
    .hint {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      line-height: 1.5;
    }
    .mode-row {
      display: flex;
      gap: var(--app-sp-3);
    }
    .mode-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      text-align: left;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      color: var(--app-text-color1);
      font-family: inherit;
      padding: var(--app-sp-4);
      cursor: pointer;
    }
    .mode-btn:hover {
      border-color: var(--app-text-color2);
    }
    .mode-btn[active] {
      border-color: var(--app-hi-color2);
    }
    .mode-btn .label {
      font-size: var(--app-fs-md);
    }
    .mode-btn .description {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
    }
    .toggle-row label {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      cursor: pointer;
    }
  `;

  render() {
    const settings = appState.local.userSettings;
    return html`
      <div class="page">
        <h1>Settings</h1>
        <section>
          <h2>Mode</h2>
          <div class="hint">Switching reloads the page into the matching surface.</div>
          <div class="mode-row">
            ${MODE_OPTIONS.map(o => html`
              <button class="mode-btn"
                ?active=${settings.appMode === o.id}
                @click=${() => appController.switchAppMode(o.id)}>
                <span class="label">${o.label}</span>
                <span class="description">${o.description}</span>
              </button>
            `)}
          </div>
        </section>
        <section>
          <h2>Resolume Remote</h2>
          <div class="hint">
            Off: never try to reach Resolume, in any mode (Live falls back to
            editing its offline copy). On: also watch quietly from Effect Dev
            and Playground, so either can offer switching to Live.
          </div>
          <div class="toggle-row">
            <label>
              <input type="checkbox"
                .checked=${settings.barrelRemoteEnabled}
                @change=${this.onToggleRemote}>
              Enable Resolume Remote
            </label>
          </div>
        </section>
        ${this.renderConnectionSection()}
      </div>
    `;
  }

  /**
   * Only shown while in Live's universe (attempting to connect, or already
   * offline-editing) — the "have an editable cached composition" case from
   * the feature request is `bootLiveOffline`'s own job (it seeds an empty
   * state gracefully when nothing's cached yet), so this just needs to
   * offer the same action the automatic snackbars already do, reachable
   * without waiting for the 5s timeout.
   */
  private renderConnectionSection() {
    const { barrelMode, liveOfflineMode, barrelConnection } = appState.local;
    if (!barrelMode && !liveOfflineMode) return null;

    if (liveOfflineMode) {
      return html`
        <section>
          <h2>Connection</h2>
          <div class="hint">Currently editing offline. Reconnecting reconciles any changes against Resolume's current composition.</div>
          <button class="mode-btn" style="flex:none" @click=${this.onTryReconnect}>
            <span class="label">Try reconnecting</span>
          </button>
        </section>
      `;
    }
    if (barrelConnection !== 'open') {
      return html`
        <section>
          <h2>Connection</h2>
          <div class="hint">Not connected to Resolume yet. You can switch to editing the offline copy right away instead of waiting.</div>
          <button class="mode-btn" style="flex:none" @click=${this.onEditOffline}>
            <span class="label">Edit offline</span>
          </button>
        </section>
      `;
    }
    return null;
  }

  private onToggleRemote = (e: Event) => {
    appController.setUserSetting('barrelRemoteEnabled', (e.target as HTMLInputElement).checked);
  };

  private onEditOffline = () => {
    try { sessionStorage.setItem(LIVE_OFFLINE_KEY, '1'); } catch { /* ignore */ }
    location.reload();
  };

  private onTryReconnect = () => {
    try { sessionStorage.removeItem(LIVE_OFFLINE_KEY); } catch { /* ignore */ }
    location.reload();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'app-settings': AppSettings;
  }
}
