/**
 * <effect-ide-app> — Root shell of the Effect IDE page.
 *
 * Layout:
 *   ┌──┬──────────────┬─┬───────────────────────────┐
 *   │ic│ left tab     │s│  monitor + transport       │
 *   │on│ content      │p│                            │
 *   │  │              │l│                            │
 *   └──┴──────────────┴─┴───────────────────────────┘
 *      (icon bar)      (splitter — drag to resize)
 *
 * Phase 3 ships the structural shell with placeholder tab content. The
 * Explorer (Phase 4) and Project Editor (Phase 5) replace those placeholders
 * later.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { dragHasFiles } from '../../utils/drag-drop';

import './ide-icon-bar';
import './ide-explorer';
import './ide-project-editor';
import './ide-debug-info';
import './ide-monitor';
import '../../widgets/splitter';

@customElement('effect-ide-app')
export class EffectIdeApp extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
    }
    .left-panel {
      background: var(--app-bg-color2);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .right-panel {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .placeholder {
      padding: var(--app-sp-6);
      font-size: var(--app-fs-md);
      color: var(--app-text-color2);
      line-height: 1.6;
    }
    .placeholder code {
      background: var(--app-bg-color1);
      padding: 1px 6px;
      border-radius: 1px;
    }
    .status-strip {
      padding: 6px 16px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      border-top: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // Page-level file-drop fallback. Listening on the host catches drops from
    // anywhere in the IDE (drag events are composed and bubble out of the inner
    // shadow trees), so a video dropped anywhere loads into the selected
    // sketch's input by default. Specific zones override by claiming the drop
    // (stopPropagation) before it reaches here — see utils/drag-drop.
    this.addEventListener('dragover', this.onPageDragOver);
    this.addEventListener('drop', this.onPageDrop);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('dragover', this.onPageDragOver);
    this.removeEventListener('drop', this.onPageDrop);
  }

  /** Allow file drops (and suppress the browser's open/navigate default). */
  private onPageDragOver = (e: DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  /** Default: load the dropped file into the selected sketch's texture input. */
  private onPageDrop = (e: DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const sketchId = appState.local.userSettings.selectedProjectId;
    if (!sketchId) return;
    void appController.handleSketchInputDrop(sketchId, file);
  };

  render() {
    const settings = appState.local.userSettings;
    const leftWidth = settings.ideLeftPanelWidth;
    const tab = settings.ideLeftTab;
    const fps = appState.local.engine.fps;
    const error = appState.local.engine.error;
    const effectCount = appState.local.availableEffects.length;
    return html`
      <ide-icon-bar></ide-icon-bar>
      <div class="left-panel" style="width: ${leftWidth}px">
        ${tab === 'explorer'
          ? html`<ide-explorer></ide-explorer>`
          : nothing}
        ${tab === 'project_editor'
          ? html`<ide-project-editor></ide-project-editor>`
          : nothing}
        ${tab === 'debug_info'
          ? html`<ide-debug-info></ide-debug-info>`
          : nothing}
      </div>
      <ide-splitter
        .width=${leftWidth}
        @resize=${this.onResize}
      ></ide-splitter>
      <div class="right-panel">
        <ide-monitor></ide-monitor>
        <div class="status-strip">
          ${error ? `Error: ${error}` : `${effectCount} effect${effectCount === 1 ? '' : 's'} discovered · ${fps} FPS`}
        </div>
      </div>
    `;
  }

  private onResize = (e: CustomEvent<{ width: number }>) => {
    appController.setUserSetting('ideLeftPanelWidth', e.detail.width);
  };
}
