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
}

class EditorRegistryImpl {
  private registrations = new Map<string, EditorRegistration>();

  /** Register editor capabilities for a module type. */
  register(packageId: string, registration: EditorRegistration) {
    this.registrations.set(packageId, registration);
  }

  /** Get the full editor factory (legacy compat). */
  getFactory(packageId: string): EditorFactory | undefined {
    return this.registrations.get(packageId)?.editor;
  }

  /** Get the inspector factory. */
  getInspectorFactory(packageId: string): InspectorFactory | undefined {
    return this.registrations.get(packageId)?.inspector;
  }

  /** Check if a module has a custom inspector. */
  hasInspector(packageId: string): boolean {
    return this.registrations.has(packageId) && !!this.registrations.get(packageId)?.inspector;
  }
}

export const editorRegistry = new EditorRegistryImpl();
