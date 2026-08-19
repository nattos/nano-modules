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

import { html, css, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { keyed } from 'lit/directives/keyed.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import { ensureChain, chainEntryAt, sketchChain } from '../sketch-types';
import { PointerDragOp, CancelReason } from '../utils/pointer-drag-op';
import { effectPath, parseEffectPath, type EffectPathParts } from '../state/effects-payload';
import { categoryColor, effectDomain } from './category-color';
import { sanitizeIconName, thumbnailDataUri } from './effect-glyph';
import './ui-icon';

import type { FieldBinding } from './field-editor';
import type { ColumnHost, ColumnsView } from './columns-view';
import { loadSketchUiState, saveSketchUiState } from '../state/sketch-ui-store';
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
  // The clicked card's chain index (the group's primary / inspector anchor).
  private dragSourceIdx = -1;
  // Every chain index being moved, ascending. A single-card drag is `[idx]`; a
  // group drag is the whole multi-selection (see onCardPointerDown).
  private dragSourceIdxs: number[] = [];
  private dragOp: PointerDragOp | null = null;
  private dragHoverTarget: { colIdx: number; insertIdx: number } | null = null;
  // True while a card reorder is in flight — drives the floating compact
  // headers popup (see renderReorderPopup). Not observable; toggled with an
  // explicit requestUpdate() so the popup mounts/unmounts on drag start/end.
  private dragActive = false;
  // Viewport Y of the clicked header's center at drag start — the popup is
  // anchored so the dragged card's row lines up with it (clamped to viewport).
  private dragAnchorY = 0;

  // ── Per-sketch scroll persistence (UI-only, keyed by sketchId) ──────────
  // Cached to indexeddb so a sketch reopens where you left it, across the
  // effect-dev / live / playground surfaces (all edit the same sketch ids).
  //
  // The sketch whose scroll we're currently tracking. Distinct from
  // cachedSketchId so the switch handler in updated() runs exactly once per
  // change and only once the editor is actually mounted.
  private scrollSketchId: string | null = null;
  // Last user scroll offset of the mounted columns-view, mirrored on every
  // scroll event so we can persist the OLD sketch's position at switch time —
  // its DOM is already gone by then (keyed() remounted for the new sketch).
  private lastScrollTop = 0;
  private lastScrollLeft = 0;
  private scrollSaveTimer = 0;
  // True while programmatically restoring — suppresses save and keeps the
  // restore's own scroll events from being mistaken for a user scroll.
  private suppressScrollSave = false;
  // Frames spent re-applying a restore while the content height fills in.
  // Bumped past the cap by a real user scroll to abandon the loop.
  private scrollRestoreTries = 0;

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
    // Persist the final scroll position before the DOM goes away, then forget
    // the tracked sketch so a reconnect (element reused on tab toggle) restores
    // fresh rather than assuming the columns-view kept its offset.
    this.flushScrollSave();
    this.scrollSketchId = null;
    this.clearSketchCaches();
  }

  /**
   * Detect a sketch switch (or first mount) and hand off scroll persistence:
   * flush the previous sketch's position, then restore the new one's. Runs on
   * every reactive render but the body only fires when `sketchId` actually
   * changes AND its editor is mounted.
   */
  protected updated(changed: PropertyValues) {
    super.updated(changed);
    const sketchId = this.sketchId;
    if (sketchId === this.scrollSketchId) return;
    // A sketchId set but not (yet) in the database renders the empty message —
    // there's no columns-view to track. Wait for it to materialize.
    if (sketchId && !appState.database.sketches[sketchId]) return;
    this.flushScrollSave();
    this.scrollSketchId = sketchId;
    this.lastScrollTop = 0;
    this.lastScrollLeft = 0;
    if (sketchId) void this.restoreScroll(sketchId);
  }

  /** Mirror the columns-view's scroll offset and debounce-persist it. */
  private onColumnsScroll = (e: Event) => {
    // Our own restore writes scrollTop; ignore those so they don't save partial
    // offsets or cancel the restore retry.
    if (this.suppressScrollSave) return;
    const off = (e.currentTarget as ColumnsView).getScrollOffset();
    this.lastScrollTop = off.top;
    this.lastScrollLeft = off.left;
    // A real user scroll ends any in-flight restore.
    this.scrollRestoreTries = Number.MAX_SAFE_INTEGER;
    this.scheduleScrollSave();
  };

  private scheduleScrollSave() {
    const sketchId = this.scrollSketchId;
    if (!sketchId) return;
    clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => {
      this.scrollSaveTimer = 0;
      void saveSketchUiState(sketchId, {
        scrollTop: this.lastScrollTop, scrollLeft: this.lastScrollLeft,
      });
    }, 300);
  }

  /** Persist the tracked position now (on sketch switch / unmount). */
  private flushScrollSave() {
    if (this.scrollSaveTimer) { clearTimeout(this.scrollSaveTimer); this.scrollSaveTimer = 0; }
    const sketchId = this.scrollSketchId;
    if (!sketchId) return;
    void saveSketchUiState(sketchId, {
      scrollTop: this.lastScrollTop, scrollLeft: this.lastScrollLeft,
    });
  }

  /**
   * Restore the sketch's saved scroll offset once its columns editor mounts.
   * Re-applied over a few frames because the content height (and thus the
   * scrollable range) fills in as columns attach — a one-shot set would clamp
   * to a not-yet-tall-enough container.
   */
  private async restoreScroll(sketchId: string) {
    const state = await loadSketchUiState(sketchId);
    // Bail if the user switched sketches while we were loading.
    if (this.sketchId !== sketchId || this.scrollSketchId !== sketchId) return;
    const top = state?.scrollTop ?? 0;
    const left = state?.scrollLeft ?? 0;
    this.lastScrollTop = top;
    this.lastScrollLeft = left;
    if (top === 0 && left === 0) return;
    this.scrollRestoreTries = 0;
    const apply = () => {
      if (this.sketchId !== sketchId || this.scrollSketchId !== sketchId) return;
      if (this.scrollRestoreTries > 30) return; // user scrolled, or content maxed out
      const cv = this.renderRoot.querySelector('columns-view') as ColumnsView | null;
      if (!cv) return;
      this.suppressScrollSave = true;
      cv.setScrollOffset(top, left);
      this.suppressScrollSave = false;
      const got = cv.getScrollOffset();
      if (Math.abs(got.top - top) > 1 || Math.abs(got.left - left) > 1) {
        this.scrollRestoreTries++;
        requestAnimationFrame(apply);
      }
    };
    requestAnimationFrame(apply);
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
    // `C` opens/closes the sidecar canvas — a sibling of W, same shape.
    // Bare key only: a ⌘C/^C that handleCommonEditShortcut declined (nothing
    // copyable) must not fall through and toggle the canvas instead.
    if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      appController.setSketchCanvasOpen(
        !appState.local.userSettings.sketchCanvasOpen);
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
    // `0` toggles bypass across the whole selection (single or multi-card) as a
    // single undo point, mirroring the card header light.
    if (e.key === '0') {
      if (appController.toggleBypassSelectedEffects()) e.preventDefault();
      return;
    }
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
          @scroll-changed=${this.onColumnsScroll}
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
    // Provisional vertical anchor around the clicked header (positionReorderPopup
    // refines this to exact row alignment + viewport clamp once measurable).
    const top = Math.round(Math.max(8, this.dragAnchorY - 60));
    const count = this.dragSourceIdxs.length;
    return html`
      <div class="reorder-popup" style=${`left:${left}px;top:${top}px`}>
        <div class="reorder-popup-title">${count > 1 ? `Move ${count} effects` : 'Move effect'}</div>
        <div class="reorder-popup-list">
          ${chain.map((entry, i) => html`
            <div class="reorder-row" data-insert-idx=${i}
              ?data-dragged=${this.dragSourceIdxs.includes(i)}>
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

    // A drag on a card that's part of a 2+ multi-selection moves the whole
    // group; otherwise just this card. The group's selection was preserved on
    // pointerdown (see column-group's selectOnPointerDown) so we can read it here.
    const clickedPath = effectPath(sketchId, colIdx, chainIdx);
    const multi = appState.local.multiSelection;
    const isGroup = multi.length >= 2 && multi.includes(clickedPath);
    const sourceIdxs = isGroup
      ? multi
          .map(parseEffectPath)
          .filter((p): p is EffectPathParts =>
            !!p && p.sketchId === sketchId && p.colIdx === colIdx)
          .map(p => p.chainIdx)
          .sort((a, b) => a - b)
      : [chainIdx];

    const hr = header.getBoundingClientRect();
    this.dragSketchId = sketchId;
    this.dragSourceCol = colIdx;
    this.dragSourceIdx = chainIdx;
    this.dragSourceIdxs = sourceIdxs;
    this.dragAnchorY = hr.top + hr.height / 2;

    this.dragOp = new PointerDragOp(e, header, {
      threshold: 5,
      move: (me) => {
        this.setDraggingCards(true);
        // First movement past the threshold: raise the floating compact-headers
        // popup and start listening for Escape (cancel). The real cards stay
        // expanded — the popup, not a collapse, is the short list to drop into.
        if (!this.dragActive) {
          this.dragActive = true;
          document.addEventListener('keydown', this.handleDragKeyDown, true);
          this.requestUpdate();
          void this.updateComplete.then(() => this.positionReorderPopup());
        }
        this.updateDragHover(me.clientX, me.clientY);
      },
      accept: () => this.commitDrop(),
      cancel: (reason) => {
        // A plain click (no drag) on a group member collapses the selection to
        // just that card — the collapse was deferred on pointerdown to allow a
        // group drag, so apply it here now that we know it wasn't a drag.
        if (reason === CancelReason.NoChange && isGroup) appController.select(clickedPath);
        this.cleanupDrag();
      },
    });
  }

  /** Toggle the dimmed `dragging` marker on every card being moved. */
  private setDraggingCards(on: boolean) {
    const col = this.columnCache.get(this.dragSourceCol);
    const root = (col as ColumnGroup | undefined)?.renderRoot;
    if (!root) return;
    for (const idx of this.dragSourceIdxs) {
      const card = root.querySelector(`.effect-card[data-chain-idx="${idx}"]`);
      if (on) card?.setAttribute('dragging', '');
      else card?.removeAttribute('dragging');
    }
  }

  /**
   * Anchor the popup so the dragged card's row lines up with where its header
   * was, clamped to stay fully within the viewport. Run after the popup renders
   * (its height + row offsets are then measurable).
   */
  private positionReorderPopup() {
    const popup = this.renderRoot.querySelector('.reorder-popup') as HTMLElement | null;
    if (!popup) return;
    const row = popup.querySelector(
      `.reorder-row[data-insert-idx="${this.dragSourceIdx}"]`) as HTMLElement | null;
    const rowCenter = row ? row.offsetTop + row.offsetHeight / 2 : popup.offsetHeight / 2;
    const h = popup.offsetHeight;
    const top = Math.max(8, Math.min(this.dragAnchorY - rowCenter, window.innerHeight - h - 8));
    popup.style.top = `${Math.round(top)}px`;
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

  /** Commit the drop — splice the dragged module(s) to the hovered insert index
   *  as a contiguous block, then move the selection with them. */
  private commitDrop() {
    if (!this.dragSketchId || !this.dragHoverTarget) { this.cleanupDrag(); return; }

    const sketchId = this.dragSketchId;
    const colIdx = this.dragSourceCol;
    const sketch = appState.database.sketches[sketchId];
    const sourceIdxs = [...this.dragSourceIdxs].sort((a, b) => a - b);
    const allModules = sourceIdxs.length > 0
      && sourceIdxs.every(i => chainEntryAt(sketch, i)?.type === 'module');
    if (!sketch || !allModules) { this.cleanupDrag(); return; }

    const targetInsertIdx = this.dragHoverTarget.insertIdx;
    const clickedIdx = this.dragSourceIdx;
    // Where the block lands: the target gap shifts down by the removed entries
    // that were above it.
    const countBefore = sourceIdxs.filter(i => i < targetInsertIdx).length;
    const adjusted = targetInsertIdx - countBefore;
    const clickedPosInBlock = Math.max(0, sourceIdxs.indexOf(clickedIdx));
    this.cleanupDrag();

    appController.mutate(
      sourceIdxs.length > 1 ? `Move ${sourceIdxs.length} effects` : 'Move effect',
      draft => {
        const sk = draft.sketches[sketchId];
        if (!sk) return;
        const chain = ensureChain(sk);
        const removed = sourceIdxs.map(i => chain[i]).filter(Boolean);
        // Splice out from highest index down so the lower indices stay valid.
        for (let k = sourceIdxs.length - 1; k >= 0; k--) chain.splice(sourceIdxs[k], 1);
        chain.splice(adjusted, 0, ...removed);
      });

    // Selection follows the moved effects to their new positions.
    const newPaths = sourceIdxs.map((_, k) => effectPath(sketchId, colIdx, adjusted + k));
    const primary = newPaths[clickedPosInBlock] ?? newPaths[0];
    if (newPaths.length > 1) appController.selectEffectGroup(newPaths, primary);
    else appController.select(primary);
  }

  private cleanupDrag() {
    this.setDraggingCards(false);
    for (const [, el] of this.columnCache) (el as ColumnGroup).hideInsertMarker?.();
    this.hidePopupMarker();
    document.removeEventListener('keydown', this.handleDragKeyDown, true);
    this.dragSketchId = null;
    this.dragSourceCol = -1;
    this.dragSourceIdx = -1;
    this.dragSourceIdxs = [];
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
