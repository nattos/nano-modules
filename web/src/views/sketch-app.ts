/**
 * <sketch-app> — Root application shell for Resolume Playground/Live.
 *
 * Builds a `ShellConfig` (see `widgets/app-shell.ts`) and renders the shared
 * `<app-shell>` — the vertical tab bar, left-panel/splitter/monitor layout is
 * common chrome shared with the Effect IDE shell (`views/effect-ide/effect-ide-app.ts`).
 * "Instances" and "Edit" (formerly a horizontal `.tab-bar`) now live in the
 * shared vertical tab bar; "Edit" renders the same `<sketch-column-editor>`
 * the Effect IDE uses for its own Project Editor tab.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { ShellConfig } from '../widgets/app-shell';

import '../widgets/app-shell';
import '../widgets/sketch-column-editor';
import '../widgets/sketch-monitor';
import '../widgets/snackbars';
import './organize-tab';
import './app-settings';
import './reconcile-dialog';

@customElement('sketch-app')
export class SketchApp extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
    }
  `;

  render() {
    const sketchId = appState.local.editingSketchId;
    // Main monitor always shows the sketch output. Selecting an effect card no
    // longer retargets the monitor to that card's chain-output texture.
    const traceTarget = { type: 'sketch_output', sketchId } as any;

    const config: ShellConfig = {
      tabs: [
        { id: 'organize', icon: 'la-th-large', title: 'Instances', kind: 'full-takeover', render: () => html`<organize-tab></organize-tab>` },
        {
          id: 'edit', icon: 'la-stream', title: 'Edit', kind: 'inline', render: () => html`
          <sketch-column-editor
            .sketchId=${sketchId}
            emptyMessage="No sketch selected for editing. Go to Instances and pick one."
          ></sketch-column-editor>
        `,
        },
        { id: 'settings', icon: 'la-cog', title: 'Settings', kind: 'full-takeover', render: () => html`<app-settings></app-settings>` },
      ],
      activeTabSettingKey: 'activeTab',
      panelWidthSettingKey: 'editLeftPanelWidth',
      onSelectTab: (id) => appController.setActiveTab(id as 'organize' | 'edit' | 'settings'),
      renderMonitor: () => html`
        <sketch-monitor
          .sketchId=${sketchId}
          traceId="edit_preview"
          .traceTarget=${traceTarget}
          emptyMessage="No sketch selected for editing."
        ></sketch-monitor>
      `,
    };

    return html`
      <app-shell .config=${config}></app-shell>
      <snackbar-host></snackbar-host>
      <reconcile-dialog></reconcile-dialog>
    `;
  }
}
