/**
 * <global-input-control> — the input card's "load a test input video" control,
 * shown only on surfaces that lack Resolume's live layer feed (offline +
 * playground). Picking a file feeds it, as a single global stand-in input, to
 * EVERY running instance; the handle is persisted and restored at app start.
 *
 * Renders nothing on effect-dev / connected-Live / arrangement — those either
 * have per-sketch inputs or a real upstream feed.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';

@customElement('global-input-control')
export class GlobalInputControl extends MobxLitElement {
  static styles = css`
    /* Lift above the texture-drop-zone overlay (z-index:10) so the buttons
     * stay clickable, like the input card's header row. */
    :host {
      display: block;
      position: relative;
      z-index: 11;
      padding: 4px 10px 8px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--app-sp-2);
      min-width: 0;
    }
    button {
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      padding: 2px 8px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { color: var(--app-text-color1); border-color: var(--app-text-color2); }
    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    .clear { flex: 0 0 auto; }
  `;

  render() {
    const local = appState.local;
    // Offline (Live without a connection) or Playground only — the surfaces
    // with no upstream Resolume feed to test effect chains against.
    const eligible = local.userSettings.appMode === 'playground' || local.liveOfflineMode;
    if (!eligible) return nothing;

    const label = local.globalInputLabel;
    if (label) {
      return html`<div class="row">
        <span class="name" title=${label}>▶ ${label}</span>
        <button class="clear" title="Remove the test input"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${this.onClear}>Clear</button>
      </div>`;
    }

    // Remembered from a previous session but its handle needs a fresh grant.
    const relink = local.globalInputRelink;
    if (relink) {
      return html`<div class="row">
        <button title="Re-grant access to the last test input"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${this.onRelink}>Reconnect ${relink}</button>
        <button class="clear" title="Forget it"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${this.onDismiss}>✕</button>
      </div>`;
    }

    return html`<div class="row">
      <button title="Load a local video/image as a test input for every instance"
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @click=${this.onLoad}>Load test input…</button>
    </div>`;
  }

  private onLoad = (e: Event) => { e.stopPropagation(); void appController.pickGlobalInputVideo(); };
  private onClear = (e: Event) => { e.stopPropagation(); void appController.clearGlobalInput(); };
  private onRelink = (e: Event) => { e.stopPropagation(); void appController.relinkGlobalInput(); };
  private onDismiss = (e: Event) => { e.stopPropagation(); void appController.dismissGlobalInputRelink(); };
}

declare global {
  interface HTMLElementTagNameMap {
    'global-input-control': GlobalInputControl;
  }
}
