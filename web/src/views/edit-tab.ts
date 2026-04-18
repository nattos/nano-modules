/**
 * <edit-tab> — Multi-column sketch editor with drag-drop, field widgets,
 * and configurable rail/tap routing.
 *
 * Uses <columns-view> for virtualized column management. Each column is a
 * <column-group> custom element; columns outside the viewport are detached
 * from the DOM (pausing MobX reactions and trace registrations).
 *
 * IMPORTANT: Field editors and custom inspectors have NO knowledge of tapping,
 * selection, or layout tracking. The column-group renders overlay layers on
 * top of effect cards, using bounding boxes from the FieldLayoutManager.
 */

import { html, css, nothing, TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { autorun, IReactionDisposer } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { Sketch, Rail } from '../sketch-types';
import { PointerDragOp } from '../utils/pointer-drag-op';

import type { FieldBinding } from '../widgets/field-editor';
import type { ColumnHost } from '../widgets/columns-view';
import type { ColumnGroupCallbacks } from '../widgets/column-group';
import type { ColumnGroup } from '../widgets/column-group';
import '../widgets/columns-view';
import '../widgets/column-group';
import '../widgets/texture-monitor';
import '../widgets/spark-chart';
import { editorRegistry } from '../editor-registry';

// Import inspector registrations (self-registering)
import '../editors/brightness-contrast-inspector';

const EXTRA_COLUMNS = 2;

@customElement('edit-tab')
export class EditTab extends MobxLitElement implements ColumnHost, ColumnGroupCallbacks {
  private previewDisposer: IReactionDisposer | null = null;

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
    return sketch.columns.length + EXTRA_COLUMNS;
  }

  connectedCallback() {
    super.connectedCallback();
    this.previewDisposer = autorun(() => {
      const _gen = appState.local.engine.frameGeneration;
      const bitmap = appState.local.engine.tracedFrames['edit_preview'];
      if (!bitmap) return;
      const canvas = this.renderRoot.querySelector('#preview-canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(bitmap, 0, 0);
    });
    document.addEventListener('keydown', this.handleGlobalKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.previewDisposer?.();
    this.previewDisposer = null;
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
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!this.isConnected) return;
    if (this.isTypingInEditable(e.target)) return;
    const selection = appState.local.selection;
    if (!selection) return;
    const parts = selection.path.split('/');
    if (parts[0] !== 'effect' || parts.length < 4) return;
    const sketchId = parts[1];
    const colIdx = parseInt(parts[2]);
    const chainIdx = parseInt(parts[3]);
    if (Number.isNaN(colIdx) || Number.isNaN(chainIdx)) return;
    e.preventDefault();
    appController.select(null);
    appController.removeEffectFromChain(sketchId, colIdx, chainIdx);
  };

  private isTypingInEditable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    // CodeMirror content editable
    if (target.closest('.cm-content')) return true;
    return false;
  }

  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .right-panel {
      width: 340px;
      min-width: 260px;
      background: var(--app-bg-color2);
      border-left: 1px solid rgba(255,255,255,0.08);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .right-content { flex: 1; overflow-y: auto; min-height: 0; padding: 12px; font-size: 11px; }
    .inspector-field {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 0;
    }
    .inspector-field-label {
      min-width: 70px; color: var(--app-text-color2);
      font-size: 10px; flex-shrink: 0;
    }
    .inspector-field-value {
      flex: 1; min-width: 0;
      color: var(--app-text-color1);
      font-size: 10px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .inspector-separator {
      height: 1px; background: rgba(255,255,255,0.06);
      margin: 8px 0;
    }
    .preview-area {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding: 8px;
      flex-shrink: 0;
    }
    .preview-area canvas {
      width: 100%; aspect-ratio: 16/9;
      background: #000; border-radius: 4px; display: block;
    }

    /* --- Buttons --- */
    .btn {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--app-text-color1);
      font-size: 10px; padding: 2px 8px;
      border-radius: 3px; cursor: pointer;
      font-family: inherit;
    }
    .btn:hover { background: rgba(255,255,255,0.15); }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-row { display: flex; gap: 6px; padding: 0 0 8px; }
    .btn-row .btn { flex: 1; text-align: center; padding: 6px; }
    .btn[active] {
      background: var(--app-hi-color2);
      border-color: var(--app-hi-color2);
      color: #fff;
    }
    .section-header {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .empty-state {
      color: var(--app-text-color2); font-size: 12px;
      text-align: center; padding: 32px 16px;
    }

    /* --- Right panel tap config --- */
    .rail-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .rail-item {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 8px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .rail-item:hover { background: rgba(255,255,255,0.08); }
    .tap-row {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 8px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px;
      font-size: 11px;
      margin-bottom: 4px;
    }
    .tap-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dir-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--app-text-color2);
      font-size: 9px; padding: 2px 6px;
      border-radius: 3px; cursor: pointer;
      font-family: inherit; text-transform: uppercase;
    }
    .dir-btn[active] {
      background: var(--app-hi-color2);
      border-color: var(--app-hi-color2);
      color: #fff;
    }
  `;

  render() {
    const sketchId = appState.local.editingSketchId;
    if (!sketchId || !appState.database.sketches[sketchId]) {
      return html`
        <div style="flex:1;display:flex;align-items:center;justify-content:center">
          <div class="empty-state">No sketch selected for editing.<br>Go to Organize and pick one.</div>
        </div>
        <div class="right-panel"></div>
      `;
    }

    const sketch = appState.database.sketches[sketchId];

    // Register preview monitor as selectable
    const previewPath = `preview/${sketchId}`;
    appController.defineSelectable({
      path: previewPath,
      label: 'Sketch Preview',
      renderInspectorContent: () => html`
        <div class="inspector-field">
          <span class="inspector-field-label">Sketch</span>
          <span class="inspector-field-value">${sketchId}</span>
        </div>
        <div class="inspector-field">
          <span class="inspector-field-label">Columns</span>
          <span class="inspector-field-value">${sketch.columns.length}</span>
        </div>
        <div class="inspector-field">
          <span class="inspector-field-label">Anchor</span>
          <span class="inspector-field-value">${sketch.anchor ?? 'none'}</span>
        </div>
        <div class="inspector-separator"></div>
        <div class="section-header">Full Preview</div>
        <texture-monitor
          .traceId=${'edit_preview'}
          .traceTarget=${{ type: 'sketch_output', sketchId } as any}
          .width=${300}
          .height=${169}
        ></texture-monitor>
      `,
    });

    return html`
      <columns-view .host=${this as ColumnHost}
        @click=${(e: Event) => {
          // Deselect when clicking on empty space (not handled by a child)
          if (e.target === e.currentTarget) appController.select(null);
        }}
      ></columns-view>
      ${this.renderRightPanel(sketchId, sketch)}
    `;
  }

  // ========================================================================
  // ColumnHost implementation
  // ========================================================================

  getColumnElement(index: number): HTMLElement {
    const cached = this.columnCache.get(index);
    if (cached) return cached;

    const sketchId = appState.local.editingSketchId ?? '';
    const sketch = appState.database.sketches[sketchId];
    const isPlaceholder = !sketch || index >= sketch.columns.length;

    const colGroup = document.createElement('column-group') as any;
    colGroup.colIdx = index;
    colGroup.sketchId = sketchId;
    colGroup.isPlaceholder = isPlaceholder;
    colGroup.callbacks = this;
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
    if (!el) {
      el = inspectorFactory.create(instanceKey, binding);
      this.inspectorCache.set(instanceKey, el);
    } else {
      (el as any).binding = binding;
    }
    return el;
  }

  // ========================================================================
  // Right panel
  // ========================================================================

  private renderRightPanel(sketchId: string, sketch: Sketch) {
    const selection = appState.local.selection;
    // Read renderInspectorContent from the registry (always fresh),
    // not from the stored selection (which is only set once on select/queue-promote).
    const registryEntry = selection
      ? appController.getSelectable(selection.path)
      : null;
    const inspectorContent = registryEntry?.renderInspectorContent?.();

    return html`
      <div class="right-panel">
        <div class="right-content">
          ${inspectorContent
            ? html`
              <div class="section-header">${registryEntry!.label}</div>
              ${inspectorContent}
            `
            : this.renderDefaultInspector(sketchId, sketch)
          }
        </div>
        <div class="preview-area"
          @click=${() => appController.select(`preview/${sketchId}`)}>
          <canvas id="preview-canvas" width="320" height="180"></canvas>
        </div>
      </div>
    `;
  }

  /** Default inspector content when nothing specific is selected. */
  private renderDefaultInspector(sketchId: string, sketch: Sketch) {
    const tappingMode = appState.local.tappingMode;
    const selectedPath = appState.local.selectedFieldPath;

    return html`
      <div class="section-header">Tools</div>
      <div class="btn-row">
        <button class="btn" ?active=${tappingMode}
          @click=${() => appController.setTappingMode(!tappingMode)}>Taps</button>
        <button class="btn" ?disabled=${!appController.history.canUndo}
          @click=${() => appController.undo()}>Undo</button>
        <button class="btn" ?disabled=${!appController.history.canRedo}
          @click=${() => appController.redo()}>Redo</button>
      </div>
      ${tappingMode && selectedPath
        ? this.renderTapConfig(sketchId, sketch, selectedPath)
        : tappingMode
          ? html`<div class="empty-state" style="padding:16px 0">Click a field to configure taps</div>`
          : nothing}
    `;
  }

  private renderTapConfig(sketchId: string, sketch: Sketch, selectedPath: string) {
    const parts = selectedPath.split('/');
    if (parts.length < 4) return nothing;
    const [_sid, colStr, chainStr, ...fieldParts] = parts;
    const colIdx = parseInt(colStr);
    const chainIdx = parseInt(chainStr);
    const fieldPath = fieldParts.join('/');
    const entry = sketch.columns[colIdx]?.chain[chainIdx];
    if (!entry || entry.type !== 'module') return nothing;

    const taps = (entry.taps ?? []).filter(t => t.fieldPath === fieldPath);
    const allRails = this.collectRails(sketch, colIdx);

    return html`
      <div class="section-header">Taps for "${fieldPath}"</div>
      ${taps.length > 0 ? html`
        ${taps.map((tap) => {
          const tapIdx = (entry.taps ?? []).indexOf(tap);
          const rail = allRails.find(r => r.id === tap.railId);
          return html`
            <div class="tap-row">
              <span class="tap-row-name">${rail?.name ?? tap.railId}</span>
              <button class="dir-btn" ?active=${tap.direction === 'read'}
                @click=${() => appController.setTapDirection(sketchId, colIdx, chainIdx, tapIdx, 'read')}>R</button>
              <button class="dir-btn" ?active=${tap.direction === 'write'}
                @click=${() => appController.setTapDirection(sketchId, colIdx, chainIdx, tapIdx, 'write')}>W</button>
              <button style="background:none;border:none;color:var(--app-text-color2);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;"
                @click=${() => appController.removeTap(sketchId, colIdx, chainIdx, tapIdx)}>×</button>
            </div>
          `;
        })}
        <!-- Show trace cards for connected rails -->
        <div class="section-header" style="margin-top:12px">Rail Values</div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:12px">
          ${taps.map((tap) => {
            const rail = allRails.find(r => r.id === tap.railId);
            if (!rail) return nothing;
            if (rail.dataType === 'texture') {
              const traceId = `rail_${sketchId}/${colIdx}/${tap.railId}`;
              // Rail texture traces would need to be registered — for now show placeholder
              return html`
                <texture-monitor
                  .traceId=${traceId}
                  .traceTarget=${null}
                  .width=${96}
                  .height=${54}
                ></texture-monitor>
              `;
            }
            // Float rails: show a spark chart (read from sketch state)
            return html`
              <spark-chart
                .fieldPath=${tap.railId}
                .binding=${{
                  instanceKey: `rail_${tap.railId}`,
                  getValue: () => {
                    const ss = appState.local.engine.sketchState;
                    const sketchSt = ss?.[sketchId];
                    const colRails = sketchSt?.[`columns/${colIdx}`];
                    return colRails?.[tap.railId]?.value ?? sketchSt?.rails?.[tap.railId]?.value ?? 0;
                  },
                  setValue: () => {},
                }}
                .width=${96}
                .height=${32}
              ></spark-chart>
            `;
          })}
        </div>
      ` : html`<div style="font-size:11px;color:var(--app-text-color2);margin-bottom:8px">No taps connected</div>`}

      <div class="section-header" style="margin-top:12px">Connect to Rail</div>
      <div class="rail-list">
        ${allRails.map(rail => html`
          <div class="rail-item"
            @click=${() => appController.addTap(sketchId, colIdx, chainIdx, rail.id, fieldPath, 'read')}>
            ${rail.name ?? rail.id} <span style="color:var(--app-text-color2);font-size:9px;margin-left:auto">${rail.dataType}</span>
          </div>
        `)}
        <button class="btn" style="width:100%;text-align:center;padding:6px"
          @click=${() => this.createRailAndTap(sketchId, colIdx, chainIdx, fieldPath)}>+ New Rail</button>
      </div>
    `;
  }

  private collectRails(sketch: Sketch, colIdx: number): Rail[] {
    const rails: Rail[] = [];
    if (sketch.rails) rails.push(...sketch.rails);
    const col = sketch.columns[colIdx];
    if (col?.rails) rails.push(...col.rails);
    return rails;
  }

  private createRailAndTap(sketchId: string, colIdx: number, chainIdx: number, fieldPath: string) {
    const sketch = appState.database.sketches[sketchId];
    const existingCount = (sketch?.columns[colIdx]?.rails?.length ?? 0) + (sketch?.rails?.length ?? 0);
    const name = `Rail ${existingCount + 1}`;
    const railId = appController.addRail(sketchId, colIdx, name, 'float');
    appController.addTap(sketchId, colIdx, chainIdx, railId, fieldPath, 'write');
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

    const sourceEntry = sketch.columns[this.dragSourceCol]?.chain[this.dragSourceIdx];
    if (!sourceEntry || sourceEntry.type !== 'module') {
      this.cleanupDrag();
      return;
    }

    // Capture all drag state before cleanup clears it
    const hoverTarget = this.dragHoverTarget;
    const sourceCol = this.dragSourceCol;
    const sourceIdx = this.dragSourceIdx;
    const prevColumnCount = sketch.columns.length;

    // Clean up drag visual state first (markers, dragging attribute)
    this.cleanupDrag();

    // Now perform the mutation — MobX will re-render affected column-groups
    if (hoverTarget.type === 'zone') {
      const { colIdx: targetColIdx, insertIdx: targetInsertIdx } = hoverTarget;

      appController.mutate('Move effect', draft => {
        const sk = draft.sketches[sketchId];
        const srcCol = sk.columns[sourceCol];
        const dstCol = sk.columns[targetColIdx] ?? srcCol;

        const [removed] = srcCol.chain.splice(sourceIdx, 1);

        let adjustedIdx = targetInsertIdx;
        if (sourceCol === targetColIdx && targetInsertIdx > sourceIdx) {
          adjustedIdx--;
        }

        dstCol.chain.splice(adjustedIdx, 0, removed);
      });

    } else if (hoverTarget.type === 'placeholder') {
      const colIdx = hoverTarget.colIdx;

      appController.mutate('Move to new column', draft => {
        const sk = draft.sketches[sketchId];
        const [removed] = sk.columns[sourceCol].chain.splice(sourceIdx, 1);

        while (sk.columns.length <= colIdx) {
          sk.columns.push({
            name: `Column ${sk.columns.length + 1}`,
            chain: [
              { type: 'texture_input', id: `in_${sk.columns.length}` },
              { type: 'texture_output', id: `out_${sk.columns.length}` },
            ],
          });
        }

        const targetChain = sk.columns[colIdx].chain;
        const outIdx = targetChain.findIndex(e => e.type === 'texture_output');
        targetChain.splice(outIdx >= 0 ? outIdx : targetChain.length, 0, removed);
      });
    }

    // If the column count changed (placeholder drop created columns),
    // invalidate cache for the new indices and notify columns-view
    const newSketch = appState.database.sketches[sketchId];
    if (newSketch && newSketch.columns.length !== prevColumnCount) {
      // Invalidate all cached columns since indices may have shifted
      this.columnCache.clear();
      const columnsView = this.renderRoot.querySelector('columns-view') as any;
      columnsView?.notifyColumnCountChanged?.();
    }
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
