/**
 * Custom inspector for composite.blend — the A/B blend node.
 *
 * Replaces the auto-generated field widgets so the crossfade `shape` param
 * renders as the <xfade-curve> graph (drag left/right on the curve edits it —
 * the mod_envelope-style direct-manipulation widget) with the live opacity as
 * a playhead. Mode + opacity keep their stock widgets.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import { BLEND_MODE_NAMES } from '../sketch-types';
import './xfade-curve';
import '../widgets/scalar-slider';
import '../widgets/field-tab-bar';
import '../widgets/field-placeholder';
import '../widgets/help-slot';

/** Options mirror the schema's selectField list; index = the enum value. */
const MODE_OPTIONS = BLEND_MODE_NAMES.map((label, value) => ({ label, value }));

@customElement('blend-inspector')
export class BlendInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  static styles = css`
    :host { display: block; }
  `;

  render() {
    if (!this.binding) return html``;
    const b = this.binding;
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      <help-slot .binding=${b} .path=${'@group/blend'}></help-slot>
      <field-tab-bar .fieldPath=${'mode'} .label=${'Blend Mode'} ?wrap=${true}
        .options=${MODE_OPTIONS} .defaultValue=${0} .binding=${b}></field-tab-bar>
      <scalar-slider style="width: 100%;" .fieldPath=${'opacity'} .label=${'Opacity'}
        .min=${0} .max=${1} .step=${0.01} .defaultValue=${0.5} .binding=${b}></scalar-slider>
      <xfade-curve .fieldPath=${'shape'} .opacityField=${'opacity'}
        .defaultValue=${0.5} ?showOverlap=${true} .binding=${b}></xfade-curve>
      <field-placeholder .fieldPath=${'tex_a'} .label=${'tex_a'}
        .kind=${'texture'} .direction=${'input'} .binding=${b}></field-placeholder>
      <field-placeholder .fieldPath=${'tex_b'} .label=${'tex_b'}
        .kind=${'texture'} .direction=${'input'} .binding=${b}></field-placeholder>
    `;
  }
}

editorRegistry.register('composite.blend', {
  inspector: {
    create(_pluginKey: string, binding: FieldBinding): HTMLElement {
      const el = document.createElement('blend-inspector') as BlendInspector;
      el.binding = binding;
      return el;
    },
    destroy(_element: HTMLElement) {},
  },
});
