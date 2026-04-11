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
 *
 * Field editors have NO knowledge of tapping, selection, or layout tracking.
 * Those concerns are handled externally by the edit-tab overlay system.
 */

/** Binding context provided by the framework. */
export interface FieldBinding {
  /** The module instance key, e.g. "virtual_bc@123". */
  instanceKey: string;

  /** Read the current value of a field path from instance state. */
  getValue(fieldPath: string): any;

  /** Write a value to a field path in instance state (one-shot, creates undo point). */
  setValue(fieldPath: string, value: any): void;

  /**
   * Begin a continuous edit (e.g., slider drag). Updates are previewed live
   * without creating undo points. Returns a handle for updating / finishing.
   */
  beginContinuousEdit(fieldPath: string, value: any): ContinuousEditHandle;
}

/** Handle for an in-progress continuous edit (slider drag, etc.). */
export interface ContinuousEditHandle {
  /** Update the value during the drag (no undo point). */
  update(value: any): void;
  /** Commit the final value as a single undo point. */
  accept(): void;
  /** Cancel and revert to the pre-drag value. */
  cancel(): void;
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
}

/** Type guard for FieldEditorElement. */
export function isFieldEditor(el: any): el is FieldEditorElement {
  return el && typeof el.bindInstance === 'function' && 'fieldPath' in el && typeof el.getControlElements === 'function';
}
