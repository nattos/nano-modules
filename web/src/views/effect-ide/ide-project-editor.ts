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
import type { ColumnGroupCallbacks } from '../../widgets/column-group';
import type { FieldBinding } from '../../widgets/field-editor';
import { editorRegistry } from '../../editor-registry';
import { isTypingInEditable } from '../../utils/keyboard';

import '../../widgets/columns-view';
import '../../widgets/column-group';

@customElement('ide-project-editor')
export class IdeProjectEditor extends MobxLitElement implements ColumnHost, ColumnGroupCallbacks {
  private columnCache = new Map<number, HTMLElement>();
  private inspectorCache = new Map<string, HTMLElement>();
  private lastSketchId: string | null = null;

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
      font-size: 11px;
      text-align: center;
      line-height: 1.6;
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

  onCardPointerDown(_e: PointerEvent, _sketchId: string, _colIdx: number, _chainIdx: number): void {
    // Single-column mode has no drag-reorder. Card selection (highlight)
    // is handled by the column-group's own pointer-down logic via
    // appController.select.
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
    if (!el) {
      el = factory.create(instanceKey, binding);
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
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!this.isConnected) return;
    if (isTypingInEditable(e)) return;
    const selection = appState.local.selection;
    if (!selection) return;
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
      <columns-view .host=${this as ColumnHost}></columns-view>
    `)}`;
  }
}
