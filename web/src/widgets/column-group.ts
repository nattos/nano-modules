/**
 * <column-group> — A single column in the sketch editor.
 *
 * Renders a column header, processing chain (effect cards, trace rows, drop zones),
 * and gutter strip for tap visualization. Extracted from edit-tab so that
 * columns-view lifecycle (attach/detach) triggers proper MobX disposal and
 * trace point unregistration.
 *
 * The column-group receives callbacks from its parent (edit-tab) for actions
 * like drag-drop, field scanning, and tap overlays.
 */

import { html, css, nothing, TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { Sketch, SketchColumn, ChainEntry, ModuleEntry } from '../sketch-types';
import type { FieldBinding, FieldEditorElement } from './field-editor';
import { isFieldEditor } from './field-editor';
import { FieldLayoutManager } from './field-layout-manager';
import { editorRegistry } from '../editor-registry';
import { createGenericInspector, type InspectorFieldDef } from './generic-inspector';
import type { TracePoint } from '../engine-types';
import type { ParamInfo } from '../engine-types';

// Import field widget elements
import './field-slider';
import './field-toggle';
import './field-trigger';
import './texture-monitor';
import './spark-chart';
import './smart-input';

import type { LongEdit } from '../state/history';

function shortName(id: string) { return id.split('.').pop() ?? id; }

/** Map an engine ParamInfo to a generic inspector field definition. */
function paramToFieldDef(p: ParamInfo): InspectorFieldDef {
  switch (p.type) {
    case 0: // bool
      return { type: 'boolean', label: p.name, path: p.name, default: p.defaultValue > 0.5 };
    case 1: // event
      return { type: 'button', label: p.name, path: p.name, text: p.name };
    case 100: // text
      return { type: 'string', label: p.name, path: p.name };
    default: // 10=standard, 11=option, 13=integer
      return {
        type: 'slider',
        label: p.name,
        path: p.name,
        min: p.min,
        max: p.max,
        step: p.type === 13 ? 1 : 0.01,
        default: p.defaultValue,
      };
  }
}

/** Callbacks from edit-tab for column-level interactions. */
export interface ColumnGroupCallbacks {
  onCardPointerDown(e: PointerEvent, sketchId: string, colIdx: number, chainIdx: number): void;
  getInspectorElement(instanceKey: string, moduleType: string, binding: FieldBinding): HTMLElement | null;
}

@customElement('column-group')
export class ColumnGroup extends MobxLitElement {
  @property({ type: Number }) colIdx = -1;
  @property() sketchId = '';
  @property({ type: Boolean }) isPlaceholder = false;
  @property({ attribute: false }) callbacks: ColumnGroupCallbacks | null = null;

  /** Each column-group owns its own layout manager for field position tracking. */
  public readonly layoutManager = new FieldLayoutManager();

  /** Which chain entry index is currently being type-edited (smart-input open), or -1 for none. */
  private editingTypeChainIdx = -1;
  /** The active LongEdit for type preview (null when not previewing). */
  private typeLongEdit: LongEdit | null = null;

  static styles = css`
    :host {
      display: flex;
      gap: 0;
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
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px;
      text-align: center;
      width: 100%;
      box-sizing: border-box;
    }
    .chain-wire { width: 2px; height: 12px; background: rgba(255,255,255,0.12); }

    /* --- Effect cards (unified with chain-marker styling) --- */
    .effect-card {
      width: 100%;
      padding: 0;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px;
      box-sizing: border-box;
    }
    .effect-card[dragging] { opacity: 0.4; }
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
    .effect-card-name {
      font-size: 11px;
      color: var(--app-text-color1);
      cursor: default;
    }
    .effect-card-name-wrapper {
      flex: 1;
      min-width: 0;
      position: relative;
    }
    .effect-card-body { padding: 6px 10px; position: relative; }
    .remove-btn {
      background: none; border: none;
      color: var(--app-text-color2); cursor: pointer;
      font-size: 14px; padding: 0 4px; line-height: 1;
    }
    .remove-btn:hover { color: var(--app-hi-color1); }

    /* --- Trace card row --- */
    .trace-card-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      width: 100%;
      padding: 4px 0;
      box-sizing: border-box;
    }

    /* --- Drop zones (invisible spacing, no visual change on hover) --- */
    .drop-zone {
      width: 100%;
      min-height: 4px;
      border-radius: 2px;
    }

    /* --- Drag insertion marker (absolutely positioned, no layout shift) --- */
    .drag-insert-marker {
      position: absolute;
      left: 0;
      right: 24px; /* leave room for gutter */
      height: 3px;
      background: var(--app-hi-color2, #4169E1);
      border-radius: 2px;
      pointer-events: none;
      z-index: 20;
      display: none;
      box-shadow: 0 0 6px rgba(65, 105, 225, 0.5);
    }
    .drag-insert-marker.visible {
      display: block;
    }
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

    /* --- Tap overlay --- */
    .tap-overlay-container {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 10;
    }
    .tap-overlay-hit {
      position: absolute;
      background: rgba(65, 105, 225, 0.12);
      border: 1px solid rgba(65, 105, 225, 0.3);
      border-radius: 2px;
      cursor: pointer;
      pointer-events: all;
    }
    .tap-overlay-hit:hover {
      background: rgba(65, 105, 225, 0.25);
    }
    .tap-overlay-hit[selected] {
      outline: 1px solid var(--app-hi-color2, #4169E1);
      outline-offset: 1px;
      background: rgba(65, 105, 225, 0.2);
    }
    /* Output field overlay uses a different color */
    .tap-overlay-hit.output {
      background: rgba(225, 105, 65, 0.12);
      border: 1px solid rgba(225, 105, 65, 0.3);
    }
    .tap-overlay-hit.output:hover {
      background: rgba(225, 105, 65, 0.25);
    }
    .tap-overlay-hit.output[selected] {
      outline-color: var(--app-hi-color1, #E16941);
      background: rgba(225, 105, 65, 0.2);
    }
    /* Read-only output field display */
    .output-field {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 2px 0;
    }
    .output-field-label {
      color: var(--app-text-color2);
      font-size: 10px;
      min-width: 60px;
      flex-shrink: 0;
    }
    .output-field-value {
      color: var(--app-hi-color1, #E16941);
      font-size: 10px;
      text-align: right;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .output-separator {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      opacity: 0.5;
      padding: 4px 0 2px;
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
  `;

  updated() {
    const column = this.renderRoot.querySelector('.column') as HTMLElement | null;
    if (column) this.layoutManager.observeContainer(column);
    this.scanAndRegisterFields();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.layoutManager.dispose();
  }

  /**
   * Return all possible insertion points with their viewport-relative positions.
   * Used by edit-tab to find the globally closest insertion target.
   */
  getInsertionPoints(): { colIdx: number; insertIdx: number; x: number; y: number; isPlaceholder: boolean }[] {
    const results: { colIdx: number; insertIdx: number; x: number; y: number; isPlaceholder: boolean }[] = [];
    const colEl = this.renderRoot.querySelector('.column') as HTMLElement | null;
    if (!colEl) return results;
    const colRect = colEl.getBoundingClientRect();
    const centerX = colRect.left + colRect.width / 2;

    if (this.isPlaceholder) {
      // Placeholder column: single insertion point at vertical center
      results.push({
        colIdx: this.colIdx,
        insertIdx: 1, // after texture_input
        x: centerX,
        y: colRect.top + colRect.height / 2,
        isPlaceholder: true,
      });
      return results;
    }

    // Real column: each drop zone is an insertion point
    const zones = this.renderRoot.querySelectorAll('.drop-zone');
    for (const zone of zones) {
      const zoneRect = zone.getBoundingClientRect();
      const dropCol = parseInt((zone as HTMLElement).dataset.dropCol!);
      const dropIdx = parseInt((zone as HTMLElement).dataset.dropIdx!);
      results.push({
        colIdx: dropCol,
        insertIdx: dropIdx,
        x: centerX,
        y: zoneRect.top + zoneRect.height / 2,
        isPlaceholder: false,
      });
    }

    return results;
  }

  /** Show the drag insertion marker at the given Y offset (relative to this element). */
  showInsertMarker(y: number) {
    const marker = this.renderRoot.querySelector('.drag-insert-marker') as HTMLElement | null;
    if (marker) {
      marker.classList.add('visible');
      marker.style.top = `${y}px`;
    }
  }

  /** Hide the drag insertion marker. */
  hideInsertMarker() {
    const marker = this.renderRoot.querySelector('.drag-insert-marker') as HTMLElement | null;
    marker?.classList.remove('visible');
  }

  render() {
    if (this.isPlaceholder) {
      return html`
        <div class="column" style="position:relative">
          <div class="column-header">Column ${this.colIdx + 1}</div>
          <div class="column-placeholder" data-placeholder-col=${this.colIdx}>
            Drop effects here
          </div>
          <div class="drag-insert-marker"></div>
        </div>
        <div class="column-gutter"></div>
      `;
    }

    const sketch = appState.database.sketches[this.sketchId];
    if (!sketch || this.colIdx < 0 || this.colIdx >= sketch.columns.length) {
      return nothing;
    }

    const column = sketch.columns[this.colIdx];

    // Touch layout generation for reactive updates
    const _layoutGen = this.layoutManager.generation;

    return html`
      <div class="column" style="position:relative">
        <div class="column-header">${column.name}</div>
        ${this.renderChain(sketch, column)}
        <div class="drag-insert-marker"></div>
      </div>
      <div class="column-gutter" data-col=${this.colIdx}>
        ${this.renderGutterTaps(sketch, column)}
      </div>
    `;
  }

  // ========================================================================
  // Chain rendering
  // ========================================================================

  private renderChain(sketch: Sketch, column: SketchColumn) {
    const items: (TemplateResult | typeof nothing)[] = [];

    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];

      if (entry.type === 'texture_input') {
        items.push(html`<div class="chain-marker">Input</div>`);
        // Trace row for the texture input
        items.push(this.renderTraceCardRow(i, entry));
        items.push(html`<div class="chain-wire"></div>`);
        items.push(this.renderDropZone(i + 1));
        items.push(html`<div class="chain-wire"></div>`);
      } else if (entry.type === 'texture_output') {
        items.push(html`<div class="chain-marker">Output</div>`);
      } else if (entry.type === 'module') {
        items.push(this.renderEffectCard(i, entry));
        // Trace row for this module's outputs
        items.push(this.renderTraceCardRow(i, entry));
        items.push(html`<div class="chain-wire"></div>`);
        if (i + 1 < column.chain.length) {
          items.push(this.renderDropZone(i + 1));
          items.push(html`<div class="chain-wire"></div>`);
        }
      }
    }

    return items;
  }

  // ========================================================================
  // Trace card rows
  // ========================================================================

  private renderTraceCardRow(chainIdx: number, entry: ChainEntry) {
    if (entry.type === 'texture_input') {
      // Show texture thumbnail for the chain input
      const traceId = `trace_${this.sketchId}/${this.colIdx}/${chainIdx}/input`;
      const target: TracePoint['target'] = {
        type: 'chain_entry',
        sketchId: this.sketchId,
        colIdx: this.colIdx,
        chainIdx,
        side: 'input',
      };
      return html`
        <div class="trace-card-row">
          <texture-monitor
            .traceId=${traceId}
            .traceTarget=${target}
            .width=${64}
            .height=${36}
          ></texture-monitor>
        </div>
      `;
    }

    if (entry.type === 'module') {
      const traceId = `trace_${this.sketchId}/${this.colIdx}/${chainIdx}/output`;
      const target: TracePoint['target'] = {
        type: 'chain_entry',
        sketchId: this.sketchId,
        colIdx: this.colIdx,
        chainIdx,
        side: 'output',
      };

      // Check for data outputs from plugin io
      const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
      const dataOutputs = plugin?.io.filter(io => io.kind === 2) ?? [];

      const binding: FieldBinding = {
        instanceKey: entry.instance_key,
        getValue: (fieldPath: string) => {
          const ps = appState.local.engine.pluginStates[entry.instance_key];
          if (ps && fieldPath in ps) return ps[fieldPath];
          return entry.params?.[fieldPath]
            ?? plugin?.params.find(p => p.name === fieldPath)?.defaultValue
            ?? 0;
        },
        setValue: () => {},  // read-only for trace
      };

      return html`
        <div class="trace-card-row">
          <texture-monitor
            .traceId=${traceId}
            .traceTarget=${target}
            .width=${64}
            .height=${36}
          ></texture-monitor>
          ${dataOutputs.map(io => html`
            <spark-chart
              .fieldPath=${io.name}
              .binding=${binding}
              .width=${64}
              .height=${24}
            ></spark-chart>
          `)}
        </div>
      `;
    }

    return nothing;
  }

  // ========================================================================
  // Effect cards
  // ========================================================================

  private renderEffectCard(chainIdx: number, entry: ModuleEntry) {
    const tappingMode = appState.local.tappingMode;
    const isEditingType = this.editingTypeChainIdx === chainIdx;

    return html`
      <div class="effect-card">
        <div class="effect-card-header"
          @pointerdown=${(e: PointerEvent) => {
            if (!isEditingType) this.callbacks?.onCardPointerDown(e, this.sketchId, this.colIdx, chainIdx);
          }}>
          <div class="effect-card-name-wrapper">
            ${isEditingType ? html`
              <smart-input
                .effects=${appState.local.availableEffects}
                .initialValue=${shortName(entry.module_type)}
                .autoSelect=${true}
                @preview=${(e: CustomEvent) => this.handleTypePreview(chainIdx, e.detail)}
                @commit=${(e: CustomEvent) => this.handleTypeCommit(chainIdx, e.detail)}
                @cancel=${() => this.handleTypeCancel()}
              ></smart-input>
            ` : html`
              <span class="effect-card-name"
                @dblclick=${(e: Event) => { e.stopPropagation(); this.beginEditType(chainIdx); }}
              >${shortName(entry.module_type)}</span>
            `}
          </div>
          <button class="remove-btn"
            @pointerdown=${(e: Event) => e.stopPropagation()}
            @click=${() => appController.removeEffectFromChain(this.sketchId, this.colIdx, chainIdx)}>×</button>
        </div>
        <div class="effect-card-body" data-card-key="${this.sketchId}/${this.colIdx}/${chainIdx}">
          ${this.renderFieldWidgets(chainIdx, entry)}
          ${tappingMode ? this.renderTapOverlay(chainIdx, entry) : nothing}
        </div>
      </div>
    `;
  }

  // ========================================================================
  // Smart type editing
  // ========================================================================

  /** Open the smart-input for a chain entry. */
  beginEditType(chainIdx: number) {
    this.editingTypeChainIdx = chainIdx;
    this.requestUpdate();
  }

  private handleTypePreview(chainIdx: number, effectId: string) {
    if (!this.typeLongEdit) {
      this.typeLongEdit = appController.beginChangeEffectType(
        this.sketchId, this.colIdx, chainIdx, effectId);
    } else {
      appController.updateChangeEffectType(
        this.typeLongEdit, this.sketchId, this.colIdx, chainIdx, effectId);
    }
  }

  private handleTypeCommit(chainIdx: number, effectId: string) {
    if (this.typeLongEdit) {
      // Update to final value, then accept (creates single undo point)
      appController.updateChangeEffectType(
        this.typeLongEdit, this.sketchId, this.colIdx, chainIdx, effectId);
      this.typeLongEdit.accept();
      this.typeLongEdit = null;
    } else {
      // No preview happened — direct change
      appController.changeEffectType(this.sketchId, this.colIdx, chainIdx, effectId);
    }
    this.editingTypeChainIdx = -1;
    this.requestUpdate();
  }

  private handleTypeCancel() {
    if (this.typeLongEdit) {
      this.typeLongEdit.cancel();
      this.typeLongEdit = null;
    }
    this.editingTypeChainIdx = -1;
    this.requestUpdate();
  }

  /** Build the set of field names that are outputs for a given module entry. */
  private getOutputFieldNames(entry: ModuleEntry): Set<string> {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const names = new Set<string>();
    // io-declared data outputs
    for (const io of plugin?.io ?? []) {
      if (io.kind === 2) names.add(io.name);
    }
    // Fields that already have write taps
    for (const tap of entry.taps ?? []) {
      if (tap.direction === 'write') names.add(tap.fieldPath);
    }
    return names;
  }

  private renderTapOverlay(chainIdx: number, entry: ModuleEntry) {
    const selectedPath = appState.local.selectedFieldPath;
    const cardBody = this.renderRoot.querySelector(
      `[data-card-key="${this.sketchId}/${this.colIdx}/${chainIdx}"]`
    ) as HTMLElement | null;

    if (!cardBody) return html`<div class="tap-overlay-container"></div>`;

    const outputFieldNames = this.getOutputFieldNames(entry);

    const hits: TemplateResult[] = [];
    const keyPrefix = `${this.sketchId}/${this.colIdx}/${chainIdx}/`;

    for (const [key] of this.layoutManager.entries) {
      if (!key.startsWith(keyPrefix)) continue;

      const rect = this.layoutManager.getRelativeRect(key, cardBody);
      if (!rect) continue;

      const fieldPath = key.slice(keyPrefix.length);
      const isOutput = outputFieldNames.has(fieldPath);
      const isSelected = selectedPath === key;

      hits.push(html`
        <div class="tap-overlay-hit ${isOutput ? 'output' : ''}" ?selected=${isSelected}
          style="top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px"
          @click=${() => this.onTapOverlayClick(key, fieldPath, isOutput, chainIdx)}></div>
      `);
    }

    return html`<div class="tap-overlay-container">${hits}</div>`;
  }

  private onTapOverlayClick(key: string, fieldPath: string, isOutput: boolean, chainIdx: number) {
    if (isOutput) {
      // Auto-create write tap with new rail
      appController.autoCreateTapForOutput(this.sketchId, this.colIdx, chainIdx, fieldPath, 'float');
    } else {
      // Auto-create read tap with last matching rail
      appController.autoCreateTapForInput(this.sketchId, this.colIdx, chainIdx, fieldPath, 'float');
    }
    appController.selectField(key);
  }

  private renderFieldWidgets(chainIdx: number, entry: ModuleEntry) {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const outputFieldNames = this.getOutputFieldNames(entry);

    const binding: FieldBinding = {
      instanceKey: entry.instance_key,
      getValue: (fieldPath: string) => {
        // Read from the live plugin state (canonical source of truth).
        // This reflects user-set values, modulated values from read taps,
        // and module-produced outputs (e.g. LFO output).
        const ps = appState.local.engine.pluginStates[entry.instance_key];
        if (ps && fieldPath in ps) return ps[fieldPath];
        // Fallback to sketch instance state or plugin defaults (before first frame arrives)
        const sketch = appState.database.sketches[this.sketchId];
        const instState = sketch?.instances?.[entry.instance_key]?.state;
        return instState?.[fieldPath]
          ?? entry.params?.[fieldPath]
          ?? plugin?.params.find(p => p.name === fieldPath)?.defaultValue
          ?? 0;
      },
      setValue: (fieldPath: string, value: any) => {
        appController.setEffectParam(this.sketchId, this.colIdx, chainIdx, fieldPath, value);
      },
    };

    // Check for a custom inspector registered via the editor registry
    const el = this.callbacks?.getInspectorElement(entry.instance_key, entry.module_type, binding);
    if (el) {
      return html`${el}${this.renderOutputFields(plugin, entry, binding, outputFieldNames)}`;
    }

    // Use the generic inspector to render input fields (excluding outputs)
    const inputParams = (plugin?.params ?? []).filter(p => !outputFieldNames.has(p.name));

    let inputSection = nothing as typeof nothing | TemplateResult;
    if (inputParams.length > 0) {
      const fields = inputParams.map((p): InspectorFieldDef => paramToFieldDef(p));
      const inspector = createGenericInspector(fields);
      inputSection = inspector(binding);
    }

    return html`${inputSection}${this.renderOutputFields(plugin, entry, binding, outputFieldNames)}`;
  }

  /**
   * Render output fields as read-only scalar-sliders.
   * These implement FieldEditorElement so they're scanned by the field layout
   * manager and get tap overlay hit targets.
   */
  private renderOutputFields(
    plugin: typeof appState.local.plugins[0] | undefined,
    entry: ModuleEntry,
    binding: FieldBinding,
    outputFieldNames: Set<string>,
  ) {
    if (!plugin) return nothing;

    // Collect all output field names: from io (kind===2), from write taps,
    // and also params that match io outputs
    const outputParams = plugin.params.filter(p => outputFieldNames.has(p.name));
    // io-only outputs (declared in io but not as params)
    const ioOnlyOutputs = plugin.io.filter(
      io => io.kind === 2 && !plugin.params.some(p => p.name === io.name)
    );

    if (outputParams.length === 0 && ioOnlyOutputs.length === 0) return nothing;

    return html`
      <div class="output-separator">outputs</div>
      ${outputParams.map(p => html`
        <scalar-slider style="width: 100%;"
          .fieldPath=${p.name}
          .label=${p.name}
          .min=${p.min}
          .max=${p.max}
          .step=${p.type === 13 ? 1 : 0.01}
          .defaultValue=${p.defaultValue}
          .binding=${binding}
        ></scalar-slider>
      `)}
      ${ioOnlyOutputs.map(io => html`
        <scalar-slider style="width: 100%;"
          .fieldPath=${io.name}
          .label=${io.name}
          .min=${0}
          .max=${1}
          .step=${0.01}
          .defaultValue=${0}
          .binding=${binding}
        ></scalar-slider>
      `)}
    `;
  }

  // ========================================================================
  // Gutter tap visualization
  // ========================================================================

  private renderGutterTaps(sketch: Sketch, column: SketchColumn) {
    const indicators: TemplateResult[] = [];
    const gutterEl = this.renderRoot.querySelector(`.column-gutter[data-col="${this.colIdx}"]`) as HTMLElement | null;
    if (!gutterEl) return indicators;

    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];
      if (entry.type !== 'module' || !entry.taps?.length) continue;

      for (const tap of entry.taps) {
        const fieldKey = `${this.sketchId}/${this.colIdx}/${i}/${tap.fieldPath}`;
        const rect = this.layoutManager.getRelativeRect(fieldKey, gutterEl);
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
  // Drop zones
  // ========================================================================

  private renderDropZone(insertIdx: number) {
    return html`
      <div class="drop-zone" data-drop-col=${this.colIdx} data-drop-idx=${insertIdx}></div>
      <button class="add-btn"
        @click=${() => this.addEffectAndBeginEdit(insertIdx)}>+</button>
    `;
  }

  /** Insert a placeholder effect and immediately open smart-input to choose the type. */
  private addEffectAndBeginEdit(insertIdx: number) {
    appController.addEffectToChain(this.sketchId, this.colIdx, insertIdx, 'com.nattos.brightness_contrast');
    // The new entry is at insertIdx in the chain. Open the type editor for it.
    // Use requestUpdate + microtask to ensure the DOM has rendered the new card.
    this.requestUpdate();
    requestAnimationFrame(() => {
      this.beginEditType(insertIdx);
    });
  }

  // ========================================================================
  // Field scanning (same as edit-tab's scanAndRegisterFields)
  // ========================================================================

  private scanAndRegisterFields() {
    requestAnimationFrame(() => {
      if (!this.sketchId) return;

      const seenKeys = new Set<string>();
      const cardBodies = this.renderRoot.querySelectorAll('[data-card-key]');
      for (const body of cardBodies) {
        const cardKey = (body as HTMLElement).dataset.cardKey!;
        this.scanFieldEditorsIn(body, cardKey, seenKeys);
      }

      for (const key of this.layoutManager.entries.keys()) {
        if (!seenKeys.has(key)) {
          this.layoutManager.unregister(key);
        }
      }
    });
  }

  private scanFieldEditorsIn(root: ParentNode, cardKey: string, seenKeys: Set<string>) {
    for (const child of root.children) {
      if (isFieldEditor(child)) {
        const fieldEditor = child as unknown as FieldEditorElement;
        for (const fieldPath of fieldEditor.controlledFields) {
          const key = `${cardKey}/${fieldPath}`;
          this.layoutManager.register(key, fieldEditor);
          seenKeys.add(key);
        }
      }
      if ((child as Element).shadowRoot) {
        this.scanFieldEditorsIn((child as Element).shadowRoot!, cardKey, seenKeys);
      }
      if (child.children.length > 0) {
        this.scanFieldEditorsIn(child, cardKey, seenKeys);
      }
    }
  }
}
