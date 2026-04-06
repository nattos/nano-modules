/**
 * <edit-tab> — Edit a sketch's chain: add/remove effects, adjust params.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { autorun, IReactionDisposer } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { PluginInfo } from '../state/types';

function shortName(id: string) { return id.split('.').pop() ?? id; }

@customElement('edit-tab')
export class EditTab extends MobxLitElement {
  private previewDisposer: IReactionDisposer | null = null;

  connectedCallback() {
    super.connectedCallback();
    // React to new traced frames and blit the edit preview to the canvas
    this.previewDisposer = autorun(() => {
      const bitmap = appState.local.engine.tracedFrames['edit_preview'];
      if (!bitmap) return;
      const canvas = this.renderRoot.querySelector('#preview-canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(bitmap, 0, 0);
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.previewDisposer?.();
    this.previewDisposer = null;
  }
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .main-area {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      min-width: 0;
    }
    .right-panel {
      width: 340px;
      min-width: 260px;
      background: var(--app-bg-color2);
      border-left: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .right-content { flex: 1; overflow-y: auto; min-height: 0; padding: 12px; }
    .preview-area {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding: 8px;
      flex-shrink: 0;
    }
    .preview-area canvas {
      width: 100%; aspect-ratio: 16/9;
      background: #000; border-radius: 4px; display: block;
    }
    .chain-column {
      display: flex; flex-direction: column; align-items: center;
      gap: 0; max-width: 400px;
    }
    .chain-marker {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: 6px 16px;
      background: rgba(255,255,255,0.03);
      border: 1px dashed rgba(255,255,255,0.12);
      border-radius: 4px; text-align: center; width: 100%;
    }
    .chain-wire { width: 2px; height: 12px; background: rgba(255,255,255,0.12); }
    .add-btn {
      background: rgba(255,255,255,0.04);
      border: 1px dashed rgba(255,255,255,0.15);
      color: var(--app-text-color2);
      font-size: 16px; width: 100%; padding: 4px;
      border-radius: 4px; cursor: pointer;
      font-family: inherit; text-align: center;
      transition: background 0.15s, border-color 0.15s;
    }
    .add-btn:hover {
      background: rgba(65,105,225,0.1);
      border-color: var(--app-hi-color2);
      color: var(--app-text-color1);
    }
    .effect-card {
      width: 100%; padding: 10px 12px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px;
    }
    .effect-card-header {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 6px;
    }
    .effect-card-name { font-size: 11px; color: var(--app-text-color1); }
    .effect-param {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 0; font-size: 10px;
    }
    .effect-param-label { min-width: 70px; color: var(--app-text-color2); }
    .effect-param-slider { flex: 1; height: 4px; accent-color: var(--app-hi-color2); }
    .effect-param-value { min-width: 28px; text-align: right; color: var(--app-text-color2); font-size: 9px; }
    .remove-btn {
      background: none; border: none;
      color: var(--app-text-color2); cursor: pointer;
      font-size: 14px; padding: 0 4px; line-height: 1;
    }
    .remove-btn:hover { color: var(--app-hi-color1); }
    .btn {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--app-text-color1);
      font-size: 10px; padding: 2px 8px;
      border-radius: 3px; cursor: pointer;
      font-family: inherit;
    }
    .btn:hover { background: rgba(255,255,255,0.15); }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-row { display: flex; gap: 6px; padding: 0 0 8px; }
    .btn-row .btn { flex: 1; text-align: center; padding: 6px; }
    .section-header {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .empty-state { color: var(--app-text-color2); font-size: 12px; text-align: center; padding: 32px 16px; }
  `;

  render() {
    const sketchId = appState.local.editingSketchId;
    if (!sketchId || !appState.database.sketches[sketchId]) {
      return html`
        <div class="main-area">
          <div class="empty-state">No sketch selected for editing.<br>Go to Organize and pick one.</div>
        </div>
        <div class="right-panel"></div>
      `;
    }

    const sketch = appState.database.sketches[sketchId];
    const column = sketch.columns[0];

    return html`
      <div class="main-area">
        ${!column
          ? html`<div class="empty-state">Empty sketch.</div>`
          : html`<div class="chain-column">${this.renderChain(sketchId, column.chain)}</div>`}
      </div>
      <div class="right-panel">
        <div class="right-content">
          <div class="section-header">Preview</div>
          <div class="empty-state" style="padding:16px 0">
            Live preview renders below
          </div>
          <div class="btn-row">
            <button class="btn" ?disabled=${!appController.history.canUndo}
              @click=${() => appController.undo()}>Undo</button>
            <button class="btn" ?disabled=${!appController.history.canRedo}
              @click=${() => appController.redo()}>Redo</button>
          </div>
        </div>
        <div class="preview-area">
          <canvas id="preview-canvas" width="320" height="180"></canvas>
        </div>
      </div>
    `;
  }

  private renderChain(sketchId: string, chain: any[]) {
    const items: any[] = [];
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];

      if (entry.type === 'texture_input') {
        items.push(html`<div class="chain-marker">Texture Input</div>`);
        items.push(html`<div class="chain-wire"></div>`);
        items.push(this.renderAddBtn(sketchId, i + 1));
        items.push(html`<div class="chain-wire"></div>`);
      } else if (entry.type === 'texture_output') {
        items.push(html`<div class="chain-marker">Texture Output</div>`);
      } else if (entry.type === 'module') {
        items.push(html`
          <div class="effect-card">
            <div class="effect-card-header">
              <span class="effect-card-name">${shortName(entry.module_type)}</span>
              <button class="remove-btn"
                @click=${() => appController.removeEffectFromChain(sketchId, 0, i)}>×</button>
            </div>
            ${this.renderParams(sketchId, entry, i)}
          </div>
        `);
        items.push(html`<div class="chain-wire"></div>`);
        if (i + 1 < chain.length) {
          items.push(this.renderAddBtn(sketchId, i + 1));
          items.push(html`<div class="chain-wire"></div>`);
        }
      }
    }
    return items;
  }

  private renderAddBtn(sketchId: string, insertIdx: number) {
    return html`
      <button class="add-btn"
        @click=${() => appController.addEffectToChain(sketchId, 0, insertIdx, 'com.nattos.brightness_contrast')}>+</button>
    `;
  }

  private renderParams(sketchId: string, entry: any, chainIdx: number) {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    if (!plugin || plugin.params.length === 0) return nothing;

    return plugin.params.map(p => {
      const key = String(p.index);
      const value = entry.params[key] ?? p.defaultValue;

      if (p.type === 0) {
        // Boolean — toggle button
        return html`
          <div class="effect-param">
            <span class="effect-param-label">${p.name}</span>
            <button class="btn" style="flex:1;font-size:9px"
              @click=${() => {
                const newVal = value > 0.5 ? 0 : 1;
                appController.setEffectParam(sketchId, 0, chainIdx, key, newVal);
              }}>${value > 0.5 ? 'ON' : 'OFF'}</button>
          </div>
        `;
      }

      if (p.type === 1) {
        // Event — momentary button
        return html`
          <div class="effect-param">
            <span class="effect-param-label">${p.name}</span>
            <button class="btn" style="flex:1;font-size:9px"
              @mousedown=${() => appController.setEffectParam(sketchId, 0, chainIdx, key, 1)}
              @mouseup=${() => appController.setEffectParam(sketchId, 0, chainIdx, key, 0)}
              @mouseleave=${() => appController.setEffectParam(sketchId, 0, chainIdx, key, 0)}>Trigger</button>
          </div>
        `;
      }

      // Standard (10), Integer (13), etc. — slider
      const step = p.type === 13 ? '1' : '0.01';
      return html`
        <div class="effect-param">
          <span class="effect-param-label">${p.name}</span>
          <input type="range" class="effect-param-slider"
                 min="${p.min}" max="${p.max}" step="${step}"
                 .value=${String(value)}
                 @input=${(e: Event) => {
                   const v = parseFloat((e.target as HTMLInputElement).value);
                   appController.setEffectParam(sketchId, 0, chainIdx, key, v);
                 }}>
          <span class="effect-param-value">${p.type === 13 ? Math.round(value) : value.toFixed(2)}</span>
        </div>
      `;
    });
  }
}
