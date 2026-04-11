/**
 * FieldLayoutManager — centralized bounding box tracking for field editors.
 *
 * All consumers of field element positions (tap overlays, tap line visualization,
 * future rail lines) go through this single source. Field editors themselves have
 * NO knowledge of this manager — the edit-tab discovers and registers them
 * by scanning the DOM.
 *
 * The manager tracks viewport-relative bounding boxes, batching recalculation
 * via requestAnimationFrame. A ResizeObserver on the columns container detects
 * layout shifts.
 */

import { observable, runInAction, action, makeObservable } from 'mobx';
import type { FieldEditorElement } from './field-editor';

export interface FieldRect {
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

/** Position of a rail within the gutter. */
export interface RailPosition {
  railId: string;
  /** X offset within the gutter element (px from left edge of gutter). */
  x: number;
}

export class FieldLayoutManager {
  @observable.shallow entries = new Map<string, FieldLayoutEntry>();

  /** Monotonically increasing generation counter — bumped on every recalculate. */
  @observable generation = 0;

  /** Allocated rail positions within the gutter, keyed by rail ID. */
  @observable.shallow railPositions = new Map<string, RailPosition>();

  private pendingRecalc = false;
  private resizeObserver: ResizeObserver | null = null;

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

  /** Schedule a recalculation. Can be called externally when layout may have shifted. */
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

  /**
   * Update rail positions within the gutter.
   * Rails are spaced evenly within the gutter, starting from the left.
   * @param railIds Ordered list of rail IDs (column-scoped first, then sketch-scoped).
   * @param gutterWidth Total gutter width in px.
   * @param baseOffset Left padding before first rail (px).
   */
  @action
  updateRailPositions(railIds: string[], gutterWidth: number, baseOffset = 8) {
    this.railPositions.clear();
    const slotWidth = 16; // px per rail
    for (let i = 0; i < railIds.length; i++) {
      this.railPositions.set(railIds[i], {
        railId: railIds[i],
        x: baseOffset + i * slotWidth + slotWidth / 2,
      });
    }
  }

  /** Get the X position for a rail within the gutter. */
  getRailX(railId: string): number | null {
    return this.railPositions.get(railId)?.x ?? null;
  }

  /** Attach a ResizeObserver to auto-recalculate on layout shifts. */
  observeContainer(container: HTMLElement) {
    this.unobserveContainer();
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
  }

  dispose() {
    this.unobserveContainer();
    runInAction(() => {
      this.entries.clear();
    });
  }
}
