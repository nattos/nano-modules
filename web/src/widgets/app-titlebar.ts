/**
 * <app-titlebar> — the drag strip at the top of a desktop window.
 *
 * The Electron shell opens its windows with `titleBarStyle: 'hidden'` /
 * `'hiddenInset'`, which hands the whole frame to the page: nothing is
 * draggable unless the page says so, so without this the window cannot be
 * moved at all. It also gets the OS window controls out of the app's way —
 * on macOS the traffic lights are drawn over the top-left of our content,
 * which is where the tab rail's first tab sits.
 *
 * Renders NOTHING in a browser (`display: none`), so the three surfaces can
 * mount it unconditionally and the web build is unchanged.
 *
 * Anything interactive placed in here must set `-webkit-app-region: no-drag`,
 * or the drag region swallows its clicks.
 */

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { isElectron } from '../state/paths';

/** Electron's `process.platform` where we have it. */
function platform(): string {
  const p = (globalThis as any).process?.platform;
  if (typeof p === 'string') return p;
  return /Mac/i.test(navigator.platform || '') ? 'darwin' : 'other';
}

@customElement('app-titlebar')
export class AppTitlebar extends LitElement {
  /** Window name, shown centred. */
  @property({ type: String }) label = '';

  static styles = css`
    :host {
      --app-titlebar-h: 28px;
      display: none;
    }
    :host([desktop]) {
      display: block;
      flex: 0 0 auto;
    }
    .bar {
      height: var(--app-titlebar-h);
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--app-bg-color2);
      border-bottom: 1px solid var(--app-tint-4);
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      -webkit-user-select: none;
      user-select: none;
      /* The whole point. */
      -webkit-app-region: drag;
      app-region: drag;
    }
    /* Keep the OS controls clear: macOS draws the traffic lights over our
       top-left, Windows' titleBarOverlay draws minimise/maximise/close over
       our top-right. The gutters are symmetric so the label stays centred in
       the window rather than in the leftover space. */
    :host([platform='darwin']) .bar { padding: 0 78px; }
    :host([platform='win32']) .bar { padding: 0 140px; }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Attributes rather than render-time branches, so the styles above stay
    // static and a browser build pays nothing.
    if (isElectron()) {
      this.setAttribute('desktop', '');
      this.setAttribute('platform', platform());
    }
  }

  render() {
    return html`<div class="bar"><span class="label">${this.label}</span></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-titlebar': AppTitlebar;
  }
}
