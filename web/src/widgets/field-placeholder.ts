/**
 * <field-placeholder> — A non-editable field editor for ports the inspector
 * can't render inline (structured objects, GPU arrays, vector primitives,
 * textures). Exists so the tap/layout system still has a FieldEditorElement
 * to attach to — without this, rail taps don't line up with the port.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';

@customElement('field-placeholder')
export class FieldPlaceholder extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  /** Short description of the value type — e.g. "struct", "gpu buffer", "vec4". */
  @property() kind = '';
  /** 'input' or 'output' — controls the color/arrow direction. */
  @property() direction: 'input' | 'output' = 'input';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('.chip') as HTMLElement | null;
    return el ? [el] : [this];
  }

  bindInstance(binding: FieldBinding) {
    this.binding = binding;
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-size: 10px;
      font-family: inherit;
    }
    .label {
      color: var(--app-text-color2, #b0b0b0);
      min-width: 60px;
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border: 1px dashed rgba(255, 255, 255, 0.18);
      border-radius: 3px;
      background: rgba(180, 180, 180, 0.14);
      color: var(--app-text-color2, #b0b0b0);
      font-size: 9px;
      overflow: hidden;
      cursor: default;
      user-select: none;
    }
    .chip[data-direction="output"] {
      border-color: rgba(130, 200, 255, 0.35);
      background: rgba(130, 200, 255, 0.18);
    }
    .arrow { opacity: 0.6; }
    .kind {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
  `;

  render() {
    const arrow = this.direction === 'output' ? '→' : '←';
    return html`
      <span class="label">${this.label}</span>
      <div class="chip" data-direction=${this.direction}
           title="${this.direction} · ${this.kind}">
        <span class="arrow">${arrow}</span>
        <span class="kind">${this.kind}</span>
      </div>
    `;
  }
}
