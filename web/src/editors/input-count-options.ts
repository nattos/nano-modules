/**
 * <input-count-options> — the input-count control for the math shapers, shown
 * in the effect card's GEAR panel under the blend and crossfade shapes.
 *
 * It lives there rather than among the card's parameter rows because it changes
 * the card's SHAPE, not a value: picking 5 makes five input rows exist. Mixed in
 * with the inputs themselves it would read as just another one of them.
 *
 * Writes go through the binding's `setShapeValue` path (see field-editor.ts), so
 * lowering the count also drops any wires landing on the inputs it hides — both
 * in one undo step.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import { MATH_MODULE_TYPES, MATH_MAX_INPUTS, MATH_MIN_INPUTS } from '../state/math-nodes';
import '../widgets/field-tab-bar';

const COUNT_OPTIONS = Array.from(
  { length: MATH_MAX_INPUTS - MATH_MIN_INPUTS + 1 },
  (_, i) => ({ label: String(MATH_MIN_INPUTS + i), value: MATH_MIN_INPUTS + i }),
);

@customElement('input-count-options')
export class InputCountOptions extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
  `;

  render() {
    if (!this.binding) return html``;
    // Same segmented bar the blend selector above it uses, so the two rows read
    // as one panel. `shapeField` is what routes the write through the
    // wire-pruning path instead of a plain param set.
    return html`
      <field-tab-bar
        .fieldPath=${'input_count'}
        .label=${'Inputs'}
        .options=${COUNT_OPTIONS}
        .defaultValue=${MATH_MIN_INPUTS}
        ?shapeField=${true}
        .binding=${this.binding}
      ></field-tab-bar>
    `;
  }
}

const optionsFactory = {
  create(_pluginKey: string, binding: FieldBinding): HTMLElement {
    const el = document.createElement('input-count-options') as InputCountOptions;
    el.binding = binding;
    return el;
  },
  destroy(_element: HTMLElement) {},
};

// Every math node gets the same control. Registered against the `options` slot,
// so the card body still renders the effect's own fields as usual.
for (const moduleType of MATH_MODULE_TYPES) {
  editorRegistry.register(moduleType, { options: optionsFactory });
}
