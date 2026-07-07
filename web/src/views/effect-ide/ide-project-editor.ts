/**
 * <ide-project-editor> — Effect IDE wrapper around the shared
 * `<sketch-column-editor>`, bound to `userSettings.selectedProjectId`.
 *
 * Default→user materialization happens in `appController.selectProject` (see
 * controller.ts) — by the time we render, the selected id is always a
 * `user:<uuid>`. The first real edit clears `isTemplate`, promoting the
 * project from "browsed" to "saved".
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import '../../widgets/sketch-column-editor';

@customElement('ide-project-editor')
export class IdeProjectEditor extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    sketch-column-editor {
      flex: 1;
      min-width: 0;
      min-height: 0;
    }
  `;

  render() {
    const id = appState.local.userSettings.selectedProjectId;
    return html`
      <sketch-column-editor
        .sketchId=${id}
        emptyMessage="Select a project from the explorer to begin."
      ></sketch-column-editor>
    `;
  }
}
