/**
 * Per-surface cache of custom effect inspectors (editorRegistry factories).
 *
 * Inspectors are stateful DOM the factory owns, so a surface has to keep one
 * per instance and destroy them when it tears down. Shared by the linear
 * effects list and the sidecar canvas — each holds its OWN cache (the same
 * instance can be shown on only one surface at a time, but the two surfaces
 * mount and unmount independently).
 */

import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from './field-editor';

export class InspectorCache {
  private cache = new Map<string, HTMLElement>();

  /**
   * The inspector element for an instance, or null when the module type has no
   * registered factory (the caller then falls back to the generic inspector).
   */
  get(instanceKey: string, moduleType: string, binding: FieldBinding): HTMLElement | null {
    const factory = editorRegistry.getInspectorFactory(moduleType);
    if (!factory) return null;

    let el: HTMLElement | undefined = this.cache.get(instanceKey);
    // Recreate when the instance's module TYPE changed under the same key: the
    // "add" flow inserts a default effect and then changes the type (reusing the
    // instanceKey), so a cache keyed only on instanceKey would keep showing the
    // old type's inspector until a reload.
    if (el && (el as any).moduleType !== moduleType) {
      editorRegistry.getInspectorFactory((el as any).moduleType ?? '')?.destroy(el);
      this.cache.delete(instanceKey);
      el = undefined;
    }
    if (!el) {
      const made = factory.create(instanceKey, binding);
      (made as any).moduleType = moduleType;
      this.cache.set(instanceKey, made);
      return made;
    }
    (el as any).binding = binding;
    return el;
  }

  /** Destroy every cached inspector through its factory and forget them. */
  clear() {
    for (const [, el] of this.cache) {
      editorRegistry.getInspectorFactory((el as any).moduleType ?? '')?.destroy(el);
    }
    this.cache.clear();
  }
}
