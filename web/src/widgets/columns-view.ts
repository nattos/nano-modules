/**
 * <columns-view> — Virtualized horizontal column container.
 *
 * Manages a set of columns provided by a ColumnHost. Columns entering the
 * viewport are attached to the DOM; columns leaving the viewport are detached
 * (triggering disconnectedCallback), but the host retains them in memory.
 *
 * Supports drag-resizable column widths and efficient coordinate-to-column lookup.
 */

import { html, css, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { PointerDragOp } from '../utils/pointer-drag-op';

/** Interface that the host must implement to provide column elements. */
export interface ColumnHost {
  /** Total number of columns. */
  readonly columnCount: number;
  /** Get or create the DOM element for column at index. Elements are cached by the host. */
  getColumnElement(index: number): HTMLElement;
  /** Called when a column enters the visible viewport. */
  columnAttached?(index: number, element: HTMLElement): void;
  /** Called when a column leaves the visible viewport. */
  columnDetached?(index: number, element: HTMLElement): void;
}

/** Interface for column elements that provide dynamic gutter width. */
export interface DynamicGutterColumn {
  getGutterWidth(): number;
}

@customElement('columns-view')
export class ColumnsView extends LitElement {
  @property({ attribute: false }) host: ColumnHost | null = null;
  @property({ type: Number }) columnMinWidth = 264;
  @property({ type: Number }) columnMaxWidth = 344;
  @property({ type: Number }) gap = 16;
  @property({ type: Number }) defaultGutterWidth = 8;

  /** Per-column widths. Lazily initialized to default width. */
  private columnWidths: number[] = [];
  /** Cached left edges for binary search. */
  private columnLeftEdges: number[] = [];
  /** Currently attached columns. */
  private attachedColumns = new Map<number, HTMLElement>();
  /** The inner content container. */
  private contentEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  /** Observes column element heights so we can size the content container for Y scroll. */
  private columnResizeObs: ResizeObserver | null = null;
  private resizeOp: PointerDragOp | null = null;

  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .scroll-container {
      flex: 1;
      min-width: 0;
      width: 0;
      overflow: auto;
      padding: 16px;
      box-sizing: border-box;
    }
    .content {
      position: relative;
      min-height: 100px;
    }
    .resize-handle {
      position: absolute;
      top: 0;
      width: 6px;
      height: 100%;
      cursor: col-resize;
      z-index: 5;
      /* Expand hit area beyond visual */
      margin-left: -3px;
    }
    .resize-handle::after {
      content: '';
      display: block;
      width: 2px;
      height: 100%;
      margin: 0 auto;
      background: transparent;
      transition: background 0.15s;
    }
    .resize-handle:hover::after {
      background: rgba(255,255,255,0.15);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.resizeObs = new ResizeObserver(() => this.updateVisibleRange());
    this.columnResizeObs = new ResizeObserver(() => this.updateContentHeight());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.columnResizeObs?.disconnect();
    this.columnResizeObs = null;
    // Detach all on disconnect
    for (const [idx, el] of this.attachedColumns) {
      el.remove();
      this.host?.columnDetached?.(idx, el);
    }
    this.attachedColumns.clear();
  }

  firstUpdated() {
    this.scrollEl = this.renderRoot.querySelector('.scroll-container') as HTMLElement;
    this.contentEl = this.renderRoot.querySelector('.content') as HTMLElement;
    if (this.scrollEl) {
      this.scrollEl.addEventListener('scroll', () => this.updateVisibleRange(), { passive: true });
      this.resizeObs?.observe(this.scrollEl);
    }
    this.recalcLayout();
    this.updateVisibleRange();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('host') || changed.has('columnMinWidth') || changed.has('columnMaxWidth') || changed.has('gap')) {
      this.recalcLayout();
      this.updateVisibleRange();
    }
  }

  /** Notify that a column's gutter width changed. Recalculates layout without detaching. */
  notifyGutterWidthChanged() {
    this.recalcLayout();
    this.updateVisibleRange();
  }

  /** Notify that the column count or data has changed. Detaches all, re-attaches visible. */
  notifyColumnCountChanged() {
    // Detach all currently attached columns so updateVisibleRange
    // will re-fetch from the host (which may have new elements).
    for (const [idx, el] of this.attachedColumns) {
      this.columnResizeObs?.unobserve(el);
      el.remove();
      this.host?.columnDetached?.(idx, el);
    }
    this.attachedColumns.clear();

    this.recalcLayout();
    this.updateVisibleRange();
  }

  /** Returns the column index at the given client X coordinate, or -1. */
  columnAtX(clientX: number): number {
    if (!this.scrollEl) return -1;
    const rect = this.scrollEl.getBoundingClientRect();
    const x = clientX - rect.left + this.scrollEl.scrollLeft - 16; // account for padding

    // Binary search the left edges
    let lo = 0;
    let hi = this.columnLeftEdges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const left = this.columnLeftEdges[mid];
      const right = left + this.getColumnTotalWidth(mid);
      if (x < left) hi = mid - 1;
      else if (x > right) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  private getDefaultWidth(): number {
    return Math.min(this.columnMaxWidth, Math.max(this.columnMinWidth, 300));
  }

  private getGutterWidth(idx: number): number {
    // Query the column-group element for its dynamic gutter width
    const el = this.attachedColumns.get(idx) as any;
    if (el?.getGutterWidth) return el.getGutterWidth();
    return this.defaultGutterWidth;
  }

  private getColumnTotalWidth(idx: number): number {
    return (this.columnWidths[idx] ?? this.getDefaultWidth()) + this.getGutterWidth(idx);
  }

  private recalcLayout() {
    const count = this.host?.columnCount ?? 0;

    // Grow columnWidths array if needed
    while (this.columnWidths.length < count) {
      this.columnWidths.push(this.getDefaultWidth());
    }

    // Recompute left edges
    this.columnLeftEdges = [];
    let x = 0;
    for (let i = 0; i < count; i++) {
      this.columnLeftEdges.push(x);
      x += this.getColumnTotalWidth(i) + this.gap;
    }

    // Set content width
    const totalWidth = x > 0 ? x - this.gap : 0;
    if (this.contentEl) {
      this.contentEl.style.width = `${totalWidth}px`;
    }
  }

  /** Set content height to the tallest attached column so Y scrolling works. */
  private updateContentHeight() {
    if (!this.contentEl) return;
    let maxH = 100; // minimum
    for (const [, el] of this.attachedColumns) {
      maxH = Math.max(maxH, el.scrollHeight);
    }
    this.contentEl.style.height = `${maxH}px`;
  }

  private updateVisibleRange() {
    if (!this.scrollEl || !this.contentEl || !this.host) return;

    const count = this.host.columnCount;
    if (count === 0) {
      // Detach everything
      for (const [idx, el] of this.attachedColumns) {
        el.remove();
        this.host.columnDetached?.(idx, el);
      }
      this.attachedColumns.clear();
      return;
    }

    const scrollLeft = this.scrollEl.scrollLeft;
    const viewWidth = this.scrollEl.clientWidth;
    const viewLeft = scrollLeft - 16; // padding offset
    const viewRight = viewLeft + viewWidth;

    // Find visible range via linear scan (column count is typically small)
    let visibleStart = -1;
    let visibleEnd = -1;
    for (let i = 0; i < count; i++) {
      const left = this.columnLeftEdges[i] ?? 0;
      const right = left + this.getColumnTotalWidth(i);
      if (right >= viewLeft && left <= viewRight) {
        if (visibleStart < 0) visibleStart = i;
        visibleEnd = i;
      }
    }

    if (visibleStart < 0) {
      visibleStart = 0;
      visibleEnd = -1;
    }

    // Detach columns that left the viewport
    for (const [idx, el] of this.attachedColumns) {
      if (idx < visibleStart || idx > visibleEnd) {
        this.columnResizeObs?.unobserve(el);
        el.remove();
        this.host.columnDetached?.(idx, el);
        this.attachedColumns.delete(idx);
      }
    }

    // Attach columns that entered the viewport
    for (let i = visibleStart; i <= visibleEnd; i++) {
      if (!this.attachedColumns.has(i)) {
        const el = this.host.getColumnElement(i);
        el.style.position = 'absolute';
        el.style.left = `${this.columnLeftEdges[i]}px`;
        el.style.top = '0';
        // Set column content width as a property — the element sizes itself via CSS.
        (el as any).columnWidth = this.columnWidths[i] ?? this.getDefaultWidth();
        this.contentEl.appendChild(el);
        this.attachedColumns.set(i, el);
        this.columnResizeObs?.observe(el);
        this.host.columnAttached?.(i, el);
      } else {
        // Update position and width property in case they changed
        const el = this.attachedColumns.get(i)!;
        el.style.left = `${this.columnLeftEdges[i]}px`;
        (el as any).columnWidth = this.columnWidths[i] ?? this.getDefaultWidth();
      }
    }

    this.updateContentHeight();

    // Update resize handles
    this.updateResizeHandles(count);
  }

  private updateResizeHandles(count: number) {
    if (!this.contentEl) return;

    // Remove old handles
    this.contentEl.querySelectorAll('.resize-handle').forEach(h => h.remove());

    // Add handles between columns
    for (let i = 0; i < count - 1; i++) {
      const left = this.columnLeftEdges[i] + this.getColumnTotalWidth(i) + this.gap / 2;
      const handle = document.createElement('div');
      handle.className = 'resize-handle';
      handle.style.left = `${left}px`;
      handle.addEventListener('pointerdown', (e) => this.onResizeStart(e, i));
      this.contentEl.appendChild(handle);
    }
  }

  private onResizeStart(e: PointerEvent, colIdx: number) {
    if (e.button !== 0) return;
    e.preventDefault();

    const startWidth = this.columnWidths[colIdx] ?? this.getDefaultWidth();
    const startX = e.clientX;

    this.resizeOp = new PointerDragOp(e, e.target as HTMLElement, {
      threshold: 0,
      move: (me) => {
        const delta = me.clientX - startX;
        const newWidth = Math.max(this.columnMinWidth, Math.min(this.columnMaxWidth, startWidth + delta));
        this.columnWidths[colIdx] = newWidth;
        this.recalcLayout();
        this.updateVisibleRange();
      },
      accept: () => { this.resizeOp = null; },
      cancel: () => {
        this.columnWidths[colIdx] = startWidth;
        this.recalcLayout();
        this.updateVisibleRange();
        this.resizeOp = null;
      },
    });
  }

  render() {
    return html`
      <div class="scroll-container">
        <div class="content"></div>
      </div>
    `;
  }
}
