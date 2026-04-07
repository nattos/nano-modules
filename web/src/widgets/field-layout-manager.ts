/**
 * FieldLayoutManager — centralized bounding box tracking for field editors.
 *
 * All consumers of field element positions (tap overlays, tap line visualization,
 * future rail lines) go through this single source. The manager tracks both
 * local (relative to host element) and viewport-relative bounding boxes,
 * batching recalculation via requestAnimationFrame.
 */

import { observable, runInAction, makeObservable } from 'mobx';
import type { FieldEditorElement, FieldLayoutManager as IFieldLayoutManager } from './field-editor';

export interface FieldRect {
  /** Y center relative to a reference element (set during getRelativeRect). */
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FieldLayoutEntry {
  key: string;
  element: FieldEditorElement;
  /** Viewport-relative rect of the host element. Updated on recalculate. */
  viewportRect: DOMRect | null;
}

export class FieldLayoutManager implements IFieldLayoutManager {
  @observable.shallow entries = new Map<string, FieldLayoutEntry>();

  /** Monotonically increasing generation counter — bumped on every recalculate. */
  @observable generation = 0;

  private pendingRecalc = false;
  private resizeObserver: ResizeObserver | null = null;
  private observedContainer: HTMLElement | null = null;

  constructor() {
    makeObservable(this);
  }

  register(key: string, element: FieldEditorElement) {
    const existing = this.entries.get(key);
    if (existing && existing.element === element) return;
    runInAction(() => {
      this.entries.set(key, { key, element, viewportRect: null });
    });
    this.scheduleRecalculate();
  }

  unregister(key: string) {
    if (!this.entries.has(key)) return;
    runInAction(() => {
      this.entries.delete(key);
    });
  }

  notifyLayoutChanged() {
    this.scheduleRecalculate();
  }

  private scheduleRecalculate() {
    if (this.pendingRecalc) return;
    this.pendingRecalc = true;
    requestAnimationFrame(() => {
      this.pendingRecalc = false;
      this.recalculate();
    });
  }

  private recalculate() {
    runInAction(() => {
      for (const entry of this.entries.values()) {
        entry.viewportRect = entry.element.getBoundingClientRect();
      }
      this.generation++;
    });
  }

  /** Get the bounding rect of a field editor relative to an ancestor element. */
  getRelativeRect(key: string, ancestor: HTMLElement): FieldRect | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const elRect = entry.element.getBoundingClientRect();
    const ancRect = ancestor.getBoundingClientRect();
    return {
      top: elRect.top - ancRect.top,
      left: elRect.left - ancRect.left,
      width: elRect.width,
      height: elRect.height,
    };
  }

  /** Get viewport-relative rect (uses cached value from last recalculate). */
  getViewportRect(key: string): DOMRect | null {
    return this.entries.get(key)?.viewportRect ?? null;
  }

  /** Attach a ResizeObserver to auto-recalculate on layout shifts. */
  observeContainer(container: HTMLElement) {
    this.unobserveContainer();
    this.observedContainer = container;
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRecalculate();
    });
    this.resizeObserver.observe(container);
  }

  unobserveContainer() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.observedContainer = null;
  }

  dispose() {
    this.unobserveContainer();
    runInAction(() => {
      this.entries.clear();
    });
  }
}
