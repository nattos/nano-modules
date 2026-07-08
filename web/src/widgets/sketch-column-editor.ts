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

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { ensureChain, chainEntryAt } from '../sketch-types';
import { PointerDragOp } from '../utils/pointer-drag-op';

import type { FieldBinding } from './field-editor';
import type { ColumnHost } from './columns-view';
import type { ColumnGroupCallbacks } from './column-group';
import { ColumnGroup } from './column-group';
import './columns-view';
import './column-group';
import { ideColumnAdapter } from '../state/ide-column-adapter';
import './taps-overlay';
import { editorRegistry } from '../editor-registry';
import { isTypingInEditable } from '../utils/keyboard';
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
  `;

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleGlobalKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleGlobalKeyDown);
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
    `;
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
        this.updateDragHover(me.clientX, me.clientY);
      },
      accept: () => this.commitDrop(),
      cancel: () => this.cleanupDrag(),
    });
  }

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
   * Find the globally closest insertion point to the pointer and show the
   * marker. Single-column → no placeholder/new-column drops.
   */
  private updateDragHover(px: number, py: number) {
    for (const [, el] of this.columnCache) (el as ColumnGroup).hideInsertMarker?.();
    this.dragHoverTarget = null;

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
    this.dragSketchId = null;
    this.dragSourceCol = -1;
    this.dragSourceIdx = -1;
    this.dragCardEl = null;
    this.dragOp = null;
    this.dragHoverTarget = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sketch-column-editor': SketchColumnEditor;
  }
}
