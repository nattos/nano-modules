/**
 * <sketch-canvas-view> — the sidecar canvas.
 *
 * A freeform surface holding the sketch's canvas-partition nodes, opened to the
 * RIGHT of the linear effects list (it takes over the monitor area, which pops
 * out to the floating overlay). Cards are the SAME <column-group> effect cards
 * as the linear list — one instance in `canvas` layout mode, rendering only the
 * entries carrying a placement — so selection, field widgets, inspectors and
 * wire anchoring all work here with no parallel implementation.
 *
 * The canvas has no <columns-view>: no virtualization, no column widths, no
 * horizontal column layout. Just a scrolling viewport over an absolutely
 * positioned surface.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { ideColumnAdapter } from '../../state/ide-column-adapter';
import { canvasChain, sketchChain } from '../../sketch-types';
import { CANVAS_CARD_WIDTH } from '../../widgets/column-group';

import '../../widgets/column-group';

/** Scroll-past-the-end tail, mirroring columns-view.updateContentHeight(). */
const TAIL_MIN = 120;

@customElement('sketch-canvas-view')
export class SketchCanvasView extends MobxLitElement {
  @property() sketchId: string | null = null;

  /** Canvas content height, tracked so the scroll range matches the list's. */
  @state() private contentH = 600;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--app-bg-color1);
    }
    .viewport {
      width: 100%;
      height: 100%;
      overflow: auto;
      position: relative;
    }
    .surface {
      position: relative;
      /* Same padding as columns-view's .scroll-container, so canvas y=0 lines
         up with the first linear card when the two scrolls are linked. */
      padding: var(--app-sp-6);
      box-sizing: border-box;
      min-width: 100%;
    }
    .empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      color: var(--app-text-color3);
      font-size: 12px;
      text-align: center;
      padding: 0 32px;
      line-height: 1.6;
    }
  `;

  /** Widest/lowest card extent, so the surface can be scrolled to reach them. */
  private measureContent() {
    const sketch = this.sketchId ? appState.database.sketches[this.sketchId] : null;
    if (!sketch) return;
    let bottom = 0;
    for (const e of canvasChain(sketch)) {
      const c = e.canvas!;
      bottom = Math.max(bottom, c.y + 220);
    }
    const vpH = this.renderRoot.querySelector('.viewport')?.clientHeight ?? 0;
    const next = Math.max(bottom, vpH) + Math.max(TAIL_MIN, vpH * 0.5);
    if (Math.abs(next - this.contentH) > 1) this.contentH = next;
  }

  protected updated() {
    this.measureContent();
  }

  render() {
    const sketchId = this.sketchId;
    const sketch = sketchId ? appState.database.sketches[sketchId] : null;
    if (!sketchId || !sketch) {
      return html`<div class="viewport"><div class="empty">
        No sketch selected for editing.</div></div>`;
    }
    const empty = sketchChain(sketch).every(e => !e.canvas);

    return html`
      <div class="viewport">
        <div class="surface" style="height:${this.contentH}px">
          <column-group
            layoutMode="canvas"
            .sketchId=${sketchId}
            .colIdx=${0}
            .columnWidth=${CANVAS_CARD_WIDTH}
            .adapter=${ideColumnAdapter}
          ></column-group>
          ${empty ? html`<div class="empty">
            The sidecar canvas is empty. Drag an effect out of the list, or
            double-click here to add one.</div>` : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sketch-canvas-view': SketchCanvasView;
  }
}
