/**
 * Base interface for standard field editor widgets.
 *
 * Field editors are MobxLitElement-based custom elements that:
 * - Display and edit a value at a specific field path in instance state
 * - Expose a common API for the framework to bind them to module instances
 * - Are designed to fit within effect card columns (limited width)
 *
 * Usage:
 *   <field-slider .fieldPath=${'brightness'} .label=${'Brightness'}
 *                  .min=${0} .max=${1} .step=${0.01}></field-slider>
 *
 * The framework calls bindInstance() after the element is created to wire
 * it to a specific module instance's state.
 */

/** Binding context provided by the framework. */
export interface FieldBinding {
  /** The module instance key, e.g. "virtual_bc@123". */
  instanceKey: string;

  /** Read the current value of a field path from instance state. */
  getValue(fieldPath: string): any;

  /** Write a value to a field path in instance state. */
  setValue(fieldPath: string, value: any): void;
}

/** Interface that all field editor elements must implement. */
export interface FieldEditorElement extends HTMLElement {
  /** The field path this editor controls, e.g. 'brightness' or 'params/0'. */
  // TODO: Delete. This is just a convention used by our "single-field" field editors.
  // Editor widgets that control multiple fields will not have this. Use controlledFields
  // instead.
  fieldPath: string;

  /** Human-readable label. */
  label: string;

  /** Bind this editor to a specific module instance. */
  bindInstance(binding: FieldBinding): void;

  /** The field paths this editor reads/writes (for framework introspection). */
  readonly controlledFields: string[];

  /** Returns the interactive control element(s) for bounding box queries. */
  getControlElements(): HTMLElement[];

  /** Whether tap configuration mode is active. */
  tappingMode: boolean;

  /** Whether this field is currently selected for tap configuration. */
  selected: boolean;

  /** Layout manager for centralized bounding box tracking. */
  layoutManager: FieldLayoutManager | null;
}

// Forward reference — avoid circular import. Concrete class in field-layout-manager.ts.
export interface FieldLayoutManager {
  notifyLayoutChanged(): void;
}

/** Type guard for FieldEditorElement. */
export function isFieldEditor(el: any): el is FieldEditorElement {
  return el && typeof el.bindInstance === 'function' && 'fieldPath' in el && typeof el.getControlElements === 'function';
}
