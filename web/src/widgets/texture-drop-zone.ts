/**
 * <texture-drop-zone> — Drag-drop overlay for the `texture_input` chain
 * entry. The actual frame-source lifecycle (off-screen video element,
 * persistence, restoration on reload) lives in the `SketchInputManager`
 * owned by AppController, so the pump survives tab switches that unmount
 * the drop-zone.
 *
 * This widget is purely the drag-drop UI: it shows a hover overlay,
 * accepts dropped files, and forwards them to
 * `appController.handleSketchInputDrop`.
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
      font-size: var(--app-fs-sm);
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
        ? html`<div class="overlay"><div class="hint">Drop file</div></div>`
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

  private onDrop = (e: DragEvent) => {
    e.preventDefault();
    this.hovering = false;
    if (!this.sketchId) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    void appController.handleSketchInputDrop(this.sketchId, file);
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
