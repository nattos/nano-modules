/**
 * FieldLayoutManager — centralized bounding-box tracking for keyed elements.
 *
 * This is the ONE rect/anchor registry used across surfaces: the effect IDE
 * tracks field editors here (the wire overlay, field-option pips, field cards
 * read positions from it), and the arrangement tracks its wire/tap anchors
 * (clips, rails, traces, fields — see `arrangement/surfaces/anchor-registry.ts`,
 * a thin keying layer over an instance of this class). Elements have NO
 * knowledge of the manager — consumers register them by key.
 *
 * The manager tracks viewport-relative bounding boxes, batching recalculation
 * via requestAnimationFrame. A ResizeObserver on a container detects layout
 * shifts. `getViewportRect` returns the cached (rAF) rect; `liveRect` reads a
 * fresh rect on demand (for consumers that recompute every frame).
 */

import { observable, runInAction, makeObservable, untracked } from 'mobx';

export interface FieldRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FieldLayoutEntry {
  key: string;
  element: HTMLElement;
  /** Viewport-relative rect of the host element. Updated on recalculate. */
  viewportRect: DOMRect | null;
}

export class FieldLayoutManager {
  @observable.shallow entries = new Map<string, FieldLayoutEntry>();

  /** Monotonically increasing generation counter — bumped on every recalculate. */
  @observable generation = 0;

  private pendingRecalc = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    makeObservable(this);
  }

  register(key: string, element: HTMLElement) {
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
      // Only bump `generation` when a rect actually moved/resized (or a new
      // entry got its first rect). Consumers re-render off `generation`, so an
      // unconditional bump turns any stray per-update recalculate into a
      // perpetual full-surface re-render loop.
      let changed = false;
      for (const entry of this.entries.values()) {
        const r = entry.element.getBoundingClientRect();
        const p = entry.viewportRect;
        if (!p || p.top !== r.top || p.left !== r.left ||
            p.width !== r.width || p.height !== r.height) {
          changed = true;
        }
        entry.viewportRect = r;
      }
      if (changed) this.generation++;
    });
  }

  /**
   * Keys of all registered editors, read WITHOUT subscribing to the observable
   * `entries` map. Consumers (the wire overlay, pips, tap-hit boxes) read live
   * positions during render but must re-render off `generation` — which bumps
   * once per rAF in `recalculate()` — NOT off raw membership mutations. Reading
   * `entries` reactively created a render → scan → register → render feedback
   * loop (the scan runs in `updated()` and mutates `entries`), spinning the
   * expensive DOM walk every frame.
   */
  keysUntracked(): string[] {
    return untracked(() => Array.from(this.entries.keys()));
  }

  /** Get the bounding rect of a field editor relative to an ancestor element.
   *  Reads `entries` untracked — see keysUntracked() for why. */
  getRelativeRect(key: string, ancestor: HTMLElement): FieldRect | null {
    const entry = untracked(() => this.entries.get(key));
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

  /** Register (or, with `null`, unregister) an element under a key. Convenience
   *  for anchor-style consumers that re-assert their element on every render. */
  setAnchor(key: string, element: HTMLElement | null | undefined) {
    if (element) this.register(key, element);
    else this.unregister(key);
  }

  /** Live (uncached) viewport rect for `key`, self-pruning disconnected or
   *  zero-size elements. For consumers that read positions every frame (e.g. the
   *  arrangement wire overlay's rAF loop) and want the freshest geometry without
   *  waiting for the next recalculate. Reads `entries` untracked — see
   *  keysUntracked() for why. */
  liveRect(key: string): DOMRect | null {
    const entry = untracked(() => this.entries.get(key));
    if (!entry) return null;
    if (!entry.element.isConnected) {
      this.unregister(key);
      return null;
    }
    const r = entry.element.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return r;
  }

  private observedContainer: HTMLElement | null = null;

  /** Attach a ResizeObserver to auto-recalculate on layout shifts.
   *
   *  Idempotent per container: callers invoke this from Lit `updated()` on
   *  every render, and a fresh `observe()` ALWAYS fires an initial callback on
   *  the next frame. Re-observing the same element on each update therefore
   *  scheduled a recalculate every frame — which bumped `generation`, which
   *  re-rendered the caller, which re-observed... a perpetual re-render loop
   *  that kept the whole editor surface updating at display rate while idle. */
  observeContainer(container: HTMLElement) {
    if (this.observedContainer === container && this.resizeObserver) return;
    this.unobserveContainer();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRecalculate();
    });
    this.resizeObserver.observe(container);
    this.observedContainer = container;
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
