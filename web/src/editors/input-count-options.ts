/**
 * <input-count-options> — the arity control for the variable-arity nodes (the
 * math shapers' inputs, the Switch's cases), shown in the effect card's GEAR
 * panel under the blend and crossfade shapes.
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
import { MATH_MODULE_TYPES, MATH_MAX_INPUTS, MATH_MIN_INPUTS,
         SWITCH_MODULE_TYPE } from '../state/math-nodes';
import '../widgets/field-tab-bar';

const COUNT_OPTIONS = Array.from(
  { length: MATH_MAX_INPUTS - MATH_MIN_INPUTS + 1 },
  (_, i) => ({ label: String(MATH_MIN_INPUTS + i), value: MATH_MIN_INPUTS + i }),
);

@customElement('input-count-options')
export class InputCountOptions extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** Row label — the nodes disagree about what they are counting. */
  @property({ attribute: false }) label = 'Inputs';

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
        .label=${this.label}
        .options=${COUNT_OPTIONS}
        .defaultValue=${MATH_MIN_INPUTS}
        ?shapeField=${true}
        .binding=${this.binding}
      ></field-tab-bar>
    `;
  }
}

function factoryLabelled(label: string) {
  return {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('input-count-options') as InputCountOptions;
      el.binding = binding;
      el.label = label;
      return el;
    },
    destroy(_element: HTMLElement) {},
  };
}

// Every variable-arity node gets the same control, differing only in what the
// row is called. Registered against the `options` slot, so the card body still
// renders the effect's own fields as usual.
const mathFactory = factoryLabelled('Inputs');
for (const moduleType of MATH_MODULE_TYPES) {
  editorRegistry.register(moduleType, { options: mathFactory });
}
// The Switch counts CASES, not inputs — it also has a `select` input that the
// count has nothing to do with, so calling this "Inputs" would be actively
// misleading about which rows it governs.
editorRegistry.register(SWITCH_MODULE_TYPE, { options: factoryLabelled('Cases') });
