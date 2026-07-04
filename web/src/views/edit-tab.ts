/**
 * <edit-tab> — Single-column sketch editor with drag-drop, field widgets,
 * and configurable rail/tap routing.
 *
 * Layout mirrors the Effect IDE's main area (`effect-ide-app.ts`): a
 * resizable `.left-panel` holding the column editor, an `<ide-splitter>`,
 * and a `.right-panel` holding the shared `<sketch-monitor>` (preview +
 * bottom transport strip). The width is persisted as
 * `userSettings.editLeftPanelWidth`, the IDE's own `ideLeftPanelWidth`
 * counterpart.
 *
 * Uses <columns-view> for virtualized column management. Each column is a
 * <column-group> custom element; columns outside the viewport are detached
 * from the DOM (pausing MobX reactions and trace registrations).
 *
 * IMPORTANT: Field editors and custom inspectors have NO knowledge of tapping,
 * selection, or layout tracking. The column-group renders overlay layers on
 * top of effect cards, using bounding boxes from the FieldLayoutManager.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { ensureChain, chainEntryAt } from '../sketch-types';
import { PointerDragOp } from '../utils/pointer-drag-op';

import type { FieldBinding } from '../widgets/field-editor';
import type { ColumnHost } from '../widgets/columns-view';
import type { ColumnGroupCallbacks } from '../widgets/column-group';
import type { ColumnGroup } from '../widgets/column-group';
import '../widgets/columns-view';
import '../widgets/column-group';
import { ideColumnAdapter } from '../state/ide-column-adapter';
import '../widgets/taps-overlay';
import '../widgets/sketch-monitor';
import '../widgets/splitter';
import '../widgets/spark-chart';
import { editorRegistry } from '../editor-registry';
import { isTypingInEditable } from '../utils/keyboard';
import { handleCommonEditShortcut } from '../utils/common-edit-shortcuts';

// Import inspector registrations (self-registering) — single barrel shared with
// the effects IDE so the lists can't drift.
import '../editors/all-inspectors';

@customElement('edit-tab')
export class EditTab extends MobxLitElement implements ColumnHost, ColumnGroupCallbacks {
  // Cached column-group elements by column index
  private columnCache = new Map<number, HTMLElement>();

  // Cached inspector elements by instance key
  private inspectorCache = new Map<string, HTMLElement>();

  // Drag state
  private dragSketchId: string | null = null;
  private dragSourceCol = -1;
  private dragSourceIdx = -1;
  private dragCardEl: HTMLElement | null = null;
  private dragOp: PointerDragOp | null = null;
  private dragHoverTarget: { type: 'zone'; colIdx: number; insertIdx: number }
    | { type: 'placeholder'; colIdx: number } | null = null;

  get columnCount(): number {
    const sketchId = appState.local.editingSketchId;
    if (!sketchId) return 0;
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return 0;
    // Single linear stack — one chain, one column. (Multi-column mode is
    // retired; the data model has been single-`chain` for a while.)
    return 1;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.handleGlobalKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.handleGlobalKeyDown);
    for (const [, el] of this.inspectorCache) {
      const factory = editorRegistry.getInspectorFactory(
        (el as any).moduleType ?? '');
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
    // Copy/Cut/Paste/Undo/Redo (⌘/Ctrl+C/X/V/Z), shared with the effect IDE
    // so the two surfaces can't drift apart on these.
    if (handleCommonEditShortcut(e)) return;
    // `W` toggles wires (taps) mode (global, when not typing) — same key as the
    // arrangement view, so the two surfaces are consistent.
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      appController.setTappingMode(!appState.local.tappingMode);
      return;
    }
    // `?` toggles help mode (global, when not typing) — a sibling of W/A, and
    // the same key as the arrangement view for consistency.
    if (e.key === '?') {
      e.preventDefault();
      appController.setHelpMode(!appState.local.helpMode);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== '0') return;
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
    const colIdx = parseInt(parts[2]);
    const chainIdx = parseInt(parts[3]);
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

  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .left-panel {
      background: var(--app-bg-color2);
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-width: 0;
    }
    .columns-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
      /* min-height: 0 is load-bearing: .columns-wrap is a main-axis item of
         the column-flex .left-panel, so the default min-height:auto would let
         it grow to its content height. columns-view sizes its scroll content
         to max(columns, clientHeight×1.5) (the scroll-past-end tail), so an
         unpinned clientHeight feeds back and diverges to the browser height
         clamp — leaving nothing to scroll. The Effect IDE's equivalent chain
         is pinned the same way (ide-project-editor's :host min-height: 0). */
      min-height: 0;
      display: flex;
    }
    .right-panel {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .empty-state {
      color: var(--app-text-color2); font-size: var(--app-fs-lg);
      text-align: center; padding: 32px 16px;
    }
  `;

  render() {
    const sketchId = appState.local.editingSketchId;
    const leftWidth = appState.local.userSettings.editLeftPanelWidth;
    if (!sketchId || !appState.database.sketches[sketchId]) {
      return html`
        <div style="flex:1;display:flex;align-items:center;justify-content:center">
          <div class="empty-state">No sketch selected for editing.<br>Go to Organize and pick one.</div>
        </div>
      `;
    }

    const traceTarget = appState.local.selection?.traceTarget
      ?? ({ type: 'sketch_output', sketchId } as any);

    return html`
      <div class="left-panel" style="width: ${leftWidth}px">
        <div class="columns-wrap">
          <columns-view .host=${this as ColumnHost}
            @click=${(e: Event) => {
              // Deselect when clicking on empty space (not handled by a child)
              if (e.target === e.currentTarget) appController.select(null);
            }}
          ></columns-view>
          <taps-overlay .sketchId=${sketchId}></taps-overlay>
        </div>
      </div>
      <ide-splitter
        .width=${leftWidth}
        @resize=${this.onResize}
      ></ide-splitter>
      <div class="right-panel">
        <sketch-monitor
          .sketchId=${sketchId}
          traceId="edit_preview"
          .traceTarget=${traceTarget}
          emptyMessage="No sketch selected for editing."
        ></sketch-monitor>
      </div>
    `;
  }

  private onResize = (e: CustomEvent<{ width: number }>) => {
    appController.setUserSetting('editLeftPanelWidth', e.detail.width);
  };

  // ========================================================================
  // ColumnHost implementation
  // ========================================================================

  getColumnElement(index: number): HTMLElement {
    const cached = this.columnCache.get(index);
    if (cached) return cached;

    const sketchId = appState.local.editingSketchId ?? '';

    const colGroup = document.createElement('column-group') as any;
    colGroup.colIdx = index;
    colGroup.sketchId = sketchId;
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

      accept: () => {
        this.commitDrop();
      },

      cancel: () => {
        this.cleanupDrag();
      },
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
   * Find the globally closest insertion point to the pointer and show the marker.
   * Always selects a target — no proximity threshold.
   */
  private updateDragHover(px: number, py: number) {
    // Hide all previous markers
    for (const [, el] of this.columnCache) {
      (el as ColumnGroup).hideInsertMarker?.();
    }
    this.dragHoverTarget = null;

    // Collect all insertion points from all cached column-groups
    let bestDist = Infinity;
    let bestPoint: { colIdx: number; insertIdx: number; x: number; y: number; isPlaceholder: boolean; element: HTMLElement } | null = null;

    for (const [, el] of this.columnCache) {
      const colGroup = el as ColumnGroup;
      if (!colGroup.getInsertionPoints) continue;
      const points = colGroup.getInsertionPoints();
      for (const pt of points) {
        const dx = px - pt.x;
        const dy = py - pt.y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestPoint = { ...pt, element: el };
        }
      }
    }

    if (!bestPoint) return;

    // Set the hover target
    if (bestPoint.isPlaceholder) {
      this.dragHoverTarget = { type: 'placeholder', colIdx: bestPoint.colIdx };
    } else {
      this.dragHoverTarget = { type: 'zone', colIdx: bestPoint.colIdx, insertIdx: bestPoint.insertIdx };
    }

    // Show insertion marker at the correct Y position in the target column
    const colGroup = bestPoint.element as ColumnGroup;
    const colEl = colGroup.renderRoot?.querySelector('.column') as HTMLElement | null;
    if (colEl) {
      const colRect = colEl.getBoundingClientRect();
      const relativeY = bestPoint.y - colRect.top;
      colGroup.showInsertMarker(relativeY);
    }
  }

  /** Commit the drop to the currently hovered target. */
  private commitDrop() {
    if (!this.dragSketchId || !this.dragHoverTarget) {
      this.cleanupDrag();
      return;
    }

    const sketchId = this.dragSketchId;
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) {
      this.cleanupDrag();
      return;
    }

    const sourceEntry = chainEntryAt(sketch, this.dragSourceIdx);
    if (!sourceEntry || sourceEntry.type !== 'module') {
      this.cleanupDrag();
      return;
    }

    // Capture all drag state before cleanup clears it
    const hoverTarget = this.dragHoverTarget;
    const sourceIdx = this.dragSourceIdx;

    // Clean up drag visual state first (markers, dragging attribute)
    this.cleanupDrag();

    // Single linear stack: every drop is a reorder within the one chain. A
    // `zone` drop inserts at the zone index; a `placeholder` drop (the extra
    // drag-out columns) just moves the entry to the bottom of the stack.
    appController.mutate('Move effect', draft => {
      const sk = draft.sketches[sketchId];
      if (!sk) return;
      const chain = ensureChain(sk);
      const [removed] = chain.splice(sourceIdx, 1);
      if (!removed) return;

      if (hoverTarget.type === 'zone') {
        let adjustedIdx = hoverTarget.insertIdx;
        if (hoverTarget.insertIdx > sourceIdx) adjustedIdx--;
        chain.splice(adjustedIdx, 0, removed);
      } else {
        chain.push(removed);
      }
    });
  }

  private cleanupDrag() {
    this.dragCardEl?.removeAttribute('dragging');
    // Hide all insertion markers
    for (const [, el] of this.columnCache) {
      (el as ColumnGroup).hideInsertMarker?.();
    }
    this.dragSketchId = null;
    this.dragSourceCol = -1;
    this.dragSourceIdx = -1;
    this.dragCardEl = null;
    this.dragOp = null;
    this.dragHoverTarget = null;
  }
}
