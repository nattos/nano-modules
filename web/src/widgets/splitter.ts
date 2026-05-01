/**
 * <ide-splitter> — A vertical draggable divider for resizing two horizontal
 * panels.
 *
 * Stateless w.r.t. the actual panel widths: takes the current `width` as a
 * property so it can clamp drags relative to a known starting point, and emits
 * a `resize` event with the new clamped width on every move. The parent is
 * responsible for storing the value (typically into user settings).
 */

import { html, css, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { PointerDragOp } from '../utils/pointer-drag-op';

@customElement('ide-splitter')
export class IdeSplitter extends LitElement {
  /** Current width of the panel being resized (px). */
  @property({ type: Number }) width = 320;
  @property({ type: Number }) minWidth = 200;
  @property({ type: Number }) maxWidth = 800;

  private startWidth = 0;
  private dragOp: PointerDragOp | null = null;

  static styles = css`
    :host {
      display: block;
      width: 4px;
      cursor: col-resize;
      background: transparent;
      flex-shrink: 0;
      align-self: stretch;
      transition: background 0.15s;
      touch-action: none;
    }
    :host(:hover), :host([dragging]) {
      background: var(--app-hi-color2);
    }
  `;

  render() {
    return html``;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('pointerdown', this.onPointerDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('pointerdown', this.onPointerDown);
    this.dragOp?.dispose();
    this.dragOp = null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.startWidth = this.width;
    this.setAttribute('dragging', '');
    this.dragOp = new PointerDragOp(e, this, {
      callMoveImmediately: true,
      threshold: 0,
      move: (_e, [dx]) => {
        const w = Math.max(
          this.minWidth,
          Math.min(this.maxWidth, this.startWidth + dx),
        );
        this.dispatchEvent(new CustomEvent('resize', {
          detail: { width: w },
          bubbles: true,
          composed: true,
        }));
      },
      complete: () => {
        this.removeAttribute('dragging');
        this.dragOp = null;
      },
    });
  };
}
