/**
 * Generic inspector field renderers.
 *
 * Ported from nano-repatch. Renders field editor widgets based on
 * declarative field definitions, wired to a FieldBinding.
 *
 * Uses <scalar-slider> for numeric/slider fields — it implements
 * FieldEditorElement so the tap overlay system picks it up.
 *
 * Usage:
 *   const inspector = createGenericInspector([
 *     { type: 'slider', label: 'Brightness', path: 'brightness', min: 0, max: 1 },
 *     { type: 'slider', label: 'Contrast', path: 'contrast', min: 0, max: 1 },
 *   ]);
 *   // In render():
 *   inspector(binding)
 */

import { html, TemplateResult, nothing } from 'lit';
import type { FieldBinding } from './field-editor';
import './scalar-slider';

// --- Field definitions ---

export type InspectorFieldDef =
  | { type: 'string'; label: string; path: string; placeholder?: string; default?: string }
  | { type: 'number'; label: string; path: string; min?: number; max?: number; step?: number; default?: number }
  | { type: 'slider'; label: string; path: string; min: number; max: number; step?: number; default?: number }
  | { type: 'boolean'; label: string; path: string; default?: boolean }
  | { type: 'select'; label: string; path: string; options: { label: string; value: any }[]; default?: any }
  | { type: 'button'; label: string; path: string; text?: string };

// --- Field renderers ---

const getValue = (binding: FieldBinding, path: string, fallback: any) => {
  const val = binding.getValue(path);
  return val !== undefined ? val : fallback;
};

const FIELD_STYLE = `display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 2px 0;`;
const LABEL_STYLE = `color: var(--app-text-color2, #b0b0b0); font-size: 10px; min-width: 60px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;

const renderStringField = (binding: FieldBinding, field: Extract<InspectorFieldDef, { type: 'string' }>) => html`
  <div style=${FIELD_STYLE}>
    <label style=${LABEL_STYLE}>${field.label}</label>
    <input
      type="text"
      .value=${getValue(binding, field.path, field.default ?? '')}
      placeholder=${field.placeholder || ''}
      @input=${(e: Event) => binding.setValue(field.path, (e.target as HTMLInputElement).value)}
      style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); color: var(--app-text-color1); border-radius: 2px; padding: 2px 4px; flex: 1; min-width: 0; font-size: 10px; font-family: inherit;"
    />
  </div>
`;

const renderNumberField = (binding: FieldBinding, field: Extract<InspectorFieldDef, { type: 'number' }>) => html`
  <div style=${FIELD_STYLE}>
    <label style=${LABEL_STYLE}>${field.label}</label>
    <scalar-slider style="flex: 1; min-width: 0;"
      .fieldPath=${field.path}
      .label=${field.label}
      .value=${getValue(binding, field.path, field.default ?? 0)}
      .min=${field.min ?? 0}
      .max=${field.max ?? 1}
      .step=${field.step || 0.01}
      .defaultValue=${field.default ?? 0}
      .binding=${binding}
    ></scalar-slider>
  </div>
`;

const renderSliderField = (binding: FieldBinding, field: Extract<InspectorFieldDef, { type: 'slider' }>) => html`
  <div style=${FIELD_STYLE}>
    <label style=${LABEL_STYLE}>${field.label}</label>
    <scalar-slider style="flex: 1; min-width: 0;"
      .fieldPath=${field.path}
      .label=${field.label}
      .value=${getValue(binding, field.path, field.default ?? field.min)}
      .min=${field.min}
      .max=${field.max}
      .step=${field.step || 0.01}
      .defaultValue=${field.default ?? field.min}
      .binding=${binding}
    ></scalar-slider>
  </div>
`;

const renderBooleanField = (binding: FieldBinding, field: Extract<InspectorFieldDef, { type: 'boolean' }>) => html`
  <div style=${FIELD_STYLE}>
    <label style=${LABEL_STYLE}>${field.label}</label>
    <input
      type="checkbox"
      .checked=${getValue(binding, field.path, field.default ?? false) > 0.5}
      @change=${(e: Event) => binding.setValue(field.path, (e.target as HTMLInputElement).checked ? 1 : 0)}
    />
  </div>
`;

const renderSelectField = (binding: FieldBinding, field: Extract<InspectorFieldDef, { type: 'select' }>) => html`
  <div style=${FIELD_STYLE}>
    <label style=${LABEL_STYLE}>${field.label}</label>
    <select
      .value=${getValue(binding, field.path, field.default ?? field.options[0]?.value)}
      @change=${(e: Event) => binding.setValue(field.path, (e.target as HTMLSelectElement).value)}
      style="background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); color: var(--app-text-color1); border-radius: 2px; padding: 2px 4px; font-size: 10px; font-family: inherit;"
    >
      ${field.options.map(opt => html`<option value=${opt.value}>${opt.label}</option>`)}
    </select>
  </div>
`;

const renderButtonField = (binding: FieldBinding, field: Extract<InspectorFieldDef, { type: 'button' }>) => html`
  <div style=${FIELD_STYLE}>
    <label style=${LABEL_STYLE}>${field.label}</label>
    <button
      @pointerdown=${() => binding.setValue(field.path, 1)}
      @pointerup=${() => binding.setValue(field.path, 0)}
      @pointerleave=${() => binding.setValue(field.path, 0)}
      style="background: rgba(255,255,255,0.06); color: var(--app-text-color1); border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 3px 8px; cursor: pointer; font-size: 10px; font-family: inherit; min-width: 50px; text-align: center;"
    >${field.text || 'Trigger'}</button>
  </div>
`;

// --- Factory ---

export const createGenericInspector = (fields: InspectorFieldDef[]) => {
  return (binding: FieldBinding): TemplateResult => {
    return html`
      <div style="display: flex; flex-direction: column;">
        ${fields.map(field => {
      switch (field.type) {
        case 'string': return renderStringField(binding, field);
        case 'number': return renderNumberField(binding, field);
        case 'slider': return renderSliderField(binding, field);
        case 'boolean': return renderBooleanField(binding, field);
        case 'select': return renderSelectField(binding, field);
        case 'button': return renderButtonField(binding, field);
        default: return nothing;
      }
    })}
      </div>
    `;
  };
};
