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
import './field-tab-bar';
import './field-placeholder';
import './field-vec';
import './field-color';
import './field-font';

// --- Field definitions ---

export type InspectorFieldDef =
  | { type: 'string'; label: string; path: string; placeholder?: string; default?: string; multiline?: boolean; description?: string }
  /// Font-family picker (searchable list with previews) for string `font` params.
  | { type: 'font'; label: string; path: string; default?: string; description?: string }
  | { type: 'number'; label: string; path: string; min?: number; max?: number; step?: number; default?: number; units?: string; description?: string }
  | { type: 'slider'; label: string; path: string; min: number; max: number; step?: number; default?: number; units?: string; description?: string }
  | { type: 'boolean'; label: string; path: string; default?: boolean; description?: string }
  | { type: 'select'; label: string; path: string; options: { label: string; value: any }[]; default?: any; wrap?: boolean; description?: string }
  | { type: 'button'; label: string; path: string; text?: string }
  /// 2/3/4-component vector — N labeled component sliders.
  | { type: 'vec'; label: string; path: string; components: 2 | 3 | 4;
      min?: number; max?: number; step?: number; default?: number[];
      componentLabels?: string[] }
  /// RGB(A) color picker — components 3 = rgb, 4 = rgba.
  | { type: 'color'; label: string; path: string; components: 3 | 4; default?: number[] }
  /**
   * Placeholder for field kinds the inspector can't edit inline — e.g.
   * structured objects, GPU arrays, textures. Rendered as
   * <field-placeholder> so the tap/layout system still registers it.
   */
  | { type: 'placeholder'; label: string; path: string; kind: string; direction: 'input' | 'output' }
  /**
   * A HELP slot (schema `type:'help'`). Renders long-form markdown in the
   * inspector's "?" help mode via <help-slot>; collapses when help mode is off.
   * `path` is the slot path (used to key global/local overrides); `default` is
   * the effect-authored markdown. Has no instance-state backing.
   */
  | { type: 'help'; label: string; path: string; default: string; group?: string };

// --- Field renderers ---

const renderString = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'string' }>) => html`
  <field-text title=${f.description ?? ''}
    .fieldPath=${f.path}
    .label=${f.label}
    .placeholder=${f.placeholder ?? ''}
    .defaultValue=${f.default ?? ''}
    .multiline=${f.multiline ?? false}
    .binding=${binding}
  ></field-text>
`;

const renderFont = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'font' }>) => html`
  <field-font title=${f.description ?? ''}
    .fieldPath=${f.path}
    .label=${f.label}
    .defaultValue=${f.default ?? ''}
    .binding=${binding}
  ></field-font>
`;

const renderNumber = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'number' }>) => html`
  <scalar-slider style="width: 100%;" title=${f.description ?? ''}
    .fieldPath=${f.path}
    .label=${f.label}
    .min=${f.min ?? 0}
    .max=${f.max ?? 1}
    .step=${f.step ?? 0.01}
    .units=${f.units ?? ''}
    .defaultValue=${f.default ?? 0}
    .binding=${binding}
  ></scalar-slider>
`;

const renderSlider = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'slider' }>) => html`
  <scalar-slider style="width: 100%;" title=${f.description ?? ''}
    .fieldPath=${f.path}
    .label=${f.label}
    .min=${f.min}
    .max=${f.max}
    .step=${f.step ?? 0.01}
    .units=${f.units ?? ''}
    .defaultValue=${f.default ?? f.min}
    .binding=${binding}
  ></scalar-slider>
`;

const renderBoolean = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'boolean' }>) => html`
  <field-toggle title=${f.description ?? ''}
    .fieldPath=${f.path}
    .label=${f.label}
    .defaultValue=${(f.default ?? false) ? 1 : 0}
    .binding=${binding}
  ></field-toggle>
`;

const renderSelect = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'select' }>) => html`
  <field-tab-bar title=${f.description ?? ''}
    .fieldPath=${f.path}
    .label=${f.label}
    .options=${f.options}
    .defaultValue=${f.default ?? f.options[0]?.value}
    ?wrap=${f.wrap ?? false}
    .binding=${binding}
  ></field-tab-bar>
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

const renderVec = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'vec' }>) => html`
  <field-vec style="width: 100%;"
    .fieldPath=${f.path}
    .label=${f.label}
    .components=${f.components}
    .min=${f.min ?? 0}
    .max=${f.max ?? 1}
    .step=${f.step ?? 0.01}
    .defaultValue=${f.default ?? new Array(f.components).fill(0)}
    .componentLabels=${f.componentLabels ?? null}
    .binding=${binding}
  ></field-vec>
`;

const renderColor = (binding: FieldBinding, f: Extract<InspectorFieldDef, { type: 'color' }>) => html`
  <field-color style="width: 100%;"
    .fieldPath=${f.path}
    .label=${f.label}
    .components=${f.components}
    .defaultValue=${f.default ?? (f.components === 4 ? [1, 1, 1, 1] : [1, 1, 1])}
    .binding=${binding}
  ></field-color>
`;

// --- Factory ---

export const createGenericInspector = (fields: InspectorFieldDef[]) => {
  return (binding: FieldBinding): TemplateResult => {
    return html`
      <div style="display: flex; flex-direction: column;">
        ${fields.map(field => {
          switch (field.type) {
            case 'string':      return renderString(binding, field);
            case 'font':        return renderFont(binding, field);
            case 'number':      return renderNumber(binding, field);
            case 'slider':      return renderSlider(binding, field);
            case 'boolean':     return renderBoolean(binding, field);
            case 'select':      return renderSelect(binding, field);
            case 'button':      return renderButton(binding, field);
            case 'vec':         return renderVec(binding, field);
            case 'color':       return renderColor(binding, field);
            case 'placeholder': return renderPlaceholder(binding, field);
            default:            return nothing;
          }
        })}
      </div>
    `;
  };
};
