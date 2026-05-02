/**
 * <ui-button> — Standard button with optional Line Awesome icon and label.
 *
 * Usage:
 *   <ui-button icon="la-pause" @click=${...}></ui-button>
 *   <ui-button icon="la-pause" @click=${...}>Pause</ui-button>
 *
 * Style with `--button-bg`, `--button-hover`, `--button-active`,
 * `--text-color`, `--border-color`. The label slot collapses when empty.
 */

import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
// @ts-ignore — `?raw` is a Vite-native suffix that returns the file as a string.
import lineawesomecss from 'line-awesome/dist/line-awesome/css/line-awesome.css?raw';

@customElement('ui-button')
export class UiButton extends LitElement {
  @property({ type: String }) icon = '';
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ type: Boolean, reflect: true }) active = false;

  @state() private hasContent = false;

  static readonly styles = [unsafeCSS(lineawesomecss), css`
    :host { display: inline-block; }
    button {
      background-color: var(--button-bg, rgba(255,255,255,0.08));
      color: var(--text-color, var(--app-text-color1, #eaeaea));
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      border-radius: 3px;
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: inherit;
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    button:hover:not(:disabled) {
      background-color: var(--button-hover, rgba(255,255,255,0.15));
    }
    button:active:not(:disabled) {
      background-color: var(--button-active, rgba(255,255,255,0.22));
    }
    :host([active]) button {
      background-color: var(--app-hi-color2, #4169E1);
      border-color: var(--app-hi-color2, #4169E1);
      color: #fff;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    i { font-size: 14px; }
    span { margin-left: 6px; }
    span.hidden { display: none; }
  `];

  private handleSlotChange = (e: Event) => {
    const slot = e.target as HTMLSlotElement;
    const nodes = slot.assignedNodes({ flatten: true });
    this.hasContent = nodes.some(node =>
      node.nodeType === Node.ELEMENT_NODE
      || (node.nodeType === Node.TEXT_NODE && node.textContent?.trim() !== ''),
    );
  };

  render() {
    return html`
      <button ?disabled=${this.disabled}>
        ${this.icon ? html`<i class="las ${this.icon}"></i>` : ''}
        <span class="${this.hasContent ? '' : 'hidden'}">
          <slot @slotchange=${this.handleSlotChange}></slot>
        </span>
      </button>
    `;
  }
}
