/**
 * <effect-ide-app> — Root shell of the Effect IDE page.
 *
 * Builds a `ShellConfig` (see `widgets/app-shell.ts`) and renders the shared
 * `<app-shell>` — the vertical tab bar, left-panel/splitter/monitor layout is
 * common chrome shared with the Resolume shell (`views/sketch-app.ts`).
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { dragHasFiles } from '../../utils/drag-drop';
import type { ShellConfig } from '../../widgets/app-shell';

import '../../widgets/app-shell';
import './ide-explorer';
import './ide-project-editor';
import './ide-debug-info';
import '../app-settings';
import '../../widgets/sketch-monitor';
import '../../widgets/snackbars';
import '../devices/devices-tab';
import '../devices/devices-float-monitor';
import '../devices/device-wire-overlay';

@customElement('effect-ide-app')
export class EffectIdeApp extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
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
    const sel = appState.local.userSettings.selectedProjectId;
    const fps = appState.local.engine.fps;
    const error = appState.local.engine.error;
    const effectCount = appState.local.availableEffects.length;

    const config: ShellConfig = {
      tabs: [
        { id: 'explorer', icon: 'la-folder', title: 'Explorer', kind: 'inline', render: () => html`<ide-explorer></ide-explorer>` },
        { id: 'project_editor', icon: 'la-stream', title: 'Project Editor', kind: 'inline', render: () => html`<ide-project-editor></ide-project-editor>` },
        {
          // Same layout as the unified surface's Devices tab: the project's
          // sketch editor stays in the left panel (rendered DIRECTLY — not via
          // <ide-project-editor> — so the shared cross-panel field-anchor
          // lookup finds it at `.left-panel sketch-column-editor`); the device
          // grid takes over the monitor area, and the output pops out to the
          // floating overlay below.
          id: 'devices', icon: 'la-icons', title: 'Devices', kind: 'inline', render: () => html`
          <sketch-column-editor
            .sketchId=${sel}
            emptyMessage="No project selected. Pick one in the explorer first."
          ></sketch-column-editor>
        `,
          renderRight: () => html`<devices-tab></devices-tab>`,
        },
        { id: 'debug_info', icon: 'la-bug', title: 'Debug Info', kind: 'inline', render: () => html`<ide-debug-info></ide-debug-info>` },
        { id: 'settings', icon: 'la-cog', title: 'Settings', kind: 'full-takeover', render: () => html`<app-settings></app-settings>` },
      ],
      activeTabSettingKey: 'ideLeftTab',
      panelWidthSettingKey: 'ideLeftPanelWidth',
      renderMonitor: () => html`
        <sketch-monitor
          .sketchId=${sel}
          .traceId=${`ide_preview:${sel}`}
          emptyMessage="No project selected. Pick one in the explorer to begin."
        ></sketch-monitor>
      `,
      renderStatus: () => html`
        <div class="status-strip">
          ${error ? `Error: ${error}` : `${effectCount} effect${effectCount === 1 ? '' : 's'} discovered · ${fps} FPS`}
        </div>
      `,
    };

    const devicesActive = appState.local.userSettings.ideLeftTab === 'devices';
    return html`
      <app-shell .config=${config}></app-shell>
      ${devicesActive ? html`
        <devices-float-monitor
          .sketchId=${sel ?? ''}
          .traceId=${`ide_preview:${sel}`}
        ></devices-float-monitor>
        <device-wire-overlay></device-wire-overlay>
      ` : nothing}
      <snackbar-host></snackbar-host>
    `;
  }
}
