import type { ModuleClient } from './module-client';

export interface EditorFactory {
  create(pluginKey: string, client: ModuleClient): HTMLElement;
  destroy(element: HTMLElement): void;
}

class EditorRegistryImpl {
  private factories = new Map<string, EditorFactory>();

  register(packageId: string, factory: EditorFactory) {
    this.factories.set(packageId, factory);
  }

  getFactory(packageId: string): EditorFactory | undefined {
    return this.factories.get(packageId);
  }
}

export const editorRegistry = new EditorRegistryImpl();
