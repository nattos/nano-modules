/**
 * Per-surface cache of custom effect widgets (editorRegistry factories).
 *
 * These are stateful DOM the factory owns, so a surface has to keep one per
 * instance and destroy them when it tears down. Shared by the linear effects
 * list and the sidecar canvas — each holds its OWN cache (the same instance can
 * be shown on only one surface at a time, but the two surfaces mount and unmount
 * independently).
 *
 * One cache serves ONE registry slot; `slot` picks which. A surface that shows
 * both a custom inspector and gear-panel options holds two caches, so the two
 * elements can't collide on the same instance key.
 */

import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from './field-editor';

/** Which editorRegistry slot a cache serves. */
export type InspectorSlot = 'inspector' | 'options';

export class InspectorCache {
  private cache = new Map<string, HTMLElement>();

  constructor(private readonly slot: InspectorSlot = 'inspector') {}

  private factoryFor(moduleType: string) {
    return this.slot === 'options'
      ? editorRegistry.getOptionsFactory(moduleType)
      : editorRegistry.getInspectorFactory(moduleType);
  }

  /**
   * The inspector element for an instance, or null when the module type has no
   * registered factory (the caller then falls back to the generic inspector).
   */
  get(instanceKey: string, moduleType: string, binding: FieldBinding): HTMLElement | null {
    const factory = this.factoryFor(moduleType);
    if (!factory) return null;

    let el: HTMLElement | undefined = this.cache.get(instanceKey);
    // Recreate when the instance's module TYPE changed under the same key: the
    // "add" flow inserts a default effect and then changes the type (reusing the
    // instanceKey), so a cache keyed only on instanceKey would keep showing the
    // old type's inspector until a reload.
    if (el && (el as any).moduleType !== moduleType) {
      this.factoryFor((el as any).moduleType ?? '')?.destroy(el);
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
      this.factoryFor((el as any).moduleType ?? '')?.destroy(el);
    }
    this.cache.clear();
  }
}
