/**
 * <ui-icon> — Inline icon backed by Line Awesome.
 *
 * Usage: <ui-icon icon="la-folder"></ui-icon>
 *
 * Style with `--icon-size` (font-size) and `--icon-color` (color), or just
 * inherit from the host element.
 */

import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
// @ts-ignore — `?raw` is a Vite-native suffix that returns the file as a string.
import lineawesomecss from 'line-awesome/dist/line-awesome/css/line-awesome.css?raw';

@customElement('ui-icon')
export class UiIcon extends LitElement {
  static styles = [
    unsafeCSS(lineawesomecss),
    css`
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
      }
      i {
        font-size: var(--icon-size, inherit);
        color: var(--icon-color, inherit);
      }
    `,
  ];

  @property({ type: String }) icon = '';

  render() {
    return html`<i class="las ${this.icon}"></i>`;
  }
}
