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

  /**
   * Live modulation telemetry for a field driven by a wire: the effective
   * resolved `value`, the swing `[min, max]` band the modulation can reach, and
   * the `neutral` fill anchor the band grows from (base value for add/mix; range
   * min/midpoint for unsigned/signed replace; 0 for `mul`), all in the field's
   * own units. Returns null when the field is not modulated.
   * Lets a slider draw the band + a filled effective bar over the base value.
   * Optional — widgets must tolerate its absence.
   */
  getModulation?(fieldPath: string): { value: number; min: number; max: number; neutral: number } | null;

  /** Write a value to a field path in instance state (one-shot, creates undo point). */
  setValue(fieldPath: string, value: any): void;

  /**
   * Begin a continuous edit (e.g., slider drag). Updates are previewed live
   * without creating undo points. Returns a handle for updating / finishing.
   */
  beginContinuousEdit(fieldPath: string, value: any): ContinuousEditHandle;

  /**
   * Begin a continuous edit over MULTIPLE field paths as a SINGLE long edit —
   * for widgets that drive several fields at once (e.g. an XY pad controlling
   * two scalars). Two separate `beginContinuousEdit` calls would cancel each
   * other (only one long edit is active at a time), so this is required to edit
   * more than one field per drag. Optional: widgets should fall back if absent.
   */
  beginContinuousEditMulti?(values: Record<string, any>): MultiContinuousEditHandle;

  /**
   * Multi-edit only: true when the bound targets (e.g. several selected clips)
   * don't all share one value for this field. Widgets render a "many" placeholder
   * instead of a concrete value, and the first edit aligns every target (clearing
   * mixed). Absent on single-target bindings — widgets treat absence as `false`.
   */
  isMixed?(fieldPath: string): boolean;

  /**
   * Multi-edit only: the distinct values currently in use across the bound
   * targets — for enum / segmented widgets to gray-highlight every option that
   * any target uses (rather than fully selecting one). Absent on single-target
   * bindings.
   */
  inUseValues?(fieldPath: string): unknown[];

  // --- Help text ("?" help mode) ---
  // These support the <help-slot> widget. All optional so non-help bindings
  // (tests, older adapters) keep working.

  /** The effect TYPE id, used to key the browser-global help override store. */
  moduleType?: string;

  /** Whether the surface's "?" help mode is currently on (help slots visible). */
  helpMode?: boolean;

  /**
   * The sketch-LOCAL help override for a slot path (scope + text), or undefined
   * when none is stored. The global override + effect default are resolved by
   * the widget itself (via the global doc store + the schema-authored default).
   */
  getHelp?(slotPath: string): { scope?: 'global' | 'local'; text?: string } | undefined;

  /**
   * Merge a partial help override (scope and/or local text) for a slot path into
   * the sketch. One undo point per call (commit on blur / segment switch).
   */
  setHelp?(slotPath: string, patch: { scope?: 'global' | 'local'; text?: string }): void;
}

/** Handle for an in-progress multi-field continuous edit (XY pad, etc.). */
export interface MultiContinuousEditHandle {
  /** Update the values during the drag (no undo point). */
  update(values: Record<string, any>): void;
  /** Commit the final values as a single undo point. */
  accept(): void;
  /** Cancel and revert to the pre-drag values. */
  cancel(): void;
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
