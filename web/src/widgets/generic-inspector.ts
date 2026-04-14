/**
 * Generic inspector field renderers.
 *
 * Every field variant renders a real FieldEditorElement custom element
 * (scalar-slider / field-toggle / field-trigger / field-text / field-select /
 * field-placeholder). The layout manager scans the DOM for these elements
 * to build tap-overlay hit boxes and rail attachment points, so inline
 * raw HTML would break tap alignment.
 *
 * Usage:
 *   const inspector = createGenericInspector([
 *     { type: 'slider', label: 'Brightness', path: 'brightness', min: 0, max: 1 },
 *     { type: 'placeholder', label: 'particles_in', path: 'particles_in',
 *       kind: 'gpu buffer', direction: 'input' },
 *   ]);
 *   inspector(binding)  // inside render()
 */

import { html, TemplateResult, nothing } from 'lit';
import type { FieldBinding } from './field-editor';
import './scalar-slider';
import './field-toggle';
import './field-trigger';
import './field-text';
import './field-select';
import './field-placeholder';

// --- Field definitions ---

export type InspectorFieldDef =
  | { type: 'string'; label: string; path: string; placeholder?: string; default?: string }
  | { type: 'number'; label: string; path: string; min?: number; max?: number; step?: number; default?: number }
  | { type: 'slider'; label: string; path: string; min: number; max: number; step?: number; default?: number }
  | { type: 'boolean'; label: string; path: string; default?: boolean }
  | { type: 'select'; label: string; path: string; options: { label: string; value: any }[]; default?: any }
  | { type: 'button'; label: string; path: string; text?: string }
  /**
   * Placeholder for field kinds the inspector can't edit inline — e.g.
   * structured objects, GPU arrays, textures, vector primitives. Rendered
   * as <field-placeholder> so the tap/layout system still registers it.
   */
  | { type: 'placeholder'; label: string; path: string; kind: string; direction: 'input' | 'output' };

// --- Field renderers ---

const renderString = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'string' }>) => html`
  <field-text
    .fieldPath=${f.path}
    .label=${f.label}
    .placeholder=${f.placeholder ?? ''}
    .defaultValue=${f.default ?? ''}
    .binding=${binding}
  ></field-text>
`;

const renderNumber = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'number' }>) => html`
  <scalar-slider style="width: 100%;"
    .fieldPath=${f.path}
    .label=${f.label}
    .min=${f.min ?? 0}
    .max=${f.max ?? 1}
    .step=${f.step ?? 0.01}
    .defaultValue=${f.default ?? 0}
    .binding=${binding}
  ></scalar-slider>
`;

const renderSlider = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'slider' }>) => html`
  <scalar-slider style="width: 100%;"
    .fieldPath=${f.path}
    .label=${f.label}
    .min=${f.min}
    .max=${f.max}
    .step=${f.step ?? 0.01}
    .defaultValue=${f.default ?? f.min}
    .binding=${binding}
  ></scalar-slider>
`;

const renderBoolean = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'boolean' }>) => html`
  <field-toggle
    .fieldPath=${f.path}
    .label=${f.label}
    .defaultValue=${(f.default ?? false) ? 1 : 0}
    .binding=${binding}
  ></field-toggle>
`;

const renderSelect = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'select' }>) => html`
  <field-select
    .fieldPath=${f.path}
    .label=${f.label}
    .options=${f.options}
    .defaultValue=${f.default ?? f.options[0]?.value}
    .binding=${binding}
  ></field-select>
`;

const renderButton = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'button' }>) => html`
  <field-trigger
    .fieldPath=${f.path}
    .label=${f.label}
    .binding=${binding}
  ></field-trigger>
`;

const renderPlaceholder = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'placeholder' }>) => html`
  <field-placeholder
    .fieldPath=${f.path}
    .label=${f.label}
    .kind=${f.kind}
    .direction=${f.direction}
    .binding=${binding}
  ></field-placeholder>
`;

// --- Factory ---

export const createGenericInspector = (fields: InspectorFieldDef[]) => {
  return (binding: FieldBinding): TemplateResult => {
    return html`
      <div style="display: flex; flex-direction: column;">
        ${fields.map(field => {
          switch (field.type) {
            case 'string':      return renderString(binding, field);
            case 'number':      return renderNumber(binding, field);
            case 'slider':      return renderSlider(binding, field);
            case 'boolean':     return renderBoolean(binding, field);
            case 'select':      return renderSelect(binding, field);
            case 'button':      return renderButton(binding, field);
            case 'placeholder': return renderPlaceholder(binding, field);
            default:            return nothing;
          }
        })}
      </div>
    `;
  };
};
