import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { ModuleClient } from '../module-client';
import { editorRegistry } from '../editor-registry';

interface SeenParam {
  id: number;
  path: string;
  ignored: boolean;
  order: number;
}

@customElement('paramlinker-editor')
export class ParamLinkerEditor extends MobxLitElement {
  @property({ attribute: false }) client!: ModuleClient;

  static styles = css`
    :host {
      display: block;
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      font-size: 12px;
      color: #eaeaea;
    }

    .section {
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    .section-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #b0b0b0;
      margin-bottom: 6px;
    }

    .controls {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }

    .toggle-btn {
      flex: 1;
      padding: 6px 12px;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 4px;
      background: rgba(255,255,255,0.05);
      color: #eaeaea;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      text-align: center;
      user-select: none;
      transition: background 0.1s;
    }
    .toggle-btn:hover { background: rgba(255,255,255,0.1); }
    .toggle-btn.active {
      background: #4169E1;
      border-color: #4169E1;
    }
    .toggle-btn.learn-active {
      background: #ff4500;
      border-color: #ff4500;
    }

    .assignment {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px;
      background: rgba(0,0,0,0.2);
      border-radius: 4px;
      margin-bottom: 8px;
    }
    .assignment-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .assignment-label {
      font-size: 10px;
      font-weight: bold;
      min-width: 30px;
    }
    .assignment-label.input { color: #4dc9f6; }
    .assignment-label.output { color: #ff8c00; }
    .assignment-path {
      font-size: 11px;
      color: #b0b0b0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .assignment-none { color: #555; font-style: italic; }

    .param-list {
      max-height: 300px;
      overflow-y: auto;
    }

    .param-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border-radius: 3px;
      cursor: default;
    }
    .param-item:hover { background: rgba(255,255,255,0.04); }

    .param-bar {
      width: 3px;
      height: 16px;
      border-radius: 1px;
      flex-shrink: 0;
    }

    .param-path {
      flex: 1;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .param-actions {
      display: flex;
      gap: 3px;
      flex-shrink: 0;
    }

    .assign-btn {
      padding: 2px 6px;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 2px;
      background: rgba(255,255,255,0.04);
      color: #b0b0b0;
      font-family: inherit;
      font-size: 9px;
      cursor: pointer;
    }
    .assign-btn:hover { background: rgba(255,255,255,0.1); color: #eaeaea; }
    .assign-btn.in-btn:hover { color: #4dc9f6; border-color: #4dc9f6; }
    .assign-btn.out-btn:hover { color: #ff8c00; border-color: #ff8c00; }

    .badge {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .badge-input { background: rgba(77,201,246,0.2); color: #4dc9f6; }
    .badge-output { background: rgba(255,140,0,0.2); color: #ff8c00; }
    .badge-ignored { background: rgba(255,255,255,0.05); color: #555; }
  `;

  private assignAsInput(paramId: number) {
    const state = this.client.getState();
    this.client.patchState({
      ...state,
      input_id: paramId,
    });
  }

  private assignAsOutput(paramId: number) {
    const state = this.client.getState();
    this.client.patchState({
      ...state,
      output_id: paramId,
    });
  }

  private toggleLearn() {
    this.client.pulseParam(0); // PID_LEARN
  }

  private toggleActive() {
    this.client.pulseParam(1); // PID_ACTIVE
  }

  render() {
    const state = this.client.store.state;
    const learning = state?.learning ?? false;
    const active = state?.active ?? true;
    const inputId = state?.input_id ?? -1;
    const outputId = state?.output_id ?? -1;
    const inputPath = state?.input_path ?? '';
    const outputPath = state?.output_path ?? '';
    const seen: SeenParam[] = state?.seen ?? [];

    // Sort by order descending (newest first)
    const sorted = [...seen].sort((a, b) => b.order - a.order);

    return html`
      <div class="section">
        <div class="controls">
          <button
            class="toggle-btn ${learning ? 'learn-active' : ''}"
            @click=${this.toggleLearn}
          >
            ${learning ? 'Stop Learning' : 'Learn'}
          </button>
          <button
            class="toggle-btn ${active ? 'active' : ''}"
            @click=${this.toggleActive}
          >
            ${active ? 'Active' : 'Inactive'}
          </button>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Assignment</div>
        <div class="assignment">
          <div class="assignment-row">
            <span class="assignment-label input">IN</span>
            ${inputId >= 0
              ? html`<span class="assignment-path">${inputPath}</span>`
              : html`<span class="assignment-path assignment-none">not assigned</span>`
            }
          </div>
          <div class="assignment-row">
            <span class="assignment-label output">OUT</span>
            ${outputId >= 0
              ? html`<span class="assignment-path">${outputPath}</span>`
              : html`<span class="assignment-path assignment-none">not assigned</span>`
            }
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">
          Discovered Parameters ${seen.length > 0 ? `(${seen.length})` : ''}
        </div>
        <div class="param-list">
          ${sorted.map(p => {
            const isInput = p.id === inputId;
            const isOutput = p.id === outputId;
            let barColor = 'rgba(255,255,255,0.15)';
            let textColor = '#b0b0b0';
            if (isInput) { barColor = '#4dc9f6'; textColor = '#4dc9f6'; }
            else if (isOutput) { barColor = '#ff8c00'; textColor = '#ff8c00'; }
            else if (p.ignored) { barColor = 'rgba(255,255,255,0.06)'; textColor = '#444'; }

            return html`
              <div class="param-item">
                <div class="param-bar" style="background:${barColor}"></div>
                <span class="param-path" style="color:${textColor}" title=${p.path}>${p.path}</span>
                ${isInput ? html`<span class="badge badge-input">IN</span>` : ''}
                ${isOutput ? html`<span class="badge badge-output">OUT</span>` : ''}
                ${p.ignored && !isInput && !isOutput ? html`<span class="badge badge-ignored">auto</span>` : ''}
                <div class="param-actions">
                  <button class="assign-btn in-btn" @click=${() => this.assignAsInput(p.id)}>In</button>
                  <button class="assign-btn out-btn" @click=${() => this.assignAsOutput(p.id)}>Out</button>
                </div>
              </div>
            `;
          })}
          ${sorted.length === 0 ? html`
            <div style="color:#555;font-size:11px;padding:8px">
              ${learning ? 'Waiting for parameter changes...' : 'Press Learn to discover parameters'}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }
}

// Register the editor factory
editorRegistry.register('com.nattos.paramlinker', {
  editor: {
    create(pluginKey: string, client: ModuleClient): HTMLElement {
      const editor = document.createElement('paramlinker-editor') as ParamLinkerEditor;
      editor.client = client;
      return editor;
    },
    destroy(_element: HTMLElement) {},
  },
});
