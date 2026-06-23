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
import type { Sketch, SketchColumn, ChainEntry, ModuleEntry, Wire, TapCurve, TapCombine, WireMagnitude, FieldConnectInfo } from '../sketch-types';
import { sketchChain, chainEntryAt, isEffectCollapsed, DASHBOARD_MODULE_TYPE, SKETCH_OUTPUT_MODULE_TYPE } from '../sketch-types';
import type { ColumnAdapter, PluginInfo, EditHandle } from './column-adapter';
import type { FieldBinding, FieldEditorElement, ContinuousEditHandle, MultiContinuousEditHandle } from './field-editor';
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
import './field-text';
import './field-select';
import './field-placeholder';
import './texture-monitor';
import './spark-chart';
import './dashboard-editor';
import './smart-input';
import './scalar-slider';
import './output-trace-card';
import './texture-drop-zone';
import '../editors/envelope-field';   // <envelope-field> for the wire Envelope stage
import './ui-icon';

import type { Selectable } from '../state/types';
import { categoryColor, effectDomain, CATEGORY_DOMAINS } from './category-color';

/** Line-awesome icon per effect category, for the insert-header chips. */
const CATEGORY_ICON: Record<string, string> = {
  source: 'la-lightbulb',
  color: 'la-palette',
  filter: 'la-filter',
  warp: 'la-vector-square',
  motion: 'la-running',
  composite: 'la-layer-group',
  mod: 'la-wave-square',
  control: 'la-sliders-h',
  debug: 'la-bug',
};
/** Preferred "default" effect to seed when inserting from a category chip. */
const CATEGORY_DEFAULT: Record<string, string> = {
  source: 'source.solid_color',
  color: 'color.tone.brightness_contrast',
};
/** Fallback temporary effect when a category has no good default in core. */
const CATEGORY_FALLBACK = 'color.tone.brightness_contrast';

function shortName(id: string) { return id.split('.').pop() ?? id; }

/**
 * Whether an effect produces an image — i.e. its schema declares a `texture`
 * field with the Output bit (io & 2). Mirrors the executor's texture-passthrough
 * test (RegisteredModule.hasTextureOutput): nodes WITHOUT a texture output (LFOs,
 * data/modulation sources) render no image and pass their input through, so tracing
 * "their output" would show the next stage's texture. Such nodes get no monitor
 * trace target — selecting them leaves the monitor on the sketch's final output.
 */
function effectHasTextureOutput(schema: Record<string, any> | undefined): boolean {
  if (!schema) return false;
  for (const fn in schema) {
    const d = schema[fn];
    if (d?.type === 'texture' && (((d.io ?? 0) & 2) !== 0)) return true;
  }
  return false;
}

/** Map an engine ParamInfo to a generic inspector field definition. */
function paramToFieldDef(p: ParamInfo): InspectorFieldDef {
  switch (p.type) {
    case 0: // bool
      return { type: 'boolean', label: p.name, path: p.name, default: p.defaultValue > 0.5 };
    case 1: // event
      return { type: 'button', label: p.name, path: p.name, text: p.name };
    case 100: // text
      // A `font` text param gets the searchable font-family picker (source.text.plain).
      if (/^font$/i.test(p.name)) {
        return { type: 'font', label: p.name, path: p.name };
      }
      // HTML/CSS fields (source.text.rich) get a multi-line editor so a whole
      // document can be pasted/edited; other text fields stay single-line.
      return { type: 'string', label: p.name, path: p.name,
               multiline: /^(html|css)$/i.test(p.name) };
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
  /** Injected data/controller/taps seam. The effect IDE passes `ideColumnAdapter`
   *  (all caps on → original behavior); other surfaces pass their own. */
  @property({ attribute: false }) adapter: ColumnAdapter | null = null;

  /** Shorthands for the injected adapter facets (assumes `adapter` is set). */
  private get ds() { return this.adapter!.data; }
  private get ctl() { return this.adapter!.controller; }
  private get taps() { return this.adapter!.taps; }

  /** Each column-group owns its own layout manager for field position tracking. */
  public readonly layoutManager = new FieldLayoutManager();

  /** Gutter width — holds the field-option pip + wire ports. Fixed now that
   *  rails are gone (it used to grow per rail). */
  static readonly GUTTER_WIDTH = 20;

  /** The right gutter only exists to host wiring/smoothing pips. With neither
   *  capability (e.g. the arrangement) there's nothing to put there, so the
   *  column goes full-width with no gutter. */
  private get hasGutter(): boolean {
    return !!(this.adapter && (this.adapter.data.caps.wiring || this.adapter.data.caps.smoothing));
  }

  getGutterWidth(): number {
    return this.hasGutter ? ColumnGroup.GUTTER_WIDTH : 0;
  }

  /** Which chain entry index is currently being type-edited (smart-input open), or -1 for none. */
  private editingTypeChainIdx = -1;
  /** The active edit handle for type preview (null when not previewing). */
  private typeLongEdit: EditHandle | null = null;
  /**
   * Set while the open type editor is choosing the type for a *freshly inserted*
   * placeholder effect (vs. retyping an existing one). The whole insertion rides
   * `typeLongEdit` so it commits as one undo point and disappears on cancel.
   */
  private insertCtx: { instanceKey: string; insertIdx: number; prefill?: string } | null = null;

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
      border-left: 1px solid var(--app-tint-2);
    }
    .column-header {
      font-size: var(--app-fs-sm);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: 6px 10px;
      width: 100%;
      box-sizing: border-box;
    }
    /* The body is the "rack" that devices slot into — toned to the app bg like
     * the arrangement timeline, not a harsh black recess. */
    .column-body {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0;
      padding: var(--app-sp-3);
      gap: var(--app-sp-2);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-2);
      border-radius: 1px;
      box-sizing: border-box;
    }

    /* Pinned category insert header — chips that begin inserting a new effect of
     * that category (with the smart-input drilled into "<category>."). */
    .insert-header {
      position: sticky;
      top: 0;
      z-index: 30;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px 0 8px;
      background: var(--app-bg-color2);
    }
    .cat-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 3px;
      background: var(--app-tint-2);
      border: 1px solid var(--chip, var(--app-tint-4));
      color: var(--app-text-color1);
      font: inherit;
      font-size: var(--app-fs-sm);
      text-transform: capitalize;
      cursor: pointer;
      user-select: none;
    }
    .cat-chip:hover { background: var(--app-tint-3); }
    .cat-chip:active { background: var(--app-tint-4); }
    .cat-chip ui-icon { --icon-size: 12px; color: var(--chip, var(--app-text-color2)); }
    .column-placeholder {
      border: 1px dashed var(--app-tint-3);
      border-radius: 1px;
      min-height: 100px;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--app-text-color2);
      font-size: var(--app-fs-md);
      opacity: 0.5;
    }

    /* ------------------------------------------------------------------
     * Devices (cards and markers) share a T-shape: body + top-tab (going
     * up) + bottom-tab (going down). Tabs are narrower than the body and
     * protrude above/below. A continuous 1px border traces the whole
     * shape — tabs overlap the body's top/bottom border by 1px so the
     * border visually joins in a single outline.
     * ---------------------------------------------------------------- */

    /* Colors used consistently across cards and markers — aligned with the
     * arrangement clip cards / track headers (panel tone + subtle border, blue
     * selection accent), so the chain reads as native to those surfaces. */
    :host {
      --device-bg: var(--app-bg-color2);
      --device-border: var(--app-tint-4);
      --device-sel-bg: rgba(65, 105, 225, 0.12);
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
      /* Contain inner z-indexes (e.g. the input marker's texture-drop-zone at
       * z-index:10) to this device so they don't paint over the NEXT device's
       * overlapping top tab and steal its clicks. Stacking between devices then
       * follows DOM order, so a later device's tab still sits over the joint. */
      isolation: isolate;
    }
    .effect-card[dragging] { opacity: 0.4; }
    /* While the type editor is open, lift the whole card above its siblings so
     * the smart-input autocomplete dropdown paints over the cards below (each
     * card is its own stacking context via isolation, so the dropdown can't
     * otherwise escape). */
    .effect-card[editing] { z-index: 50; }

    /* Inner body of a device — border only on the LEFT and RIGHT so the
     * outline of the whole shape (body + tab joints) reads as one
     * continuous path. The top/bottom edges are drawn by the .tab-area
     * notch/tab pieces above and below the body. */
    .effect-card-inner, .chain-marker-inner {
      width: 100%;
      background: var(--device-bg);
      border: 1px solid var(--device-border);
      border-radius: 2px;
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
      font-size: var(--app-fs-sm);
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
      /* Fill the wrapper's locked height and center the text, so the whole row
       * height is a double-click target (covering above/below the glyphs) and
       * the text stays vertically aligned with the header's other controls. */
      flex: 1;
      min-width: 0;
      align-self: stretch;
      display: flex;
      align-items: center;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      cursor: default;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* A small per-category accent dot — a quiet hint at the effect's domain,
     * sitting between the bypass toggle and the name. Tracks the type live while
     * the smart-input is open (so it shifts hue as a new type is previewed). */
    .effect-cat-dot {
      flex: 0 0 auto;
      width: 6px; height: 6px;
      border-radius: 50%;
      margin-right: 6px;
      opacity: 0.8;
    }
    .effect-card-name-wrapper {
      flex: 1;
      min-width: 0;
      position: relative;
      /* Center both the static label and the smart-input editor, and lock a
       * single height for both so double-clicking to edit never nudges the
       * header up/down (the label and CodeMirror differ by ~1px otherwise). */
      display: flex;
      align-items: center;
      min-height: 22px;
    }
    .effect-card-name-wrapper > smart-input {
      flex: 1;
      min-width: 0;
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
      gap: var(--app-sp-2);
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

    /* --- Drag insertion marker (absolutely positioned, no layout shift) --- */
    .drag-insert-marker {
      position: absolute;
      left: 0;
      right: var(--gutter-width, 8px); /* leave room for gutter */
      height: 3px;
      background: var(--app-hi-color2, #4169E1);
      border-radius: 1px;
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
      border-radius: 1px;
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
    /* Engine-level field-option "light" by the field row. The ELEMENT is a
       generous transparent hit box; the visible 6px green dot (the device-on
       accent, distinct from the blue/red tap rails) is drawn via ::after so the
       click target is the whole box, not just the dot. */
    .field-option-pip {
      position: absolute;
      left: -3px;
      width: 16px; height: 22px;
      transform: translateY(-50%);
      cursor: pointer;
      z-index: 3;
    }
    .field-option-pip::after {
      content: '';
      position: absolute;
      left: 6px; top: 50%; margin-top: -3px;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--app-ok);
      box-shadow: 0 0 4px var(--app-ok);
      pointer-events: none;
    }
    .field-option-pip:hover::after {
      box-shadow: 0 0 0 2px rgba(255,255,255,0.25), 0 0 4px var(--app-ok);
    }
    .field-option-pip[selected]::after { box-shadow: 0 0 0 2px rgba(255,255,255,0.85); }
    /* A wired field's pip follows the rail convention: blue for inputs, red for
     * outputs (vs the option green). */
    .field-option-pip.wired::after {
      background: var(--app-hi-color2, #4169E1);
      box-shadow: 0 0 4px var(--app-hi-color2, #4169E1);
    }
    .field-option-pip.wired:hover::after {
      box-shadow: 0 0 0 2px rgba(255,255,255,0.25), 0 0 4px var(--app-hi-color2, #4169E1);
    }
    .field-option-pip.wired.output::after {
      background: var(--app-hi-color1, #ff4500);
      box-shadow: 0 0 4px var(--app-hi-color1, #ff4500);
    }
    .field-option-pip.wired.output:hover::after {
      box-shadow: 0 0 0 2px rgba(255,255,255,0.25), 0 0 4px var(--app-hi-color1, #ff4500);
    }

    /* --- Inspector content (rendered into the right panel via Selectable) --- */
    .section-header {
      font-size: var(--app-fs-sm); text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--app-text-color2); margin-bottom: 8px;
    }
    .inspector-field {
      display: flex; align-items: center; gap: var(--app-sp-3); padding: 4px 0;
    }
    .inspector-field-label {
      min-width: 70px; color: var(--app-text-color2); font-size: var(--app-fs-sm); flex-shrink: 0;
    }
    .inspector-field-value {
      flex: 1; min-width: 0; color: var(--app-text-color1); font-size: var(--app-fs-sm);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .inspector-separator {
      height: 1px; background: var(--app-tint-2); margin: 8px 0;
    }
  `;

  updated() {
    // Set explicit widths via CSS custom properties on the host element.
    // No gutter → the column fills its host (full-width cards).
    this.style.setProperty('--column-width', this.hasGutter ? `${this.columnWidth}px` : '100%');
    this.style.setProperty('--gutter-width', `${this.getGutterWidth()}px`);

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
        insertIdx: 0, // implicit input is on top; first module goes at 0
        x: centerX,
        y: colRect.top + colRect.height / 2,
        isPlaceholder: true,
      });
      return results;
    }

    // Tabs are gone — insertion points are the gaps between cards. One above
    // each card (insert at that index) plus one below the last card (append).
    const cards = [...this.renderRoot.querySelectorAll('.effect-card[data-chain-idx]')] as HTMLElement[];
    for (const card of cards) {
      const idx = parseInt(card.dataset.chainIdx!);
      const r = card.getBoundingClientRect();
      results.push({ colIdx: this.colIdx, insertIdx: idx, x: centerX, y: r.top, isPlaceholder: false });
    }
    const last = cards[cards.length - 1];
    if (last) {
      const r = last.getBoundingClientRect();
      results.push({ colIdx: this.colIdx, insertIdx: cards.length, x: centerX, y: r.bottom, isPlaceholder: false });
    } else {
      // Empty chain: a single insertion slot near the top (below the input marker).
      results.push({ colIdx: this.colIdx, insertIdx: 0, x: centerX, y: colRect.top + 40, isPlaceholder: false });
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

    const sketch = this.ds.getSketch(this.sketchId);
    if (!sketch || this.colIdx !== 0) {
      return nothing;
    }

    // Single linear stack: synthesize a column view over the canonical chain so
    // the rest of this widget (built around SketchColumn) keeps working.
    const column: SketchColumn = { name: 'main', chain: sketchChain(sketch) };

    // Touch layout generation for reactive updates
    const _layoutGen = this.layoutManager.generation;

    return html`
      <div class="column" style="position:relative">
        ${this.renderInsertHeader(column)}
        <div class="column-body">
          ${this.renderChain(sketch, column)}
        </div>
        <div class="drag-insert-marker"></div>
      </div>
      ${this.hasGutter ? html`
        <div class="column-gutter" data-col=${this.colIdx}>
          ${this.renderFieldOptionPips(column)}
        </div>
      ` : nothing}
    `;
  }

  // ========================================================================
  // Chain rendering
  // ========================================================================

  private renderChain(sketch: Sketch, column: SketchColumn) {
    const items: (TemplateResult | typeof nothing)[] = [];
    // Implicit texture input marker on top — not stored in chain.
    items.push(this.renderInputMarker(column));
    for (let i = 0; i < column.chain.length; i++) {
      items.push(this.renderEffectCard(i, column.chain[i]));
    }
    // Implicit texture output marker on the bottom.
    items.push(this.renderOutputMarker(column));
    return items;
  }

  /**
   * Implicit texture-input marker. Drop tab below inserts a new module at
   * chainIdx 0 (the top of the chain).
   */
  private renderInputMarker(column: SketchColumn) {
    const path = `input/${this.sketchId}/${this.colIdx}`;
    const isSelected = this.ctl.isSelected(path);
    this.registerChainMarkerSelectable(path, 'Texture Input', 'input');
    const selectMarker = (e: Event) => { e.stopPropagation(); this.ctl.select(path); };
    return html`
      <div class="chain-marker" ?selected=${isSelected}>
        <div class="chain-marker-inner">
          <div class="chain-marker-label" @click=${selectMarker}>Input</div>
          ${this.renderInputTraceCardRow(column)}
        </div>
        <texture-drop-zone .sketchId=${this.sketchId}></texture-drop-zone>
      </div>
    `;
  }

  /**
   * Implicit texture-output marker. Drop tab above inserts a new module
   * at chainIdx = chain.length (the bottom of the chain).
   */
  private renderOutputMarker(column: SketchColumn) {
    const path = `output/${this.sketchId}/${this.colIdx}`;
    const isSelected = this.ctl.isSelected(path);
    this.registerChainMarkerSelectable(path, 'Texture Output', 'output');
    const selectMarker = (e: Event) => { e.stopPropagation(); this.ctl.select(path); };
    return html`
      <div class="chain-marker" ?selected=${isSelected}>
        <div class="chain-marker-inner">
          <div class="chain-marker-label" @click=${selectMarker}>Output</div>
        </div>
      </div>
    `;
  }

  /**
   * Preview row beneath the input marker. The column's input texture is
   * the input handle of chain[0]; with an empty chain there is no
   * stage to trace and we render nothing.
   */
  private renderInputTraceCardRow(column: SketchColumn) {
    if (!this.ds.caps.tracing) return nothing;
    if (column.chain.length === 0) return nothing;
    const tracePath = `trace/${this.sketchId}/${this.colIdx}/input`;
    const traceSelected = this.ctl.isSelected(tracePath);
    const traceId = `trace_${this.sketchId}/${this.colIdx}/input`;
    const target: TracePoint['target'] = {
      type: 'chain_entry',
      sketchId: this.sketchId,
      colIdx: this.colIdx,
      chainIdx: 0,
      side: 'input',
    };
    return html`
      <div class="trace-card-row" ?selected=${traceSelected}
        @click=${(e: Event) => { e.stopPropagation(); this.ctl.select(tracePath); }}>
        <texture-monitor
          .traceId=${traceId}
          .traceTarget=${target}
          .width=${64}
          .height=${36}
        ></texture-monitor>
      </div>
    `;
  }

  // ========================================================================
  // Trace card rows
  // ========================================================================

  private renderTraceCardRow(chainIdx: number, entry: ChainEntry) {
    // chain[] holds only modules; the implicit input marker uses
    // renderInputTraceCardRow directly.
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
    // util.dashboard wires through its knob widgets (the <dashboard-editor>
    // body), not a separate output-trace row. Hiding the row (a) keeps each
    // <scalar-knob> the SOLE field-layout endpoint for its knob_i — so both the
    // input and output wires attach to the knob, like the old virtual dashboard
    // — and (b) hides the dashboard's output traces.
    if (entry.module_type === DASHBOARD_MODULE_TYPE) return nothing;
    // No trace pipeline on this surface → no output-trace monitors.
    if (!this.ds.caps.tracing) return nothing;
    const plugin = this.ds.getPlugin(entry.module_type);
    const outputs = this.collectModuleOutputs(entry);
    const tappingMode = this.ds.tappingMode;
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
    _schemaDef: any | null,
    tappingMode: boolean,
  ) {
    e.stopPropagation();
    if (!tappingMode) return;
    // Non-destructive: select the output field (no tap created). Connect via badges.
    const key = `${this.sketchId}/${this.colIdx}/${chainIdx}/${fieldPath}`;
    const entry = chainEntryAt(this.ds.getSketch(this.sketchId), chainIdx);
    if (entry?.type === 'module') this.registerFieldSelectable(key, chainIdx, entry, fieldPath, true);
    this.ctl.selectField(key);
  }

  // ========================================================================
  // Effect cards
  // ========================================================================

  private renderEffectCard(chainIdx: number, entry: ModuleEntry) {
    const tappingMode = this.ds.tappingMode;
    const isEditingType = this.editingTypeChainIdx === chainIdx;
    const effectPath = `effect/${this.sketchId}/${this.colIdx}/${chainIdx}`;
    const isSelected = this.ctl.isSelected(effectPath);
    const isCollapsed = isEffectCollapsed(this.ds.getSketch(this.sketchId), entry.instance_key);

    // Per-effect device controls (reserved engine keys in instance state).
    const reservedState = this.ds.getSketch(this.sketchId)
      ?.instances?.[entry.instance_key]?.state as Record<string, unknown> | undefined;
    const bypass = reservedState?.__bypass__ === true || reservedState?.__bypass__ === 1;
    const opacity = typeof reservedState?.__opacity__ === 'number'
      ? reservedState!.__opacity__ as number : 1;

    // Register as selectable with inspector content
    this.registerEffectSelectable(effectPath, chainIdx, entry);

    // Select on pointerdown — happens before drag threshold is reached, so
    // the card is selected whether the user intended to click or drag.
    const selectOnPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('smart-input')) return;
      this.ctl.select(effectPath);
    };

    return html`
      <div class="effect-card" ?selected=${isSelected} ?collapsed=${isCollapsed}
        ?editing=${isEditingType}
        data-chain-idx=${chainIdx}
        @click=${(e: Event) => {
          if ((e.target as HTMLElement).closest('smart-input, .tab-area')) return;
          // Swallow clicks anywhere on the card so the columns-view empty-space
          // handler (which sees a retargeted event and thinks the click was on
          // itself) doesn't immediately deselect us. Selecting the EFFECT itself
          // happens ONLY on the header (its pointerdown handler), so clicking a
          // field editor in the body selects just that parameter — the card no
          // longer steals selection out from under it.
          e.stopPropagation();
        }}>
        <div class="effect-card-inner">
          <div class="effect-card-header"
            @pointerdown=${(e: PointerEvent) => {
              selectOnPointerDown(e);
              if (!isEditingType) this.callbacks?.onCardPointerDown(e, this.sketchId, this.colIdx, chainIdx);
            }}
            @dblclick=${(e: Event) => this.onHeaderDblClick(e, entry)}>
            <button
              title=${bypass ? 'Device off — click to enable' : 'Device on — click to bypass'}
              style="margin-right:6px;background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:0 4px;opacity:${bypass ? 0.5 : 1};color:${bypass ? 'var(--app-text-color2)' : 'var(--app-ok)'}"
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${(e: Event) => {
                e.stopPropagation();
                this.ctl.setEffectParam(this.sketchId, this.colIdx, chainIdx, '__bypass__', !bypass);
              }}>⏻</button>
            <span class="effect-cat-dot" title=${effectDomain(entry.module_type)}
              style="background:${categoryColor(effectDomain(entry.module_type))}"></span>
            <div class="effect-card-name-wrapper" style=${isEditingType ? 'flex:1' : 'flex:0 1 auto'}>
              ${isEditingType ? html`
                <smart-input
                  .effects=${this.ds.availableEffects}
                  .initialValue=${this.insertCtx ? (this.insertCtx.prefill ?? '') : entry.module_type}
                  .autoSelect=${true}
                  @preview=${(e: CustomEvent) => this.handleTypePreview(chainIdx, e.detail)}
                  @commit=${(e: CustomEvent) => this.handleTypeCommit(chainIdx, e.detail)}
                  @delete-request=${() => this.handleTypeDeleteRequest(chainIdx)}
                  @cancel=${() => this.handleTypeCancel()}
                ></smart-input>
              ` : html`
                <span class="effect-card-name"
                  @dblclick=${(e: Event) => { e.stopPropagation(); this.beginEditType(chainIdx); }}
                  title=${entry.module_type}
                >${this.effectDisplayName(entry.module_type)}</span>
              `}
            </div>
            <scalar-slider
              title=${`Opacity ${Math.round(opacity * 100)}%`}
              style="margin-left:auto;width:64px"
              .fieldPath=${'__opacity__'}
              .min=${0} .max=${1} .step=${0.01} .defaultValue=${1}
              .binding=${this.deviceBinding(chainIdx, entry)}
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${(e: Event) => e.stopPropagation()}
            ></scalar-slider>
          </div>
          ${isCollapsed ? nothing : html`
            <div class="effect-card-divider"></div>
            <div class="effect-card-body" data-card-key="${this.sketchId}/${this.colIdx}/${chainIdx}"
              style=${bypass ? 'opacity:0.4;pointer-events:none' : ''}>
              ${this.renderFieldWidgets(chainIdx, entry)}
            </div>
            ${this.renderTraceCardRow(chainIdx, entry)}
            ${tappingMode ? this.renderTapOverlay(chainIdx, entry) : nothing}
          `}
        </div>
      </div>
    `;
  }

  /**
   * Double-click an effect card header to collapse / expand it — but NOT when
   * the double-click lands on the editable type text (which opens the type
   * editor) or on a header control (bypass toggle / opacity slider).
   */
  private onHeaderDblClick(e: Event, entry: ModuleEntry) {
    const t = e.target as HTMLElement;
    if (t.closest('.effect-card-name, smart-input, scalar-slider, button')) return;
    e.stopPropagation();
    this.ctl.toggleEffectCollapsed(this.sketchId, entry.instance_key);
  }

  // ========================================================================
  // Smart type editing
  // ========================================================================

  /** Human-readable display name for a module type ("Brightness & Contrast"),
   *  falling back to the short id segment when no effect metadata is found. */
  private effectDisplayName(moduleType: string): string {
    const eff = this.ds.availableEffects?.find(e => e.id === moduleType);
    return eff?.name || shortName(moduleType);
  }

  /** Open the smart-input for a chain entry. */
  beginEditType(chainIdx: number) {
    this.editingTypeChainIdx = chainIdx;
    this.requestUpdate();
  }

  private handleTypePreview(chainIdx: number, effectId: string) {
    if (this.insertCtx) {
      // Insertion: the long edit already exists (it added the placeholder) —
      // just re-point it at the previewed type.
      this.ctl.updateInsertEffect(
        this.typeLongEdit!, this.sketchId, this.colIdx, this.insertCtx.insertIdx,
        this.insertCtx.instanceKey, effectId);
    } else if (!this.typeLongEdit) {
      this.typeLongEdit = this.ctl.beginChangeEffectType(
        this.sketchId, this.colIdx, chainIdx, effectId);
    } else {
      this.ctl.updateChangeEffectType(
        this.typeLongEdit, this.sketchId, this.colIdx, chainIdx, effectId);
    }
  }

  private handleTypeCommit(chainIdx: number, effectId: string) {
    if (this.insertCtx) {
      // Commit the insertion at the chosen type → one "Add <type>" undo point.
      this.ctl.updateInsertEffect(
        this.typeLongEdit!, this.sketchId, this.colIdx, this.insertCtx.insertIdx,
        this.insertCtx.instanceKey, effectId);
      this.typeLongEdit!.accept();
    } else if (this.typeLongEdit) {
      // Update to final value, then accept (creates single undo point)
      this.ctl.updateChangeEffectType(
        this.typeLongEdit, this.sketchId, this.colIdx, chainIdx, effectId);
      this.typeLongEdit.accept();
    } else {
      // No preview happened — direct change
      this.ctl.changeEffectType(this.sketchId, this.colIdx, chainIdx, effectId);
    }
    this.endTypeEdit();
  }

  /**
   * Escape or click-away. For a fresh insertion this backs out entirely
   * (the placeholder is removed, no undo point); for an existing effect it
   * reverts to the original type.
   */
  private handleTypeCancel() {
    if (this.insertCtx && this.typeLongEdit) {
      this.ctl.cancelInsertEffect(this.typeLongEdit);
    } else if (this.typeLongEdit) {
      this.ctl.cancelChangeEffectType(this.typeLongEdit);
    }
    this.endTypeEdit();
  }

  /**
   * User expressly committed empty text (Enter/Tab on a blank field).
   * For a fresh insertion this is the same as cancelling — back out, no undo
   * point. For an existing effect it means "delete this effect" (its own undo
   * point); any in-progress type preview is reverted first.
   */
  private handleTypeDeleteRequest(chainIdx: number) {
    if (this.insertCtx && this.typeLongEdit) {
      this.ctl.cancelInsertEffect(this.typeLongEdit);
    } else {
      if (this.typeLongEdit) this.typeLongEdit.cancel();
      this.ctl.select(null);
      this.ctl.removeEffectFromChain(this.sketchId, this.colIdx, chainIdx);
    }
    this.endTypeEdit();
  }

  /** Tear down the type-editing session state and re-render. */
  private endTypeEdit() {
    this.typeLongEdit = null;
    this.insertCtx = null;
    this.editingTypeChainIdx = -1;
    this.requestUpdate();
  }

  /**
   * Build the set of field names that are SCHEMA-declared outputs for this
   * module. Write taps on a field no longer promote it to an output — input
   * params stay inputs regardless of how they're tapped.
   */
  private getOutputFieldNames(entry: ModuleEntry): Set<string> {
    const names = new Set<string>();
    // util.sketch_output: its out_i fields are io = in|out, but they are wire
    // DESTS (a producer writes INTO them), not sources. Return an empty set so
    // every endpoint renders with data-isOutput=false — a producer-output→
    // sketch-output connection is then unambiguously directed (writer=producer),
    // independent of chain order. The trace cards still render: collectModuleOutputs
    // scans io&2 itself. The schema still declares io&2 for future output exposure.
    if (entry.module_type === SKETCH_OUTPUT_MODULE_TYPE) return names;
    // util.dashboard's knob_i fields are io = in|out, so the generic io&2 scan
    // below surfaces them as outputs (wire sources) like any other effect.
    const plugin = this.ds.getPlugin(entry.module_type);
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
    const plugin = this.ds.getPlugin(entry.module_type);
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
    const selectedPath = this.ctl.selectedFieldKey();
    // Anchor the overlay to the effect-card-inner so it can span both the
    // inputs body and the output trace-card row.
    const innerEl = this.renderRoot.querySelector(
      `[data-card-key="${this.sketchId}/${this.colIdx}/${chainIdx}"]`
    )?.closest('.effect-card-inner') as HTMLElement | null;

    if (!innerEl) return html`<div class="tap-overlay-container"></div>`;

    const outputFieldNames = this.getOutputFieldNames(entry);
    const schema = this.ds.getPlugin(entry.module_type)?.schema ?? {};

    const hits: TemplateResult[] = [];
    const keyPrefix = `${this.sketchId}/${this.colIdx}/${chainIdx}/`;

    for (const key of this.layoutManager.keysUntracked()) {
      if (!key.startsWith(keyPrefix)) continue;

      const rect = this.layoutManager.getRelativeRect(key, innerEl);
      if (!rect) continue;

      const fieldPath = key.slice(keyPrefix.length);
      const isOutput = outputFieldNames.has(fieldPath);
      const isSelected = selectedPath === key;
      const schemaDef = (schema as any)[fieldPath] ?? null;
      this.registerFieldSelectable(key, chainIdx, entry, fieldPath, isOutput);

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

  /**
   * Start a drag-to-connect from a tap overlay hit, routed through the shared
   * connect controller (draws the rubber-band line; can drop on a field or a
   * rail badge). A short press (no drag) falls through to onTapOverlayClick.
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
    // A connect gesture is already in flight (e.g. click-to-connect): don't start
    // a competing drag whose pointerup would cancel/clear it before the click
    // can land the connection. Let onTapOverlayClick complete it.
    if (this.taps.state) return;
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
    const key = `${this.sketchId}/${this.colIdx}/${chainIdx}/${fieldPath}`;
    // Drag-to-connect, routed through the shared connect controller so the
    // rubber-band line draws and the drop can land on a field OR a rail badge.
    // A short press (no drag) falls through to onTapOverlayClick (select).
    this.taps.beginFromFieldDrag(e, sourceEl, this.sketchId, key, sourceInfo);
  }

  private onTapOverlayClick(
    key: string,
    fieldPath: string,
    isOutput: boolean,
    schemaDef: any | null,
    chainIdx: number,
  ) {
    // Swallow the synthetic click that trails a drag-to-connect gesture.
    if (this.taps.consumeClickSuppression()) return;
    // If a connect gesture is in flight, this click lands the connection here.
    if (this.taps.state) { this.taps.completeOnField(key); return; }
    // Non-destructive: first click SELECTS the field (no tap created). Clicking
    // the already-selected field again picks it up for click-to-connect.
    if (this.ctl.selectedFieldKey() === key) {
      const hit = this.renderRoot.querySelector(
        `.tap-overlay-hit[data-chain-idx="${chainIdx}"][data-field-path="${fieldPath}"],
         .field-option-pip.connectable[data-chain-idx="${chainIdx}"][data-field-path="${fieldPath}"]`) as HTMLElement | null;
      const r = hit?.getBoundingClientRect();
      this.taps.beginFromFieldClick(this.sketchId, key, {
        sketchId: this.sketchId, colIdx: this.colIdx, chainIdx, fieldPath,
        isOutput, viewportY: r ? r.top + r.height / 2 : 0, schemaDef,
      });
      return;
    }
    this.ctl.selectField(key);
  }

  private renderFieldWidgets(chainIdx: number, entry: ModuleEntry) {
    // util.dashboard: a distinct kind of effect with a bespoke knob-row body.
    if (entry.module_type === DASHBOARD_MODULE_TYPE) {
      return html`<dashboard-editor
        .sketchId=${this.sketchId} .instanceKey=${entry.instance_key}></dashboard-editor>`;
    }
    // util.sketch_output: its out_i fields are io = in|out, so they'd otherwise
    // render 8 input sliders here. Suppress the body entirely — the 8 fields are
    // exposed only as the output-trace row below (wire DEST endpoints).
    if (entry.module_type === SKETCH_OUTPUT_MODULE_TYPE) return nothing;

    const plugin = this.ds.getPlugin(entry.module_type);

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

  /**
   * Binding for the per-effect device controls (reserved `__`-keys in instance
   * state). Unlike buildFieldBinding it returns `undefined` for a missing value
   * rather than 0, so a control falls back to its own `defaultValue` — old
   * sketches with no `__opacity__` then read as full opacity (1), not 0. Writes
   * go through the long-edit (continuous) path so a drag is one undo entry.
   */
  private deviceBinding(chainIdx: number, entry: ModuleEntry): FieldBinding {
    return {
      instanceKey: entry.instance_key,
      getValue: (fieldPath: string) => {
        const st = this.ds.getSketch(this.sketchId)
          ?.instances?.[entry.instance_key]?.state as Record<string, unknown> | undefined;
        const v = st?.[fieldPath];
        return typeof v === 'number' ? v : undefined;
      },
      setValue: (fieldPath: string, value: any) => {
        this.ctl.setEffectParam(this.sketchId, this.colIdx, chainIdx, fieldPath, value);
      },
      beginContinuousEdit: (fieldPath: string, value: any): ContinuousEditHandle => {
        const edit = this.ctl.beginSetEffectParam(
          this.sketchId, this.colIdx, chainIdx, fieldPath, value);
        return {
          update: (v: any) => this.ctl.updateSetEffectParam(
            edit, this.sketchId, this.colIdx, chainIdx, fieldPath, v),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
    };
  }

  /** Shared FieldBinding builder — used by both the inputs body and the output trace cards. */
  private buildFieldBinding(
    chainIdx: number,
    entry: ModuleEntry,
    plugin: PluginInfo | undefined,
  ): FieldBinding {
    return {
      instanceKey: entry.instance_key,
      getValue: (fieldPath: string) => {
        // util.sketch_output: a wire writes INTO out_i via its read-tap, but an
        // identity passthrough never republishes to pluginStates — the written
        // value only surfaces as modulation telemetry. Read it from there so the
        // output-trace spark-chart shows the wire value (else it pins at 0).
        if (entry.module_type === SKETCH_OUTPUT_MODULE_TYPE) {
          const md = this.ds.modulation(entry.instance_key)?.[fieldPath];
          return md && typeof md.value === 'number' ? md.value : 0;
        }
        const ps = this.ds.pluginState(entry.instance_key);
        // OUTPUT fields are LIVE-published by the running effect — pluginStates
        // is authoritative. Prefer it, and crucially do NOT fall through to the
        // authored state, which a freshly-created instance is seeded with at the
        // schema default (0). That stale 0 would otherwise shadow the live value
        // and pin the output trace at 0.0 forever (until save+reload dropped it).
        const isOutput = (((plugin?.schema as any)?.[fieldPath]?.io ?? 0) & 2) !== 0;
        if (isOutput && ps && fieldPath in ps) return ps[fieldPath];
        // Input fields: authored value (loaded/saved state + edits) wins.
        // pluginStates is seeded with schema DEFAULTS for input fields the module
        // never republishes (it only set_val()s its outputs), so trusting it first
        // would shadow just-loaded state with defaults a frame after load.
        const sketch = this.ds.getSketch(this.sketchId);
        const instState = sketch?.instances?.[entry.instance_key]?.state;
        if (instState && fieldPath in instState) return instState[fieldPath];
        if (entry.params && fieldPath in entry.params) return entry.params[fieldPath];
        // Live published value (effect outputs / broadcasts) from the engine.
        if (ps && fieldPath in ps) return ps[fieldPath];
        return plugin?.params.find(p => p.name === fieldPath)?.defaultValue ?? 0;
      },
      getModulation: (fieldPath: string) => {
        const md = this.ds.modulation(entry.instance_key);
        const m = md?.[fieldPath];
        return m && typeof m.value === 'number' ? m : null;
      },
      setValue: (fieldPath: string, value: any) => {
        this.ctl.setEffectParam(this.sketchId, this.colIdx, chainIdx, fieldPath, value);
      },
      beginContinuousEdit: (fieldPath: string, value: any): ContinuousEditHandle => {
        const edit = this.ctl.beginSetEffectParam(
          this.sketchId, this.colIdx, chainIdx, fieldPath, value);
        return {
          update: (v: any) => this.ctl.updateSetEffectParam(
            edit, this.sketchId, this.colIdx, chainIdx, fieldPath, v),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
      beginContinuousEditMulti: (values: Record<string, any>): MultiContinuousEditHandle => {
        const edit = this.ctl.beginSetEffectParams(
          this.sketchId, this.colIdx, chainIdx, values);
        return {
          update: (v: Record<string, any>) => this.ctl.updateSetEffectParams(
            edit, this.sketchId, this.colIdx, chainIdx, v),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
    };
  }

  private buildInputFieldDefs(
    plugin: PluginInfo | undefined,
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
      // Hidden fields are still in the schema (and still receive
      // patches / participate in rails) — we just don't render them.
      // Effects toggle visibility via state::setFieldHidden in
      // on-state-ready / on_state_patched.
      if (d.hidden) continue;
      const label = schemaFieldDisplayName(d, name);
      if (d.type === 'texture') {
        fields.push({ type: 'placeholder', label, path: name,
          kind: 'texture', direction: 'input' });
        continue;
      }
      if (isScalarSchemaField(d)) {
        // Int fields carrying an `options` list become dropdown
        // selects (state::Schema::selectField on the C++ side).
        if (d.type === 'int' && Array.isArray(d.options) && d.options.length > 0) {
          fields.push({
            type: 'select', label, path: name,
            options: d.options.map((o: any) => ({
              label: String(o?.label ?? o?.value ?? ''),
              value: typeof o?.value === 'number' ? o.value : 0,
            })),
            default: typeof d.default === 'number' ? d.default : (d.options[0]?.value ?? 0),
            wrap: d.wrap === true,
            description: typeof d.description === 'string' ? d.description : undefined,
          });
          continue;
        }
        const param = plugin.params.find(p => p.name === name);
        if (param) {
          const fieldDef = paramToFieldDef(param);
          fieldDef.label = label;
          // Overlay schema-only UI options the legacy ParamInfo doesn't carry
          // (step/units/description from state::Schema's floatField/intField).
          if (fieldDef.type === 'slider' || fieldDef.type === 'number') {
            if (typeof d.step === 'number' && d.step > 0) fieldDef.step = d.step;
            if (typeof d.units === 'string') fieldDef.units = d.units;
          }
          if (typeof d.description === 'string') (fieldDef as any).description = d.description;
          fields.push(fieldDef);
          continue;
        }
        // No legacy param row (shouldn't happen for scalars) — fall through.
      }
      // Font-family picker (state::Schema::fontField) — searchable list editor.
      if (d.type === 'font') {
        fields.push({
          type: 'font', label, path: name,
          default: typeof d.default === 'string' ? d.default : '',
          description: typeof d.description === 'string' ? d.description : undefined,
        });
        continue;
      }
      // Vector fields: float2 / float3 / float4 → labeled component
      // sliders, or RGB(A) color picker when the schema carries
      // hint="color".
      const vecCount = d.type === 'float2' ? 2 : d.type === 'float3' ? 3 : d.type === 'float4' ? 4 : 0;
      if (vecCount > 0) {
        const def: number[] = Array.isArray(d.default) ? (d.default as number[]) : new Array(vecCount).fill(0);
        if ((vecCount === 3 || vecCount === 4) && d.hint === 'color') {
          fields.push({
            type: 'color', label, path: name,
            components: vecCount as 3 | 4,
            default: def,
          });
        } else {
          fields.push({
            type: 'vec', label, path: name,
            components: vecCount as 2 | 3 | 4,
            // Default the slider range to the vec field's natural [0,1]
            // unless the schema carries explicit min/max in the future.
            min: typeof d.min === 'number' ? d.min : 0,
            max: typeof d.max === 'number' ? d.max : 1,
            step: typeof d.step === 'number' ? d.step : 0.01,
            default: def,
          });
        }
        continue;
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
   * A small "light" in the gutter (by the field row) for any field that carries
   * engine-level options (currently smoothing) OR has a wire connected to it.
   * Clicking it selects the field, which surfaces the floating field card (where
   * the options + connected wires are listed). Fields with no inline editor
   * (e.g. pure outputs) have no gutter rect, so they get no pip — the wire arc
   * still shows that connection.
   */
  private renderFieldOptionPips(column: SketchColumn): TemplateResult[] {
    const pips: TemplateResult[] = [];
    if (!this.ds.caps.wiring && !this.ds.caps.smoothing) return pips;
    const gutterEl = this.renderRoot.querySelector(
      `.column-gutter[data-col="${this.colIdx}"]`) as HTMLElement | null;
    if (!gutterEl) return pips;
    const selKey = this.ctl.selectedFieldKey();
    const wires = this.ds.getSketch(this.sketchId)?.wires ?? [];
    const sketch = this.ds.getSketch(this.sketchId);
    for (let i = 0; i < column.chain.length; i++) {
      const entry = column.chain[i];
      if (entry.type !== 'module') continue;
      const outputFieldNames = this.getOutputFieldNames(entry);
      // Collect fields needing a pip: smoothing-enabled (extend as more
      // engine-level options arrive) plus any field a wire touches.
      const wiredFields = new Set<string>();
      const optionFields = new Set<string>();
      for (const [fp, opts] of Object.entries(entry.fieldOptions ?? {})) {
        if (opts?.smoothing?.enabled) optionFields.add(fp);
      }
      for (const w of wires) {
        if (w.src.instanceKey === entry.instance_key) wiredFields.add(w.src.field);
        if (w.dest.instanceKey === entry.instance_key) wiredFields.add(w.dest.field);
      }
      const fieldPaths = [...new Set([...optionFields, ...wiredFields])];

      // Collapsed card: its field rows are gone, so the per-row pips can't
      // anchor. Splay them to the right of the card instead — wires anchor to
      // these (see taps-overlay cardAnchorEl) and, in wiring mode, connect here.
      if (isEffectCollapsed(sketch, entry.instance_key)) {
        pips.push(...this.renderCollapsedPips(
          i, entry, fieldPaths, gutterEl, outputFieldNames, wiredFields, selKey));
        continue;
      }

      for (const fieldPath of fieldPaths) {
        const fieldKey = `${this.sketchId}/${this.colIdx}/${i}/${fieldPath}`;
        const rect = this.layoutManager.getRelativeRect(fieldKey, gutterEl);
        if (!rect) continue;
        // Ensure the field selectable exists so clicking the pip actually shows
        // the card — even outside taps mode and for fields with no taps.
        this.registerFieldSelectable(fieldKey, i, entry, fieldPath, outputFieldNames.has(fieldPath));
        const yCenter = rect.top + rect.height / 2;
        const isWired = wiredFields.has(fieldPath);
        const isOutput = outputFieldNames.has(fieldPath);
        const title = isWired
          ? 'Wired — click to view connections'
          : 'Smoothing on — click to edit';
        pips.push(html`
          <div class="field-option-pip ${isWired ? 'wired' : ''} ${isWired && isOutput ? 'output' : ''}"
            ?selected=${selKey === fieldKey}
            data-field-key=${fieldKey}
            style="top:${yCenter}px"
            title=${title}
            @click=${(e: Event) => { e.stopPropagation(); this.ctl.selectField(fieldKey); }}></div>
        `);
      }
    }
    return pips;
  }

  /**
   * Pips for a COLLAPSED card. Same green/blue/red dots as the field-row pips,
   * but splayed to the right of the card body (the rows are hidden) so each
   * connected/optioned field still has a visible, clickable anchor. They carry
   * the full connect dataset + class `connectable` so that, in wiring mode,
   * drag/drop-to-connect treats them as the field's endpoint, and committed
   * wires anchor their arcs here (taps-overlay falls back to the option pip when
   * a field has no live tap-port hit-box).
   */
  private renderCollapsedPips(
    chainIdx: number,
    entry: ModuleEntry,
    fieldPaths: string[],
    gutterEl: HTMLElement,
    outputFieldNames: Set<string>,
    wiredFields: Set<string>,
    selKey: string | null,
  ): TemplateResult[] {
    const out: TemplateResult[] = [];
    if (fieldPaths.length === 0) return out;
    const cardEl = this.renderRoot.querySelector(
      `.effect-card[data-chain-idx="${chainIdx}"]`) as HTMLElement | null;
    if (!cardEl) return out;
    const cardRect = cardEl.getBoundingClientRect();
    const gutterRect = gutterEl.getBoundingClientRect();
    const baseY = cardRect.top + cardRect.height / 2 - gutterRect.top;
    const schema = this.ds.getPlugin(entry.module_type)?.schema ?? {};

    fieldPaths.forEach((fieldPath, j) => {
      const fieldKey = `${this.sketchId}/${this.colIdx}/${chainIdx}/${fieldPath}`;
      const isOutput = outputFieldNames.has(fieldPath);
      const isWired = wiredFields.has(fieldPath);
      const schemaDef = (schema as any)[fieldPath] ?? null;
      this.registerFieldSelectable(fieldKey, chainIdx, entry, fieldPath, isOutput);
      // Splay rightward off the card's vertical midline, one dot-width per pip.
      const left = 2 + j * 16;
      const title = isWired
        ? 'Wired — click to view connections'
        : 'Smoothing on — click to edit';
      out.push(html`
        <div class="field-option-pip connectable ${isWired ? 'wired' : ''} ${isWired && isOutput ? 'output' : ''}"
          ?selected=${selKey === fieldKey}
          data-field-key=${fieldKey}
          data-sketch-id=${this.sketchId}
          data-col-idx=${this.colIdx}
          data-chain-idx=${chainIdx}
          data-field-path=${fieldPath}
          data-is-output=${isOutput ? 'true' : 'false'}
          style="top:${baseY}px;left:${left}px"
          title=${title}
          @pointerdown=${(e: PointerEvent) =>
            this.onCollapsedPipPointerDown(e, fieldKey, fieldPath, isOutput, schemaDef, chainIdx)}
          @click=${(e: Event) =>
            this.onCollapsedPipClick(e, fieldKey, fieldPath, isOutput, schemaDef, chainIdx)}></div>
      `);
    });
    return out;
  }

  /** Collapsed-pip pointerdown: start a drag-to-connect, but only in wiring
   *  mode (otherwise the pip is just a selection target). */
  private onCollapsedPipPointerDown(
    e: PointerEvent, key: string, fieldPath: string,
    isOutput: boolean, schemaDef: any | null, chainIdx: number,
  ) {
    if (!this.ds.tappingMode) return;
    this.onTapHitPointerDown(e, key, fieldPath, isOutput, schemaDef, chainIdx);
  }

  /** Collapsed-pip click: complete/pick-up a connection in wiring mode, else
   *  just select the field (surfaces the floating field card). */
  private onCollapsedPipClick(
    e: Event, key: string, fieldPath: string,
    isOutput: boolean, schemaDef: any | null, chainIdx: number,
  ) {
    e.stopPropagation();
    if (this.ds.tappingMode) {
      this.onTapOverlayClick(key, fieldPath, isOutput, schemaDef, chainIdx);
    } else {
      this.ctl.selectField(key);
    }
  }

  // ========================================================================
  // Drop zones
  // ========================================================================

  // ========================================================================
  // Category insert header
  // ========================================================================

  /** The pinned chip header — one chip per effect category present, in canonical
   *  order. Clicking begins an insertion drilled into that category. */
  private renderInsertHeader(_column: SketchColumn) {
    if (!this.ds.caps.typeEditing) return nothing;
    const present = new Set(this.ds.availableEffects.map((e) => e.category));
    const cats: string[] = CATEGORY_DOMAINS.filter((c) => present.has(c));
    for (const c of present) if (!cats.includes(c)) cats.push(c); // any extras last
    if (cats.length === 0) return nothing;
    return html`
      <div class="insert-header">
        ${cats.map((cat) => html`
          <button
            class="cat-chip"
            style=${`--chip:${categoryColor(cat)}`}
            title=${`Insert ${cat} effect`}
            @click=${() => this.insertCategoryEffect(cat)}
          >
            <ui-icon icon=${CATEGORY_ICON[cat] ?? 'la-plus'}></ui-icon>
            <span>${cat}</span>
          </button>
        `)}
      </div>
    `;
  }

  /** Insert point like "+ Track": below the selected card, else at the end. */
  private computeInsertIdx(): number {
    const sketch = this.ds.getSketch(this.sketchId);
    const chain = sketch ? sketchChain(sketch) : [];
    for (let i = 0; i < chain.length; i++) {
      if (this.ctl.isSelected(`effect/${this.sketchId}/${this.colIdx}/${i}`)) return i + 1;
    }
    return chain.length;
  }

  /** Best temporary effect id for a category (preferred default → first in
   *  category → core fallback). The user immediately retypes via the prefilled
   *  smart-input, so this is just the placeholder card content. */
  private categoryDefault(category: string): string {
    const avail = this.ds.availableEffects;
    const has = (id: string) => avail.some((e) => e.id === id);
    const pref = CATEGORY_DEFAULT[category];
    if (pref && has(pref)) return pref;
    const first = avail.find((e) => e.id.startsWith(`${category}.`));
    if (first) return first.id;
    return has(CATEGORY_FALLBACK) ? CATEGORY_FALLBACK : (avail[0]?.id ?? CATEGORY_FALLBACK);
  }

  /** Insert the category's default effect as a committed edit and select it — it
   *  does NOT open the type editor (double-click the card name to retype). */
  private insertCategoryEffect(category: string) {
    const insertIdx = this.computeInsertIdx();
    const { edit } = this.ctl.beginInsertEffect(
      this.sketchId, this.colIdx, insertIdx, this.categoryDefault(category));
    edit.accept();
    this.ctl.select(`effect/${this.sketchId}/${this.colIdx}/${insertIdx}`);
    this.requestUpdate();
    // Bring the freshly-inserted card into view (the scroller is an ancestor).
    void this.updateComplete.then(() => {
      this.renderRoot
        .querySelector(`.effect-card[data-chain-idx="${insertIdx}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    const plugin = this.ds.getPlugin(entry.module_type);
    const availEffect = this.ds.availableEffects.find(e => e.id === entry.module_type);

    this.ctl.defineSelectable({
      path,
      label: availEffect?.name ?? shortName(entry.module_type),
      // Selecting an effect drives the main monitor to that effect's output —
      // but only if it actually renders an image. Texture-passthrough nodes
      // (LFOs, data sources) have no texture output, so tracing "their output"
      // would show the next stage's texture; leave the monitor on final output.
      traceTarget: effectHasTextureOutput(plugin?.schema as any)
        ? { type: 'chain_entry', sketchId: this.sketchId, colIdx: this.colIdx, chainIdx, side: 'output' }
        : undefined,
      // Copy this card's instance state; paste drops the clipboard effect
      // immediately AFTER this one (chainIdx + 1). Keyed by instance_key so
      // copy survives reorders that may stale the captured chainIdx.
      copy: this.ds.caps.clipboard
        ? () => this.ctl.snapshotEffect(this.sketchId, entry.instance_key)
        : undefined,
      paste: this.ds.caps.clipboard
        ? (payload) => {
            if (payload.kind !== 'effect') return;
            this.ctl.insertEffectFromClipboard(this.sketchId, this.colIdx, chainIdx + 1, payload);
          }
        : undefined,
      renderInspectorContent: () => {
        const binding: FieldBinding = {
          instanceKey: entry.instance_key,
          getValue: (fieldPath: string) => {
            // Authored value wins over pluginStates (seeded with input defaults
            // the module never republishes); see buildFieldBinding for why.
            const sketch = this.ds.getSketch(this.sketchId);
            const instState = sketch?.instances?.[entry.instance_key]?.state;
            if (instState && fieldPath in instState) return instState[fieldPath];
            const ps = this.ds.pluginState(entry.instance_key);
            if (ps && fieldPath in ps) return ps[fieldPath];
            return plugin?.params.find(p => p.name === fieldPath)?.defaultValue ?? 0;
          },
          setValue: (fieldPath: string, value: any) => {
            this.ctl.setEffectParam(this.sketchId, this.colIdx, chainIdx, fieldPath, value);
          },
          beginContinuousEdit: (fieldPath: string, value: any): ContinuousEditHandle => {
            const edit = this.ctl.beginSetEffectParam(
              this.sketchId, this.colIdx, chainIdx, fieldPath, value);
            return {
              update: (v: any) => this.ctl.updateSetEffectParam(
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

  /**
   * Register a single field as a selectable. Its inspector content — the field
   * editor, the engine-level smoothing option, and the taps wired to it — is
   * shown in the right panel AND cloned into the floating field card (taps-overlay).
   */
  private registerFieldSelectable(
    key: string, chainIdx: number, entry: ModuleEntry, fieldPath: string, isOutput: boolean) {
    this.ctl.defineSelectable({
      path: `field/${key}`,
      label: fieldPath,
      renderInspectorContent: () => this.renderFieldInspector(chainIdx, entry, fieldPath, isOutput),
    });
  }

  /** Inspector body for one field — reused by the right panel and the floating card. */
  private renderFieldInspector(
    chainIdx: number, entry: ModuleEntry, fieldPath: string, isOutput: boolean) {
    const sId = this.sketchId, cI = this.colIdx;
    const plugin = this.ds.getPlugin(entry.module_type);
    const binding = this.buildFieldBinding(chainIdx, entry, plugin);

    // Single field editor (input fields only; pure outputs have no inline editor).
    const fieldDef = this.buildInputFieldDefs(plugin).find(f => f.path === fieldPath);
    const editor = fieldDef ? createGenericInspector([fieldDef])(binding) : nothing;

    // Smoothing — engine-level option, scalar input floats. Driven by the
    // standard IDE field widgets via a small binding onto the smoothing sub-tree.
    const sm = entry.fieldOptions?.[fieldPath]?.smoothing;
    const coerce = (k: string, v: any) => k === 'enabled' ? v > 0.5 : v;
    const smBinding: FieldBinding = {
      instanceKey: `${entry.instance_key}::smoothing::${fieldPath}`,
      getValue: (k: string) => {
        const s = entry.fieldOptions?.[fieldPath]?.smoothing;
        return k === 'enabled' ? (s?.enabled ?? false) : (s?.duration ?? 0.2);
      },
      setValue: (k: string, v: any) =>
        this.ctl.setFieldSmoothing(sId, cI, chainIdx, fieldPath, { [k]: coerce(k, v) }),
      beginContinuousEdit: (k: string, v: any): ContinuousEditHandle => {
        const edit = this.ctl.beginSetFieldSmoothing(
          sId, cI, chainIdx, fieldPath, { [k]: coerce(k, v) });
        return {
          update: (nv: any) => this.ctl.updateSetFieldSmoothing(
            edit, sId, cI, chainIdx, fieldPath, { [k]: coerce(k, nv) }),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
    };
    const smoothing = (isOutput || !this.ds.caps.smoothing) ? nothing : html`
      <div class="section-header" style="margin-top:8px">Smoothing</div>
      <field-toggle style="width:100%"
        .fieldPath=${'enabled'} .label=${'Enable'} .binding=${smBinding}></field-toggle>
      ${sm?.enabled ? html`
        <scalar-slider style="width:100%"
          .fieldPath=${'duration'} .label=${'Duration (s)'}
          .min=${0} .max=${5} .step=${0.05} .defaultValue=${0.2}
          .binding=${smBinding}></scalar-slider>
      ` : nothing}`;

    const sketch = this.ds.getSketch(this.sketchId);

    // Wires connected to this field. A field may be the source
    // (output) or the dest (input) of a wire; show the other endpoint + remove.
    const myKey = entry.instance_key;
    const wires = (sketch?.wires ?? []).filter(w =>
      (w.src.instanceKey === myKey && w.src.field === fieldPath) ||
      (w.dest.instanceKey === myKey && w.dest.field === fieldPath));
    // Modulation (scale/remap + combine) only applies to SCALAR wires — match
    // the executor, which runs the tap-mod math only on the scalar path. A
    // scalar field is a single number/bool; vectors/textures/structs carry only
    // the connection.
    const schemaType = (plugin?.schema?.[fieldPath] as { type?: string } | undefined)?.type;
    const isScalar = schemaType === 'float' || schemaType === 'int' || schemaType === 'bool'
      || fieldDef?.type === 'slider' || fieldDef?.type === 'number';
    const wiresSection = html`
      <div class="section-header" style="margin-top:8px">Wires</div>
      ${wires.length === 0
        ? html`<div style="font-size:11px;color:var(--app-text-color2)">No wires — drag field-to-field to connect.</div>`
        : wires.map(w => {
            const isSrc = w.src.instanceKey === myKey && w.src.field === fieldPath;
            const other = isSrc ? w.dest : w.src;
            const otherEntry = (sketch ? sketchChain(sketch) : [])
              .find(e => e.type === 'module' && e.instance_key === other.instanceKey) as ModuleEntry | undefined;
            const otherName = otherEntry ? shortName(otherEntry.module_type) : other.instanceKey;
            return html`
              <div class="tap-row">
                <span class="tap-row-name" title="${other.instanceKey}.${other.field}">
                  ${isSrc ? '→' : '←'} ${otherName}.${other.field}</span>
                <button style="background:none;border:none;color:var(--app-text-color2);cursor:pointer;font-size:14px;padding:0 4px;line-height:1"
                  title="Remove wire"
                  @click=${() => this.ctl.removeWire(sId, w.id)}>×</button>
              </div>
              ${isScalar ? this.renderWireModInspector(w) : nothing}
            `;
          })}
    `;

    return html`
      ${editor}
      ${smoothing}
      ${this.ds.caps.wiring ? wiresSection : nothing}
    `;
  }

  /**
   * Modulation controls for one scalar wire: a range remapper (scale + optional
   * remap with saturation and in/out shaping curves) applied to the value, and a
   * `combine` mode for how it folds into the dest when several wires target it.
   * Built from the shared field editors via a FieldBinding (so long edits +
   * styling come for free) — the scalar twin of the old per-tap mod inspector.
   */
  private renderWireModInspector(wire: Wire) {
    const remap = wire.mod?.remap;
    const usesPower = remap?.curveIn === 'power' || remap?.curveOut === 'power';
    const CURVES: TapCurve[] = ['linear', 'quad', 'circular', 'power', 'foldback'];
    const COMBINES: TapCombine[] = ['replace', 'mix', 'add', 'mul'];
    const MAGNITUDES: WireMagnitude[] = ['auto', 'signed', 'unsigned', 'absolute'];
    const curveOpts = CURVES.map(c => ({ label: c, value: c }));
    const combineOpts = COMBINES.map(c => ({ label: c, value: c }));
    const magOpts = MAGNITUDES.map(m => ({ label: m, value: m }));

    // The shaper stages run in this order (matching native/src/sketch/tap_mod.h +
    // the executor): ENVELOPE → REMAP → SCALE (pure value transforms) → DELAY
    // (temporal, transitive) — with Magnitude folding the result into the dest
    // field's range and Combine deciding how multiple wires stack. The panel is
    // laid out in that order. Envelope's drawn-curve editor can't be a generic
    // field, so it's rendered as a <envelope-field> between the head and tail
    // generic blocks (both driven by the one shared wire binding).
    const binding = this.wireModBinding(wire.id);
    const envEnabled = !!(wire.mod?.envelope && wire.mod.envelope.length >= 6);

    const headFields: InspectorFieldDef[] = [
      { type: 'select', label: 'Magnitude', path: 'magnitude', options: magOpts, default: 'auto' },
      { type: 'boolean', label: 'Envelope', path: 'envelopeEnabled', default: false },
    ];

    // Remap shapes the value (in its own range); Scale then scales the result in
    // modulation space (applied LAST among the pure stages, before Magnitude maps
    // it into the dest field's declared range). Scale sits under Remap to match.
    const tailFields: InspectorFieldDef[] = [
      { type: 'boolean', label: 'Remap', path: 'remapEnabled', default: false },
    ];
    if (remap) {
      tailFields.push(
        { type: 'slider', label: 'In min', path: 'remap.inMin', min: -1, max: 1, default: 0 },
        { type: 'slider', label: 'In max', path: 'remap.inMax', min: -1, max: 1, default: 1 },
        { type: 'slider', label: 'Out min', path: 'remap.outMin', min: -1, max: 1, default: 0 },
        { type: 'slider', label: 'Out max', path: 'remap.outMax', min: -1, max: 1, default: 1 },
        { type: 'boolean', label: 'Saturate', path: 'remap.saturate', default: false },
        { type: 'select', label: 'Curve in', path: 'remap.curveIn', options: curveOpts, default: 'linear' },
        { type: 'select', label: 'Curve out', path: 'remap.curveOut', options: curveOpts, default: 'linear' },
      );
      if (usesPower) {
        tailFields.push({ type: 'slider', label: 'Exponent', path: 'remap.exponent', min: 0, max: 8, step: 0.1, default: 2 });
      }
    }
    tailFields.push({ type: 'slider', label: 'Scale', path: 'scale', min: 0, max: 4, step: 0.01, default: 1 });
    // Delay: temporal time-shift (seconds), runs after the pure stages. Bounded by
    // the executor's delay-line span (~8s @60fps); the slider caps at 2s.
    tailFields.push({ type: 'slider', label: 'Delay (s)', path: 'delay', min: 0, max: 2, step: 0.01, default: 0 });
    tailFields.push({ type: 'select', label: 'Combine', path: 'combine', options: combineOpts, default: 'replace' });
    if ((wire.combine ?? 'replace') === 'mix') {
      tailFields.push({ type: 'slider', label: 'Mix', path: 'mixFactor', min: 0, max: 1, default: 1 });
    }

    return html`<div style="margin:2px 0 6px 8px;padding-left:8px;border-left:2px solid rgba(255,255,255,0.08)">
      ${createGenericInspector(headFields)(binding)}
      ${envEnabled ? html`<envelope-field .binding=${binding} .fieldPath=${'envelope'}></envelope-field>` : nothing}
      ${createGenericInspector(tailFields)(binding)}
    </div>`;
  }

  /**
   * FieldBinding mapping synthetic paths to a wire's mod fields, so the shared
   * field editors can drive them with long edits. Numbers (scale, remap in/out
   * min/max, exponent, mixFactor), booleans (remapEnabled, remap.saturate), and
   * selects (remap.curveIn/curveOut, combine). Reads return undefined for unset
   * numerics so sliders fall back to their default.
   */
  private wireModBinding(wireId: string): FieldBinding {
    const sId = this.sketchId;
    const getWire = (): Wire | undefined =>
      this.ds.getSketch(sId)?.wires?.find(w => w.id === wireId);
    const read = (path: string): any => {
      const wire = getWire();
      if (!wire) return undefined;
      if (path === 'scale') return wire.mod?.scale;
      if (path === 'delay') return wire.mod?.delay;
      if (path === 'mixFactor') return wire.mixFactor;
      if (path === 'combine') return wire.combine ?? 'replace';
      if (path === 'magnitude') return wire.magnitude ?? 'auto';
      if (path === 'envelope') return wire.mod?.envelope;
      if (path === 'envelopeEnabled') return !!(wire.mod?.envelope && wire.mod.envelope.length >= 6);
      if (path === 'remapEnabled') return !!wire.mod?.remap;
      if (path.startsWith('remap.')) {
        return (wire.mod?.remap as Record<string, any> | undefined)?.[path.slice(6)];
      }
      return undefined;
    };
    // Build a Partial<Wire> patch for a path+value, deep-merging mod/remap.
    const patchFor = (path: string, v: any): Partial<Wire> => {
      const mod = getWire()?.mod ?? {};
      if (path === 'scale') return { mod: { ...mod, scale: v as number } };
      if (path === 'delay') return { mod: { ...mod, delay: v as number } };
      if (path === 'mixFactor') return { mixFactor: v as number };
      if (path === 'combine') return { combine: v as TapCombine };
      if (path === 'magnitude') return { magnitude: v as WireMagnitude };
      if (path === 'envelope') return { mod: { ...mod, envelope: v as number[] } };
      if (path === 'envelopeEnabled') {
        // Toggle on → seed the identity curve [0,0,0, 1,1,0] (passthrough);
        // off → drop the array. Matches remap's enable-seeds-default pattern.
        return { mod: { ...mod, envelope: v ? (mod.envelope ?? [0, 0, 0, 1, 1, 0]) : undefined } };
      }
      if (path === 'remapEnabled') {
        return { mod: { ...mod, remap: v ? (mod.remap ?? { inMin: 0, inMax: 1, outMin: 0, outMax: 1 }) : undefined } };
      }
      const remap = mod.remap ?? { inMin: 0, inMax: 1, outMin: 0, outMax: 1 };
      const key = path.slice(6);
      // field-toggle writes 0/1 for saturate; everything else is the typed value.
      const val = key === 'saturate' ? !!v : v;
      return { mod: { ...mod, remap: { ...remap, [key]: val } } };
    };
    return {
      instanceKey: `wire/${sId}/${wireId}`,
      getValue: (path: string) => read(path),
      setValue: (path: string, v: any) => this.ctl.updateWire(sId, wireId, patchFor(path, v)),
      beginContinuousEdit: (path: string, v: any): ContinuousEditHandle => {
        const edit = this.ctl.beginUpdateWire(sId, wireId, patchFor(path, v));
        return {
          update: (nv: any) => this.ctl.updateUpdateWire(edit, sId, wireId, patchFor(path, nv)),
          accept: () => edit.accept(),
          cancel: () => edit.cancel(),
        };
      },
    };
  }

  /**
   * Register the implicit input or output marker as a selectable. The
   * trace target binds to chain[0]'s input (for the input marker) or
   * chain[N-1]'s output (for the output marker) — those are the column's
   * implicit I/O textures.
   */
  private registerChainMarkerSelectable(path: string, label: string, side: 'input' | 'output') {
    const sketch = this.ds.getSketch(this.sketchId);
    const chainLen = sketch ? sketchChain(sketch).length : 0;
    const chainIdx = side === 'input' ? 0 : Math.max(0, chainLen - 1);
    const traceId = `trace_${this.sketchId}/${this.colIdx}/${side}`;
    const target: TracePoint['target'] = {
      type: 'chain_entry',
      sketchId: this.sketchId,
      colIdx: this.colIdx,
      chainIdx,
      side,
    };
    const previewAvailable = chainLen > 0;

    this.ctl.defineSelectable({
      path,
      // Selecting a texture marker drives the main monitor to this texture.
      traceTarget: previewAvailable ? target : undefined,
      label,
      renderInspectorContent: () => html`
        <div class="inspector-field">
          <span class="inspector-field-label">Type</span>
          <span class="inspector-field-value">${side === 'input' ? 'texture_input' : 'texture_output'}</span>
        </div>
        <div class="inspector-field">
          <span class="inspector-field-label">Column</span>
          <span class="inspector-field-value">${this.colIdx}</span>
        </div>
        <div class="inspector-separator"></div>
        <div class="section-header">Preview</div>
        ${previewAvailable ? html`
          <texture-monitor
            .traceId=${traceId}
            .traceTarget=${target}
            .width=${280}
            .height=${158}
          ></texture-monitor>
        ` : html`
          <div class="inspector-field-value" style="opacity:0.6">
            ${side === 'input' ? 'No modules in this column yet.' : 'No modules in this column yet.'}
          </div>
        `}
      `,
    });
  }
}
