/**
 * <edit-tab> — Multi-column sketch editor with drag-drop, field widgets,
 * and configurable rail/tap routing.
 *
 * Shows the sketch's columns side by side, plus placeholder columns.
 * Effect cards can be dragged between columns and reordered within columns.
 * Each effect card renders field editor widgets for its parameters.
 *
 * Tapping mode allows connecting field editors to sideband rails via taps.
 * A gutter strip to the right of each column visualizes tap connections.
 */

import { html, css, nothing, TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { autorun, IReactionDisposer } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { ParamInfo } from '../state/types';
import type { Sketch, SketchColumn, ChainEntry, ModuleEntry, Rail, Tap } from '../sketch-types';

// Register field widgets and inspectors
import '../widgets/field-slider';
import '../widgets/field-toggle';
import '../widgets/field-trigger';
import type { FieldBinding } from '../widgets/field-editor';
import { FieldLayoutManager } from '../widgets/field-layout-manager';
import { editorRegistry } from '../editor-registry';

// Import inspector registrations (self-registering)
import '../editors/brightness-contrast-inspector';

function shortName(id: string) { return id.split('.').pop() ?? id; }

// Number of extra placeholder columns to show
const EXTRA_COLUMNS = 2;

@customElement('edit-tab')
export class EditTab extends MobxLitElement {
  private previewDisposer: IReactionDisposer | null = null;
  private layoutManager = new FieldLayoutManager();

  // Cached inspector elements by instance key
  private inspectorCache = new Map<string, HTMLElement>();

  // Drag state
  private dragSketchId: string | null = null;
  private dragSourceCol = -1;
  private dragSourceIdx = -1;

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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.previewDisposer?.();
    this.previewDisposer = null;
    this.layoutManager.dispose();
    // Clean up cached inspectors
    for (const [key, el] of this.inspectorCache) {
      const factory = editorRegistry.getInspectorFactory(
        (el as any).moduleType ?? '');
      factory?.destroy(el);
    }
    this.inspectorCache.clear();
  }

  updated() {
    // Attach ResizeObserver to columns container for layout tracking
    const container = this.renderRoot.querySelector('.columns-container') as HTMLElement | null;
    if (container) this.layoutManager.observeContainer(container);
    // Re-scan field editors after each render
    this.scanAndRegisterFields();
  }

  static styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .main-area {
      flex: 1;
      overflow: auto;
      padding: 16px;
      min-width: 0;
      width: 0;
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
    .right-content { flex: 1; overflow-y: auto; min-height: 0; padding: 12px; }
    .preview-area {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding: 8px;
      flex-shrink: 0;
    }
    .preview-area canvas {
      width: 100%; aspect-ratio: 16/9;
      background: #000; border-radius: 4px; display: block;
    }

    /* --- Multi-column layout --- */
    .columns-container {
      display: flex;
      gap: 16px;
      align-items: flex-start;
    }
    .column-group {
      display: flex;
      gap: 0;
      min-width: 264px;
      max-width: 344px;
      flex: 1;
      align-items: stretch;
    }
    .column {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0;
      flex: 1;
      min-width: 0;
    }
    .column-gutter {
      width: 24px;
      flex-shrink: 0;
      position: relative;
      border-left: 1px solid rgba(255,255,255,0.04);
    }
    .column-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      margin-bottom: 8px;
      width: 100%;
    }
    .column-placeholder {
      border: 1px dashed rgba(255,255,255,0.08);
      border-radius: 4px;
      min-height: 100px;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--app-text-color2);
      font-size: 11px;
      opacity: 0.5;
    }

    /* --- Chain elements --- */
    .chain-marker {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: 6px 16px;
      background: rgba(255,255,255,0.03);
      border: 1px dashed rgba(255,255,255,0.12);
      border-radius: 4px;
      text-align: center;
      width: 100%;
    }
    .chain-wire { width: 2px; height: 12px; background: rgba(255,255,255,0.12); }
    .add-btn {
      background: rgba(255,255,255,0.04);
      border: 1px dashed rgba(255,255,255,0.15);
      color: var(--app-text-color2);
      font-size: 16px;
      width: 100%;
      padding: 4px;
      border-radius: 4px;
      cursor: pointer;
      font-family: inherit;
      text-align: center;
      transition: background 0.15s, border-color 0.15s;
    }
    .add-btn:hover {
      background: rgba(65,105,225,0.1);
      border-color: var(--app-hi-color2);
      color: var(--app-text-color1);
    }

    /* --- Effect cards --- */
    .effect-card {
      width: 100%;
      padding: 0;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .effect-card[dragging] {
      opacity: 0.4;
    }
    .effect-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      cursor: grab;
      user-select: none;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .effect-card-header:active { cursor: grabbing; }
    .effect-card-name { font-size: 11px; color: var(--app-text-color1); }
    .effect-card-body { padding: 6px 10px; }
    .remove-btn {
      background: none; border: none;
      color: var(--app-text-color2); cursor: pointer;
      font-size: 14px; padding: 0 4px; line-height: 1;
    }
    .remove-btn:hover { color: var(--app-hi-color1); }

    /* --- Drop zones --- */
    .drop-zone {
      width: 100%;
      min-height: 4px;
      transition: min-height 0.15s, background 0.15s;
      border-radius: 2px;
    }
    .drop-zone.drag-over {
      min-height: 24px;
      background: rgba(65,105,225,0.15);
      border: 1px dashed var(--app-hi-color2);
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

    /* --- Tap visualization --- */
    .tap-indicator {
      position: absolute;
      right: 4px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      transform: translateY(-50%);
      z-index: 2;
    }
    .tap-indicator.write { background: var(--app-hi-color2, #4169E1); }
    .tap-indicator.read { background: var(--app-hi-color1, #E16941); }
    .tap-indicator-line {
      position: absolute;
      right: 12px;
      height: 2px;
      width: 12px;
      transform: translateY(-50%);
      z-index: 1;
    }
    .tap-indicator-line.write { background: var(--app-hi-color2, #4169E1); opacity: 0.5; }
    .tap-indicator-line.read { background: var(--app-hi-color1, #E16941); opacity: 0.5; }

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
        <div class="main-area">
          <div class="empty-state">No sketch selected for editing.<br>Go to Organize and pick one.</div>
        </div>
        <div class="right-panel"></div>
      `;
    }

    const sketch = appState.database.sketches[sketchId];
    const totalCols = sketch.columns.length + EXTRA_COLUMNS;
    const tappingMode = appState.local.tappingMode;

    // Touch the layout manager generation to react to position changes
    const _layoutGen = this.layoutManager.generation;

    return html`
      <div class="main-area"
        @field-tap-select=${this.onFieldTapSelect}>
        <div class="columns-container">
          ${Array.from({ length: totalCols }, (_, colIdx) => {
      if (colIdx < sketch.columns.length) {
        return this.renderColumn(sketchId, sketch, colIdx);
      } else {
        return this.renderPlaceholderColumn(colIdx);
      }
    })}
        </div>
      </div>
      ${this.renderRightPanel(sketchId, sketch)}
    `;
  }

  // ========================================================================
  // Right panel
  // ========================================================================

  private renderRightPanel(sketchId: string, sketch: Sketch) {
    const tappingMode = appState.local.tappingMode;
    const selectedPath = appState.local.selectedFieldPath;

    return html`
      <div class="right-panel">
        <div class="right-content">
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
        </div>
        <div class="preview-area">
          <canvas id="preview-canvas" width="320" height="180"></canvas>
        </div>
      </div>
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
      ${taps.length > 0 ? taps.map((tap, i) => {
        const tapIdx = (entry.taps ?? []).indexOf(tap);
        const rail = allRails.find(r => r.id === tap.railId);
        return html`
          <div class="tap-row">
            <span class="tap-row-name">${rail?.name ?? tap.railId}</span>
            <button class="dir-btn" ?active=${tap.direction === 'read'}
              @click=${() => appController.setTapDirection(sketchId, colIdx, chainIdx, tapIdx, 'read')}>R</button>
            <button class="dir-btn" ?active=${tap.direction === 'write'}
              @click=${() => appController.setTapDirection(sketchId, colIdx, chainIdx, tapIdx, 'write')}>W</button>
            <button class="remove-btn"
              @click=${() => appController.removeTap(sketchId, colIdx, chainIdx, tapIdx)}>×</button>
          </div>
        `;
      }) : html`<div style="font-size:11px;color:var(--app-text-color2);margin-bottom:8px">No taps connected</div>`}

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

  private onFieldTapSelect = (e: CustomEvent) => {
    const sketchId = appState.local.editingSketchId;
    if (!sketchId) return;
    // Walk up from the event target to find the effect card and extract indices
    const detail = e.detail as { fieldPath: string };
    // Find the effect card element
    const path = e.composedPath();
    for (const el of path) {
      if (el instanceof HTMLElement && el.dataset.fieldKey) {
        appController.selectField(`${el.dataset.fieldKey}/${detail.fieldPath}`);
        return;
      }
    }
  };

  // ========================================================================
  // Column rendering
  // ========================================================================

  private renderColumn(sketchId: string, sketch: Sketch, colIdx: number) {
    const column = sketch.columns[colIdx];
    return html`
      <div class="column-group">
        <div class="column">
          <div class="column-header">${column.name}</div>
          ${this.renderChain(sketchId, sketch, column, colIdx)}
        </div>
        <div class="column-gutter" data-col=${colIdx}>
          ${this.renderGutterTaps(sketchId, sketch, column, colIdx)}
        </div>
      </div>
    `;
  }

  private renderPlaceholderColumn(colIdx: number) {
    return html`
      <div class="column-group">
        <div class="column">
          <div class="column-header">Column ${colIdx + 1}</div>
          <div class="column-placeholder"
            @dragover=${(e: DragEvent) => { e.preventDefault(); e.currentTarget?.classList.add('drag-over'); }}
            @dragleave=${(e: DragEvent) => { e.currentTarget?.classList.remove('drag-over'); }}
            @drop=${(e: DragEvent) => this.onDropToNewColumn(e, colIdx)}>
            Drop effects here
          </div>
        </div>
        <div class="column-gutter"></div>
      </div>
    `;
  }

  private renderChain(sketchId: string, sketch: Sketch, column: SketchColumn, colIdx: number) {
    const items: TemplateResult[] = [];

    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];

      if (entry.type === 'texture_input') {
        items.push(html`<div class="chain-marker">Input</div>`);
        items.push(html`<div class="chain-wire"></div>`);
        items.push(this.renderDropZone(sketchId, colIdx, i + 1));
        items.push(html`<div class="chain-wire"></div>`);
      } else if (entry.type === 'texture_output') {
        items.push(html`<div class="chain-marker">Output</div>`);
      } else if (entry.type === 'module') {
        items.push(this.renderEffectCard(sketchId, colIdx, i, entry));
        items.push(html`<div class="chain-wire"></div>`);
        if (i + 1 < column.chain.length) {
          items.push(this.renderDropZone(sketchId, colIdx, i + 1));
          items.push(html`<div class="chain-wire"></div>`);
        }
      }
    }

    return items;
  }

  // ========================================================================
  // Gutter tap visualization
  // ========================================================================

  private renderGutterTaps(sketchId: string, sketch: Sketch, column: SketchColumn, colIdx: number) {
    const indicators: TemplateResult[] = [];
    const gutterSelector = `.column-gutter[data-col="${colIdx}"]`;

    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];
      if (entry.type !== 'module' || !entry.taps?.length) continue;

      for (const tap of entry.taps) {
        const fieldKey = `${sketchId}/${colIdx}/${i}/${tap.fieldPath}`;
        const rect = this.layoutManager.getRelativeRect(
          fieldKey,
          this.renderRoot.querySelector(gutterSelector) as HTMLElement ?? this,
        );
        if (!rect) continue;

        const yCenter = rect.top + rect.height / 2;
        indicators.push(html`
          <div class="tap-indicator ${tap.direction}" style="top:${yCenter}px"></div>
          <div class="tap-indicator-line ${tap.direction}" style="top:${yCenter}px"></div>
        `);
      }
    }

    return indicators;
  }

  // ========================================================================
  // Effect cards
  // ========================================================================

  private renderEffectCard(sketchId: string, colIdx: number, chainIdx: number, entry: ModuleEntry) {
    return html`
      <div class="effect-card"
        data-field-key="${sketchId}/${colIdx}/${chainIdx}"
        draggable="true"
        @dragstart=${(e: DragEvent) => this.onDragStart(e, sketchId, colIdx, chainIdx)}
        @dragend=${this.onDragEnd}>
        <div class="effect-card-header">
          <span class="effect-card-name">${shortName(entry.module_type)}</span>
          <button class="remove-btn"
            @click=${() => appController.removeEffectFromChain(sketchId, colIdx, chainIdx)}>×</button>
        </div>
        <div class="effect-card-body">
          ${this.renderFieldWidgets(sketchId, colIdx, chainIdx, entry)}
        </div>
      </div>
    `;
  }

  /**
   * Render the body of an effect card.
   *
   * If the module has a registered custom inspector, use it.
   * Otherwise, auto-generate field editor widgets from param declarations.
   */
  private renderFieldWidgets(sketchId: string, colIdx: number, chainIdx: number, entry: ModuleEntry) {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const tappingMode = appState.local.tappingMode;
    const selectedPath = appState.local.selectedFieldPath;

    // Create a FieldBinding that reads/writes through the controller
    const binding: FieldBinding = {
      instanceKey: entry.instance_key,
      getValue: (fieldPath: string) => {
        return entry.params[fieldPath]
          ?? plugin?.params.find(p => p.name === fieldPath)?.defaultValue
          ?? 0;
      },
      setValue: (fieldPath: string, value: any) => {
        appController.setEffectParam(sketchId, colIdx, chainIdx, fieldPath, value);
      },
    };

    // Check for a custom inspector
    const inspectorFactory = editorRegistry.getInspectorFactory(entry.module_type);
    if (inspectorFactory) {
      let el = this.inspectorCache.get(entry.instance_key);
      if (!el) {
        el = inspectorFactory.create(entry.instance_key, binding);
        this.inspectorCache.set(entry.instance_key, el);
      } else {
        // Update binding on existing element
        (el as any).binding = binding;
      }
      return html`${el}`;
    }

    // Fallback: auto-generate from param declarations
    if (!plugin || plugin.params.length === 0) return nothing;

    return plugin.params.map(p => {
      const fieldPath = p.name;
      const fieldKey = `${sketchId}/${colIdx}/${chainIdx}/${fieldPath}`;
      const isSelected = selectedPath === fieldKey;

      if (p.type === 0) {
        return html`<field-toggle
          .fieldPath=${fieldPath} .label=${p.name}
          .defaultValue=${p.defaultValue}
          .binding=${binding}
          .tappingMode=${tappingMode}
          .selected=${isSelected}
          .layoutManager=${this.layoutManager}
          data-layout-key=${fieldKey}
          ${this.registerFieldRef(fieldKey)}></field-toggle>`;
      }

      if (p.type === 1) {
        return html`<field-trigger
          .fieldPath=${fieldPath} .label=${p.name}
          .defaultValue=${p.defaultValue}
          .binding=${binding}
          .tappingMode=${tappingMode}
          .selected=${isSelected}
          .layoutManager=${this.layoutManager}
          data-layout-key=${fieldKey}
          ${this.registerFieldRef(fieldKey)}></field-trigger>`;
      }

      return html`<field-slider
        .fieldPath=${fieldPath} .label=${p.name}
        .min=${p.min} .max=${p.max}
        .step=${p.type === 13 ? 1 : 0.01}
        .defaultValue=${p.defaultValue}
        .binding=${binding}
        .tappingMode=${tappingMode}
        .selected=${isSelected}
        .layoutManager=${this.layoutManager}
        data-layout-key=${fieldKey}
        ${this.registerFieldRef(fieldKey)}></field-slider>`;
    });
  }

  /**
   * Returns a Lit directive-like ref callback that registers the field element
   * with the layout manager after it's rendered.
   */
  private registerFieldRef(key: string) {
    // We'll register in updated() by scanning data-layout-key attributes instead
    return nothing;
  }

  /**
   * After each render, scan for field editors and register them with the layout manager.
   */
  protected firstUpdated() {
    this.scanAndRegisterFields();
  }

  private scanAndRegisterFields() {
    // Deferred to next frame to ensure field editors have rendered
    requestAnimationFrame(() => {
      const editors = this.renderRoot.querySelectorAll('[data-layout-key]');
      const seenKeys = new Set<string>();
      for (const el of editors) {
        const key = (el as HTMLElement).dataset.layoutKey;
        if (key && 'getControlElements' in el) {
          this.layoutManager.register(key, el as any);
          seenKeys.add(key);
        }
      }
      // Unregister stale entries
      for (const key of this.layoutManager.entries.keys()) {
        if (!seenKeys.has(key)) {
          this.layoutManager.unregister(key);
        }
      }
    });
  }

  // ========================================================================
  // Drop zones & add buttons
  // ========================================================================

  private renderDropZone(sketchId: string, colIdx: number, insertIdx: number) {
    return html`
      <div class="drop-zone"
        @dragover=${(e: DragEvent) => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add('drag-over'); }}
        @dragleave=${(e: DragEvent) => { (e.currentTarget as HTMLElement).classList.remove('drag-over'); }}
        @drop=${(e: DragEvent) => this.onDrop(e, sketchId, colIdx, insertIdx)}>
      </div>
      <button class="add-btn"
        @click=${() => appController.addEffectToChain(sketchId, colIdx, insertIdx, 'com.nattos.brightness_contrast')}>+</button>
    `;
  }

  // ========================================================================
  // Drag & Drop
  // ========================================================================

  private onDragStart(e: DragEvent, sketchId: string, colIdx: number, chainIdx: number) {
    this.dragSketchId = sketchId;
    this.dragSourceCol = colIdx;
    this.dragSourceIdx = chainIdx;
    e.dataTransfer!.effectAllowed = 'move';
    // Mark the dragged card visually
    (e.currentTarget as HTMLElement).setAttribute('dragging', '');
  }

  private onDragEnd = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).removeAttribute('dragging');
    this.dragSketchId = null;
    this.dragSourceCol = -1;
    this.dragSourceIdx = -1;
    // Clear all drag-over highlights
    this.renderRoot.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  };

  private onDrop(e: DragEvent, targetSketchId: string, targetColIdx: number, targetInsertIdx: number) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('drag-over');

    if (!this.dragSketchId || this.dragSourceCol < 0 || this.dragSourceIdx < 0) return;
    if (this.dragSketchId !== targetSketchId) return; // cross-sketch drag not supported yet

    const sketch = appState.database.sketches[targetSketchId];
    if (!sketch) return;

    const sourceCol = sketch.columns[this.dragSourceCol];
    const sourceEntry = sourceCol?.chain[this.dragSourceIdx];
    if (!sourceEntry || sourceEntry.type !== 'module') return;

    appController.mutate('Move effect', draft => {
      const sk = draft.sketches[targetSketchId];
      const srcCol = sk.columns[this.dragSourceCol];
      const dstCol = sk.columns[targetColIdx] ?? srcCol;

      // Remove from source
      const [removed] = srcCol.chain.splice(this.dragSourceIdx, 1);

      // Adjust insert index if moving within the same column and after the source
      let adjustedIdx = targetInsertIdx;
      if (this.dragSourceCol === targetColIdx && targetInsertIdx > this.dragSourceIdx) {
        adjustedIdx--;
      }

      // Insert at target
      dstCol.chain.splice(adjustedIdx, 0, removed);
    });
  }

  private onDropToNewColumn(e: DragEvent, colIdx: number) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('drag-over');

    if (!this.dragSketchId || this.dragSourceCol < 0 || this.dragSourceIdx < 0) return;

    const sketchId = this.dragSketchId;
    const sketch = appState.database.sketches[sketchId];
    if (!sketch) return;

    const sourceEntry = sketch.columns[this.dragSourceCol]?.chain[this.dragSourceIdx];
    if (!sourceEntry || sourceEntry.type !== 'module') return;

    appController.mutate('Move to new column', draft => {
      const sk = draft.sketches[sketchId];

      // Remove from source column
      const [removed] = sk.columns[this.dragSourceCol].chain.splice(this.dragSourceIdx, 1);

      // Create new column with the moved effect
      while (sk.columns.length <= colIdx) {
        sk.columns.push({
          name: `Column ${sk.columns.length + 1}`,
          chain: [
            { type: 'texture_input', id: `in_${sk.columns.length}` },
            { type: 'texture_output', id: `out_${sk.columns.length}` },
          ],
        });
      }

      // Insert before the texture_output
      const targetChain = sk.columns[colIdx].chain;
      const outIdx = targetChain.findIndex(e => e.type === 'texture_output');
      targetChain.splice(outIdx >= 0 ? outIdx : targetChain.length, 0, removed);
    });
  }
}
