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
import { appState } from '../state/app-state';
import { dragHasFiles, claimDrop } from '../utils/drag-drop';

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

  // This zone is a specific override of the page-level drop fallback: it claims
  // file drags (preventDefault + stopPropagation) so the event never reaches
  // the IDE host listener — and shows its own hover affordance meanwhile.

  private onDragEnter = (e: DragEvent) => {
    if (!dragHasFiles(e)) return;
    claimDrop(e);
    this.hovering = true;
  };

  private onDragOver = (e: DragEvent) => {
    if (!dragHasFiles(e)) return;
    claimDrop(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.hovering = true;
  };

  private onDragLeave = (_e: DragEvent) => {
    this.hovering = false;
  };

  private onDrop = (e: DragEvent) => {
    claimDrop(e);
    this.hovering = false;
    const dt = e.dataTransfer;
    if (!dt) return;
    const file = dt.files?.[0] ?? null;

    // Offline / playground: the drop feeds the SINGLE global test input (fed to
    // every instance), mirroring the "Load test input…" button — those surfaces
    // have no Resolume feed and no per-sketch input pump. Everywhere else it's
    // the per-sketch input drop.
    const local = appState.local;
    const globalSurface = local.userSettings.appMode === 'playground' || local.liveOfflineMode;
    if (globalSurface) {
      // A dropped file exposes a FileSystemFileHandle in Chromium — capture it
      // SYNCHRONOUSLY (the DataTransfer is only live during the event) so the
      // dropped input persists across reload, exactly like the picker. Fall
      // back to the plain File (no persistence) when handles aren't available.
      const item = dt.items?.[0] as any;
      const handlePromise: Promise<FileSystemHandle | null> | null =
        item && typeof item.getAsFileSystemHandle === 'function'
          ? item.getAsFileSystemHandle().catch(() => null)
          : null;
      if (file || handlePromise) void appController.dropGlobalInput(file, handlePromise);
      return;
    }

    if (!this.sketchId || !file) return;
    void appController.handleSketchInputDrop(this.sketchId, file);
  };
}
