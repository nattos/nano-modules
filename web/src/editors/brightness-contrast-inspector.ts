/**
 * Custom inspector for the brightness_contrast module.
 *
 * Demonstrates a minimal inspector: just standard field widgets
 * with a section header. The framework auto-binds the widgets.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import '../widgets/field-slider';

@customElement('bc-inspector')
export class BrightnessContrastInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host {
      display: block;
    }
    .section {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2, #b0b0b0);
      padding: 4px 0 2px;
      opacity: 0.7;
    }
  `;

  render() {
    if (!this.binding) return html``;
    return html`
      <div class="section">Color Adjust</div>
      <field-slider .fieldPath=${'brightness'} .label=${'Brightness'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5}
        .binding=${this.binding}></field-slider>
      <field-slider .fieldPath=${'contrast'} .label=${'Contrast'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5}
        .binding=${this.binding}></field-slider>
    `;
  }
}

// Register the inspector
editorRegistry.register('video.brightness_contrast', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('bc-inspector') as BrightnessContrastInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
