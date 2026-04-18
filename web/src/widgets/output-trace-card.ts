/**
 * <output-trace-card> — A small card at the bottom of an effect card representing
 * one of its outputs. Also a FieldEditorElement so the tap-overlay / rail-gutter
 * system can point tap indicators at it.
 *
 * Rendering mode is chosen by `kind`:
 *   - 'texture'              → <texture-monitor> preview of the output texture
 *   - 'float' / 'int' / 'bool' → <spark-chart> polling the live value
 *   - anything else          → labeled placeholder box (struct / gpu / vec)
 *
 * Always shows a caption with the output's display name so users can see what
 * each card represents.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';
import type { TracePoint } from '../engine-types';

import './texture-monitor';
import './spark-chart';

@customElement('output-trace-card')
export class OutputTraceCard extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  /** Schema type label, e.g. 'texture', 'float', 'struct', 'gpu buffer', 'vec4'. */
  @property() kind = '';
  @property() traceId = '';
  @property({ attribute: false }) traceTarget: TracePoint['target'] | null = null;
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }
  getControlElements(): HTMLElement[] { return [this]; }
  bindInstance(binding: FieldBinding) { this.binding = binding; }

  static styles = css`
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      min-width: 64px;
    }
    .content {
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .placeholder {
      width: 64px;
      height: 36px;
      background: rgba(255,255,255,0.04);
      border: 1px dashed rgba(255,255,255,0.18);
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--app-text-color2, #b0b0b0);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      box-sizing: border-box;
    }
    .caption {
      font-size: 9px;
      color: var(--app-text-color2, #b0b0b0);
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  private renderContent() {
    if (this.kind === 'texture') {
      return html`
        <texture-monitor
          .traceId=${this.traceId}
          .traceTarget=${this.traceTarget}
          .width=${64}
          .height=${36}
        ></texture-monitor>
      `;
    }
    const scalar = this.kind === 'float' || this.kind === 'int' || this.kind === 'bool';
    if (scalar && this.binding) {
      return html`
        <spark-chart
          .fieldPath=${this.fieldPath}
          .binding=${this.binding}
          .width=${64}
          .height=${36}
        ></spark-chart>
      `;
    }
    // Structured / gpu / vector / unknown — no live data, just a labeled chip.
    return html`<div class="placeholder">${this.kind || 'output'}</div>`;
  }

  render() {
    return html`
      <div class="content">${this.renderContent()}</div>
      ${this.label ? html`<div class="caption" title=${this.label}>${this.label}</div>` : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'output-trace-card': OutputTraceCard;
  }
}
