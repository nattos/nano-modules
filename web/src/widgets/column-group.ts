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
import { reaction, IReactionDisposer } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { FieldConnectInfo } from '../state/controller';
import type { Sketch, SketchColumn, ChainEntry, ModuleEntry } from '../sketch-types';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle } from './field-editor';
import { isFieldEditor } from './field-editor';
import { FieldLayoutManager } from './field-layout-manager';
import { editorRegistry } from '../editor-registry';
import { createGenericInspector, type InspectorFieldDef } from './generic-inspector';
import type { TracePoint } from '../engine-types';
import type { ParamInfo } from '../engine-types';
import { PointerDragOp } from '../utils/pointer-drag-op';

/**
 * Pierce nested shadow roots looking for the topmost element at (x, y).
 * elementFromPoint at document level returns the shadow host; descending
 * into each shadowRoot gives us the actual pointer target inside.
 */
function deepElementFromPoint(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const sr = (el as unknown as { shadowRoot: ShadowRoot | null }).shadowRoot;
    if (!sr) break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** Find the tap-overlay-hit under the given viewport coordinates, if any. */
function findTapOverlayHitAt(x: number, y: number): HTMLElement | null {
  const leaf = deepElementFromPoint(x, y);
  if (!leaf) return null;
  return (leaf.closest?.('.tap-overlay-hit') as HTMLElement | null) ?? null;
}

// Import field widget elements
import './field-slider';
import './field-toggle';
import './field-trigger';
import './field-text';
import './field-select';
import './field-placeholder';
import './texture-monitor';
import './spark-chart';
import './smart-input';
import './scalar-slider';
import './output-trace-card';

import type { LongEdit } from '../state/history';
import type { Selectable } from '../state/types';

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

/**
 * Derive the human-readable type chip for a schema field — used by
 * the placeholder widget to let the user see that a port carries
 * structured, vector, GPU-buffer or texture data.
 */
function schemaFieldKindLabel(def: any): string {
  if (!def || typeof def !== 'object') return 'unknown';
  switch (def.type) {
    case 'object':  return 'struct';
    case 'array':   return def.gpu ? 'gpu buffer' : 'array';
    case 'texture': return 'texture';
    case 'float2':  return 'vec2';
    case 'float3':  return 'vec3';
    case 'float4':  return 'vec4';
    default:        return String(def.type ?? 'unknown');
  }
}

/** The raw schema type tag (used by trace cards to pick a rendering mode). */
function schemaFieldKindTag(def: any): string {
  if (!def || typeof def !== 'object') return 'unknown';
  return String(def.type ?? 'unknown');
}

/** Prefer an explicit display name from the schema when present. */
function schemaFieldDisplayName(def: any, fallback: string): string {
  if (def && typeof def.name === 'string' && def.name.length > 0) return def.name;
  return fallback;
}

/** True for structured / GPU / vector fields that need layout-based auto-tap. */
function isStructuredSchemaType(def: any): boolean {
  if (!def || typeof def !== 'object') return false;
  const t = def.type;
  return t === 'object' || t === 'array' || t === 'float2' || t === 'float3' || t === 'float4';
}

/**
 * True when a schema field is a "simple" scalar port that fits the
 * existing ParamInfo slider/toggle/etc model. Everything else needs
 * a placeholder.
 */
function isScalarSchemaField(def: any): boolean {
  if (!def || typeof def !== 'object') return false;
  const t = def.type;
  return t === 'float' || t === 'int' || t === 'bool'
      || t === 'string' || t === 'event';
}

/** Callbacks from edit-tab for column-level interactions. */
export interface ColumnGroupCallbacks {
  onCardPointerDown(e: PointerEvent, sketchId: string, colIdx: number, chainIdx: number): void;
  getInspectorElement(instanceKey: string, moduleType: string, binding: FieldBinding): HTMLElement | null;
  onGutterWidthChanged?(): void;
}

@customElement('column-group')
export class ColumnGroup extends MobxLitElement {
  @property({ type: Number }) colIdx = -1;
  @property() sketchId = '';
  @property({ type: Boolean }) isPlaceholder = false;
  @property({ type: Number }) columnWidth = 300;
  @property({ attribute: false }) callbacks: ColumnGroupCallbacks | null = null;

  /** Each column-group owns its own layout manager for field position tracking. */
  public readonly layoutManager = new FieldLayoutManager();

  /** Width per rail slot in the gutter. */
  static readonly RAIL_SLOT_WIDTH = 16;
  /** Base gutter width (with zero rails). */
  static readonly GUTTER_BASE_WIDTH = 8;
  /** Number of rails per quantized gutter block. */
  static readonly RAILS_PER_BLOCK = 4;
  /** Width of one quantized block. */
  static readonly GUTTER_BLOCK_WIDTH = ColumnGroup.RAILS_PER_BLOCK * ColumnGroup.RAIL_SLOT_WIDTH;

  /** Compute the number of rails in this column (column-scoped + sketch-scoped). */
  getRailCount(): number {
    const sketch = appState.database.sketches[this.sketchId];
    if (!sketch || this.colIdx < 0 || this.colIdx >= sketch.columns.length) return 0;
    const colRails = sketch.columns[this.colIdx]?.rails?.length ?? 0;
    const sketchRails = sketch.rails?.length ?? 0;
    return colRails + sketchRails;
  }

  /** Compute gutter width, growing in quantized jumps per RAILS_PER_BLOCK. */
  getGutterWidth(): number {
    const railCount = this.getRailCount();
    if (railCount === 0) return ColumnGroup.GUTTER_BASE_WIDTH;
    const blocks = Math.ceil(railCount / ColumnGroup.RAILS_PER_BLOCK);
    return ColumnGroup.GUTTER_BASE_WIDTH + blocks * ColumnGroup.GUTTER_BLOCK_WIDTH;
  }

  /** Which chain entry index is currently being type-edited (smart-input open), or -1 for none. */
  private editingTypeChainIdx = -1;
  /** The active LongEdit for type preview (null when not previewing). */
  private typeLongEdit: LongEdit | null = null;
  /** Disposes the reaction that syncs rail positions. */
  private railReactionDisposer: IReactionDisposer | null = null;

  static styles = css`
    :host {
      display: flex;
      gap: 0;
      align-items: stretch;
    }
    .column {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0;
      width: var(--column-width);
      flex-shrink: 0;
    }
    .column-gutter {
      width: var(--gutter-width);
      flex-shrink: 0;
      position: relative;
      border-left: 1px solid rgba(255,255,255,0.04);
    }
    .column-header {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: 6px 10px;
      width: 100%;
      box-sizing: border-box;
    }
    /* The body is the recessed "rack" that devices slot into. */
    .column-body {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0;
      padding: 4px 0;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      box-shadow: inset 0 1px 0 rgba(0,0,0,0.4), inset 0 0 0 1px rgba(0,0,0,0.25);
      box-sizing: border-box;
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

    /* ------------------------------------------------------------------
     * Devices (cards and markers) share a T-shape: body + top-tab (going
     * up) + bottom-tab (going down). Tabs are narrower than the body and
     * protrude above/below. A continuous 1px border traces the whole
     * shape — tabs overlap the body's top/bottom border by 1px so the
     * border visually joins in a single outline.
     * ---------------------------------------------------------------- */

    /* Colors used consistently across cards and markers. */
    :host {
      --device-bg: rgba(255,255,255,0.07);
      --device-border: rgba(255,255,255,0.22);
      --device-sel-bg: rgba(65, 105, 225, 0.22);
      --device-sel-border: var(--app-hi-color2, #4169E1);
    }

    .effect-card, .chain-marker {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      box-sizing: border-box;
      cursor: default;
      position: relative;
    }
    /* Each device overlaps the previous one so the top-tab U-shape straddles
     * the bottom tab coming down from above (circuit-edge-connector look).
     * The first child of column-body doesn't need this. */
    .effect-card, .chain-marker {
      margin-top: -7px;
    }
    .column-body > :first-child {
      margin-top: 0;
    }
    .effect-card[dragging] { opacity: 0.4; }

    /* Inner body of a device — solid rectangle with full border. */
    .effect-card-inner, .chain-marker-inner {
      width: 100%;
      background: var(--device-bg);
      border: 1px solid var(--device-border);
      box-sizing: border-box;
      position: relative;
      z-index: 0;
    }
    .chain-marker-inner {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      padding: 0;
      cursor: default;
    }
    .chain-marker-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: 8px 10px;
      text-align: center;
      cursor: pointer;
    }
    .effect-card[selected] .effect-card-inner,
    .chain-marker[selected] .chain-marker-inner {
      background: var(--device-sel-bg);
      border-color: var(--device-sel-border);
    }
    .trace-card-row[selected] {
      outline: 1px solid var(--device-sel-border);
      outline-offset: -1px;
    }

    .effect-card-header {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      cursor: grab;
      user-select: none;
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
    /* Horizontal divider under the card header. */
    .effect-card-divider {
      height: 1px;
      background: var(--device-border);
      width: 100%;
    }
    .effect-card[selected] .effect-card-divider {
      background: var(--device-sel-border);
      opacity: 0.5;
    }
    .effect-card-body {
      padding: 6px 10px 8px;
      position: relative;
    }

    /* --- Trace card row (lives INSIDE a device body) --- */
    .trace-card-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      width: 100%;
      padding: 6px 10px 8px;
      box-sizing: border-box;
      border-top: 1px solid var(--device-border);
    }
    .effect-card[selected] .trace-card-row,
    .chain-marker[selected] .trace-card-row {
      border-top-color: var(--device-sel-border);
      opacity: 0.9;
    }

    /* --- Device tabs — circuit-style "tab + slot" connectors. ---
     *
     * Bottom tab (plain narrow rectangle, protrudes below the body).
     * Top tab (wider U-shape SVG with a slot cut into its top — the slot
     * straddles the narrower bottom tab of the card above, so the two
     * elements visually interlock like a card-edge connector).
     *
     * The device box overlaps the previous one by 7px (see margin-top on
     * .effect-card/.chain-marker) so both tabs occupy the same seam region
     * in absolute Y. The bottom tab's z-index > top tab's z-index so the
     * bottom tab visibly sits IN FRONT OF the slot while the posts
     * straddle it. Horizontal widths are chosen so the bottom tab fits
     * inside the slot opening with a small visible clearance gap.
     * ---------------------------------------------------------------- */

    /* Bottom tab (narrow protrusion going down from this card's body). */
    .device-tab.bottom {
      width: 24%;
      align-self: center;
      height: 7px;
      background: var(--device-bg);
      border: 1px solid var(--device-border);
      border-top: none;
      border-radius: 0 0 3px 3px;
      margin-top: -1px;          /* overlap body's bottom border by 1px */
      box-sizing: border-box;
      position: relative;
      z-index: 3;                /* in front of the top tab below */
      cursor: pointer;
    }
    .device-tab.bottom:hover {
      background: rgba(65, 105, 225, 0.3);
      border-color: var(--device-sel-border);
    }
    .device-tab.bottom[selected] {
      background: var(--device-sel-bg);
      border-color: var(--device-sel-border);
      box-shadow: inset 0 0 0 1px var(--device-sel-border);
    }

    /* Top tab (U-shape SVG). 56% wide, with slot carved from its top. */
    .device-tab.top {
      width: 56%;
      align-self: center;
      height: 10px;
      display: block;
      line-height: 0;
      margin-bottom: -1px;       /* overlap body's top border by 1px */
      position: relative;
      z-index: 1;
      cursor: pointer;
      overflow: visible;
    }
    .device-tab.top svg {
      width: 100%;
      height: 100%;
      display: block;
      overflow: visible;
    }
    .device-tab.top .tab-fill {
      fill: var(--device-bg);
    }
    .device-tab.top .tab-stroke {
      fill: none;
      stroke: var(--device-border);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .device-tab.top:hover .tab-fill {
      fill: rgba(65, 105, 225, 0.3);
    }
    .device-tab.top:hover .tab-stroke {
      stroke: var(--device-sel-border);
    }
    .device-tab.top[selected] .tab-fill {
      fill: var(--device-sel-bg);
    }
    .device-tab.top[selected] .tab-stroke {
      stroke: var(--device-sel-border);
      stroke-width: 1.5;
    }
    .effect-card[selected] > .device-tab.top .tab-stroke,
    .chain-marker[selected] > .device-tab.top .tab-stroke {
      stroke: var(--device-sel-border);
    }
    .effect-card[selected] > .device-tab.bottom,
    .chain-marker[selected] > .device-tab.bottom {
      border-color: var(--device-sel-border);
    }

    /* --- Drop zones (invisible hit regions inside tabs, used for drag-drop target discovery) --- */
    .drop-zone {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    /* --- Drag insertion marker (absolutely positioned, no layout shift) --- */
    .drag-insert-marker {
      position: absolute;
      left: 0;
      right: var(--gutter-width, 8px); /* leave room for gutter */
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

    /* --- Tap overlay — spans the entire card inner (inputs body + output
     * trace-card row) so users can click to create taps on ANY field. --- */
    .tap-overlay-container {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 10;
    }
    /* Inputs (reads) — blue. */
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
    /* Output field overlay — writes are red. */
    .tap-overlay-hit.output {
      background: rgba(255, 69, 0, 0.14);
      border: 1px solid rgba(255, 69, 0, 0.35);
    }
    .tap-overlay-hit.output:hover {
      background: rgba(255, 69, 0, 0.28);
    }
    .tap-overlay-hit.output[selected] {
      outline-color: var(--app-hi-color1, #ff4500);
      background: rgba(255, 69, 0, 0.22);
    }
    /* Drag-to-connect visuals. Source is dashed-outlined; current target
     * pulses brighter. Both are layered on top of normal hover styles. */
    .tap-overlay-hit[tap-dragging] {
      outline: 2px dashed var(--app-hi-color2, #4169E1);
      outline-offset: 1px;
    }
    .tap-overlay-hit[tap-drop-target] {
      outline: 2px solid var(--app-hi-color2, #4169E1);
      outline-offset: 1px;
      background: rgba(65, 105, 225, 0.35);
    }
    .tap-overlay-hit.output[tap-drop-target] {
      outline-color: var(--app-hi-color1, #ff4500);
      background: rgba(255, 69, 0, 0.35);
    }
    /* --- Tap visualization (writes=red, reads=blue) --- */
    .tap-indicator {
      position: absolute;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      z-index: 2;
      cursor: pointer;
    }
    .tap-indicator.write { background: var(--app-hi-color1, #ff4500); }
    .tap-indicator.read  { background: var(--app-hi-color2, #4169E1); }
    .tap-indicator:hover { box-shadow: 0 0 0 2px rgba(255,255,255,0.2); }
    .tap-indicator[selected] {
      box-shadow: 0 0 0 2px rgba(255,255,255,0.8);
    }
    .tap-indicator-line {
      position: absolute;
      height: 2px;
      transform: translateY(-50%);
      z-index: 1;
      cursor: pointer;
    }
    /* Invisible padding strip to enlarge the click hitbox above/below the 2px line. */
    .tap-indicator-line::before {
      content: '';
      position: absolute;
      left: 0; right: 0;
      top: -5px; bottom: -5px;
    }
    .tap-indicator-line.write { background: var(--app-hi-color1, #ff4500); opacity: 0.6; }
    .tap-indicator-line.read  { background: var(--app-hi-color2, #4169E1); opacity: 0.6; }
    .tap-indicator-line:hover { opacity: 0.9; }
    .tap-indicator-line[selected] { opacity: 1; }

    /* --- Rail vertical lines ---
     * A rail is drawn as a dim full-height backbone with a bright blue
     * overlay covering just the "active" segment: from the first write
     * tap's Y down to the last read tap's Y. The overlay is only rendered
     * when the rail has at least one writer AND one reader. --- */
    .rail-line {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      transform: translateX(-50%);
      background: rgba(255,255,255,0.08);
      z-index: 0;
    }
    .rail-line:hover {
      background: rgba(255,255,255,0.2);
    }
    .rail-line-active {
      position: absolute;
      width: 2px;
      transform: translateX(-50%);
      background: var(--app-hi-color2, #4169E1);
      opacity: 0.85;
      z-index: 1;
      pointer-events: none;
    }

    /* --- Inspector content (rendered into the right panel via Selectable) --- */
    .section-header {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .inspector-field {
      display: flex; align-items: center; gap: 6px; padding: 4px 0;
    }
    .inspector-field-label {
      min-width: 70px; color: var(--app-text-color2); font-size: 10px; flex-shrink: 0;
    }
    .inspector-field-value {
      flex: 1; min-width: 0; color: var(--app-text-color1); font-size: 10px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .inspector-separator {
      height: 1px; background: rgba(255,255,255,0.06); margin: 8px 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    // React to rail changes and recompute positions outside of render.
    this.railReactionDisposer = reaction(
      () => {
        const sketch = appState.database.sketches[this.sketchId];
        if (!sketch || this.colIdx < 0 || this.colIdx >= sketch.columns.length) return null;
        const colRails = sketch.columns[this.colIdx]?.rails ?? [];
        const sketchRails = sketch.rails ?? [];
        return [...colRails.map(r => r.id), ...sketchRails.map(r => r.id)];
      },
      (railIds) => {
        if (railIds) {
          this.layoutManager.updateRailPositions(railIds, this.getGutterWidth());
          // Notify parent to recalculate layout (gutter width changed)
          this.callbacks?.onGutterWidthChanged?.();
        }
      },
      { fireImmediately: true, equals: (a, b) => {
        if (a === b) return true;
        if (!a || !b || a.length !== b.length) return false;
        return a.every((id, i) => id === b[i]);
      }},
    );
  }

  updated() {
    // Set explicit widths via CSS custom properties on the host element.
    this.style.setProperty('--column-width', `${this.columnWidth}px`);
    this.style.setProperty('--gutter-width', `${this.getGutterWidth()}px`);

    const column = this.renderRoot.querySelector('.column') as HTMLElement | null;
    if (column) this.layoutManager.observeContainer(column);
    this.scanAndRegisterFields();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.railReactionDisposer?.();
    this.railReactionDisposer = null;
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
        <div class="column-body">
          ${this.renderChain(sketch, column)}
        </div>
        <div class="drag-insert-marker"></div>
      </div>
      <div class="column-gutter" data-col=${this.colIdx}>
        ${this.renderRailLines(sketch, column)}
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
        items.push(this.renderInputMarker(i, entry));
      } else if (entry.type === 'texture_output') {
        items.push(this.renderOutputMarker(i, entry));
      } else if (entry.type === 'module') {
        items.push(this.renderEffectCard(i, entry));
      }
    }

    return items;
  }

  /** Render the texture_input marker with a bottom tab (insert-after-input). */
  private renderInputMarker(chainIdx: number, entry: ChainEntry) {
    const path = `input/${this.sketchId}/${this.colIdx}/${chainIdx}`;
    const isSelected = appController.isSelected(path);
    this.registerChainMarkerSelectable(path, 'Texture Input', chainIdx, entry);
    const selectMarker = (e: Event) => { e.stopPropagation(); appController.select(path); };
    return html`
      <div class="chain-marker" ?selected=${isSelected}>
        <div class="chain-marker-inner">
          <div class="chain-marker-label" @click=${selectMarker}>Input</div>
          ${this.renderTraceCardRow(chainIdx, entry)}
        </div>
        ${this.renderDeviceTab('bottom', chainIdx + 1)}
      </div>
    `;
  }

  /** Render the texture_output marker with a top tab (insert-before-output). */
  private renderOutputMarker(chainIdx: number, entry: ChainEntry) {
    const path = `output/${this.sketchId}/${this.colIdx}/${chainIdx}`;
    const isSelected = appController.isSelected(path);
    this.registerChainMarkerSelectable(path, 'Texture Output', chainIdx, entry);
    const selectMarker = (e: Event) => { e.stopPropagation(); appController.select(path); };
    return html`
      <div class="chain-marker" ?selected=${isSelected}>
        ${this.renderDeviceTab('top', chainIdx)}
        <div class="chain-marker-inner">
          <div class="chain-marker-label" @click=${selectMarker}>Output</div>
        </div>
      </div>
    `;
  }

  // ========================================================================
  // Trace card rows
  // ========================================================================

  private renderTraceCardRow(chainIdx: number, entry: ChainEntry) {
    if (entry.type === 'texture_input') {
      const tracePath = `trace/${this.sketchId}/${this.colIdx}/${chainIdx}/input`;
      const traceSelected = appController.isSelected(tracePath);
      const traceId = `trace_${this.sketchId}/${this.colIdx}/${chainIdx}/input`;
      const target: TracePoint['target'] = {
        type: 'chain_entry',
        sketchId: this.sketchId,
        colIdx: this.colIdx,
        chainIdx,
        side: 'input',
      };
      return html`
        <div class="trace-card-row" ?selected=${traceSelected}
          @click=${(e: Event) => { e.stopPropagation(); appController.select(tracePath); }}>
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
      return this.renderModuleOutputRow(chainIdx, entry);
    }

    return nothing;
  }

  /**
   * Bottom-of-card row with one trace card per output. Each card is a
   * FieldEditorElement so the gutter tap indicators and tap overlays line up
   * with the output rather than a hidden slider inside the body.
   */
  private renderModuleOutputRow(chainIdx: number, entry: ModuleEntry) {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const outputs = this.collectModuleOutputs(entry);
    const tappingMode = appState.local.tappingMode;
    const cardKey = `${this.sketchId}/${this.colIdx}/${chainIdx}`;
    const binding = this.buildFieldBinding(chainIdx, entry, plugin);

    // Show an empty row if there are no outputs — still keeps a data-card-key
    // anchor so gutter positions can resolve if a user force-writes a tap.
    if (outputs.length === 0) return nothing;

    return html`
      <div class="trace-card-row" data-card-key="${cardKey}">
        ${outputs.map(o => {
          const traceId = `trace_${this.sketchId}/${this.colIdx}/${chainIdx}/output/${o.fieldPath}`;
          const target: TracePoint['target'] | null = o.isTexture
            ? {
                type: 'chain_entry',
                sketchId: this.sketchId,
                colIdx: this.colIdx,
                chainIdx,
                side: 'output',
              }
            : null;
          return html`
            <output-trace-card
              .fieldPath=${o.fieldPath}
              .label=${o.displayName}
              .kind=${o.isTexture ? 'texture' : o.kindTag}
              .traceId=${traceId}
              .traceTarget=${target}
              .binding=${binding}
              @click=${(e: Event) => this.onOutputCardClick(e, chainIdx, o.fieldPath, o.schemaDef, tappingMode)}
              title="${tappingMode ? 'Click to create write tap' : o.displayName}"
            ></output-trace-card>
          `;
        })}
      </div>
    `;
  }

  /**
   * Click on an output trace card:
   *  - tap mode → create a write tap for this output (struct-typed outputs
   *    get a struct rail carrying the output's schema, scalar/texture outputs
   *    get the appropriate scalar rail).
   *  - otherwise → no-op (selection of individual outputs isn't plumbed yet).
   */
  private onOutputCardClick(
    e: Event,
    chainIdx: number,
    fieldPath: string,
    schemaDef: any | null,
    tappingMode: boolean,
  ) {
    e.stopPropagation();
    if (!tappingMode) return;
    const key = `${this.sketchId}/${this.colIdx}/${chainIdx}/${fieldPath}`;
    appController.autoCreateTapForOutputField(
      this.sketchId, this.colIdx, chainIdx, fieldPath, schemaDef);
    appController.selectField(key);
  }

  // ========================================================================
  // Effect cards
  // ========================================================================

  private renderEffectCard(chainIdx: number, entry: ModuleEntry) {
    const tappingMode = appState.local.tappingMode;
    const isEditingType = this.editingTypeChainIdx === chainIdx;
    const effectPath = `effect/${this.sketchId}/${this.colIdx}/${chainIdx}`;
    const isSelected = appController.isSelected(effectPath);

    // Register as selectable with inspector content
    this.registerEffectSelectable(effectPath, chainIdx, entry);

    // Select on pointerdown — happens before drag threshold is reached, so
    // the card is selected whether the user intended to click or drag.
    const selectOnPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('smart-input')) return;
      appController.select(effectPath);
    };

    return html`
      <div class="effect-card" ?selected=${isSelected}
        @click=${(e: Event) => {
          if ((e.target as HTMLElement).closest('smart-input, .device-tab')) return;
          appController.select(effectPath);
        }}>
        ${this.renderDeviceTab('top', chainIdx)}
        <div class="effect-card-inner">
          <div class="effect-card-header"
            @pointerdown=${(e: PointerEvent) => {
              selectOnPointerDown(e);
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
                  @delete-request=${() => this.handleTypeDeleteRequest(chainIdx)}
                  @cancel=${() => this.handleTypeCancel()}
                ></smart-input>
              ` : html`
                <span class="effect-card-name"
                  @dblclick=${(e: Event) => { e.stopPropagation(); this.beginEditType(chainIdx); }}
                >${shortName(entry.module_type)}</span>
              `}
            </div>
          </div>
          <div class="effect-card-divider"></div>
          <div class="effect-card-body" data-card-key="${this.sketchId}/${this.colIdx}/${chainIdx}">
            ${this.renderFieldWidgets(chainIdx, entry)}
          </div>
          ${this.renderTraceCardRow(chainIdx, entry)}
          ${tappingMode ? this.renderTapOverlay(chainIdx, entry) : nothing}
        </div>
        ${this.renderDeviceTab('bottom', chainIdx + 1)}
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

  /**
   * User cleared the type text field and accepted — interpret as "delete this effect".
   * Any in-progress type preview is cancelled first so we don't leave a preview in the
   * undo stack.
   */
  private handleTypeDeleteRequest(chainIdx: number) {
    if (this.typeLongEdit) {
      this.typeLongEdit.cancel();
      this.typeLongEdit = null;
    }
    this.editingTypeChainIdx = -1;
    appController.select(null);
    appController.removeEffectFromChain(this.sketchId, this.colIdx, chainIdx);
    this.requestUpdate();
  }

  /**
   * Build the set of field names that are SCHEMA-declared outputs for this
   * module. Write taps on a field no longer promote it to an output — input
   * params stay inputs regardless of how they're tapped.
   */
  private getOutputFieldNames(entry: ModuleEntry): Set<string> {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const names = new Set<string>();
    // Schema io-declared outputs (io bit 2).
    const schema = plugin?.schema ?? {};
    for (const [name, def] of Object.entries(schema)) {
      const io = (def as any)?.io ?? 0;
      if (io & 2) names.add(name);
    }
    // Legacy io declarations (kind=2 data outputs, kind=1 texture outputs).
    for (const io of plugin?.io ?? []) {
      if (io.kind === 2 || io.kind === 1) names.add(io.name);
    }
    return names;
  }

  /**
   * Collect output rows for this module, ordered (schema order first, then
   * legacy io-declared fallbacks). Used by the trace-card row.
   */
  private collectModuleOutputs(entry: ModuleEntry): Array<{
    fieldPath: string;
    displayName: string;
    kindLabel: string;
    kindTag: string;
    isTexture: boolean;
    schemaDef: any | null;
  }> {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const rows: Array<{
      fieldPath: string;
      displayName: string;
      kindLabel: string;
      kindTag: string;
      isTexture: boolean;
      schemaDef: any | null;
    }> = [];
    const seen = new Set<string>();

    const schema = plugin?.schema ?? {};
    const entries = Object.entries(schema).sort(([an, ad], [bn, bd]) => {
      const ao = (ad as any)?.order ?? 1000;
      const bo = (bd as any)?.order ?? 1000;
      if (ao !== bo) return ao - bo;
      return an.localeCompare(bn);
    });
    for (const [name, def] of entries) {
      const d: any = def;
      const io = d?.io ?? 0;
      if (!(io & 2)) continue;
      seen.add(name);
      rows.push({
        fieldPath: name,
        displayName: schemaFieldDisplayName(d, name),
        kindLabel: schemaFieldKindLabel(d),
        kindTag: schemaFieldKindTag(d),
        isTexture: d.type === 'texture',
        schemaDef: d,
      });
    }

    // Legacy modules without a matching schema entry: fall back to plugin.io.
    for (const io of plugin?.io ?? []) {
      if (seen.has(io.name)) continue;
      if (io.kind === 1) {
        rows.push({
          fieldPath: io.name,
          displayName: io.name,
          kindLabel: 'texture',
          kindTag: 'texture',
          isTexture: true,
          schemaDef: null,
        });
        seen.add(io.name);
      } else if (io.kind === 2) {
        rows.push({
          fieldPath: io.name,
          displayName: io.name,
          kindLabel: 'float',
          kindTag: 'float',
          isTexture: false,
          schemaDef: null,
        });
        seen.add(io.name);
      }
    }
    return rows;
  }

  private renderTapOverlay(chainIdx: number, entry: ModuleEntry) {
    const selectedPath = appState.local.selectedFieldPath;
    // Anchor the overlay to the effect-card-inner so it can span both the
    // inputs body and the output trace-card row.
    const innerEl = this.renderRoot.querySelector(
      `[data-card-key="${this.sketchId}/${this.colIdx}/${chainIdx}"]`
    )?.closest('.effect-card-inner') as HTMLElement | null;

    if (!innerEl) return html`<div class="tap-overlay-container"></div>`;

    const outputFieldNames = this.getOutputFieldNames(entry);
    const schema = appState.local.plugins.find(p => p.id === entry.module_type)?.schema ?? {};

    const hits: TemplateResult[] = [];
    const keyPrefix = `${this.sketchId}/${this.colIdx}/${chainIdx}/`;

    for (const [key] of this.layoutManager.entries) {
      if (!key.startsWith(keyPrefix)) continue;

      const rect = this.layoutManager.getRelativeRect(key, innerEl);
      if (!rect) continue;

      const fieldPath = key.slice(keyPrefix.length);
      const isOutput = outputFieldNames.has(fieldPath);
      const isSelected = selectedPath === key;
      const schemaDef = (schema as any)[fieldPath] ?? null;

      hits.push(html`
        <div class="tap-overlay-hit ${isOutput ? 'output' : ''}" ?selected=${isSelected}
          data-sketch-id=${this.sketchId}
          data-col-idx=${this.colIdx}
          data-chain-idx=${chainIdx}
          data-field-path=${fieldPath}
          data-is-output=${isOutput ? 'true' : 'false'}
          style="top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px"
          @pointerdown=${(e: PointerEvent) => this.onTapHitPointerDown(
            e, key, fieldPath, isOutput, schemaDef, chainIdx)}
          @click=${() => this.onTapOverlayClick(key, fieldPath, isOutput, schemaDef, chainIdx)}></div>
      `);
    }

    return html`<div class="tap-overlay-container">${hits}</div>`;
  }

  /** Active drag-to-connect state (null when not dragging). */
  private tapDragState: {
    sourceInfo: FieldConnectInfo;
    sourceEl: HTMLElement;
    currentTargetEl: HTMLElement | null;
  } | null = null;

  /**
   * Start a potential drag-to-connect from a tap overlay hit. If the user
   * moves past the threshold, we resolve the drop target on pointerup and
   * ask the controller to create the tap connection. Short drags fall
   * through to the normal click handler (single-field auto-tap).
   */
  private onTapHitPointerDown(
    e: PointerEvent,
    _key: string,
    fieldPath: string,
    isOutput: boolean,
    schemaDef: any | null,
    chainIdx: number,
  ) {
    if (e.button !== 0) return;
    const sourceEl = e.currentTarget as HTMLElement;
    const rect = sourceEl.getBoundingClientRect();
    const sourceInfo: FieldConnectInfo = {
      sketchId: this.sketchId,
      colIdx: this.colIdx,
      chainIdx,
      fieldPath,
      isOutput,
      viewportY: rect.top + rect.height / 2,
      schemaDef,
    };

    new PointerDragOp(e, sourceEl, {
      threshold: 5,
      move: (me) => {
        if (!this.tapDragState) {
          sourceEl.setAttribute('tap-dragging', '');
          this.tapDragState = { sourceInfo, sourceEl, currentTargetEl: null };
        }
        this.updateTapDragHover(me.clientX, me.clientY);
      },
      accept: (me) => {
        const target = this.findTapDragTarget(me.clientX, me.clientY);
        if (target && this.tapDragState) {
          appController.connectFields(sourceInfo, target);
        }
        this.endTapDrag();
      },
      cancel: () => { this.endTapDrag(); },
    });
  }

  private updateTapDragHover(x: number, y: number) {
    if (!this.tapDragState) return;
    const hitEl = findTapOverlayHitAt(x, y);
    // Don't self-target the source.
    const same = hitEl === this.tapDragState.sourceEl;
    const newTarget = same ? null : hitEl;
    if (this.tapDragState.currentTargetEl === newTarget) return;
    this.tapDragState.currentTargetEl?.removeAttribute('tap-drop-target');
    newTarget?.setAttribute('tap-drop-target', '');
    this.tapDragState.currentTargetEl = newTarget;
  }

  private findTapDragTarget(x: number, y: number): FieldConnectInfo | null {
    const hitEl = findTapOverlayHitAt(x, y);
    if (!hitEl) return null;
    if (this.tapDragState && hitEl === this.tapDragState.sourceEl) return null;

    const sketchId = hitEl.dataset.sketchId ?? '';
    const colIdx = parseInt(hitEl.dataset.colIdx ?? '-1');
    const chainIdx = parseInt(hitEl.dataset.chainIdx ?? '-1');
    const fieldPath = hitEl.dataset.fieldPath ?? '';
    const isOutput = hitEl.dataset.isOutput === 'true';
    if (!sketchId || colIdx < 0 || chainIdx < 0 || !fieldPath) return null;

    const sketch = appState.database.sketches[sketchId];
    const entry = sketch?.columns[colIdx]?.chain[chainIdx];
    if (!entry || entry.type !== 'module') return null;
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const schemaDef = plugin?.schema?.[fieldPath] ?? null;
    const rect = hitEl.getBoundingClientRect();
    return {
      sketchId, colIdx, chainIdx, fieldPath, isOutput,
      viewportY: rect.top + rect.height / 2,
      schemaDef,
    };
  }

  private endTapDrag() {
    if (!this.tapDragState) return;
    this.tapDragState.sourceEl.removeAttribute('tap-dragging');
    this.tapDragState.currentTargetEl?.removeAttribute('tap-drop-target');
    this.tapDragState = null;
  }

  private onTapOverlayClick(
    key: string,
    fieldPath: string,
    isOutput: boolean,
    schemaDef: any | null,
    chainIdx: number,
  ) {
    if (isOutput) {
      appController.autoCreateTapForOutputField(
        this.sketchId, this.colIdx, chainIdx, fieldPath, schemaDef);
    } else {
      appController.autoCreateTapForInputField(
        this.sketchId, this.colIdx, chainIdx, fieldPath, schemaDef);
    }
    appController.selectField(key);
  }

  private renderFieldWidgets(chainIdx: number, entry: ModuleEntry) {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);

    const binding = this.buildFieldBinding(chainIdx, entry, plugin);

    // Check for a custom inspector registered via the editor registry
    const el = this.callbacks?.getInspectorElement(entry.instance_key, entry.module_type, binding);
    if (el) return html`${el}`;

    // Build input fields from the schema (when available) so we can
    // render placeholders for structured / GPU / vector ports that
    // don't fit the scalar ParamInfo model. Falls back to plugin.params
    // for modules without a schema block.
    const inputFields = this.buildInputFieldDefs(plugin);
    if (inputFields.length === 0) return nothing;
    const inspector = createGenericInspector(inputFields);
    return inspector(binding);
  }

  /** Shared FieldBinding builder — used by both the inputs body and the output trace cards. */
  private buildFieldBinding(
    chainIdx: number,
    entry: ModuleEntry,
    plugin: typeof appState.local.plugins[0] | undefined,
  ): FieldBinding {
    return {
      instanceKey: entry.instance_key,
      getValue: (fieldPath: string) => {
        const ps = appState.local.engine.pluginStates[entry.instance_key];
        if (ps && fieldPath in ps) return ps[fieldPath];
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
      beginContinuousEdit: (fieldPath: string, value: any): ContinuousEditHandle => {
        const edit = appController.beginSetEffectParam(
          this.sketchId, this.colIdx, chainIdx, fieldPath, value);
        return {
          update: (v: any) => appController.updateSetEffectParam(
            edit, this.sketchId, this.colIdx, chainIdx, fieldPath, v),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
    };
  }

  private buildInputFieldDefs(
    plugin: typeof appState.local.plugins[0] | undefined,
  ): InspectorFieldDef[] {
    if (!plugin) return [];

    const schema = plugin.schema;
    if (!schema || Object.keys(schema).length === 0) {
      // Legacy fallback — no schema available; go off plugin.params.
      return plugin.params.map(paramToFieldDef);
    }

    // Sort by order, then name, to match declaration order.
    const entries = Object.entries(schema)
      .sort(([an, ad], [bn, bd]) => {
        const ao = (ad as any)?.order ?? 1000;
        const bo = (bd as any)?.order ?? 1000;
        if (ao !== bo) return ao - bo;
        return an.localeCompare(bn);
      });

    const fields: InspectorFieldDef[] = [];
    for (const [name, def] of entries) {
      const d: any = def;
      const io = d?.io ?? 0;
      const isInput = !!(io & 1);
      if (!isInput) continue; // pure outputs handled by the trace-card row
      const label = schemaFieldDisplayName(d, name);
      if (d.type === 'texture') {
        fields.push({ type: 'placeholder', label, path: name,
          kind: 'texture', direction: 'input' });
        continue;
      }
      if (isScalarSchemaField(d)) {
        const param = plugin.params.find(p => p.name === name);
        if (param) {
          const fieldDef = paramToFieldDef(param);
          fieldDef.label = label;
          fields.push(fieldDef);
          continue;
        }
        // No legacy param row (shouldn't happen for scalars) — fall through.
      }
      fields.push({
        type: 'placeholder', label, path: name,
        kind: schemaFieldKindLabel(d), direction: 'input',
      });
    }
    return fields;
  }


  // ========================================================================
  // Gutter tap visualization
  // ========================================================================

  /**
   * Render vertical rail lines in the gutter, plus a blue "active segment"
   * overlay covering the range from the first write tap's Y down to the
   * last read tap's Y. Only rails with both a writer AND a reader (in
   * THIS column — rails can be multi-column but tap Y is per-column)
   * get an active overlay.
   */
  private renderRailLines(sketch: Sketch, column: SketchColumn) {
    const allRails = [
      ...(column.rails ?? []),
      ...(sketch.rails ?? []),
    ];
    if (allRails.length === 0) return nothing;

    const gutterEl = this.renderRoot.querySelector(
      `.column-gutter[data-col="${this.colIdx}"]`
    ) as HTMLElement | null;

    // Compute first-write / last-read Y for each rail. Iterate ONCE over
    // the column's chain so large columns stay cheap.
    const railActive = new Map<string, { firstWriteY: number; lastReadY: number }>();
    if (gutterEl) {
      const ensure = (id: string) => {
        let e = railActive.get(id);
        if (!e) {
          e = { firstWriteY: Infinity, lastReadY: -Infinity };
          railActive.set(id, e);
        }
        return e;
      };
      for (let i = 0; i < column.chain.length; i++) {
        const entry = column.chain[i];
        if (entry.type !== 'module' || !entry.taps?.length) continue;
        for (const tap of entry.taps) {
          const fieldKey = `${this.sketchId}/${this.colIdx}/${i}/${tap.fieldPath}`;
          const rect = this.layoutManager.getRelativeRect(fieldKey, gutterEl);
          if (!rect) continue;
          const y = rect.top + rect.height / 2;
          const a = ensure(tap.railId);
          if (tap.direction === 'write') {
            if (y < a.firstWriteY) a.firstWriteY = y;
          } else {
            if (y > a.lastReadY) a.lastReadY = y;
          }
        }
      }
    }

    return allRails.map(rail => {
      const x = this.layoutManager.getRailX(rail.id);
      if (x === null) return nothing;
      const seg = railActive.get(rail.id);
      const hasActive = seg && seg.firstWriteY !== Infinity && seg.lastReadY !== -Infinity
        && seg.firstWriteY < seg.lastReadY;
      return html`
        <div class="rail-line"
          style="left:${x}px"
          title="${rail.name ?? rail.id}"></div>
        ${hasActive ? html`
          <div class="rail-line-active"
            style="left:${x}px;top:${seg!.firstWriteY}px;height:${seg!.lastReadY - seg!.firstWriteY}px"></div>
        ` : nothing}
      `;
    });
  }

  private renderGutterTaps(sketch: Sketch, column: SketchColumn) {
    const indicators: TemplateResult[] = [];
    const gutterEl = this.renderRoot.querySelector(`.column-gutter[data-col="${this.colIdx}"]`) as HTMLElement | null;
    if (!gutterEl) return indicators;

    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];
      if (entry.type !== 'module' || !entry.taps?.length) continue;

      for (let tapIdx = 0; tapIdx < entry.taps.length; tapIdx++) {
        const tap = entry.taps[tapIdx];
        const fieldKey = `${this.sketchId}/${this.colIdx}/${i}/${tap.fieldPath}`;
        const rect = this.layoutManager.getRelativeRect(fieldKey, gutterEl);
        if (!rect) continue;

        const railX = this.layoutManager.getRailX(tap.railId);
        if (railX === null) continue;

        const yCenter = rect.top + rect.height / 2;
        const tapPath = `gtap/${this.sketchId}/${this.colIdx}/${i}/${tapIdx}`;
        const isSelected = appController.isSelected(tapPath);
        this.registerGutterTapSelectable(tapPath, i, tapIdx);

        const onClick = (e: Event) => {
          e.stopPropagation();
          appController.select(tapPath);
        };

        // Dot at the rail X position
        indicators.push(html`
          <div class="tap-indicator ${tap.direction}" ?selected=${isSelected}
            style="left:${railX}px;top:${yCenter}px"
            title="${tap.direction === 'write' ? 'Write' : 'Read'} tap → ${tap.fieldPath}"
            @click=${onClick}></div>
        `);

        // Horizontal line from gutter left edge (0) to the rail dot
        indicators.push(html`
          <div class="tap-indicator-line ${tap.direction}" ?selected=${isSelected}
            style="left:0;width:${railX - 3}px;top:${yCenter}px"
            @click=${onClick}></div>
        `);
      }
    }

    return indicators;
  }

  /** Register a gutter tap (visual wire connector) as a selectable. */
  private registerGutterTapSelectable(path: string, chainIdx: number, tapIdx: number) {
    const sketchId = this.sketchId;
    const colIdx = this.colIdx;
    appController.defineSelectable({
      path,
      label: 'Tap',
      renderInspectorContent: () => {
        const sketch = appState.database.sketches[sketchId];
        const entry = sketch?.columns[colIdx]?.chain[chainIdx];
        if (!entry || entry.type !== 'module') return undefined;
        const tap = entry.taps?.[tapIdx];
        if (!tap) return undefined;
        const allRails = [
          ...(sketch!.rails ?? []),
          ...(sketch!.columns[colIdx]?.rails ?? []),
        ];
        const rail = allRails.find(r => r.id === tap.railId);
        return html`
          <div class="inspector-field">
            <span class="inspector-field-label">Direction</span>
            <span class="inspector-field-value">${tap.direction}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">Field</span>
            <span class="inspector-field-value">${tap.fieldPath}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">Rail</span>
            <span class="inspector-field-value">${rail?.name ?? tap.railId}</span>
          </div>
          <div class="inspector-separator"></div>
          <button class="btn" style="width:100%;padding:6px"
            @click=${() => {
              appController.removeTap(sketchId, colIdx, chainIdx, tapIdx);
              appController.select(null);
            }}>Remove Tap</button>
        `;
      },
    });
  }

  // ========================================================================
  // Drop zones
  // ========================================================================

  /**
   * Render one tab of a device's circuit-edge shape.
   * - 'bottom' is a narrow rectangle protruding below the body (the "card
   *   edge" that plugs in).
   * - 'top' is a wider U-shape SVG with a slot cut into its top. The slot
   *   opening straddles the bottom tab of the device above, so stacked
   *   cards read as tab-meets-slot.
   *
   * Both tabs are clickable (selects the insert-point) and dbl-clickable
   * (inserts a new effect). Either tab also serves as a drag-drop target.
   */
  private renderDeviceTab(position: 'top' | 'bottom', insertIdx: number) {
    const tabPath = `tab/${this.sketchId}/${this.colIdx}/${insertIdx}`;
    const isSelected = appController.isSelected(tabPath);
    this.registerTabSelectable(tabPath, insertIdx);
    const onClick = (e: Event) => { e.stopPropagation(); appController.select(tabPath); };
    const onDblClick = (e: Event) => { e.stopPropagation(); this.addEffectAndBeginEdit(insertIdx); };

    if (position === 'top') {
      // U-shape: the slot opens upward (Y=0 to Y=7 of viewBox, X=22 to X=78).
      // The bottom edge (Y=10) is the connection to the body and carries
      // NO stroke so it merges cleanly with the body's top border.
      return html`
        <div class="device-tab top" ?selected=${isSelected}
          @click=${onClick} @dblclick=${onDblClick}
          title="Double-click to insert effect">
          <svg viewBox="0 0 100 10" preserveAspectRatio="none">
            <path class="tab-fill"
              d="M 0 10 L 0 0 L 22 0 L 22 7 L 78 7 L 78 0 L 100 0 L 100 10 Z"></path>
            <path class="tab-stroke"
              d="M 0 10 L 0 0 L 22 0 L 22 7 L 78 7 L 78 0 L 100 0 L 100 10"></path>
          </svg>
          <div class="drop-zone" data-drop-col=${this.colIdx} data-drop-idx=${insertIdx}></div>
        </div>
      `;
    }
    return html`
      <div class="device-tab bottom" ?selected=${isSelected}
        @click=${onClick} @dblclick=${onDblClick}
        title="Double-click to insert effect">
        <div class="drop-zone" data-drop-col=${this.colIdx} data-drop-idx=${insertIdx}></div>
      </div>
    `;
  }

  /** Insert a placeholder effect and immediately open smart-input to choose the type. */
  private addEffectAndBeginEdit(insertIdx: number) {
    appController.addEffectToChain(this.sketchId, this.colIdx, insertIdx, 'video.brightness_contrast');
    // The new entry is at insertIdx in the chain. Open the type editor for it.
    // Use requestUpdate + microtask to ensure the DOM has rendered the new card.
    this.requestUpdate();
    requestAnimationFrame(() => {
      this.beginEditType(insertIdx);
    });
  }

  /** Register a tab (insert hotspot) as a selectable. */
  private registerTabSelectable(path: string, insertIdx: number) {
    appController.defineSelectable({
      path,
      label: 'Insert Point',
      renderInspectorContent: () => html`
        <div class="inspector-field">
          <span class="inspector-field-label">Column</span>
          <span class="inspector-field-value">${this.colIdx}</span>
        </div>
        <div class="inspector-field">
          <span class="inspector-field-label">Position</span>
          <span class="inspector-field-value">${insertIdx}</span>
        </div>
        <div class="inspector-separator"></div>
        <div style="font-size:10px;color:var(--app-text-color2);padding:4px 0 8px">
          Double-click the tab to insert a new effect here.
        </div>
      `,
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

  // ========================================================================
  // Selectable registration
  // ========================================================================

  /** Register an effect card as a selectable with full inspector content. */
  private registerEffectSelectable(path: string, chainIdx: number, entry: ModuleEntry) {
    const plugin = appState.local.plugins.find(p => p.id === entry.module_type);
    const availEffect = appState.local.availableEffects.find(e => e.id === entry.module_type);

    appController.defineSelectable({
      path,
      label: availEffect?.name ?? shortName(entry.module_type),
      renderInspectorContent: () => {
        const binding: FieldBinding = {
          instanceKey: entry.instance_key,
          getValue: (fieldPath: string) => {
            const ps = appState.local.engine.pluginStates[entry.instance_key];
            if (ps && fieldPath in ps) return ps[fieldPath];
            const sketch = appState.database.sketches[this.sketchId];
            const instState = sketch?.instances?.[entry.instance_key]?.state;
            return instState?.[fieldPath]
              ?? plugin?.params.find(p => p.name === fieldPath)?.defaultValue ?? 0;
          },
          setValue: (fieldPath: string, value: any) => {
            appController.setEffectParam(this.sketchId, this.colIdx, chainIdx, fieldPath, value);
          },
          beginContinuousEdit: (fieldPath: string, value: any): ContinuousEditHandle => {
            const edit = appController.beginSetEffectParam(
              this.sketchId, this.colIdx, chainIdx, fieldPath, value);
            return {
              update: (v: any) => appController.updateSetEffectParam(
                edit, this.sketchId, this.colIdx, chainIdx, fieldPath, v),
              accept: () => edit.accept(),
              cancel: () => edit.cancel(),
            };
          },
        };

        const outputFieldNames = this.getOutputFieldNames(entry);
        const inputParams = (plugin?.params ?? []).filter(p => !outputFieldNames.has(p.name));
        const outputParams = (plugin?.params ?? []).filter(p => outputFieldNames.has(p.name));

        return html`
          <div class="inspector-field">
            <span class="inspector-field-label">Type</span>
            <span class="inspector-field-value">${entry.module_type}</span>
          </div>
          <div class="inspector-field">
            <span class="inspector-field-label">Instance</span>
            <span class="inspector-field-value">${entry.instance_key}</span>
          </div>
          ${availEffect?.description ? html`
            <div style="font-size:10px;color:var(--app-text-color2);padding:4px 0 8px">
              ${availEffect.description}
            </div>
          ` : nothing}
          <div class="inspector-separator"></div>
          ${inputParams.length > 0 ? html`
            <div class="section-header">Parameters</div>
            ${inputParams.map(p => html`
              <scalar-slider style="width:100%"
                .fieldPath=${p.name}
                .label=${p.name}
                .min=${p.min} .max=${p.max}
                .step=${p.type === 13 ? 1 : 0.01}
                .defaultValue=${p.defaultValue}
                .binding=${binding}
              ></scalar-slider>
            `)}
          ` : nothing}
          ${outputParams.length > 0 ? html`
            <div class="section-header" style="margin-top:8px">Outputs</div>
            ${outputParams.map(p => html`
              <scalar-slider style="width:100%"
                .fieldPath=${p.name}
                .label=${p.name}
                .min=${p.min} .max=${p.max}
                .step=${p.type === 13 ? 1 : 0.01}
                .defaultValue=${p.defaultValue}
                .binding=${binding}
              ></scalar-slider>
            `)}
          ` : nothing}
        `;
      },
    });
  }

  /** Register a chain marker (texture input/output) as a selectable. */
  private registerChainMarkerSelectable(path: string, label: string, chainIdx: number, entry: ChainEntry) {
    const side = entry.type === 'texture_input' ? 'input' : 'output';
    const traceId = `trace_${this.sketchId}/${this.colIdx}/${chainIdx}/${side}`;
    const target: TracePoint['target'] = {
      type: 'chain_entry',
      sketchId: this.sketchId,
      colIdx: this.colIdx,
      chainIdx,
      side: side as 'input' | 'output',
    };

    appController.defineSelectable({
      path,
      label,
      renderInspectorContent: () => html`
        <div class="inspector-field">
          <span class="inspector-field-label">Type</span>
          <span class="inspector-field-value">${entry.type}</span>
        </div>
        <div class="inspector-field">
          <span class="inspector-field-label">Column</span>
          <span class="inspector-field-value">${this.colIdx}</span>
        </div>
        <div class="inspector-separator"></div>
        <div class="section-header">Preview</div>
        <texture-monitor
          .traceId=${traceId}
          .traceTarget=${target}
          .width=${280}
          .height=${158}
        ></texture-monitor>
      `,
    });
  }
}
