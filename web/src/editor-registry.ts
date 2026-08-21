import type { ModuleClient } from './module-client';
import type { FieldBinding } from './widgets/field-editor';

/**
 * Factory for "large" sidecar editors — full-featured, can do whatever they want.
 */
export interface EditorFactory {
  create(pluginKey: string, client: ModuleClient): HTMLElement;
  destroy(element: HTMLElement): void;
}

/**
 * Factory for "inspector" views — compact, column-width editors
 * rendered inside effect cards in the column view.
 *
 * Inspectors should limit themselves to standard field widgets,
 * section headers, and explanatory text.
 */
export interface InspectorFactory {
  create(pluginKey: string, binding: FieldBinding): HTMLElement;
  destroy(element: HTMLElement): void;
}

/**
 * Registration entry for a module's editor capabilities.
 */
export interface EditorRegistration {
  /** Full sidecar editor (optional). */
  editor?: EditorFactory;
  /** Compact inspector for effect cards (optional). */
  inspector?: InspectorFactory;
  /**
   * Extra controls for the effect card's GEAR panel (optional) — the row that
   * opens under the header, below the blend and crossfade shapes.
   *
   * Distinct from `inspector`, which replaces the card BODY: this only appends
   * to the options row, so the body keeps rendering the effect's schema fields
   * as usual. It's the place for controls that change the card's SHAPE rather
   * than a value — the math nodes' input count, for instance — which would be
   * noise among the ordinary parameters.
   *
   * Receives the same schema-backed `FieldBinding` the card body uses (not the
   * reserved-key `deviceBinding` that drives blend/crossfade), so a widget here
   * reads and writes the effect's own fields.
   */
  options?: InspectorFactory;
}

class EditorRegistryImpl {
  private registrations = new Map<string, EditorRegistration>();

  /**
   * Register editor capabilities for a module type. MERGES into any existing
   * registration rather than replacing it, so the slots (`editor`, `inspector`,
   * `options`) can be contributed from separate files — a module that has both
   * a custom inspector and gear-panel options doesn't need them declared
   * together, and neither registration can silently clobber the other.
   */
  register(packageId: string, registration: EditorRegistration) {
    const existing = this.registrations.get(packageId);
    this.registrations.set(packageId, existing ? { ...existing, ...registration } : registration);
  }

  /** Get the full editor factory (legacy compat). */
  getFactory(packageId: string): EditorFactory | undefined {
    return this.registrations.get(packageId)?.editor;
  }

  /** Get the inspector factory. */
  getInspectorFactory(packageId: string): InspectorFactory | undefined {
    return this.registrations.get(packageId)?.inspector;
  }

  /** Get the gear-panel options factory. */
  getOptionsFactory(packageId: string): InspectorFactory | undefined {
    return this.registrations.get(packageId)?.options;
  }

  /** Check if a module has a custom inspector. */
  hasInspector(packageId: string): boolean {
    return this.registrations.has(packageId) && !!this.registrations.get(packageId)?.inspector;
  }
}

export const editorRegistry = new EditorRegistryImpl();
