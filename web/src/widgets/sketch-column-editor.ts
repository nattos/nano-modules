/**
 * <sketch-column-editor> — the single-column sketch editor body shared by the
 * Effect IDE's Project Editor tab and the Resolume shell's Edit tab (they
 * used to be two independent reimplementations — `ide-project-editor.ts` and
 * `edit-tab.ts` — that could silently drift; this is the one canonical
 * columns-editor now).
 *
 * Fully driven by the `sketchId` property — the caller decides which sketch
 * that is (`userSettings.selectedProjectId` for the IDE,
 * `appState.local.editingSketchId` for Resolume). Renders only the
 * columns-editor body (`.columns-wrap`: `<columns-view>` + `<taps-overlay>`);
 * the surrounding left-panel/splitter/monitor chrome lives in `<app-shell>`.
 *
 * Uses <columns-view> for virtualized column management (a single column —
 * multi-column mode is retired, the data model has been single-`chain` for a
 * while). Each column is a <column-group> custom element.
 *
 * IMPORTANT: Field editors and custom inspectors have NO knowledge of tapping,
 * selection, or layout tracking. The column-group renders overlay layers on
 * top of effect cards, using bounding boxes from the FieldLayoutManager.
 */

import { html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { ensureChain, chainEntryAt, sketchChain } from '../sketch-types';
import type { ModuleEntry } from '../sketch-types';
import { PointerDragOp } from '../utils/pointer-drag-op';
import { categoryColor, effectDomain } from './category-color';
import { sanitizeIconName, thumbnailDataUri } from './effect-glyph';
import './ui-icon';

import type { FieldBinding } from './field-editor';
import type { ColumnHost } from './columns-view';
import type { ColumnGroupCallbacks } from './column-group';
import { ColumnGroup } from './column-group';
import './columns-view';
import './column-group';
import { ideColumnAdapter } from '../state/ide-column-adapter';
import './taps-overlay';
import { editorRegistry } from '../editor-registry';
import { isTypingInEditable, isFieldControlFocused } from '../utils/keyboard';
import { handleCommonEditShortcut } from '../utils/common-edit-shortcuts';

// Import inspector registrations (self-registering) — single barrel shared by
// every surface so the lists can't drift.
import '../editors/all-inspectors';

@customElement('sketch-column-editor')
export class SketchColumnEditor extends MobxLitElement implements ColumnHost, ColumnGroupCallbacks {
  /** The sketch to edit. Null / missing from the database renders `emptyMessage`. */
  @property({ attribute: false }) sketchId: string | null = null;
  /** Shown when `sketchId` is unset or not (yet) in the database. */
  @property({ type: String }) emptyMessage = 'No sketch selected.';

  // Cached column-group elements by column index.
  private columnCache = new Map<number, HTMLElement>();
  // Cached inspector elements by instance key.
  private inspectorCache = new Map<string, HTMLElement>();

  // The sketch the caches above were built for. Both caches hold per-sketch
  // elements (column-groups carry their sketchId; inspectors bind instance
  // keys), so switching the edited sketch while this stays mounted must reset
  // them — paired with the keyed() remount of columns-view in render(), which
  // drops the stale DOM.
  private cachedSketchId: string | null = null;

  // Drag state.
  private dragSketchId: string | null = null;
  private dragSourceCol = -1;
  private dragSourceIdx = -1;
  private dragCardEl: HTMLElement | null = null;
  private dragOp: PointerDragOp | null = null;
  private dragHoverTarget: { colIdx: number; insertIdx: number } | null = null;
  // True while a card reorder is in flight — drives the floating compact
  // headers popup (see renderReorderPopup). Not observable; toggled with an
  // explicit requestUpdate() so the popup mounts/unmounts on drag start/end.
  private dragActive = false;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .readonly-ribbon {
      flex-shrink: 0;
      padding: 5px 12px;
      font-size: var(--app-fs-sm);
      color: var(--app-warn);
      background: var(--app-bg-color2);
      border-bottom: 1px solid var(--app-tint-3);
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      color: var(--app-text-color2);
      font-size: var(--app-fs-lg);
      text-align: center;
      line-height: 1.6;
    }
    .columns-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
      /* min-height: 0 is load-bearing: .columns-wrap is a main-axis item of a
         column-flex host, so the default min-height:auto would let it grow to
         its content height. columns-view sizes its scroll content to
         max(columns, clientHeight×1.5) (the scroll-past-end tail), so an
         unpinned clientHeight feeds back and diverges to the browser height
         clamp — leaving nothing to scroll. */
      min-height: 0;
      display: flex;
    }
    columns-view {
      flex: 1;
      min-width: 0;
    }

    /* Floating compact-headers popup shown while dragging a card to reorder.
     * Fixed-positioned just past the sketch panel's right edge so it floats
     * over the main output monitor — a short, always-visible list of the chain
     * you can drop into without scrolling the (uncollapsed) real cards. */
    .reorder-popup {
      position: fixed;
      z-index: 200;
      width: 190px;
      max-height: 60vh;
      overflow-y: auto;
      box-sizing: border-box;
      padding: 4px;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 3px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      /* Pointer capture keeps events on the dragged header — the popup is a
         hit-tested drop zone (via getBoundingClientRect), never an event
         target, so it must not intercept the pointer. */
      pointer-events: none;
      user-select: none;
    }
    .reorder-popup-title {
      font-size: var(--app-fs-sm);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: 2px 6px 6px;
    }
    .reorder-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      margin-bottom: 3px;
      box-sizing: border-box;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
    }
    .reorder-row:last-child { margin-bottom: 0; }
    /* The card being dragged, dimmed in the list (it stays in the chain until
       the drop commits — matching the real column's dragging card). */
    .reorder-row[data-dragged] { opacity: 0.4; }
    .reorder-row-name {
      flex: 1;
      min-width: 0;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .reorder-glyph {
      flex: 0 0 auto;
      width: 14px; height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .reorder-glyph.reorder-thumb { border-radius: 2px; object-fit: cover; }
    .reorder-dot {
      flex: 0 0 auto;
      width: 6px; height: 6px;
      border-radius: 50%;
      opacity: 0.8;
    }
    /* Insertion marker inside the popup — mirrors the in-column one. */
    .reorder-popup-marker {
      position: absolute;
      left: 4px; right: 4px;
      height: 3px;
      margin-top: -1px;
      background: var(--app-hi-color2, #4169E1);
      border-radius: 1px;
      box-shadow: 0 0 6px rgba(65, 105, 225, 0.5);
      pointer-events: none;
      display: none;
    }
    .reorder-popup-marker.visible { display: block; }
  `;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleGlobalKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleGlobalKeyDown);
    // Abort any in-flight reorder so its window listeners + Escape handler don't
    // outlive the element (dispose → cancel → cleanupDrag).
    this.dragOp?.dispose();
    this.clearSketchCaches();
  }

  private clearSketchCaches() {
    for (const [, el] of this.inspectorCache) {
      const factory = editorRegistry.getInspectorFactory((el as any).moduleType ?? '');
      factory?.destroy(el);
    }
    this.inspectorCache.clear();
    this.columnCache.clear();
  }

  /**
   * Delete/Backspace on a selected effect card removes the effect. Ignored when
   * focus is in an editable element (so typing in inputs still works).
   */
  private handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (!this.isConnected) return;
    if (isTypingInEditable(e)) return;
    // Copy/Cut/Paste/Undo/Redo (⌘/Ctrl+C/X/V/Z), shared across every surface
    // so they can't drift apart on these.
    if (handleCommonEditShortcut(e)) return;
    // `W` toggles wires (taps) mode (global, when not typing) — same key as the
    // arrangement view, so all surfaces are consistent.
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      appController.setTappingMode(!appState.local.tappingMode);
      return;
    }
    // `?` toggles help mode (global, when not typing) — a sibling of W, same
    // key across all surfaces.
    if (e.key === '?') {
      e.preventDefault();
      appController.setHelpMode(!appState.local.helpMode);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== '0') return;
    // A focused field control on the selected card (knob/slider/number/…) owns
    // Delete/Backspace (reset to default) and `0` — never let the key fall
    // through to deleting or bypassing the effect card itself. The card stays
    // app-selected while a field only holds DOM focus, so guard on focus here.
    if (isFieldControlFocused(e)) return;
    // A multi-selected GROUP (2+ cards) deletes as one undo point; falls
    // through when the multi-selection isn't an actionable group.
    if ((e.key === 'Delete' || e.key === 'Backspace')
      && appController.removeMultiSelectedEffects()) {
      e.preventDefault();
      return;
    }
    const selection = appState.local.selection;
    if (!selection) return;
    // A selected wire (`wire/<sketchId>/<wireId>`) breaks on Delete/Backspace —
    // it was selected, not deleted, on click, so this is the deliberate removal.
    if (selection.path.startsWith('wire/') && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      const parts = selection.path.split('/');
      appController.removeWire(parts[1], parts.slice(2).join('/'));
      return;
    }
    const parts = selection.path.split('/');
    if (parts[0] !== 'effect' || parts.length < 4) return;
    const sketchId = parts[1];
    const colIdx = parseInt(parts[2], 10);
    const chainIdx = parseInt(parts[3], 10);
    if (Number.isNaN(colIdx) || Number.isNaN(chainIdx)) return;

    if (e.key === '0') {
      // Toggle the selected device on/off (bypass), mirroring the header light.
      const entry = chainEntryAt(appState.database.sketches[sketchId], chainIdx);
      if (!entry || entry.type !== 'module') return;
      const st = appState.database.sketches[sketchId]
        ?.instances?.[entry.instance_key]?.state as Record<string, unknown> | undefined;
      const bypass = st?.__bypass__ === true || st?.__bypass__ === 1;
      e.preventDefault();
      appController.setEffectParam(sketchId, colIdx, chainIdx, '__bypass__', !bypass);
      return;
    }

    e.preventDefault();
    appController.select(null);
    appController.removeEffectFromChain(sketchId, colIdx, chainIdx);
  };

  render() {
    const sketchId = this.sketchId;
    if (!sketchId || !appState.database.sketches[sketchId]) {
      return html`<div class="empty">${this.emptyMessage}</div>`;
    }

    // Per-sketch cache reset — see cachedSketchId.
    if (sketchId !== this.cachedSketchId) {
      this.cachedSketchId = sketchId;
      this.clearSketchCaches();
    }

    const readonly = appState.local.readonly;
    // An unlaunched placeholder instance will never "sync" — it has no live
    // bridge registration until Resolume launches its clip. Say so instead of
    // implying an in-flight sync that isn't coming.
    const unlaunched = readonly && appState.local.barrelInstances.some(
      i => i.key === sketchId && i.unlaunched);
    const ribbonText = unlaunched
      ? 'Read-only — launch this clip in Resolume to edit.'
      : 'Read-only — syncing with Resolume…';
    return html`
      ${readonly ? html`<div class="readonly-ribbon">${ribbonText}</div>` : ''}
      ${keyed(sketchId, html`
      <div class="columns-wrap" ?inert=${readonly}>
        <columns-view .host=${this as ColumnHost}
          fitWidth
          .defaultGutterWidth=${ColumnGroup.GUTTER_WIDTH}
          @click=${(e: Event) => {
            // Deselect when clicking on empty space (not handled by a child)
            if (e.target === e.currentTarget) appController.select(null);
          }}
        ></columns-view>
        <taps-overlay .sketchId=${sketchId}></taps-overlay>
      </div>`)}
      ${this.dragActive ? this.renderReorderPopup(sketchId) : nothing}
    `;
  }

  /**
   * The floating compact-headers popup shown during a reorder drag. Lists every
   * chain entry as a short icon+name row, positioned just past the sketch
   * panel's right edge (over the monitor). Rendered once when the drag starts;
   * the insertion marker inside it is moved imperatively during the drag (see
   * updatePopupHover), so this doesn't re-render per pointer move.
   */
  private renderReorderPopup(sketchId: string) {
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return nothing;
    const chain = sketchChain(sketch);
    const rect = this.getBoundingClientRect();
    const left = Math.round(rect.right + 8);
    const top = Math.round(rect.top + 48);
    return html`
      <div class="reorder-popup" style=${`left:${left}px;top:${top}px`}>
        <div class="reorder-popup-title">Move effect</div>
        <div class="reorder-popup-list">
          ${chain.map((entry, i) => html`
            <div class="reorder-row" data-insert-idx=${i}
              ?data-dragged=${i === this.dragSourceIdx}>
              ${this.renderPopupGlyph(entry.module_type)}
              <span class="reorder-row-name" title=${entry.module_type}
                >${this.effectName(entry.module_type)}</span>
            </div>
          `)}
        </div>
        <div class="reorder-popup-marker"></div>
      </div>
    `;
  }

  /** Human name for an effect id — availableEffects label, else the last segment. */
  private effectName(moduleType: string): string {
    const eff = appState.local.availableEffects?.find(e => e.id === moduleType);
    return eff?.name || (moduleType.split('.').pop() ?? moduleType);
  }

  /** Leading glyph for a popup row — the effect's thumbnail/icon tinted with its
   *  category accent, else a plain category dot. Mirrors the card header glyph. */
  private renderPopupGlyph(moduleType: string) {
    const domain = effectDomain(moduleType);
    const eff = appState.local.availableEffects?.find(e => e.id === moduleType);
    const thumb = thumbnailDataUri(eff?.thumbnail);
    if (thumb) {
      return html`<img class="reorder-glyph reorder-thumb" src=${thumb} alt="" title=${domain}>`;
    }
    const icon = sanitizeIconName(eff?.icon);
    if (icon) {
      return html`<ui-icon class="reorder-glyph" icon=${icon} title=${domain}
        style=${`--icon-color:${categoryColor(domain)};--icon-size:13px`}></ui-icon>`;
    }
    return html`<span class="reorder-dot" title=${domain}
      style=${`background:${categoryColor(domain)}`}></span>`;
  }

  // ========================================================================
  // ColumnHost implementation
  // ========================================================================

  get columnCount(): number {
    const sketchId = this.sketchId;
    if (!sketchId) return 0;
    // Single linear stack — one chain, one column.
    return appState.database.sketches[sketchId] ? 1 : 0;
  }

  getColumnElement(index: number): HTMLElement {
    const sketchId = this.sketchId ?? '';
    const cached = this.columnCache.get(index);
    if (cached) {
      // Refresh sketchId in case the selection materialized to a new id
      // (e.g. a default project promoted to a fresh user: id) without the
      // cache having been cleared.
      (cached as any).sketchId = sketchId;
      return cached;
    }

    const colGroup = document.createElement('column-group') as any;
    colGroup.colIdx = index;
    colGroup.sketchId = sketchId;
    colGroup.isPlaceholder = false;
    colGroup.callbacks = this;
    colGroup.adapter = ideColumnAdapter;
    this.columnCache.set(index, colGroup as HTMLElement);
    return colGroup as HTMLElement;
  }

  columnAttached(_index: number, _element: HTMLElement): void {
    // Column-group's connectedCallback handles MobX setup
  }

  columnDetached(_index: number, _element: HTMLElement): void {
    // Column-group's disconnectedCallback handles cleanup
  }

  // ========================================================================
  // ColumnGroupCallbacks implementation
  // ========================================================================

  onCardPointerDown(e: PointerEvent, sketchId: string, colIdx: number, chainIdx: number): void {
    if (e.button !== 0) return;

    const header = e.currentTarget as HTMLElement;
    const card = header.closest('.effect-card') as HTMLElement | null;
    if (!card) return;

    this.dragSketchId = sketchId;
    this.dragSourceCol = colIdx;
    this.dragSourceIdx = chainIdx;
    this.dragCardEl = card;

    this.dragOp = new PointerDragOp(e, header, {
      threshold: 5,
      move: (me) => {
        card.setAttribute('dragging', '');
        // First movement past the threshold: raise the floating compact-headers
        // popup and start listening for Escape (cancel). The real cards stay
        // expanded — the popup, not a collapse, is the short list to drop into.
        if (!this.dragActive) {
          this.dragActive = true;
          document.addEventListener('keydown', this.handleDragKeyDown, true);
          this.requestUpdate();
        }
        this.updateDragHover(me.clientX, me.clientY);
      },
      accept: () => this.commitDrop(),
      cancel: () => this.cleanupDrag(),
    });
  }

  /** Escape cancels an in-flight reorder (disposing the drag op fires cancel →
   *  cleanupDrag). Captured so it wins over other global handlers. */
  private handleDragKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.dragOp) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragOp.dispose();
  };

  onGutterWidthChanged(): void {
    const columnsView = this.renderRoot.querySelector('columns-view') as any;
    columnsView?.notifyGutterWidthChanged?.();
  }

  getInspectorElement(instanceKey: string, moduleType: string, binding: FieldBinding): HTMLElement | null {
    const inspectorFactory = editorRegistry.getInspectorFactory(moduleType);
    if (!inspectorFactory) return null;

    let el = this.inspectorCache.get(instanceKey);
    // Recreate when the instance's module TYPE changed under the same key: the
    // "add" flow inserts a default effect and then changes the type (reusing the
    // instanceKey), so a cache keyed only on instanceKey would keep showing the
    // old type's inspector until a reload.
    if (el && (el as any).moduleType !== moduleType) {
      editorRegistry.getInspectorFactory((el as any).moduleType ?? '')?.destroy(el);
      this.inspectorCache.delete(instanceKey);
      el = undefined;
    }
    if (!el) {
      el = inspectorFactory.create(instanceKey, binding);
      (el as any).moduleType = moduleType;
      this.inspectorCache.set(instanceKey, el);
    } else {
      (el as any).binding = binding;
    }
    return el;
  }

  // ========================================================================
  // Drag & Drop (PointerDragOp-based)
  // ========================================================================

  /**
   * Route the pointer to a drop target and draw the insertion marker there:
   * the floating popup takes priority when hovered, otherwise the real sketch
   * column. Hovering neither area clears the target so the drop cancels.
   */
  private updateDragHover(px: number, py: number) {
    for (const [, el] of this.columnCache) (el as ColumnGroup).hideInsertMarker?.();
    this.hidePopupMarker();
    this.dragHoverTarget = null;

    // 1) Over the floating compact-headers popup?
    const popup = this.renderRoot.querySelector('.reorder-popup') as HTMLElement | null;
    if (popup && this.pointInRect(px, py, popup.getBoundingClientRect())) {
      this.updatePopupHover(popup, py);
      return;
    }
    // 2) Over the real sketch column area?
    const columnsView = this.renderRoot.querySelector('columns-view') as HTMLElement | null;
    if (columnsView && this.pointInRect(px, py, columnsView.getBoundingClientRect())) {
      this.updateColumnHover(px, py);
      return;
    }
    // 3) Outside both — no target; the drop will cancel.
  }

  private pointInRect(x: number, y: number, r: DOMRect): boolean {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** Marker + target over the real cards — the globally closest insertion point. */
  private updateColumnHover(px: number, py: number) {
    let bestDist = Infinity;
    let bestPoint: { colIdx: number; insertIdx: number; x: number; y: number; element: HTMLElement } | null = null;

    for (const [, el] of this.columnCache) {
      const colGroup = el as ColumnGroup;
      if (!colGroup.getInsertionPoints) continue;
      for (const pt of colGroup.getInsertionPoints()) {
        const dx = px - pt.x;
        const dy = py - pt.y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; bestPoint = { ...pt, element: el }; }
      }
    }
    if (!bestPoint) return;

    this.dragHoverTarget = { colIdx: bestPoint.colIdx, insertIdx: bestPoint.insertIdx };
    const colGroup = bestPoint.element as ColumnGroup;
    const colEl = colGroup.renderRoot?.querySelector('.column') as HTMLElement | null;
    if (colEl) {
      const colRect = colEl.getBoundingClientRect();
      colGroup.showInsertMarker(bestPoint.y - colRect.top);
    }
  }

  /** Marker + target over the popup — the closest gap between compact rows. */
  private updatePopupHover(popup: HTMLElement, py: number) {
    const rows = [...popup.querySelectorAll('.reorder-row')] as HTMLElement[];
    if (rows.length === 0) return;
    const popRect = popup.getBoundingClientRect();

    let bestDist = Infinity;
    let bestIdx = 0;
    let bestY = popRect.top;
    for (const row of rows) {
      const idx = parseInt(row.dataset.insertIdx ?? '0', 10);
      const r = row.getBoundingClientRect();
      const d = Math.abs(py - r.top);
      if (d < bestDist) { bestDist = d; bestIdx = idx; bestY = r.top; }
    }
    // Trailing gap: below the last row appends at chain.length.
    const last = rows[rows.length - 1];
    const lr = last.getBoundingClientRect();
    const dLast = Math.abs(py - lr.bottom);
    if (dLast < bestDist) { bestDist = dLast; bestIdx = rows.length; bestY = lr.bottom; }

    this.dragHoverTarget = { colIdx: 0, insertIdx: bestIdx };
    const marker = popup.querySelector('.reorder-popup-marker') as HTMLElement | null;
    if (marker) {
      marker.style.top = `${bestY - popRect.top + popup.scrollTop}px`;
      marker.classList.add('visible');
    }
  }

  private hidePopupMarker() {
    const marker = this.renderRoot.querySelector('.reorder-popup-marker') as HTMLElement | null;
    marker?.classList.remove('visible');
  }

  /** Commit the drop — splice the dragged module to the hovered insert index. */
  private commitDrop() {
    if (!this.dragSketchId || !this.dragHoverTarget) { this.cleanupDrag(); return; }

    const sketchId = this.dragSketchId;
    const sketch = appState.database.sketches[sketchId];
    const sourceEntry = chainEntryAt(sketch, this.dragSourceIdx);
    if (!sketch || !sourceEntry || sourceEntry.type !== 'module') { this.cleanupDrag(); return; }

    const { insertIdx: targetInsertIdx } = this.dragHoverTarget;
    const sourceIdx = this.dragSourceIdx;
    this.cleanupDrag();

    // Single linear stack: every drop is a reorder within the one chain.
    appController.mutate('Move effect', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const chain = ensureChain(sk);
      const [removed] = chain.splice(sourceIdx, 1);
      if (!removed) return;
      let adjustedIdx = targetInsertIdx;
      if (targetInsertIdx > sourceIdx) adjustedIdx--;
      chain.splice(adjustedIdx, 0, removed);
    });
  }

  private cleanupDrag() {
    this.dragCardEl?.removeAttribute('dragging');
    for (const [, el] of this.columnCache) (el as ColumnGroup).hideInsertMarker?.();
    this.hidePopupMarker();
    document.removeEventListener('keydown', this.handleDragKeyDown, true);
    this.dragSketchId = null;
    this.dragSourceCol = -1;
    this.dragSourceIdx = -1;
    this.dragCardEl = null;
    this.dragOp = null;
    this.dragHoverTarget = null;
    // Tear down the floating popup.
    if (this.dragActive) {
      this.dragActive = false;
      this.requestUpdate();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sketch-column-editor': SketchColumnEditor;
  }
}
