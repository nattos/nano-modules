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

import { html, css, nothing, svg, TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { Sketch, SketchColumn, ChainEntry, ModuleEntry, Wire, FieldConnectInfo, SketchOutputFormat, SketchResolutionOverride } from '../sketch-types';
import { sketchChain, chainEntryAt, isEffectCollapsed, DASHBOARD_MODULE_TYPE, SKETCH_OUTPUT_MODULE_TYPE, RESERVED_FIELD_DEFS, BLEND_MODE_NAMES, isDefaultOutputFormat, isDeviceOff } from '../sketch-types';
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
import './field-tab-bar';
import './field-placeholder';
import './texture-monitor';
import './spark-chart';
import './dashboard-editor';
import './smart-input';
import './scalar-slider';
import './editable-number';
import './output-trace-card';
import './texture-drop-zone';
import './global-input-control';
import { wireModBinding, renderWireModInspector } from './wire-mod-inspector';
import './ui-icon';

import type { Selectable } from '../state/types';
import { categoryColor, effectDomain, CATEGORY_DOMAINS } from './category-color';

/** Options for the per-effect `__blend__` selector (gear options row). Index =
 *  the composite.blend enum value the executor consumes. */
const BLEND_MODE_OPTIONS = BLEND_MODE_NAMES.map((label, value) => ({ label, value }));
import { sanitizeIconName, thumbnailDataUri } from './effect-glyph';

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
  warp: 'warp.transform',
  mod: 'mod.source.lfo',
};
/** Fallback temporary effect when a category has no good default in core. */
const CATEGORY_FALLBACK = 'color.tone.brightness_contrast';

// ── Wire arc geometry (gently bowed cubic bezier, writer→reader) ──
type Pt = { x: number; y: number };
function arcBezierPath(a: Pt, b: Pt): string {
  const dy = b.y - a.y;
  const bow = Math.min(Math.max(Math.abs(dy) * 0.25 + 26, 32), 90);
  const c1 = { x: a.x + bow, y: a.y + dy * 0.33 };
  const c2 = { x: b.x + bow, y: b.y - dy * 0.33 };
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
}

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
  /**
   * Optional placeholder row drawn in the gap BEFORE chain card `gapIndex`
   * (`0..chain.length`, `chain.length` ⇒ after the last card). Multi-edit uses it
   * to surface a collapsed "N other effects" row for ragged effects that aren't
   * common across the selected clips. Returns null/undefined to draw nothing —
   * inert for single-clip/track panels that don't implement it.
   */
  renderInterstitial?(sketchId: string, gapIndex: number): TemplateResult | null;
}

@customElement('column-group')
export class ColumnGroup extends MobxLitElement {
  @property({ type: Number }) colIdx = -1;
  @property() sketchId = '';
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

  /** Effect cards (by instance key) with their options row open — the gear
   *  toggle right of the opacity slider. Session-local UI state, not persisted. */
  private effectOptionsOpen = new Set<string>();

  /** Gutter width — holds the field-option pip + wire ports. Fixed now that
   *  rails are gone (it used to grow per rail). */
  static readonly GUTTER_WIDTH = 20;

  /** Modulation/option pips render in a thin strip on the LEFT of the column (for
   *  every surface — IDE and arrangement alike). The old right-hand "gutter" is retired
   *  (single linear stack, no multi-column). The strip is ALWAYS present for a real
   *  column — it's an always-on indicator, independent of wires MODE (which only gates
   *  the connect interaction). renderFieldOptionPips emits a dot only for fields that
   *  are actually wired or have smoothing, so the strip is invisible until there's
   *  something to show. */
  private get showPips(): boolean {
    return !!this.adapter;
  }

  getGutterWidth(): number {
    return 0; // retired — the column is always full-width; pips float on the left
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
  /**
   * Bumped every time a NEW type-edit session begins (retype or insert).
   * Terminal smart-input events (preview/commit/cancel/delete-request) close
   * over the session id at render time; a STALE event firing after the user
   * has already moved on to a different card (e.g. a delayed blur landing
   * after a new session started) compares its captured id against the
   * current one and no-ops instead of mutating the wrong session's edit.
   */
  private editSession = 0;

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
      padding: var(--app-sp-2) 0;
      gap: var(--app-sp-2);
      box-sizing: border-box;
    }

    /* Category insert chips — pinned to the BOTTOM of the chain + scroll area:
     * a row of chips that begin inserting a new effect of that category. */
    .insert-header {
      position: sticky;
      bottom: 0;
      z-index: 30;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 8px 0 6px;
      margin-top: 4px;
      background: var(--app-bg-color2);
      border-top: 1px solid var(--app-tint-3);
    }
    .insert-header--empty {
      display: block;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      padding: 8px 0;
      line-height: 1.4;
    }
    .insert-header--empty .insert-hint {
      display: block;
      color: var(--app-warn, var(--app-text-color2));
      opacity: 0.85;
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
    /* The top-level "New" chip — the primary insert action, tinted with the
     * selection accent so it stands apart from the per-category chips. */
    .cat-chip--new {
      --chip: var(--app-hi-color2, #4169E1);
      background: var(--device-sel-bg);
      font-weight: 600;
    }
    .cat-chip--new ui-icon { color: var(--app-hi-color2, #4169E1); }
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
      /* Drop the shared z-index:0 stacking context so the header row / options
       * (z-index:11) can lift above the texture-drop-zone overlay (z-index:10),
       * while the marker's non-interactive body stays below it as the drop
       * target. The drop-zone is still contained by .chain-marker's isolation. */
      z-index: auto;
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
    /* Input marker header — mirror the effect-card header: glyph, then name
     * aligned left, gear pinned right. Lifted above the texture-drop-zone
     * overlay (z-index:10) so the gear and its options stay clickable. */
    .chain-marker-label-row {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      position: relative;
      z-index: 11;
    }
    .chain-marker-glyph {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      margin-right: 6px;
      --icon-size: 14px;
      color: var(--app-text-color2);
    }
    .chain-marker-label-row > .chain-marker-label {
      flex: 1;
      min-width: 0;
      padding: 0;
      text-align: left;
    }
    .chain-marker-label-row > .device-gear-btn {
      margin-left: auto;
    }
    /* Per-sketch output-format options (Input card gear section). */
    .output-format-options {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 0 10px 8px;
      /* Above the drop-zone overlay so its buttons/inputs are clickable. */
      position: relative;
      z-index: 11;
    }
    .ofo-row {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .ofo-row-label {
      flex: 0 0 38px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .ofo-btn {
      flex: 0 0 auto;
      background: none;
      border: 1px solid var(--device-border);
      border-radius: 2px;
      color: var(--app-text-color2);
      font-size: var(--app-fs-sm);
      padding: 2px 6px;
      line-height: 1.2;
      cursor: pointer;
    }
    .ofo-btn:hover { color: var(--app-text-color1); }
    .ofo-btn[data-active] {
      color: var(--app-text-color1);
      border-color: var(--device-sel-border);
      background: var(--device-sel-bg);
    }
    .ofo-num {
      width: 52px;
      flex: 0 0 auto;
      font-size: var(--app-fs-sm);
      --editable-text-pad: 2px 4px;
      --editable-text-radius: 2px;
    }
    .ofo-note {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
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
    /* Per-effect header glyph (icon or thumbnail) — sits in the dot's slot. */
    .effect-glyph {
      flex: 0 0 auto;
      width: 14px; height: 14px;
      margin-right: 6px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .effect-glyph.effect-thumb {
      border-radius: 2px;
      object-fit: cover;
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
      /* Fill the full header height so the name's hit target reaches the header
       * edges (the text stays centered) — clicking the type is otherwise a thin
       * single-line target. */
      align-self: stretch;
    }
    .effect-card-name-wrapper > smart-input {
      flex: 1;
      min-width: 0;
    }
    /* Gear toggle (right of the opacity slider): reveals the per-effect
     * options row below the header. Lit up while the row is open OR while a
     * non-default option (blend mode) is active, so a hidden non-Normal blend
     * is never invisible. */
    .device-gear-btn {
      flex: 0 0 auto;
      background: none;
      border: none;
      cursor: pointer;
      padding: 0 2px;
      margin-left: 4px;
      font-size: 13px;
      line-height: 1;
      color: var(--app-text-color2);
      display: inline-flex;
      align-items: center;
    }
    .device-gear-btn:hover { color: var(--app-text-color1); }
    .device-gear-btn[data-active] { color: var(--app-text-color1); }
    /* Per-effect options row (engine-reserved keys beyond bypass/opacity),
     * slotted between the header and the body divider. */
    .effect-card-options {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      padding: 2px 10px 6px;
    }
    /* The blend segmented bar (same widget video.blend's mode field uses —
     * every mode one click away, wrapping onto extra rows as needed). */
    .effect-card-options field-tab-bar {
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

    /* --- Wire arcs (in-column overlay, shown in wires mode) --- */
    .wire-lines {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
      z-index: 6;
    }
    .wire-arc {
      fill: none;
      stroke: var(--app-hi-color2, #4169E1);
      stroke-width: 1.5;
      opacity: 0.55;
      stroke-dasharray: 5 4;
      stroke-linecap: round;
      animation: wire-flow 0.7s linear infinite;
    }
    .wire-group:hover .wire-arc { stroke: var(--app-hi-color1, #ff4500); opacity: 0.95; }
    .wire-arc.selected {
      stroke: var(--app-hi-color1, #ff4500);
      opacity: 1;
      stroke-width: 2.5;
      stroke-dasharray: none;
      animation: none;
    }
    .wire-mod-panel {
      margin: var(--app-sp-2) 0 0;
      padding: var(--app-sp-2) var(--app-sp-3) var(--app-sp-3);
      border: 1px solid var(--app-hi-color2, #4169E1);
      border-radius: 2px;
      background: var(--app-bg-color2);
    }
    /* Floating variant — a popup anchored at the click point (matches the IDE's
       floating field card) instead of pushing the column layout from the bottom. */
    .wire-mod-panel.floating {
      position: fixed;
      z-index: 61;
      width: 210px;
      margin: 0;
      max-height: 70vh;
      overflow-y: auto;
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.5);
    }
    .wire-mod-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: var(--app-fs-sm);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--app-text-color2);
      margin-bottom: 4px;
    }
    .wire-mod-remove {
      background: none;
      border: none;
      color: var(--app-text-color2);
      cursor: pointer;
      padding: 2px;
      display: flex;
    }
    .wire-mod-remove:hover { color: var(--app-err-color, #e0564f); }
    .wire-mod-remove ui-icon { --icon-size: 12px; }
    .wire-hit {
      fill: none;
      stroke: transparent;
      stroke-width: 14;
      pointer-events: stroke;
      cursor: pointer;
    }
    .connect-line {
      stroke: var(--app-hi-color2, #4169E1);
      stroke-width: 2;
      stroke-dasharray: 4 3;
      pointer-events: none;
    }
    @keyframes wire-flow { to { stroke-dashoffset: -9; } }

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
    /* Left strip hosting the modulation/option pips (the right gutter is retired). */
    .pip-strip {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 14px;
      pointer-events: none;
      z-index: 4;
    }
    .field-option-pip {
      position: absolute;
      left: 0;
      width: 14px; height: 22px;
      transform: translateY(-50%);
      cursor: pointer;
      pointer-events: auto;
      z-index: 3;
    }
    .field-option-pip::after {
      content: '';
      position: absolute;
      left: 2px; top: 50%; margin-top: -3px;
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
    this.style.setProperty('--column-width', '100%');
    this.style.setProperty('--gutter-width', '0px');

    const column = this.renderRoot.querySelector('.column') as HTMLElement | null;
    if (column) this.layoutManager.observeContainer(column);
    this.scanAndRegisterFields();
  }

  private wireRaf = 0;
  connectedCallback() {
    super.connectedCallback();
    // Keep wire arcs glued to their field rows (positions shift on scroll/resize
    // without a Lit re-render). Cheap no-op when there's no wire overlay.
    const tick = () => { this.wireRaf = requestAnimationFrame(tick); this.updateWireGeometry(); };
    this.wireRaf = requestAnimationFrame(tick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.layoutManager.dispose();
    if (this.wireRaf) cancelAnimationFrame(this.wireRaf);
    this.wireRaf = 0;
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

    // Insertion points are the gaps between cards. One above
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
        <div class="column-body">
          ${this.renderChain(sketch, column)}
        </div>
        <div class="drag-insert-marker"></div>
        ${this.renderWireArcs(sketch)}
        ${this.renderSelectedWirePanel(sketch)}
        ${this.renderInsertHeader(column)}
        ${this.showPips ? html`
          <div class="pip-strip" data-col=${this.colIdx}>
            ${this.renderFieldOptionPips(column)}
          </div>` : nothing}
      </div>
    `;
  }

  // ========================================================================
  // Chain rendering
  // ========================================================================

  private renderChain(sketch: Sketch, column: SketchColumn) {
    const items: (TemplateResult | typeof nothing)[] = [];
    // Optional gap placeholder (multi-edit "other effects" row); inert otherwise.
    const inter = (gap: number) => {
      const r = this.callbacks?.renderInterstitial?.(this.sketchId, gap);
      if (r) items.push(r);
    };
    // Implicit texture input marker on top — not stored in chain.
    items.push(this.renderInputMarker(column));
    inter(0);
    for (let i = 0; i < column.chain.length; i++) {
      items.push(this.renderEffectCard(i, column.chain[i]));
      inter(i + 1);
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
    // Per-sketch output format lives behind the Input card's gear (mirrors the
    // effect-card gear). Only when the surface's controller supports it.
    const canFormat = !!this.ctl.setSketchOutputFormat;
    const fmt = this.ds.getSketch(this.sketchId)?.outputFormat;
    const nonDefault = !isDefaultOutputFormat(fmt);
    return html`
      <div class="chain-marker" ?selected=${isSelected}>
        <div class="chain-marker-inner">
          <div class="chain-marker-label-row">
            <ui-icon class="chain-marker-glyph" icon="la-image"></ui-icon>
            <div class="chain-marker-label" @click=${selectMarker}>Input</div>
            ${canFormat ? html`
              <button
                class="device-gear-btn"
                title=${nonDefault ? 'Sketch output format (overridden)' : 'Sketch output format'}
                ?data-active=${this.inputOptionsOpen || nonDefault}
                @pointerdown=${(e: Event) => e.stopPropagation()}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.inputOptionsOpen = !this.inputOptionsOpen;
                  this.requestUpdate();
                }}><ui-icon icon="la-cog"></ui-icon></button>
            ` : nothing}
          </div>
          ${canFormat && this.inputOptionsOpen ? this.renderOutputFormatOptions(fmt) : nothing}
          ${this.renderInputTraceCardRow(column)}
          <global-input-control></global-input-control>
        </div>
        <texture-drop-zone .sketchId=${this.sketchId}></texture-drop-zone>
      </div>
    `;
  }

  /** Open state of the Input card's output-format section (session-local,
   *  like effectOptionsOpen). */
  private inputOptionsOpen = false;
  /** Which custom editor is expanded ('scale' | 'fixed' | null). Preset picks
   *  clear it; opening one reveals its number input(s). */
  private ofoCustom: 'scale' | 'fixed' | null = null;

  /** Merge a partial change into the sketch's outputFormat (undoable via the
   *  controller; all-defaults deletes the key). `resolution: null` clears the
   *  resolution override, `undefined` leaves it as is. */
  private patchOutputFormat(patch: { resolution?: SketchResolutionOverride | null; bitDepth?: 8 | 16 }) {
    const cur = this.ds.getSketch(this.sketchId)?.outputFormat;
    const res = patch.resolution === undefined ? cur?.resolution
              : patch.resolution === null ? undefined : patch.resolution;
    const bd = patch.bitDepth ?? (cur?.bitDepth === 16 ? 16 : 8);
    const next: SketchOutputFormat = {};
    if (res) next.resolution = res;
    if (bd === 16) next.bitDepth = 16;
    this.ctl.setSketchOutputFormat?.(
      this.sketchId, (next.resolution || next.bitDepth) ? next : undefined);
  }

  private renderOutputFormatOptions(fmt: SketchOutputFormat | undefined) {
    const res = fmt?.resolution;
    const scale = res?.mode === 'multiplier' ? res.scale : (res ? null : 1);
    const fixed = res?.mode === 'fixed' ? res : null;
    const depth = fmt?.bitDepth === 16 ? 16 : 8;
    const SCALES: { label: string; value: number }[] = [
      { label: '1/4', value: 0.25 }, { label: '1/2', value: 0.5 },
      { label: '1x', value: 1 }, { label: '2x', value: 2 }, { label: '4x', value: 4 },
    ];
    const FIXED: { label: string; w: number; h: number }[] = [
      { label: '720p', w: 1280, h: 720 },
      { label: '1080p', w: 1920, h: 1080 },
      { label: '4k', w: 3840, h: 2160 },
    ];
    const scaleIsPreset = scale !== null && SCALES.some(s => s.value === scale);
    const fixedIsPreset = !!fixed && FIXED.some(f => f.w === fixed.width && f.h === fixed.height);
    const showScaleCustom = this.ofoCustom === 'scale' || (scale !== null && !scaleIsPreset);
    const showFixedCustom = this.ofoCustom === 'fixed' || (!!fixed && !fixedIsPreset);
    const pickScale = (v: number) => {
      this.ofoCustom = null;
      this.patchOutputFormat({ resolution: v === 1 ? null : { mode: 'multiplier', scale: v } });
    };
    const pickFixed = (w: number, h: number) => {
      this.ofoCustom = null;
      this.patchOutputFormat({ resolution: { mode: 'fixed', width: w, height: h } });
    };
    return html`
      <div class="output-format-options" @click=${(e: Event) => e.stopPropagation()}>
        <div class="ofo-row">
          <span class="ofo-row-label" title="Internal resolution as a multiplier of the output size">Scale</span>
          ${SCALES.map(s => html`
            <button class="ofo-btn" ?data-active=${scale === s.value && !showScaleCustom}
              @click=${() => pickScale(s.value)}>${s.label}</button>`)}
          <button class="ofo-btn" ?data-active=${showScaleCustom && scale !== null}
            title="Custom multiplier"
            @click=${() => { this.ofoCustom = this.ofoCustom === 'scale' ? null : 'scale'; this.requestUpdate(); }}>…</button>
          ${showScaleCustom ? html`
            <editable-number class="ofo-num" label="Custom scale"
              .value=${scale ?? 1} .min=${0.1} .max=${8} .step=${0.05}
              @input=${(e: CustomEvent<number>) => this.patchOutputFormat({
                resolution: e.detail === 1 ? null : { mode: 'multiplier', scale: e.detail } })}
              @pointerdown=${(e: Event) => e.stopPropagation()}></editable-number>` : nothing}
        </div>
        <div class="ofo-row">
          <span class="ofo-row-label" title="Fixed internal resolution (stretched to fill the output)">Fixed</span>
          ${FIXED.map(f => html`
            <button class="ofo-btn" ?data-active=${!!fixed && fixed.width === f.w && fixed.height === f.h && !showFixedCustom}
              @click=${() => pickFixed(f.w, f.h)}>${f.label}</button>`)}
          <button class="ofo-btn" ?data-active=${showFixedCustom && !!fixed}
            title="Custom fixed size"
            @click=${() => { this.ofoCustom = this.ofoCustom === 'fixed' ? null : 'fixed'; this.requestUpdate(); }}>…</button>
          ${showFixedCustom ? html`
            <editable-number class="ofo-num" label="Custom width"
              .value=${fixed?.width ?? 1920} .min=${8} .max=${8192} .step=${1}
              @input=${(e: CustomEvent<number>) => this.patchOutputFormat({
                resolution: { mode: 'fixed', width: Math.round(e.detail), height: fixed?.height ?? 1080 } })}
              @pointerdown=${(e: Event) => e.stopPropagation()}></editable-number>
            <span class="ofo-note">×</span>
            <editable-number class="ofo-num" label="Custom height"
              .value=${fixed?.height ?? 1080} .min=${8} .max=${8192} .step=${1}
              @input=${(e: CustomEvent<number>) => this.patchOutputFormat({
                resolution: { mode: 'fixed', width: fixed?.width ?? 1920, height: Math.round(e.detail) } })}
              @pointerdown=${(e: Event) => e.stopPropagation()}></editable-number>` : nothing}
        </div>
        <div class="ofo-row">
          <span class="ofo-row-label" title="Working bit depth for the whole chain">Depth</span>
          <button class="ofo-btn" ?data-active=${depth === 8}
            @click=${() => this.patchOutputFormat({ bitDepth: 8 })}>8-bit</button>
          <button class="ofo-btn" ?data-active=${depth === 16}
            title="16-bit float working precision (~2x memory/bandwidth); values are no longer clamped to [0,1] between effects"
            @click=${() => this.patchOutputFormat({ bitDepth: 16 })}>16F</button>
          <span class="ofo-note">
            ${fixed ? `${fixed.width}×${fixed.height}` : scale === 1 || scale === null && !fixed ? 'output size' : `×${scale}`}${depth === 16 ? ' @ 16F' : ''}
          </span>
        </div>
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
          .traceSource=${this.adapter?.traceSource ?? null}
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
    const plugin = this.ds.getPlugin(entry.module_type, entry.instance_key);
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
              .min=${typeof o.schemaDef?.min === 'number' ? o.schemaDef.min : 0}
              .max=${typeof o.schemaDef?.max === 'number' ? o.schemaDef.max : 1}
              .traceId=${traceId}
              .traceTarget=${target}
              .traceSource=${this.adapter?.traceSource ?? null}
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
    const session = this.editSession;
    const effectPath = `effect/${this.sketchId}/${this.colIdx}/${chainIdx}`;
    const isSelected = this.ctl.isSelected(effectPath)
      || (this.ctl.isMultiSelected?.(effectPath) ?? false);
    const isCollapsed = isEffectCollapsed(this.ds.getSketch(this.sketchId), entry.instance_key);

    // Per-effect device controls (reserved engine keys in instance state).
    const reservedState = this.ds.getSketch(this.sketchId)
      ?.instances?.[entry.instance_key]?.state as Record<string, unknown> | undefined;
    const bypass = isDeviceOff(reservedState);
    const opacity = typeof reservedState?.__opacity__ === 'number'
      ? reservedState!.__opacity__ as number : 1;
    const blendMode = typeof reservedState?.__blend__ === 'number'
      ? reservedState!.__blend__ as number : 0;
    const optionsOpen = this.effectOptionsOpen.has(entry.instance_key);

    // Register as selectable with inspector content
    this.registerEffectSelectable(effectPath, chainIdx, entry);

    // Select on pointerdown — happens before drag threshold is reached, so
    // the card is selected whether the user intended to click or drag.
    // Cmd/ctrl-click toggles multi-selection membership; shift-click extends a
    // range from the primary selection (surfaces without multi-select fall
    // back to plain select). Plain click collapses any group to this card.
    const isGroupGesture = (e: PointerEvent) => e.metaKey || e.ctrlKey || e.shiftKey;
    const selectOnPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('smart-input')) return;
      if ((e.metaKey || e.ctrlKey) && this.ctl.toggleSelectEffect) {
        this.ctl.toggleSelectEffect(effectPath);
      } else if (e.shiftKey && this.ctl.rangeSelectEffect) {
        this.ctl.rangeSelectEffect(effectPath);
      } else if (this.ctl.isEffectInGroup?.(effectPath)) {
        // Plain click on a card already in a 2+ group: keep the group intact so
        // a drag moves the whole group. The host-driven drag collapses to just
        // this card if it turns out to be a click, not a drag (see
        // onCardPointerDown's cancel handler).
      } else {
        this.ctl.select(effectPath);
      }
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
              if (isEditingType) return;
              // Group-selection gestures never start a drag — a cmd-click that
              // wiggles a few pixels must not reorder the card it just toggled.
              if (isGroupGesture(e)) return;
              // Self-contained reorder (arrangement) vs. host-driven drag (IDE).
              if (this.ds.caps.reorder) this.beginCardDrag(e, chainIdx);
              else this.callbacks?.onCardPointerDown(e, this.sketchId, this.colIdx, chainIdx);
            }}
            @dblclick=${(e: Event) => this.onHeaderDblClick(e, entry)}>
            <button
              class="device-bypass-btn"
              title=${bypass ? 'Device off — click to enable' : 'Device on — click to bypass'}
              style="margin-right:6px;background:none;border:none;cursor:pointer;font-size:13px;line-height:1;padding:0 4px;opacity:${bypass ? 0.5 : 1};color:${bypass ? 'var(--app-text-color2)' : 'var(--app-text-color1)'}"
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${(e: Event) => {
                e.stopPropagation();
                this.ctl.setEffectParam(this.sketchId, this.colIdx, chainIdx, '__enable__', bypass);
              }}>⏻</button>
            ${this.renderEffectGlyph(entry.module_type)}
            <div class="effect-card-name-wrapper" style=${isEditingType ? 'flex:1' : 'flex:0 1 auto'}>
              ${isEditingType ? html`
                <smart-input
                  .effects=${this.ds.availableEffects}
                  .initialValue=${this.insertCtx ? (this.insertCtx.prefill ?? '') : entry.module_type}
                  .autoSelect=${true}
                  @preview=${(e: CustomEvent) => this.handleTypePreview(chainIdx, session, e.detail)}
                  @commit=${(e: CustomEvent) => this.handleTypeCommit(chainIdx, session, e.detail)}
                  @delete-request=${() => this.handleTypeDeleteRequest(chainIdx, session)}
                  @cancel=${(e: CustomEvent) => this.handleTypeCancel(chainIdx, session, e.detail)}
                ></smart-input>
              ` : html`
                <span class="effect-card-name"
                  @dblclick=${(e: Event) => { e.stopPropagation(); this.beginEditType(chainIdx); }}
                  title=${entry.module_type}
                >${this.effectDisplayName(entry.module_type)}</span>
              `}
            </div>
            <scalar-slider
              class="device-opacity-slider"
              title=${`Opacity ${Math.round(opacity * 100)}%`}
              style="margin-left:auto;width:64px"
              .fieldPath=${'__opacity__'}
              .min=${0} .max=${1} .step=${0.01} .defaultValue=${1}
              .binding=${this.deviceBinding(chainIdx, entry)}
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${(e: Event) => e.stopPropagation()}
            ></scalar-slider>
            <button
              class="device-gear-btn"
              title=${blendMode !== 0
                ? `Effect options — blend: ${BLEND_MODE_NAMES[blendMode] ?? blendMode}`
                : 'Effect options'}
              ?data-active=${optionsOpen || blendMode !== 0}
              @pointerdown=${(e: Event) => e.stopPropagation()}
              @click=${(e: Event) => {
                e.stopPropagation();
                const k = entry.instance_key;
                if (this.effectOptionsOpen.has(k)) this.effectOptionsOpen.delete(k);
                else this.effectOptionsOpen.add(k);
                this.requestUpdate();
              }}><ui-icon icon="la-cog"></ui-icon></button>
          </div>
          ${optionsOpen ? html`
            <div class="effect-card-options">
              <field-tab-bar
                .fieldPath=${'__blend__'}
                .label=${'Blend'}
                .options=${BLEND_MODE_OPTIONS}
                .defaultValue=${0}
                ?wrap=${true}
                .binding=${this.deviceBinding(chainIdx, entry)}
              ></field-tab-bar>
            </div>
          ` : nothing}
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

  /**
   * Leading glyph for an effect-card header: the effect's own declared icon (or
   * base64 thumbnail), sanitized and tinted with the category accent — falling
   * back to the plain category dot when it declares neither. Mirrors the
   * smart-input picker so a card and its autocomplete row read identically.
   */
  private renderEffectGlyph(moduleType: string) {
    const domain = effectDomain(moduleType);
    const eff = this.ds.availableEffects?.find(e => e.id === moduleType);
    const thumb = thumbnailDataUri(eff?.thumbnail);
    if (thumb) {
      return html`<img class="effect-glyph effect-thumb" src=${thumb} alt="" title=${domain}>`;
    }
    const icon = sanitizeIconName(eff?.icon);
    if (icon) {
      return html`<ui-icon class="effect-glyph" icon=${icon} title=${domain}
        style=${`--icon-color:${categoryColor(domain)};--icon-size:13px`}></ui-icon>`;
    }
    return html`<span class="effect-cat-dot" title=${domain}
      style="background:${categoryColor(domain)}"></span>`;
  }

  /** Open the smart-input for a chain entry. */
  beginEditType(chainIdx: number) {
    this.finishPendingEdit();
    this.editingTypeChainIdx = chainIdx;
    this.editSession++;
    this.requestUpdate();
  }

  /**
   * Resolve any currently-open type-edit session before starting a new one —
   * an abandoned retype reverts to its original type, an abandoned insertion
   * backs out. Without this, starting a second session while the first is
   * still live would leave `typeLongEdit`/`insertCtx` pointing at only the
   * newer one, orphaning the first edit's preview in the live document.
   */
  private finishPendingEdit() {
    if (this.insertCtx && this.typeLongEdit) this.ctl.cancelInsertEffect(this.typeLongEdit);
    else if (this.typeLongEdit) this.ctl.cancelChangeEffectType(this.typeLongEdit);
    this.typeLongEdit = null;
    this.insertCtx = null;
    this.editingTypeChainIdx = -1;
  }

  private handleTypePreview(chainIdx: number, session: number, effectId: string) {
    if (session !== this.editSession) return; // stale — a newer session has since begun
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

  private handleTypeCommit(chainIdx: number, session: number, effectId: string) {
    if (session !== this.editSession) return;
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
   * Escape always abandons the edit: for a fresh insertion this backs it out
   * entirely (the placeholder is removed, no undo point); for an existing
   * effect it reverts to the original type. Clicking away (blur) is softer —
   * for a fresh insertion it ACCEPTS whatever type is currently set (even the
   * category's untouched default), landing one "Add <type>" undo point;
   * for an existing effect it still reverts, same as Escape.
   */
  private handleTypeCancel(chainIdx: number, session: number, reason: 'escape' | 'blur') {
    if (session !== this.editSession) return;
    if (reason === 'blur' && this.insertCtx && this.typeLongEdit) {
      this.typeLongEdit.accept();
    } else if (this.insertCtx && this.typeLongEdit) {
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
  private handleTypeDeleteRequest(chainIdx: number, session: number) {
    if (session !== this.editSession) return;
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
    const plugin = this.ds.getPlugin(entry.module_type, entry.instance_key);
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
    const plugin = this.ds.getPlugin(entry.module_type, entry.instance_key);
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
    const schema = this.ds.getPlugin(entry.module_type, entry.instance_key)?.schema ?? {};

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
          @click=${(e: Event) => this.onTapOverlayClick(key, fieldPath, isOutput, schemaDef, chainIdx, e)}></div>
      `);
    }

    // Engine-reserved header controls (power ⏻ + opacity) as wire/lane DESTS.
    // They aren't schema fields — no layoutManager key — so measure their DOM
    // rects directly and attach a synthetic [0,1] float schemaDef (the executor
    // folds `__` dests through its own opacity/enable decisions).
    {
      const headerEl = innerEl.querySelector('.effect-card-header') as HTMLElement | null;
      const base = innerEl.getBoundingClientRect();
      const pushReserved = (el: HTMLElement | null, fieldPath: string) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const key = `${keyPrefix}${fieldPath}`;
        const schemaDef = RESERVED_FIELD_DEFS[fieldPath];
        this.registerFieldSelectable(key, chainIdx, entry, fieldPath, false);
        hits.push(html`
          <div class="tap-overlay-hit" ?selected=${selectedPath === key}
            data-sketch-id=${this.sketchId}
            data-col-idx=${this.colIdx}
            data-chain-idx=${chainIdx}
            data-field-path=${fieldPath}
            data-is-output="false"
            style="top:${r.top - base.top}px;left:${r.left - base.left}px;width:${r.width}px;height:${r.height}px"
            @pointerdown=${(e: PointerEvent) => this.onTapHitPointerDown(
              e, key, fieldPath, false, schemaDef, chainIdx)}
            @click=${(e: Event) => this.onTapOverlayClick(key, fieldPath, false, schemaDef, chainIdx, e)}></div>
        `);
      };
      pushReserved(headerEl?.querySelector('.device-bypass-btn') ?? null, '__enable__');
      pushReserved(headerEl?.querySelector('.device-opacity-slider') ?? null, '__opacity__');
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
    // a competing drag whose pointerup would cancel/clear it before the click can
    // land the connection. Let onTapOverlayClick complete it. STOP PROPAGATION so the
    // pointerdown doesn't reach the document `onDocDown` (which would cancel the
    // gesture) NOR the arrangement clip's pointerdown (which would deselect + re-render,
    // destroying this hit before its click fires) — that's why click-to-connect was
    // broken within a clip's sketch in the arrangement.
    if (this.taps.state) { e.stopPropagation(); return; }
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
    e?: Event,
  ) {
    // Swallow the synthetic click that trails a drag-to-connect gesture.
    if (this.taps.consumeClickSuppression()) return;
    // If a connect gesture is in flight, this click lands the connection here. Stop it
    // bubbling so it doesn't also deselect the arrangement clip after connecting. Pass
    // the STRUCTURED target info (not the re-parsed key) so a slashed sketchId — the
    // arrangement's `clip/<track>/<clip>` — resolves correctly.
    if (this.taps.state) {
      e?.stopPropagation();
      const rect = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
      this.taps.completeOnField(key, {
        sketchId: this.sketchId, colIdx: this.colIdx, chainIdx, fieldPath, isOutput,
        viewportY: rect ? rect.top + rect.height / 2 : 0, schemaDef,
      });
      return;
    }
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

    const plugin = this.ds.getPlugin(entry.module_type, entry.instance_key);

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
    const body = inspector(binding);
    // Click-to-select a field (arrangement automation): a click anywhere on a
    // field row selects it via the field editor's `fieldPath`. Dragging a slider
    // doesn't fire a click, so value edits are unaffected.
    if (this.ds.caps.fieldClickSelect) {
      return html`<div @click=${(e: Event) => this.onFieldRowClick(e, chainIdx)}>${body}</div>`;
    }
    return body;
  }

  /** Resolve the field editor under a click and select its field. */
  private onFieldRowClick(e: Event, chainIdx: number) {
    const path = (e.composedPath?.() ?? []) as Array<{ fieldPath?: string }>;
    const editor = path.find((n) => typeof n?.fieldPath === 'string');
    const fieldPath = editor?.fieldPath;
    if (!fieldPath) return;
    this.ctl.selectField(`${this.sketchId}/${this.colIdx}/${chainIdx}/${fieldPath}`);
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
      // Wire-driven reserved keys (__opacity__/__enable__) record modulation
      // bands like any float field — draw them on the header controls.
      getModulation: (fieldPath: string) =>
        this.ds.modulation(entry.instance_key)?.[fieldPath] ?? null,
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
    const self = this;   // for the non-arrow helpMode getter below
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
      // Multi-edit: forward the adapter's mixed/in-use signal (absent on
      // single-target adapters, so single-clip + track cards never see it).
      isMixed: (fieldPath: string) => this.ds.fieldMixed?.(entry.instance_key, fieldPath) ?? false,
      inUseValues: (fieldPath: string) => this.ds.fieldInUse?.(entry.instance_key, fieldPath) ?? [],
      // Help text ("?" mode): the effect type keys the global override store;
      // helpMode gates visibility; local overrides live on the instance and are
      // read via the (surface-synthesized) sketch, written via the controller.
      moduleType: entry.module_type,
      get helpMode() { return self.ds.helpMode; },
      getHelp: (slotPath: string) => {
        const sketch = this.ds.getSketch(this.sketchId);
        return sketch?.instances?.[entry.instance_key]?.help?.[slotPath];
      },
      setHelp: (slotPath: string, patch: { scope?: 'global' | 'local'; text?: string }) => {
        this.ctl.setInstanceHelp(this.sketchId, entry.instance_key, slotPath, patch);
      },
      // The effect-authored default lives ONCE in the schema: a group's help
      // (`@group/<id>`) or a help field's default. Custom inspectors reference
      // slot paths and let this resolve the text (no re-typed duplication).
      helpDefault: (slotPath: string) => {
        if (slotPath.startsWith('@group/')) {
          const gid = slotPath.slice('@group/'.length);
          const h = plugin?.groups?.[gid]?.help;
          return typeof h === 'string' ? h : undefined;
        }
        const d = (plugin?.schema as any)?.[slotPath]?.default;
        return typeof d === 'string' ? d : undefined;
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

    // Collect each field def with its group id, then insert section headers on
    // group transitions in a second pass (below).
    const collected: { def: InspectorFieldDef; group?: string }[] = [];
    let curGroup: string | undefined;
    const push = (fdef: InspectorFieldDef) => collected.push({ def: fdef, group: curGroup });
    for (const [name, def] of entries) {
      const d: any = def;
      curGroup = typeof d.group === 'string' ? d.group : undefined;
      const io = d?.io ?? 0;
      // Help slots (state::Schema::helpField) — UI-only documentation, io=0.
      // Emitted before the input filter; <help-slot> self-gates on help mode.
      if (d.type === 'help') {
        push({ type: 'help', label: name, path: name,
          default: typeof d.default === 'string' ? d.default : '' });
        continue;
      }
      const isInput = !!(io & 1);
      if (!isInput) continue; // pure outputs handled by the trace-card row
      // Hidden fields are still in the schema (and still receive
      // patches / participate in rails) — we just don't render them.
      // Effects toggle visibility via state::setFieldHidden in
      // on-state-ready / on_state_patched.
      if (d.hidden) continue;
      const label = schemaFieldDisplayName(d, name);
      if (d.type === 'texture') {
        push({ type: 'placeholder', label, path: name,
          kind: 'texture', direction: 'input' });
        continue;
      }
      if (isScalarSchemaField(d)) {
        // Int fields carrying an `options` list become dropdown
        // selects (state::Schema::selectField on the C++ side).
        if (d.type === 'int' && Array.isArray(d.options) && d.options.length > 0) {
          push({
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
          push(fieldDef);
          continue;
        }
        // No legacy param row (shouldn't happen for scalars) — fall through.
      }
      // Font-family picker (state::Schema::fontField) — searchable list editor.
      if (d.type === 'font') {
        push({
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
        const dval: number[] = Array.isArray(d.default) ? (d.default as number[]) : new Array(vecCount).fill(0);
        if ((vecCount === 3 || vecCount === 4) && d.hint === 'color') {
          push({
            type: 'color', label, path: name,
            components: vecCount as 3 | 4,
            default: dval,
          });
        } else {
          push({
            type: 'vec', label, path: name,
            components: vecCount as 2 | 3 | 4,
            // Default the slider range to the vec field's natural [0,1]
            // unless the schema carries explicit min/max in the future.
            min: typeof d.min === 'number' ? d.min : 0,
            max: typeof d.max === 'number' ? d.max : 1,
            step: typeof d.step === 'number' ? d.step : 0.01,
            default: dval,
          });
        }
        continue;
      }
      push({
        type: 'placeholder', label, path: name,
        kind: schemaFieldKindLabel(d), direction: 'input',
      });
    }

    // Second pass: insert a group SECTION HEADER whenever the group changes.
    // Group display name + section help come from the schema's `groups` object.
    const groups = plugin.groups ?? {};
    const fields: InspectorFieldDef[] = [];
    let lastGroup: string | undefined;
    for (const { def: fdef, group } of collected) {
      if (group !== lastGroup) {
        if (group) {
          const gi = groups[group];
          fields.push({
            type: 'section',
            label: gi?.name ?? group,
            path: `@group/${group}`,
            help: typeof gi?.help === 'string' ? gi.help : undefined,
          });
        }
        lastGroup = group;
      }
      fields.push(fdef);
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
    // No caps/mode gate: a pip is an always-visible indicator for a field that is wired
    // or has smoothing (computed below). Wires-MODE only governs the connect gesture,
    // not whether the modulation indicator shows.
    // The pips live in the left strip; positions resolve relative to it.
    const gutterEl = this.renderRoot.querySelector(
      `.pip-strip[data-col="${this.colIdx}"]`) as HTMLElement | null;
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
            @click=${(e: PointerEvent) => this.onPipClick(e, fieldKey, i, fieldPath, entry.instance_key)}></div>
        `);
      }
    }
    return pips;
  }

  /** Click a modulation/option pip → open its options popup. A connect gesture in
   *  flight completes here (pip is a connect endpoint too). Otherwise, in the
   *  arrangement (inline arcs, no field-card system) selecting the wire on this field
   *  surfaces the floating wire-mod panel; the IDE selects the field, which surfaces
   *  its own floating field card. Smoothing-only / unwired fields select the field. */
  private onPipClick(e: PointerEvent, fieldKey: string, chainIdx: number, fieldPath: string, instanceKey: string) {
    e.stopPropagation();
    if (this.taps.state) {
      const rect = (e.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
      const ent = chainEntryAt(this.ds.getSketch(this.sketchId), chainIdx);
      const isOutput = ent?.type === 'module' ? this.getOutputFieldNames(ent).has(fieldPath) : false;
      // Carry the real schemaDef: connect-side rules read it (e.g. a device
      // wire accepts a RELAY dest — io input bit — even when isOutput).
      const schemaDef = ent?.type === 'module'
        ? (this.ds.getPlugin(ent.module_type, ent.instance_key)?.schema as any)?.[fieldPath] ?? null
        : null;
      this.taps.completeOnField(fieldKey, {
        sketchId: this.sketchId, colIdx: this.colIdx, chainIdx, fieldPath, isOutput,
        viewportY: rect ? rect.top + rect.height / 2 : 0, schemaDef,
      });
      return;
    }
    if (this.ds.caps.inlineWirePanel) {
      // Exactly one wire on the field → jump straight to its panel. Several
      // wires (stacked inputs) → fall through to the field card, which lists
      // them all with per-wire inspectors.
      const touching = (this.ds.getSketch(this.sketchId)?.wires ?? []).filter((w) =>
        (w.dest.instanceKey === instanceKey && w.dest.field === fieldPath) ||
        (w.src.instanceKey === instanceKey && w.src.field === fieldPath));
      if (touching.length === 1) {
        this.wirePanelPos = { x: e.clientX + 10, y: e.clientY };
        this.ctl.select(`wire/${this.sketchId}/${touching[0].id}`);
        return;
      }
    }
    this.ctl.selectField(fieldKey);
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
    const schema = this.ds.getPlugin(entry.module_type, entry.instance_key)?.schema ?? {};

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
  // Wire arcs (in-column overlay)
  // ========================================================================

  /** Committed wires for this sketch as {srcChain, srcField, destChain, destField}. */
  private wireConnections(sketch: Sketch): { sc: number; sf: string; dc: number; df: string; wireId: string }[] {
    const loc = new Map<string, number>();
    sketchChain(sketch).forEach((e, chi) => { if (e.type === 'module') loc.set(e.instance_key, chi); });
    const out: { sc: number; sf: string; dc: number; df: string; wireId: string }[] = [];
    for (const w of sketch.wires ?? []) {
      const sc = loc.get(w.src.instanceKey), dc = loc.get(w.dest.instanceKey);
      if (sc === undefined || dc === undefined) continue;
      out.push({ sc, sf: w.src.field, dc, df: w.dest.field, wireId: w.id });
    }
    return out;
  }

  /** Wire overlay SVG, shown in wires mode. Geometry is glued each rAF. */
  private renderWireArcs(sketch: Sketch) {
    if (!this.ds.caps.inlineWireArcs) return nothing;
    const conns = this.wireConnections(sketch);
    return html`
      <svg class="wire-lines">
        ${conns.map((cn) => {
          const wirePath = `wire/${this.sketchId}/${cn.wireId}`;
          const sel = this.ctl.isSelected(wirePath);
          return svg`<g class="wire-group">
            <path class="wire-hit" data-sc=${cn.sc} data-sf=${cn.sf} data-dc=${cn.dc} data-df=${cn.df}
              @click=${(e: PointerEvent) => { e.stopPropagation(); this.wirePanelPos = { x: e.clientX + 10, y: e.clientY }; this.ctl.select(wirePath); }}
              @dblclick=${() => this.ctl.removeWire(this.sketchId, cn.wireId)}></path>
            <path class="wire-arc ${sel ? 'selected' : ''}" data-sc=${cn.sc} data-sf=${cn.sf} data-dc=${cn.dc} data-df=${cn.df}></path>
          </g>`;
        })}
        <line class="connect-line" style="display:none"></line>
      </svg>
    `;
  }

  /** When a wire is selected, the inline mod-inspector panel (combine / curve /
   *  magnitude / envelope / scale / delay), reusing the shared wire editor. */
  private renderSelectedWirePanel(sketch: Sketch) {
    if (!this.ds.caps.inlineWirePanel) return nothing;
    const prefix = `wire/${this.sketchId}/`;
    const wire = (sketch.wires ?? []).find((w) => this.ctl.isSelected(prefix + w.id));
    if (!wire) return nothing;
    // Float the panel at the click point (a popup in place), matching the IDE's
    // floating field card, rather than pushing the column from the bottom.
    const pos = this.wirePanelPos;
    const floatStyle = pos ? `left:${pos.x}px; top:${pos.y}px` : '';
    return html`
      <div class="wire-mod-panel ${pos ? 'floating' : ''}" style=${floatStyle}
        @pointerdown=${(e: Event) => e.stopPropagation()}>
        <div class="wire-mod-head">
          <span>Wire · ${wire.src.field} → ${wire.dest.field}</span>
          <button class="wire-mod-remove" title="Remove wire"
            @click=${() => this.ctl.removeWire(this.sketchId, wire.id)}>
            <ui-icon icon="la-trash"></ui-icon>
          </button>
        </div>
        ${this.renderWireModInspector(wire)}
      </div>
    `;
  }

  /** Viewport position for the floating wire-mod popup (set on a wire click). */
  private wirePanelPos: { x: number; y: number } | null = null;

  /** Overlay-relative center of a field's connect anchor (tap-port hit, else its
   *  collapsed-card option pip). Coords relative to `base` (the SVG rect). */
  private wireFieldCenter(chainIdx: number, field: string, base: DOMRect): Pt | null {
    const sel = `.tap-overlay-hit[data-chain-idx="${chainIdx}"][data-field-path="${field}"],`
      + `.field-option-pip.connectable[data-chain-idx="${chainIdx}"][data-field-path="${field}"]`;
    const hit = this.renderRoot.querySelector(sel) as HTMLElement | null;
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.left + r.width / 2 - base.left, y: r.top + r.height / 2 - base.top };
  }

  /** Per-rAF: glue each wire arc to its field rows + draw the live rubber-band. */
  private updateWireGeometry() {
    const svgEl = this.renderRoot.querySelector('svg.wire-lines') as SVGElement | null;
    if (!svgEl) return;
    const base = svgEl.getBoundingClientRect();
    // READ then WRITE to avoid layout thrash.
    const paths = [...svgEl.querySelectorAll('path.wire-arc, path.wire-hit')] as SVGPathElement[];
    const geo = paths.map((p) => ({
      p,
      a: this.wireFieldCenter(+(p.dataset.sc ?? -1), p.dataset.sf ?? '', base),
      b: this.wireFieldCenter(+(p.dataset.dc ?? -1), p.dataset.df ?? '', base),
    }));
    for (const { p, a, b } of geo) {
      if (!a || !b) { p.style.display = 'none'; continue; }
      p.style.display = '';
      p.setAttribute('d', arcBezierPath(a, b));
    }
    // Live rubber-band line during a connect gesture.
    const line = svgEl.querySelector('line.connect-line') as SVGLineElement | null;
    const c = this.taps.state as { info?: FieldConnectInfo; pointerX: number; pointerY: number } | null;
    if (line) {
      const src = c?.info ? this.wireFieldCenter(c.info.chainIdx, c.info.fieldPath, base) : null;
      if (c && src) {
        line.style.display = '';
        line.setAttribute('x1', String(src.x));
        line.setAttribute('y1', String(src.y));
        line.setAttribute('x2', String(c.pointerX - base.left));
        line.setAttribute('y2', String(c.pointerY - base.top));
      } else {
        line.style.display = 'none';
      }
    }
  }

  // ========================================================================
  // Category insert header
  // ========================================================================

  /** The pinned chip header — one chip per effect category present, in canonical
   *  order. Clicking begins an insertion drilled into that category. */
  private renderInsertHeader(_column: SketchColumn) {
    if (!this.ds.caps.typeEditing) return nothing;
    // Category = the effect id's first segment (its taxonomy domain), the same
    // derivation the per-card dot and smart-input use — robust even when the
    // `category` meta field is '' (barrel mode hardcodes it empty).
    const ae = this.ds.availableEffects ?? [];
    const present = new Set(ae.map((e) => effectDomain(e.id)).filter(Boolean));
    const cats: string[] = CATEGORY_DOMAINS.filter((c) => present.has(c));
    for (const c of present) if (!cats.includes(c)) cats.push(c); // any extras last
    if (cats.length === 0) {
      // No effects to insert. In barrel mode this almost always means the
      // connected NanoBarrel loaded no wasm effects (stale/empty
      // Contents/Resources/wasm) — surface it instead of an empty bar.
      return html`
        <div class="insert-header insert-header--empty">
          No effects available to insert.${this.ds.barrelMode ? html`
            <span class="insert-hint">This NanoBarrel instance reported no
            effects — rebuild/redeploy its bundle's wasm.</span>` : nothing}
        </div>`;
    }
    return html`
      <div class="insert-header">
        <button
          class="cat-chip cat-chip--new"
          title="Insert an effect (pick any type) — or drag to a position"
          @pointerdown=${(e: PointerEvent) => this.onNewChipPointerDown(e)}
        >
          <ui-icon icon="la-plus"></ui-icon>
          <span>New</span>
        </button>
        ${cats.map((cat) => html`
          <button
            class="cat-chip"
            style=${`--chip:${categoryColor(cat)}`}
            title=${`Insert ${cat} effect — or drag to a position`}
            @pointerdown=${(e: PointerEvent) => this.onChipPointerDown(e, cat)}
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

  /** Placeholder effect id for a top-level ("New") insert — brightness/contrast
   *  when present (a neutral, obviously-visual default), else the first
   *  available effect. */
  private newDefaultType(): string {
    const avail = this.ds.availableEffects;
    if (avail.some((e) => e.id === CATEGORY_FALLBACK)) return CATEGORY_FALLBACK;
    return avail[0]?.id ?? CATEGORY_FALLBACK;
  }

  /**
   * Begin inserting a new effect — seeds a placeholder `defaultType` and opens
   * the smart-input primed with `prefill` (`"<category>."` to drill into a
   * category, `""` to start at the top level). The whole insertion rides one
   * long edit: Escape backs it out entirely (no undo point); clicking away or
   * committing a pick accepts the current type as a single "Add <type>" undo
   * point — see handleTypeCancel/handleTypeCommit.
   */
  private beginInsertAt(insertIdx: number, defaultType: string, prefill: string) {
    this.finishPendingEdit();
    const { edit, instanceKey } = this.ctl.beginInsertEffect(
      this.sketchId, this.colIdx, insertIdx, defaultType);
    this.typeLongEdit = edit;
    this.insertCtx = { instanceKey, insertIdx, prefill };
    this.editingTypeChainIdx = insertIdx;
    this.editSession++;
    this.ctl.select(`effect/${this.sketchId}/${this.colIdx}/${insertIdx}`);
    this.requestUpdate();
    // Bring the freshly-inserted card into view (the scroller is an ancestor).
    void this.updateComplete.then(() => {
      this.renderRoot
        .querySelector(`.effect-card[data-chain-idx="${insertIdx}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /** Insert drilled into a category (smart-input prefilled with "<category>."). */
  private insertCategoryEffectAt(category: string, insertIdx: number) {
    this.beginInsertAt(insertIdx, this.categoryDefault(category), `${category}.`);
  }

  /** Insert at the top level — the smart-input opens with the full effect list
   *  (no category drill-down) and a brightness/contrast placeholder. */
  private insertNewEffectAt(insertIdx: number) {
    this.beginInsertAt(insertIdx, this.newDefaultType(), '');
  }

  // ── Self-contained drag (caps.reorder): drag a chip to insert at a position,
  //    or drag a card header to reorder. Shows the insert cursor while dragging. ──
  private drag: {
    kind: 'card' | 'chip';
    from: number;           // card: source chainIdx; chip: -1
    category?: string;      // chip: which category (absent ⇒ top-level "New")
    topLevel?: boolean;     // chip: insert from the top level (the "New" chip)
    startX: number; startY: number;
    active: boolean;        // crossed the move threshold
    targetIdx: number;      // current insertion index under the pointer
  } | null = null;

  private onChipPointerDown(e: PointerEvent, category: string) {
    if (e.button !== 0) return;
    this.startDrag(e, { kind: 'chip', from: -1, category });
  }

  /** The top-level "New" chip — same gesture as a category chip, but the
   *  insertion opens at the top of the effect list rather than a category. */
  private onNewChipPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.startDrag(e, { kind: 'chip', from: -1, topLevel: true });
  }

  private beginCardDrag(e: PointerEvent, chainIdx: number) {
    this.startDrag(e, { kind: 'card', from: chainIdx });
  }

  private startDrag(e: PointerEvent, partial: { kind: 'card' | 'chip'; from: number; category?: string; topLevel?: boolean }) {
    this.drag = { ...partial, startX: e.clientX, startY: e.clientY, active: false, targetIdx: -1 };
    const move = (ev: PointerEvent) => this.onDragMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.onDragUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private onDragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.active = true;
      if (d.kind === 'card') this.markDragging(d.from, true);
    }
    // Dragging a NEW effect (chip) out of the sketch column area cancels the
    // insertion — clear the target and hide the marker so a drop does nothing.
    if (d.kind === 'chip' && !this.isPointerInSketchArea(e.clientX, e.clientY)) {
      d.targetIdx = -1;
      this.hideInsertMarker();
      return;
    }
    const pts = this.getInsertionPoints();
    if (pts.length === 0) return;
    let best = pts[0];
    let bestDist = Infinity;
    for (const p of pts) {
      const dist = Math.abs(p.y - e.clientY);
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    d.targetIdx = best.insertIdx;
    const colEl = this.renderRoot.querySelector('.column') as HTMLElement | null;
    if (colEl) this.showInsertMarker(best.y - colEl.getBoundingClientRect().top);
  }

  private onDragUp(_e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    this.hideInsertMarker();
    if (d?.kind === 'card') this.markDragging(d.from, false);
    if (!d) return;
    if (!d.active) {
      // A plain click (no drag): a chip inserts at the default point; a card
      // header just selects (already handled on pointerdown).
      if (d.kind === 'chip') this.insertFromChip(d, this.computeInsertIdx());
      return;
    }
    // targetIdx stays -1 when a chip was released outside the sketch area — the
    // drag is cancelled, insert nothing.
    if (d.targetIdx < 0) return;
    if (d.kind === 'chip') {
      this.insertFromChip(d, d.targetIdx);
    } else if (d.kind === 'card' && d.from !== d.targetIdx && d.from + 1 !== d.targetIdx) {
      this.ctl.moveEffect?.(this.sketchId, this.colIdx, d.from, d.targetIdx);
    }
  }

  /** Dispatch a chip drop to the right insert flow: top-level "New" vs. a
   *  specific category. */
  private insertFromChip(d: { topLevel?: boolean; category?: string }, insertIdx: number) {
    if (d.topLevel) this.insertNewEffectAt(insertIdx);
    else if (d.category) this.insertCategoryEffectAt(d.category, insertIdx);
  }

  /** Bounding rect of the visible sketch column area (the host columns-view),
   *  used to cancel a chip drag released outside it. */
  private isPointerInSketchArea(x: number, y: number): boolean {
    const root = this.getRootNode();
    const host = root instanceof ShadowRoot ? (root.host as HTMLElement) : null;
    const rect = (host ?? this).getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  private markDragging(chainIdx: number, on: boolean) {
    const card = this.renderRoot.querySelector(`.effect-card[data-chain-idx="${chainIdx}"]`);
    if (on) card?.setAttribute('dragging', '');
    else card?.removeAttribute('dragging');
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
    const plugin = this.ds.getPlugin(entry.module_type, entry.instance_key);
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
            if (payload.kind === 'effects') {
              this.ctl.insertEffectsFromClipboard?.(
                this.sketchId, this.colIdx, chainIdx + 1, payload);
              return;
            }
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
    const plugin = this.ds.getPlugin(entry.module_type, entry.instance_key);
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
   * Modulation controls for one scalar wire — the shared inspector (see
   * widgets/wire-mod-inspector.ts), bound to this column's wire ops so long
   * edits route through the ColumnController seam (the arrangement supplies
   * a different adapter).
   */
  private renderWireModInspector(wire: Wire) {
    const sId = this.sketchId, wireId = wire.id;
    const binding = wireModBinding(`wire/${sId}/${wireId}`, {
      getWire: () => this.ds.getSketch(sId)?.wires?.find(w => w.id === wireId),
      updateWire: (patch) => this.ctl.updateWire(sId, wireId, patch),
      beginUpdateWire: (patch) => this.ctl.beginUpdateWire(sId, wireId, patch),
      updateUpdateWire: (edit, patch) => this.ctl.updateUpdateWire(edit, sId, wireId, patch),
    });
    return renderWireModInspector(wire, binding);
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
