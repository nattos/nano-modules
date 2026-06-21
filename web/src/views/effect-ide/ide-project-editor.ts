/**
 * <ide-project-editor> — Single-column project editor.
 *
 * Hosts the existing `<columns-view>` widget restricted to a single column,
 * reusing `<column-group>` and the editor registry so all field widgets,
 * trace cards, and inline inspectors work identically to the resolume editor.
 *
 * The active project comes from `userSettings.selectedProjectId`. When the
 * selection changes, columns-view is keyed-remounted so the column-group is
 * recreated with the correct sketchId (and its internal caches start fresh).
 *
 * Default→user materialization happens in `appController.selectProject` (see
 * controller.ts) — by the time we render, the selected id is always a
 * `user:<uuid>`. The first real edit clears `isTemplate`, promoting the
 * project from "browsed" to "saved".
 */

import { html, css, PropertyValues } from 'lit';
import { customElement } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import type { ColumnHost } from '../../widgets/columns-view';
import { type ColumnGroupCallbacks, ColumnGroup } from '../../widgets/column-group';
import type { FieldBinding } from '../../widgets/field-editor';
import { editorRegistry } from '../../editor-registry';
import { ensureChain, chainEntryAt } from '../../sketch-types';
import { isTypingInEditable } from '../../utils/keyboard';
import { PointerDragOp } from '../../utils/pointer-drag-op';

import '../../widgets/columns-view';
import '../../widgets/column-group';
import '../../widgets/taps-overlay';

// Custom inspector registrations — a single barrel shared with edit-tab.ts so
// the effect IDE and the sketch shell can never disagree on which custom editors
// exist (the lists used to drift, silently dropping mod.shaper.envelope from the IDE).
import '../../editors/all-inspectors';

@customElement('ide-project-editor')
export class IdeProjectEditor extends MobxLitElement implements ColumnHost, ColumnGroupCallbacks {
  private columnCache = new Map<number, HTMLElement>();
  private inspectorCache = new Map<string, HTMLElement>();
  private lastSketchId: string | null = null;

  // Card drag-reorder state (single column → reorder within the chain).
  private dragSketchId: string | null = null;
  private dragSourceCol = -1;
  private dragSourceIdx = -1;
  private dragCardEl: HTMLElement | null = null;
  private dragOp: PointerDragOp | null = null;
  private dragHoverTarget: { type: 'zone'; colIdx: number; insertIdx: number } | null = null;

  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      color: var(--app-text-color2);
      font-size: var(--app-fs-md);
      text-align: center;
      line-height: 1.6;
    }
    .columns-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
    }
    columns-view {
      flex: 1;
      min-width: 0;
    }
  `;

  // ---- ColumnHost ----

  get columnCount(): number {
    const id = appState.local.userSettings.selectedProjectId;
    if (!id) return 0;
    return appState.database.sketches[id] ? 1 : 0;
  }

  getColumnElement(index: number): HTMLElement {
    const id = appState.local.userSettings.selectedProjectId ?? '';
    const cached = this.columnCache.get(index);
    if (cached) {
      // Refresh sketchId in case the selection materialized to a new id.
      (cached as any).sketchId = id;
      return cached;
    }
    const colGroup = document.createElement('column-group') as any;
    colGroup.colIdx = 0;
    colGroup.sketchId = id;
    colGroup.isPlaceholder = false;
    colGroup.callbacks = this;
    this.columnCache.set(index, colGroup as HTMLElement);
    return colGroup as HTMLElement;
  }

  columnAttached(_index: number, _element: HTMLElement): void {}
  columnDetached(_index: number, _element: HTMLElement): void {}

  // ---- ColumnGroupCallbacks ----

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

  /**
   * Find the closest insertion point to the pointer (within the single column)
   * and show the marker. Single-column → no placeholder/new-column drops.
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
        if (pt.isPlaceholder) continue;  // no new-column drops in single-column mode
        const dx = px - pt.x, dy = py - pt.y, dist = dx * dx + dy * dy;
        if (dist < bestDist) { bestDist = dist; bestPoint = { ...pt, element: el }; }
      }
    }
    if (!bestPoint) return;

    this.dragHoverTarget = { type: 'zone', colIdx: bestPoint.colIdx, insertIdx: bestPoint.insertIdx };
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

    // Single linear stack: reorder within the one chain.
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

  onGutterWidthChanged(): void {
    const cv = this.renderRoot.querySelector('columns-view') as any;
    cv?.notifyGutterWidthChanged?.();
  }

  getInspectorElement(
    instanceKey: string,
    moduleType: string,
    binding: FieldBinding,
  ): HTMLElement | null {
    const factory = editorRegistry.getInspectorFactory(moduleType);
    if (!factory) return null;
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
      el = factory.create(instanceKey, binding);
      (el as any).moduleType = moduleType;
      this.inspectorCache.set(instanceKey, el);
    } else {
      (el as any).binding = binding;
    }
    return el;
  }

  // ---- Lifecycle ----

  willUpdate(_changed: PropertyValues): void {
    const id = appState.local.userSettings.selectedProjectId ?? null;
    if (id !== this.lastSketchId) {
      this.disposeColumnElements();
      this.lastSketchId = id;
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('keydown', this.onGlobalKeyDown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.onGlobalKeyDown);
    this.disposeColumnElements();
    this.disposeInspectors();
  }

  /**
   * Delete/Backspace removes the selected effect card. Mirrors the resolume
   * editor's handler — same behavior, same guards (no-op while typing).
   */
  private onGlobalKeyDown = (e: KeyboardEvent) => {
    if (!this.isConnected) return;
    if (isTypingInEditable(e)) return;
    // Copy / paste the selected effect (⌘/Ctrl+C / +V). The isTypingInEditable
    // guard above means a genuine text copy/paste is never hijacked. We only
    // preventDefault when there's actually something to do, so the browser's
    // default still runs otherwise (e.g. ⌘C with nothing copyable selected).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'c') {
        if (appController.canCopy) { e.preventDefault(); appController.copySelection(); }
        return;
      }
      if (k === 'v') {
        if (appController.canPaste) { e.preventDefault(); appController.pasteClipboard(); }
        return;
      }
    }
    // `T` toggles taps mode (global, when not typing).
    if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      appController.setTappingMode(!appState.local.tappingMode);
      return;
    }
    if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== '0') return;
    const selection = appState.local.selection;
    if (!selection) return;
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

  private disposeColumnElements(): void {
    this.columnCache.clear();
  }

  private disposeInspectors(): void {
    for (const [, el] of this.inspectorCache) {
      const moduleType = (el as any).moduleType ?? '';
      const factory = editorRegistry.getInspectorFactory(moduleType);
      factory?.destroy(el);
    }
    this.inspectorCache.clear();
  }

  render() {
    const id = appState.local.userSettings.selectedProjectId;
    if (!id || !appState.database.sketches[id]) {
      return html`<div class="empty">Select a project from the explorer to begin.</div>`;
    }
    // Key on sketchId so columns-view fully remounts when the selection
    // changes — keeps internal column-group caches in sync.
    return html`${keyed(id, html`
      <div class="columns-wrap">
        <columns-view .host=${this as ColumnHost}
          fitWidth
          .defaultGutterWidth=${ColumnGroup.GUTTER_WIDTH}
          @click=${(e: Event) => {
            // Deselect when clicking empty space (not handled by a child).
            if (e.target === e.currentTarget) appController.select(null);
          }}
        ></columns-view>
        <taps-overlay .sketchId=${id}></taps-overlay>
      </div>
    `)}`;
  }
}
