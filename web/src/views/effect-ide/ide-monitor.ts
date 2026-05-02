/**
 * <ide-monitor> — Right-panel monitor for the IDE.
 *
 * Renders the current project's `sketch_output` trace via the existing
 * `<texture-monitor>` widget, plus transport controls (pause / restart).
 *
 * Pause state lives in `userSettings.paused` so it survives reloads. The
 * engine command is sent through `appController.setPaused`, and `boot.ts`
 * re-applies the saved value at startup.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';

import '../../widgets/texture-monitor';
import '../../widgets/ui-button';

@customElement('ide-monitor')
export class IdeMonitor extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .preview {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      background: #000;
      overflow: hidden;
    }
    texture-monitor {
      max-width: 100%;
      max-height: 100%;
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--app-text-color2);
      font-size: 11px;
      text-align: center;
      padding: 32px;
    }
    .transport {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      background: var(--app-bg-color2);
      border-top: 1px solid rgba(255,255,255,0.08);
      flex-shrink: 0;
    }
    .stat {
      margin-left: auto;
      font-size: 10px;
      color: var(--app-text-color2);
    }
  `;

  render() {
    const sel = appState.local.userSettings.selectedProjectId;
    const sketch = sel ? appState.database.sketches[sel] : null;
    const paused = appState.local.userSettings.paused;
    const fps = appState.local.engine.fps;
    const error = appState.local.engine.error;
    return html`
      <div class="preview">
        ${sel && sketch
          ? html`<texture-monitor
              .traceId=${`ide_preview:${sel}`}
              .traceTarget=${{ type: 'sketch_output', sketchId: sel } as any}
              .width=${640}
              .height=${360}
              resolution="high"
            ></texture-monitor>`
          : html`<div class="empty">No project selected.<br>Pick one in the explorer to begin.</div>`}
      </div>
      <div class="transport">
        <ui-button
          .icon=${paused ? 'la-play' : 'la-pause'}
          title=${paused ? 'Resume engine' : 'Pause engine'}
          @click=${this.onTogglePause}>
        </ui-button>
        <ui-button
          icon="la-redo"
          title="Reset elapsed time"
          @click=${this.onRestart}>
        </ui-button>
        <span class="stat">
          ${error ? `Error: ${error}` : `${fps} FPS`}
        </span>
      </div>
    `;
  }

  private onTogglePause = () => {
    appController.setPaused(!appState.local.userSettings.paused);
  };

  private onRestart = () => {
    appController.restartEngine();
  };
}
