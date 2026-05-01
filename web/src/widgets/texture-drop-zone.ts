/**
 * <texture-drop-zone> — Drag-drop overlay for injecting an image (and later
 * video) frame source into a sketch's `texture_input` chain entry.
 *
 * Mounted as an absolutely-positioned child inside the `texture_input` marker
 * element (which is `position: relative`). Stays out of the way until a drag
 * starts, then highlights and accepts a drop.
 *
 * Phase 7a: image only. Video drops are deferred to a follow-up phase.
 */

import { html, css, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { appController } from '../state/controller';

@customElement('texture-drop-zone')
export class TextureDropZone extends LitElement {
  /** Sketch this drop zone targets. Required. */
  @property() sketchId = '';

  /** Reflected so the host can react via attribute selector if needed. */
  @property({ type: Boolean, reflect: true }) hovering = false;

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      display: block;
      z-index: 10;
    }
    .receiver {
      position: absolute;
      inset: 0;
    }
    :host([hovering]) .overlay {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: rgba(65,105,225,0.15);
      outline: 2px dashed var(--app-hi-color2);
      outline-offset: -2px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .hint {
      font-size: 10px;
      color: var(--app-hi-color2);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
  `;

  render() {
    return html`
      <div class="receiver"
        @dragover=${this.onDragOver}
        @dragenter=${this.onDragEnter}
        @dragleave=${this.onDragLeave}
        @drop=${this.onDrop}>
      </div>
      ${this.hovering
        ? html`<div class="overlay"><div class="hint">Drop image</div></div>`
        : null}
    `;
  }

  private onDragEnter = (e: DragEvent) => {
    if (!this.hasFile(e)) return;
    e.preventDefault();
    this.hovering = true;
  };

  private onDragOver = (e: DragEvent) => {
    if (!this.hasFile(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.hovering = true;
  };

  private onDragLeave = (_e: DragEvent) => {
    this.hovering = false;
  };

  private onDrop = async (e: DragEvent) => {
    e.preventDefault();
    this.hovering = false;
    if (!this.sketchId) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      console.warn('[texture-drop-zone] only images are supported (got', file.type, ')');
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      appController.setSketchInput(this.sketchId, bitmap);
    } catch (err) {
      console.warn('[texture-drop-zone] failed to decode image', err);
    }
  };

  private hasFile(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }
}
