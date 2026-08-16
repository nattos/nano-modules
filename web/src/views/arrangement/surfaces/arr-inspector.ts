/**
 * <arr-inspector> — content depends on the active right tab:
 *   inspector → the current selection (clip / track / rail / multi)
 *   settings  → composition settings + app-wide settings (combined list)
 *   export    → offline (Precise) render options
 *
 * Mockup: editors are representative; field values aren't deeply wired.
 */

import { html, css, nothing, TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store, paths } from '../state/store';
import { libraryPaths, type LibraryPath } from '../../../state/library-paths';
import {
  handlesFromDataTransfer,
  isElectron,
  showDirectoryPicker,
  type PathsDirectoryHandle,
} from '../../../state/paths';
import { sequenceLaneOf, sequenceInteriorBeats, clipProcessesTexture, clipTransportDriven, clipHasTransportSection, resolveSourceTransform, sceneChannelAssignments, BLEND_MODE_NAMES, type Clip, type Track, type ExportResolutionMode, type ExportFpsMode } from '../model/composition';
import './source-transform-widget';
import './arr-mixer-strip';
import './arr-debug';
import { ArrColumnAdapter, clipTarget, trackTarget, transportTarget, trackTransportTarget, multiClipTarget, buildClipFieldBinding, buildMultiDashBinding, type DeviceTarget } from './arr-column-adapter';
import { multiSketchId } from '../state/multi-edit';
import { catalogEffect } from '../engine/effect-catalog';
import { exportController } from '../engine/export-controller';
import { renderPlayModeControls, playModeControlsStyles } from './play-mode-controls';
import type { FieldBinding } from '../../../widgets/field-editor';
import type { ColumnGroupCallbacks } from '../../../widgets/column-group';
import { editorRegistry } from '../../../editor-registry';
import '../../../editors/all-inspectors'; // self-registering custom inspectors (envelope, adsr, …)
import '../../../widgets/column-group';
import '../../../widgets/ui-icon';
import '../../../widgets/editable-label';
import type { EditableLabel } from '../../../widgets/editable-label';
import '../../../widgets/editable-number';
import '../../../widgets/scalar-knob';
import '../../../widgets/spark-chart';

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", "4w ago". */
function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  const w = d / 7;
  if (w < 5) return `${Math.round(w)}w ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/**
 * Per-selection inspector scroll memory: when you re-select a thing, its panel
 * restores where you'd left it scrolled. Keyed by the selection path
 * (`clip/<trk>/<clip>`, `track/<id>`, `rail/<id>`). An insertion-ordered Map acts
 * as an LRU — re-touching a key moves it to the end; the oldest is evicted past
 * the cap. Module-level so it survives the (singleton) inspector's re-renders.
 */
const SCROLL_MEMORY_N = 64;
const inspectorScrollMemory = new Map<string, number>();
function rememberInspectorScroll(path: string, top: number) {
  inspectorScrollMemory.delete(path);
  inspectorScrollMemory.set(path, top);
  while (inspectorScrollMemory.size > SCROLL_MEMORY_N) {
    const oldest = inspectorScrollMemory.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    inspectorScrollMemory.delete(oldest);
  }
}

@customElement('arr-inspector')
export class ArrInspector extends MobxLitElement {
  /** One ColumnAdapter per device-list target (clip/track), stable across re-renders. */
  private columnAdapters = new Map<string, ArrColumnAdapter>();
  private adapterFor(target: DeviceTarget): ArrColumnAdapter {
    let a = this.columnAdapters.get(target.id);
    if (!a) {
      a = new ArrColumnAdapter(target);
      this.columnAdapters.set(target.id, a);
    }
    return a;
  }
  /** Custom inspector elements (envelope, adsr, …) cached by engine instance key,
   *  re-bound each render — mirrors edit-tab's getInspectorElement. The binding
   *  passed in is whatever the active panel built: a single-clip binding OR the
   *  multi-edit fan-out binding (which reports isMixed/inUseValues), so custom
   *  editors get multi-clip fan-out for free and can opt into mixed indication. */
  private inspectorCache = new Map<string, HTMLElement & { moduleType?: string; binding?: FieldBinding }>();
  /** column-group callbacks (instance-scoped so the inspector cache lives here).
   *  Shared by the clip / track / multi panels — one cache, keyed by the unique
   *  engine instance key. */
  private columnCallbacks: ColumnGroupCallbacks = {
    onCardPointerDown: () => {},
    getInspectorElement: (instanceKey: string, moduleType: string, binding: FieldBinding): HTMLElement | null => {
      const factory = editorRegistry.getInspectorFactory(moduleType);
      if (!factory) return null;
      let el = this.inspectorCache.get(instanceKey);
      // The same key may host a different module type after a retype — rebuild.
      if (el && el.moduleType !== moduleType) {
        editorRegistry.getInspectorFactory(el.moduleType ?? '')?.destroy(el);
        this.inspectorCache.delete(instanceKey);
        el = undefined;
      }
      if (!el) {
        el = factory.create(instanceKey, binding) as HTMLElement & { moduleType?: string; binding?: FieldBinding };
        el.moduleType = moduleType;
        this.inspectorCache.set(instanceKey, el);
      } else {
        el.binding = binding; // rebind (single ⇄ multi panel, or live binding swap)
      }
      return el;
    },
    // Multi-edit only: a collapsed "N other effects" row in a gap that holds
    // ragged (non-common) effects. Selectable into chainFocusPath; Backspace
    // then fans the delete out across the selected clips (deleteMultiRaggedGap).
    renderInterstitial: (sketchId: string, gapIndex: number): TemplateResult | null => {
      if (!sketchId.startsWith('multi/')) return null;
      const target = this.multiTargets.get(sketchId);
      const seg = target?.raggedSegments?.().find((s) => s.gapIndex === gapIndex);
      if (!seg || seg.count === 0) return null;
      const path = `other/${sketchId}/${gapIndex}`;
      const sel = store.chainFocusPath === path;
      // Rendered inside column-group's shadow root → inline styles (the --app-*
      // custom props pierce the boundary; class rules in arr-inspector wouldn't).
      const style = [
        'margin:3px 10px', 'padding:5px 10px', 'border-radius:4px',
        'border:1px dashed ' + (sel ? 'var(--app-hi-color2)' : 'var(--app-tint-4)'),
        'background:' + (sel ? 'var(--app-tint-3)' : 'transparent'),
        'color:' + (sel ? 'var(--app-hi-color2)' : 'var(--app-text-color2)'),
        'font-size:var(--app-fs-xs)', 'text-align:center', 'cursor:pointer',
      ].join(';');
      return html`<div
        class="other-effects"
        style=${style}
        title="Effects present on only some of the selected clips. Select + ⌫ to remove them."
        @click=${(e: Event) => { e.stopPropagation(); store.setChainFocus(path); }}
      >⋯ ${seg.count} other effect${seg.count === 1 ? '' : 's'} (not shared)</div>`;
    },
  };

  /** Stable per device-field-source FieldBinding for the dashboard widgets. */
  private dashBindings = new Map<string, FieldBinding>();
  private dashBindingFor(trackId: string, clipId: string, deviceId: string): FieldBinding {
    const key = `${trackId}/${clipId}/${deviceId}`;
    let b = this.dashBindings.get(key);
    if (!b) {
      b = buildClipFieldBinding(trackId, clipId, deviceId);
      this.dashBindings.set(key, b);
    }
    return b;
  }
  static styles = [playModeControlsStyles, css`
    :host {
      display: block;
      overflow-y: auto;
      color: var(--app-text-color1);
      font-size: var(--app-fs-md);
    }
    .section-header {
      font-size: var(--app-fs-sm);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--app-text-color2);
      padding: var(--app-sp-4) var(--app-sp-5) var(--app-sp-2);
      border-bottom: 1px solid var(--app-tint-2);
    }
    .body {
      padding: var(--app-sp-4) var(--app-sp-5);
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-4);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--app-sp-4);
      min-height: 22px;
    }
    .row label {
      color: var(--app-text-color2);
      font-size: var(--app-fs-sm);
    }
    .row .val {
      color: var(--app-text-color1);
      font-variant-numeric: tabular-nums;
    }
    input,
    select {
      font-family: inherit;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 3px var(--app-sp-3);
      max-width: 130px;
    }
    editable-number.num {
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      width: 64px;
      --editable-text-pad: 3px var(--app-sp-3);
    }
    .group-title {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      margin-top: var(--app-sp-3);
      border-top: 1px solid var(--app-tint-2);
      padding-top: var(--app-sp-3);
    }
    .auto-block {
      padding: 4px 0 8px;
    }
    .auto-name {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      padding: 2px 0 4px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .chip {
      font-size: var(--app-fs-xs);
      padding: 2px 6px;
      border-radius: 2px;
      background: var(--app-tint-2);
    }
    .chip.mod {
      color: var(--app-cat-mod);
    }
    .tag {
      display: inline-block;
      font-size: var(--app-fs-xs);
      padding: 1px 6px;
      border-radius: 2px;
      background: var(--app-tint-3);
      color: var(--app-text-color2);
    }
    .empty {
      padding: var(--app-sp-6);
      color: var(--app-text-color2);
      opacity: 0.7;
      line-height: 1.6;
    }
    .dash-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 6px 4px 2px;
    }
    .dnode {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      width: 46px;
    }
    .dnode .fpip {
      position: absolute;
      top: -3px;
      left: 2px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      cursor: pointer;
      border: 1px solid var(--app-bg-color2);
      z-index: 1;
    }
    .dnode .fpip.in {
      background: var(--app-io-input);
    }
    .dnode .fpip.out {
      background: var(--app-io-output);
    }
    .dnode .knob {
      width: 30px;
      height: 30px;
    }
    .dnode .spark {
      width: 42px;
      height: 16px;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-io-output);
      border-radius: 2px;
    }
    .dnode .dlabel {
      font-size: 8px;
      color: var(--app-text-color2);
      max-width: 46px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dash-empty {
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      opacity: 0.6;
      padding: 2px 4px;
    }
    .btn {
      font-family: inherit;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .btn.primary {
      border-color: var(--app-hi-color2);
      color: var(--app-hi-color2);
    }
    .btn[disabled] { opacity: 0.5; cursor: default; }
    .muted { color: var(--app-text-color2); font-size: var(--app-fs-sm); }
    .err { color: var(--app-hi-color1); font-size: var(--app-fs-sm); white-space: pre-wrap; }
    .exp-progress { height: 6px; border-radius: 3px; overflow: hidden; background: var(--app-tint-3); margin-top: 8px; }
    .exp-progress > i { display: block; height: 100%; background: var(--app-hi-color2); transition: width 0.1s linear; }
    .ws-toolbar {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .ws-cur {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      margin-bottom: 6px;
    }
    .ws-cur .folder {
      color: var(--app-text-color1);
    }
    .ws-dir {
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      margin: 8px 0 2px;
      letter-spacing: 0.02em;
    }
    .transport-head { margin-top: 4px; }
    /* The transport chain sits MID-PANEL (play mode + the rest follow it), so it
       must NOT take the main chain's scroll-past-the-end pad below — that 40vh gap
       pushed everything under it below the fold. Needs the element+both-classes
       specificity to beat the column-group.chain rule regardless of order. */
    column-group.chain.transport-chain { margin-bottom: 6px; }
    /* The play-mode block is the FALLBACK while a transport controller drives —
       visible but visually secondary. */
    .transport-overridden .dimmed { opacity: 0.45; }
    column-group.chain {
      display: block;
      margin-bottom: 40vh;
    }
    .chain-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .src-missing { color: var(--app-error, #e0564a); font-weight: 600; }
    /* Multi-edit "other wires/rails" badges — the ragged-tally analog of the
       "other effects" row. Selectable into chainFocusPath; ⌫ fans out removal. */
    .other-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: -2px 0 2px;
    }
    .other-badge {
      font: inherit;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
      background: var(--app-tint-2);
      border: 1px dashed var(--app-tint-4);
      border-radius: 3px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .other-badge:hover { background: var(--app-tint-3); }
    .other-badge.sel {
      color: var(--app-hi-color2);
      border-color: var(--app-hi-color2);
      border-style: solid;
      background: var(--app-tint-3);
    }
    /* Enum tab bar: one connected control, segments sharing 1px dividers, the
       active one marked by a subtle raised tint + an accent underline (no bright
       fill). The outer border + radius + overflow:hidden round the whole group. */
    .seg {
      display: inline-flex;
      gap: 0;
      border: 1px solid var(--app-tint-4);
      border-radius: 4px;
      overflow: hidden;
      background: var(--app-bg-color1);
    }
    .segbtn {
      font: inherit;
      font-size: var(--app-fs-xs);
      text-transform: capitalize;
      color: var(--app-text-color2);
      background: transparent;
      border: none;
      border-left: 1px solid var(--app-tint-4);
      padding: 3px 9px;
      cursor: pointer;
    }
    .segbtn:first-child { border-left: none; }
    .segbtn:hover { background: var(--app-tint-2); color: var(--app-text-color1); }
    .segbtn.on {
      color: var(--app-hi-color2);
      background: var(--app-tint-3);
      box-shadow: inset 0 -2px 0 var(--app-hi-color2);
    }
    /* Multi-edit: an option in use by SOME (not all) selected clips — no single
       option is "on", but every in-use one gets a muted fill so you can see the
       spread. Picking one aligns all (then it reads as a normal single value). */
    .segbtn.inuse:not(.on) {
      background: var(--app-tint-2);
      color: var(--app-text-color1);
    }
    /* Wrapping variant (the 16-mode blend selector): segments still connected, but
       the row flows onto multiple lines. */
    .seg.wrap { display: flex; flex-wrap: wrap; justify-content: center; }
    .ws-list {
      display: flex;
      flex-direction: column;
      /* No gap — entries sit flush; the parent .body gap would otherwise space them. */
    }
    .ws-file {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 6px;
      min-height: 30px;
      border-radius: 2px;
      cursor: pointer;
      color: var(--app-text-color1);
    }
    .ws-file:hover {
      background: var(--app-tint-1);
    }
    .ws-file.active {
      background: var(--app-tint-2);
      color: var(--app-hi-color2);
    }
    .ws-file > ui-icon {
      --icon-size: 13px;
      color: var(--app-text-color2);
      flex-shrink: 0;
    }
    .ws-file .ws-name {
      flex: 1;
      min-width: 0;
    }
    .ws-ago {
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      flex-shrink: 0;
      white-space: nowrap;
    }
    .ws-del {
      background: none;
      border: none;
      color: var(--app-text-color2);
      cursor: pointer;
      padding: 2px;
      border-radius: 2px;
      display: flex;
      opacity: 0;
      flex-shrink: 0;
    }
    .ws-del ui-icon {
      --icon-size: 13px;
    }
    .ws-file:hover .ws-del {
      opacity: 1;
    }
    .ws-del:hover {
      color: var(--app-err-color, #e0564f);
      background: var(--app-tint-2);
    }
    .pop-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
    }
    .lib-drop {
      border: 1px dashed transparent;
      border-radius: 3px;
      margin: 0 -4px;
      padding: 2px 4px;
      transition: border-color 0.1s, background 0.1s;
    }
    .lib-drop.over {
      border-color: var(--app-hi-color2);
      background: var(--app-tint-1);
    }
    .lib-hint {
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      line-height: 1.4;
      margin-bottom: 6px;
    }
    .lib-row {
      margin-bottom: 6px;
    }
    .lib-badge {
      font-size: var(--app-fs-xs);
      border-radius: 2px;
      padding: 0 3px;
      margin-left: 3px;
      white-space: nowrap;
    }
    .lib-badge.ok {
      color: var(--app-hi-color2);
      background: var(--app-tint-1);
    }
    .lib-badge.off {
      color: var(--app-text-color2);
      opacity: 0.5;
      text-decoration: line-through;
    }
    .lib-abs {
      display: flex;
      gap: 4px;
      align-items: center;
      margin: 2px 0 0 18px;
    }
    .lib-abs-input {
      flex: 1;
      min-width: 0;
      font-family: var(--app-font-mono, monospace);
      font-size: var(--app-fs-xs);
      color: var(--app-text-color);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-line-color);
      border-radius: 2px;
      padding: 1px 4px;
    }
    .confirm-pop {
      position: fixed;
      z-index: 41;
      width: 220px;
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 4px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
      padding: 10px;
    }
    .confirm-pop .cp-msg {
      font-size: var(--app-fs-md);
      margin-bottom: 10px;
      line-height: 1.35;
      word-break: break-word;
    }
    .confirm-pop .cp-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }
    .btn.danger {
      border-color: var(--app-err-color, #e0564f);
      color: var(--app-err-color, #e0564f);
    }
    .ws-drop-hint {
      border: 1px dashed var(--app-tint-4);
      border-radius: 3px;
      padding: 14px 10px;
      text-align: center;
      color: var(--app-text-color2);
      font-size: var(--app-fs-xs);
      margin-bottom: 10px;
    }
  `];

  @state() private rememberedLabel: string | null = null;
  /** True while a folder is dragged over the Library paths drop zone. */
  @state() private libDragOver = false;
  /** Generic confirmation popover, anchored near the click. */
  @state() private confirm:
    | { message: string; confirmLabel: string; danger: boolean; x: number; y: number; onYes: () => void | Promise<void> }
    | null = null;

  /** The key whose panel is currently displayed (for scroll memory). */
  private inspectedPath: string | null = null;

  /** The scroll-memory key for whatever the inspector currently shows. A multi-
   *  clip selection gets its OWN key (the multi target id) so scrolling the
   *  multi panel doesn't clobber the primary clip's remembered offset. */
  private inspectorKey(): string | null {
    if (store.activeRightTab !== 'inspector') return null;
    if (store.selection.size > 1) {
      const refs = store.selectedClipRefs();
      if (refs.length > 1) return multiSketchId(refs);
    }
    // Include the sequence fallback so the panel keeps its own scroll memory.
    return store.primaryPath ?? store.inspectorFallbackPath;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('scroll', this.onScroll, { passive: true });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('scroll', this.onScroll);
  }

  /** Stash the live scroll under the path currently on screen (the inspector tab
   *  only — other tabs don't participate in per-selection memory). */
  private onScroll = () => {
    if (store.activeRightTab === 'inspector' && this.inspectedPath) {
      rememberInspectorScroll(this.inspectedPath, this.scrollTop);
    }
  };

  firstUpdated() {
    // Surface a "reopen last folder" affordance (label only — re-mounting needs
    // a user gesture, which the button click provides).
    void import('../workspace/workspace-store').then(({ rememberedWorkspaceLabel }) =>
      rememberedWorkspaceLabel().then((l) => { this.rememberedLabel = l; }),
    );
    void libraryPaths.ensureLoaded();
  }

  updated() {
    // When the inspected thing changes, restore its remembered scroll (or top).
    // The prior path's offset was already captured by onScroll. Restore after a
    // frame so the new content has laid out (scrollTop clamps to scrollHeight).
    const path = this.inspectorKey();
    if (path !== this.inspectedPath) {
      this.inspectedPath = path;
      const saved = path ? inspectorScrollMemory.get(path) ?? 0 : 0;
      requestAnimationFrame(() => {
        if (this.inspectedPath === path) this.scrollTop = saved;
      });
    }
  }

  render() {
    let content: TemplateResult;
    switch (store.activeRightTab) {
      case 'workspace': content = this.renderWorkspace(); break;
      case 'settings': content = this.renderSettings(); break;
      case 'export': content = this.renderExport(); break;
      case 'debug': content = html`<arr-debug></arr-debug>`; break;
      default: content = this.renderSelection(); break;
    }
    // The confirmation popover overlays whichever tab is active.
    return html`${content}${this.renderConfirm()}`;
  }

  // ── Selection ─────────────────────────────────────────────────────────
  private renderSelection(): TemplateResult {
    const count = store.selection.size;
    if (count === 0) {
      // Nothing selected, but the clip panel's nested sequence timeline was the
      // last surface touched → show the SEQUENCE clip that owns it, so the
      // inspector isn't blank while you're editing its interior.
      const seq = store.inspectorFallbackPath;
      if (seq) return this.renderClipInspector(seq);
      return html`<div class="empty">
        Nothing selected.<br />Click a clip or track. Double-click an empty lane
        to create a clip.
      </div>`;
    }
    if (count > 1) {
      // Two or more CLIPS → the multi-edit panel (edit their common chain at
      // once). A mixed selection (clips + tracks/rails) edits only the clips.
      const refs = this.selectedClipRefs();
      if (refs.length > 1) return this.renderMultiClipInspector(refs);
      return html`
        <div class="section-header">${count} items selected</div>
        <div class="body">
          <div class="row">
            <label>Selection</label
            ><span class="val">${count} objects</span>
          </div>
          <div class="empty" style="padding:0">
            Multi-select — shared edits would apply to all. Press ⌫ to delete
            selected clips.
          </div>
        </div>
      `;
    }
    const path = store.primaryPath!;
    const kind = path.split('/')[0];
    if (kind === 'clip') return this.renderClipInspector(path);
    if (kind === 'track') return this.renderTrackInspector(path);
    if (kind === 'rail') return this.renderRailInspector(path);
    return html`<div class="empty">Selected: ${path}</div>`;
  }

  /** The selected CLIPS, primary-first (the store owns the truth — see
   *  store.selectedClipRefs). */
  private selectedClipRefs(): { trackId: string; clipId: string }[] {
    return store.selectedClipRefs();
  }

  /** One multiClipTarget per selection set (stable across re-renders so its
   *  pending-insert bridge + the cached adapter survive). Keyed by the target id
   *  (which encodes the sorted clip set). */
  private multiTargets = new Map<string, DeviceTarget>();
  private multiTargetFor(refs: { trackId: string; clipId: string }[]): DeviceTarget {
    const id = multiSketchId(refs);
    let t = this.multiTargets.get(id);
    if (!t) { t = multiClipTarget(refs); this.multiTargets.set(id, t); }
    return t;
  }

  private renderMultiClipInspector(
    refs: { trackId: string; clipId: string }[],
  ): TemplateResult {
    const target = this.multiTargetFor(refs);
    // The concrete selected clips, for plain-field aggregation. A field that all
    // clips agree on renders as the single value; one that differs shows “many”
    // (mirroring the single-clip inspector's rows as closely as possible).
    const clips = refs
      .map((r) => store.trackById(r.trackId)?.clips.find((c) => c.id === r.clipId))
      .filter((c): c is NonNullable<typeof c> => !!c);
    const agg = <T,>(vals: T[]): { mixed: boolean; value: T | undefined; inUse: T[] } => {
      const inUse: T[] = [];
      for (const v of vals) if (!inUse.some((u) => u === v)) inUse.push(v);
      return { mixed: inUse.length > 1, value: vals[0], inUse };
    };
    const nameAgg = agg(clips.map((c) => c.name));
    const kindAgg = agg(clips.map((c) => c.kind));
    const processesAgg = agg(clips.map((c) => clipProcessesTexture(c)));
    const clip0 = clips[0];
    const sourceClips = clips.filter((c) => !!c.source);
    // Source label: include clips WITHOUT a source (as undefined) so a ragged
    // mix of has-source / no-source also reads as “many”.
    const sourceAgg = agg(clips.map((c) => c.source?.label));
    const scaleAgg = agg(sourceClips.map((c) => c.source?.scaleMode ?? 'fit'));
    const c0scale = clip0?.source?.scaleMode ?? 'fit';
    const showPlacement = !!clip0?.source && (['fit', 'cover', 'none'] as const).includes(c0scale as any);

    const raggedWires = target.raggedWireCount?.() ?? 0;
    const raggedRails = target.raggedRailCount?.() ?? 0;
    const badge = (path: string, n: number, label: string, title: string) => {
      const sel = store.chainFocusPath === path;
      return html`<button
        class="other-badge ${sel ? 'sel' : ''}"
        title=${title}
        @click=${(e: Event) => { e.stopPropagation(); store.setChainFocus(path); }}
      >${n} ${label}${n === 1 ? '' : 's'} (not shared)</button>`;
    };
    return html`
      <div class="section-header">
        ${refs.length} clips ·
        <editable-label
          .value=${nameAgg.mixed ? '' : nameAgg.value ?? ''}
          .displayValue=${nameAgg.mixed ? '' : nameAgg.value ?? ''}
          placeholder=${nameAgg.mixed ? 'many — rename all' : 'Untitled clip'}
          @commit=${(e: CustomEvent) => store.renameClips(refs, e.detail)}
        ></editable-label>
      </div>
      <div class="body">
        <div class="row">
          <label>Kind</label>
          <span class="val">
            <span class="tag">${kindAgg.mixed ? 'many' : kindAgg.value}</span>
            <span class="tag">${processesAgg.mixed ? 'many' : (processesAgg.value ? 'processes frames' : 'modulation-only')}</span>
          </span>
        </div>
        ${clip0
          ? renderPlayModeControls(
              clip0.loop,
              clip0.source && clip0.source.fps ? clip0.source.durationFrames / clip0.source.fps : 0,
              (patch) => store.updateClipsLoop(refs, patch),
              store.composition.meta.timeSignature[0],
            )
          : ''}
        ${sourceClips.length
          ? html`<div class="row">
              <label>Source</label>
              <span class="val">${sourceAgg.mixed ? 'many' : sourceAgg.value}</span>
            </div>`
          : ''}
        ${sourceClips.length
          ? html`<div class="row">
              <label>Scale</label>
              <span class="val seg">
                ${(['fit', 'cover', 'stretch', 'none'] as const).map(
                  (m) => html`<button
                    class="segbtn ${!scaleAgg.mixed && scaleAgg.value === m ? 'on' : ''} ${scaleAgg.inUse.includes(m) ? 'inuse' : ''}"
                    @click=${() => store.setClipsScaleMode(refs, m)}
                  >${m}</button>`,
                )}
              </span>
            </div>`
          : ''}
        ${showPlacement && clip0?.source
          ? html`<div class="row">
              <label>Placement</label>
              <span class="val" style="flex:1; min-width:0;">
                <source-transform-widget
                  .canvasW=${store.composition.meta.resolution.width}
                  .canvasH=${store.composition.meta.resolution.height}
                  .videoW=${clip0.source.width ?? 0}
                  .videoH=${clip0.source.height ?? 0}
                  .srcUrl=${clip0.source.url ?? ''}
                  .mode=${c0scale}
                  .transform=${resolveSourceTransform(clip0.source.transform)}
                  .onChange=${(patch: any, ck?: string) => store.setClipsSourceTransform(refs, patch, ck)}
                ></source-transform-widget>
              </span>
            </div>`
          : ''}
        ${this.renderMultiDashboard(target, () => this.multiClipsFor(refs))}
        <div class="group-title chain-hdr"><span>Chain (common)</span></div>
        ${raggedWires > 0 || raggedRails > 0
          ? html`<div class="other-badges">
              ${raggedWires > 0
                ? badge(`otherwires/${target.id}`, raggedWires, 'other wire',
                    'Modulation wires present on only some of the selected clips. Select + ⌫ to remove them.')
                : ''}
              ${raggedRails > 0
                ? badge(`otherrails/${target.id}`, raggedRails, 'other rail',
                    'Return-track modulations present on only some of the selected clips. Select + ⌫ to remove them.')
                : ''}
            </div>`
          : ''}
        <column-group
          class="chain"
          .colIdx=${0}
          .sketchId=${target.id}
          .columnWidth=${280}
          .adapter=${this.adapterFor(target)}
          .callbacks=${this.columnCallbacks}
        ></column-group>
      </div>
    `;
  }

  /** The clip's TRANSPORT section: the section's own effect card (palette
   *  restricted to transport controllers). Overrides the play mode below
   *  while it holds a controller; an empty card is the add affordance. */
  private renderTransportSection(trackId: string, clip: Clip) {
    const driven = clipTransportDriven(clip);
    const sectioned = clipHasTransportSection(clip);
    const has = (clip.transport?.devices.length ?? 0) > 0;
    const target = transportTarget(trackId, clip.id);
    return html`
      <div class="row transport-head">
        <label>Transport</label>
        <span class="val">
          ${driven
            ? html`<span class="tag">drives content time</span>`
            : sectioned
              ? html`<span class="tag">follow actions</span>`
              : has
                ? html`<span class="tag">inert (no controller)</span>`
                : html`<span class="tag" style="opacity:0.6">play mode below</span>`}
        </span>
      </div>
      <column-group
        class="chain transport-chain"
        .colIdx=${0}
        .sketchId=${target.id}
        .columnWidth=${280}
        .adapter=${this.adapterFor(target)}
        .callbacks=${this.columnCallbacks}
      ></column-group>
    `;
  }

  private onDashPip(e: PointerEvent, wire: any) {
    e.stopPropagation();
    store.selectWire(wire.wireId, wire.clipPath, wire.target);
    store.openTapPopup({ wireId: wire.wireId, x: e.clientX + 8, y: e.clientY + 8, label: wire.label });
  }

  /** Catalog range + label for a clip device field (for knob/spark scaling). */
  private fieldMeta(clip: any, deviceId: string, field: string): { min: number; max: number; label: string } {
    const dev = clip.sketch.devices.find((d: any) => d.id === deviceId);
    const f = dev ? catalogEffect(dev.moduleType)?.fields.find((x) => x.key === field) : undefined;
    return { min: f?.min ?? 0, max: f?.max ?? 1, label: f?.label ?? field };
  }

  private renderDashboard(clip: any, clipPath: string): TemplateResult {
    const [, trackId, clipId] = clipPath.split('/');
    const inputs = clip.reads ?? [];
    const outputs = clip.exports ?? [];
    return html`
      <div class="group-title" style="border-top:none;margin-top:0;padding-top:0">
        Dashboard · inputs
      </div>
      <div class="dash-row">
        ${inputs.length
          ? inputs.map((r: any) => {
              const m = this.fieldMeta(clip, r.targetDeviceId, r.targetField);
              return html`<div class="dnode">
                <span class="fpip in" title=${`rail → ${m.label} (double-click to delete)`}
                  @pointerdown=${(e: PointerEvent) => this.onDashPip(e, {
                    wireId: 'r:' + r.id, dir: 'in', clipPath, target: { field: r.targetField },
                    label: `rail → ${m.label}`,
                  })}
                  @dblclick=${(e: Event) => { e.stopPropagation(); store.deleteWire('r:' + r.id); }}></span>
                <scalar-knob
                  .binding=${this.dashBindingFor(trackId, clipId, r.targetDeviceId)}
                  .fieldPath=${r.targetField} .label=${m.label}
                  .min=${m.min} .max=${m.max}></scalar-knob>
              </div>`;
            })
          : html`<div class="dash-empty">No rail inputs.</div>`}
      </div>
      <div class="group-title">Dashboard · outputs</div>
      <div class="dash-row">
        ${outputs.length
          ? outputs.map((ex: any) => {
              const m = this.fieldMeta(clip, ex.sourceDeviceId, ex.sourceField);
              return html`<div class="dnode">
                <span class="fpip out" title=${`${m.label} → rail (double-click to delete)`}
                  @pointerdown=${(e: PointerEvent) => this.onDashPip(e, {
                    wireId: 'w:' + ex.id, dir: 'out', clipPath, target: {},
                    label: `${m.label} → rail`,
                  })}
                  @dblclick=${(e: Event) => { e.stopPropagation(); store.deleteWire('w:' + ex.id); }}></span>
                <spark-chart
                  .binding=${this.dashBindingFor(trackId, clipId, ex.sourceDeviceId)}
                  .fieldPath=${ex.sourceField} .min=${m.min} .max=${m.max}
                  .width=${44} .height=${20}></spark-chart>
                <span class="dlabel">${m.label}</span>
              </div>`;
            })
          : html`<div class="dash-empty">No rail outputs.</div>`}
      </div>
    `;
  }

  /** clip[0] (the multi-edit reconciliation template) of a selection. */
  private multiClipsFor(refs: { trackId: string; clipId: string }[]) {
    const r = refs[0];
    return r ? store.trackById(r.trackId)?.clips.find((c) => c.id === r.clipId) : undefined;
  }

  /** Stable multi-edit dashboard bindings (fan-out writes), keyed per device. */
  private multiDashBindings = new Map<string, FieldBinding>();
  private multiDashBindingFor(target: DeviceTarget, getClip0: () => any, repDeviceId: string): FieldBinding {
    const key = `${target.id}/${repDeviceId}`;
    let b = this.multiDashBindings.get(key);
    if (!b) { b = buildMultiDashBinding(target, getClip0, repDeviceId); this.multiDashBindings.set(key, b); }
    return b;
  }

  /** The multi-edit dashboard: the rail taps COMMON to every selected clip. Knob/
   *  spark edits fan out; dbl-clicking a pip removes that rail tap from ALL clips.
   *  Ragged (clip-specific) taps are tallied separately by the "other rails" badge. */
  private renderMultiDashboard(
    target: DeviceTarget, getClip0: () => any,
  ): TemplateResult {
    const clip0 = getClip0();
    const taps = clip0 ? target.commonRailTaps?.() ?? [] : [];
    const inputs = taps.filter((t) => t.kind === 'read');
    const outputs = taps.filter((t) => t.kind === 'export');
    const delTaps = (t: { kind: 'export' | 'read'; tapIdsByClip: Map<string, string> }) =>
      store.removeClipsRailTaps([...t.tapIdsByClip.values()].map((id) => ({ kind: t.kind === 'export' ? 'w' as const : 'r' as const, id })));
    return html`
      <div class="group-title" style="border-top:none;margin-top:0;padding-top:0">Dashboard · inputs</div>
      <div class="dash-row">
        ${inputs.length
          ? inputs.map((t) => {
              const m = this.fieldMeta(clip0, t.repDeviceId, t.field);
              return html`<div class="dnode">
                <span class="fpip in" title=${`rail → ${m.label} (double-click to remove from all)`}
                  @pointerdown=${(e: Event) => e.stopPropagation()}
                  @dblclick=${(e: Event) => { e.stopPropagation(); delTaps(t); }}></span>
                <scalar-knob
                  .binding=${this.multiDashBindingFor(target, getClip0, t.repDeviceId)}
                  .fieldPath=${t.field} .label=${m.label} .min=${m.min} .max=${m.max}></scalar-knob>
              </div>`;
            })
          : html`<div class="dash-empty">No shared rail inputs.</div>`}
      </div>
      <div class="group-title">Dashboard · outputs</div>
      <div class="dash-row">
        ${outputs.length
          ? outputs.map((t) => {
              const m = this.fieldMeta(clip0, t.repDeviceId, t.field);
              return html`<div class="dnode">
                <span class="fpip out" title=${`${m.label} → rail (double-click to remove from all)`}
                  @pointerdown=${(e: Event) => e.stopPropagation()}
                  @dblclick=${(e: Event) => { e.stopPropagation(); delTaps(t); }}></span>
                <spark-chart
                  .binding=${this.multiDashBindingFor(target, getClip0, t.repDeviceId)}
                  .fieldPath=${t.field} .min=${m.min} .max=${m.max} .width=${44} .height=${20}></spark-chart>
                <span class="dlabel">${m.label}</span>
              </div>`;
            })
          : html`<div class="dash-empty">No shared rail outputs.</div>`}
      </div>
    `;
  }

  /** Scene trigger channel: 'auto' assigns by position (first unassigned);
   *  an explicit number pins it (arbitrary positive ids allowed). */
  private renderSceneChannelRow(track: Track, clip: Clip): TemplateResult {
    const idx = track.clips.indexOf(clip);
    const effective = idx >= 0 ? sceneChannelAssignments(track)[idx] : 0;
    const isAuto = clip.triggerChannel == null;
    return html`<div class="row">
      <label>Channel</label>
      <span class="val seg">
        <button
          class="segbtn ${isAuto ? 'on' : ''}"
          title="Auto-assign by position (first unassigned channel)"
          @click=${() => store.setSceneChannel(track.id, clip.id, null)}
        >auto${isAuto ? ` (${effective})` : ''}</button>
        <input
          type="number"
          min="1"
          step="1"
          style="width:56px"
          .value=${String(effective)}
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const v = Number(input.value);
            if (Number.isFinite(v) && v >= 1) {
              store.setSceneChannel(track.id, clip.id, Math.round(v));
            } else {
              // Rejected input: Lit's .value dirty-check won't re-assert the
              // old value into the DOM, so reset it explicitly.
              input.value = String(effective);
            }
          }}
        />
      </span>
    </div>
    <div class="row">
      <label title="Which return track's trigger events launch this scene (wire one in wires mode)">Listen</label>
      <span class="val">
        ${clip.triggerRead
          ? html`<span class="tag">${store.railTrackFor(clip.triggerRead.railId)?.name ?? 'return'}</span>
              <button class="segbtn" title="Back to the track default / global trigger bus"
                @click=${() => store.connectTriggerListen(track.id, clip.id, clip.triggerRead!.railId)}
              >✕</button>`
          : track.triggerRead
            ? html`<span class="tag">track: ${store.railTrackFor(track.triggerRead.railId)?.name ?? 'return'}</span>`
            : html`<span class="tag" style="opacity:.7">global triggers</span>`}
      </span>
    </div>`;
  }

  /**
   * SEQUENCE clips: what's inside, how the interior lane behaves, and the
   * escape hatch. The clip's play-mode controls and transport section render
   * unchanged below — the interior IS a content stream, so looping/seeking a
   * sequence clip works exactly like looping a video.
   */
  private renderSequenceSection(trackId: string, clip: Clip): TemplateResult | typeof nothing {
    const lane = sequenceLaneOf(clip);
    if (!lane) return nothing;
    const bars = sequenceInteriorBeats(clip) / store.barBeats;
    return html`
      <div class="row">
        <label>Contents</label>
        <span class="val">
          <span class="tag">${lane.clips.length} clip${lane.clips.length === 1 ? '' : 's'}</span>
          <span class="tag">${bars.toFixed(2)} bars</span>
        </span>
      </div>
      <div class="row">
        <label>Interior</label>
        <span class="val">
          <button
            class=${lane.kind === 'track' ? 'on' : ''}
            @click=${() => store.setSequenceLaneKind(trackId, clip.id, 'track')}
            title="Timeline lane: sub-clips play by position"
          >Timeline</button>
          <button
            class=${lane.kind === 'scene' ? 'on' : ''}
            @click=${() => store.setSequenceLaneKind(trackId, clip.id, 'scene')}
            title="Scene lane: sub-clips are launchable cells"
          >Scenes</button>
        </span>
      </div>
      <div class="row">
        <label></label>
        <span class="val">
          <button
            @click=${() => { store.select(paths.clip(trackId, clip.id)); store.uncollapseSelection(); }}
            title="Break this sequence back onto the timeline (⇧⌘J)"
          >Uncollapse</button>
        </span>
      </div>
    `;
  }

  private renderClipInspector(path: string): TemplateResult {
    const found = store.clipByPath(path);
    if (!found) return html`<div class="empty">Clip not found.</div>`;
    const { clip } = found;
    const processes = clipProcessesTexture(clip);
    const isScene = found.track.kind === 'scene';
    return html`
      <div class="section-header">
        ${isScene ? 'Scene' : 'Clip'} ·
        <editable-label
          .value=${clip.name}
          .displayValue=${store.clipDisplayName(clip)}
          placeholder=${isScene ? 'Untitled scene' : 'Untitled clip'}
          @commit=${(e: CustomEvent) => store.renameClip(found.track.id, clip.id, e.detail)}
        ></editable-label>
      </div>
      <div class="body">
        <div class="row">
          <label>Kind</label>
          <span class="val">
            <span class="tag">${clip.kind}</span>
            <span class="tag"
              >${processes ? 'processes frames' : 'modulation-only'}</span
            >
          </span>
        </div>
        ${isScene ? this.renderSceneChannelRow(found.track, clip) : ''}
        ${this.renderSequenceSection(found.track.id, clip)}
        ${this.renderTransportSection(found.track.id, clip)}
        ${clipTransportDriven(clip)
          ? html`<div class="transport-overridden"
              title="A transport-controller effect drives this clip's content time; the play mode below is the fallback if the section empties.">
              <div class="dimmed">
                ${renderPlayModeControls(
                  clip.loop,
                  clip.source && clip.source.fps ? clip.source.durationFrames / clip.source.fps : 0,
                  (patch) => store.updateClipLoop(found.track.id, clip.id, patch),
                  store.composition.meta.timeSignature[0],
                )}
              </div>
            </div>`
          : renderPlayModeControls(
              clip.loop,
              clip.source && clip.source.fps ? clip.source.durationFrames / clip.source.fps : 0,
              (patch) => store.updateClipLoop(found.track.id, clip.id, patch),
              store.composition.meta.timeSignature[0],
            )}
        ${clip.source
          ? html`<div class="row">
              <label>Source</label>
              <span class="val">
                ${store.sourceMissing(clip.source.sourceKey)
                  ? html`<span class="src-missing" title="The source file could not be found or accessed (moved, deleted, or permission revoked).">⚠ missing / inaccessible</span>`
                  : clip.source.label}
              </span>
            </div>
            ${clip.source.sourceKey && store.mediaRelPaths[clip.source.sourceKey]
              ? html`<div class="row">
                  <label>Path</label>
                  <span class="val" style="opacity:0.8" title=${store.mediaRelPaths[clip.source.sourceKey]}>${store.mediaRelPaths[clip.source.sourceKey]}</span>
                </div>`
              : ''}
            <div class="row">
              <label>Scale</label>
              <span class="val seg">
                ${(['fit', 'cover', 'stretch', 'none'] as const).map(
                  (m) => html`<button
                    class="segbtn ${(clip.source?.scaleMode ?? 'fit') === m ? 'on' : ''}"
                    @click=${() => store.setClipScaleMode(found.track.id, clip.id, m)}
                  >${m}</button>`,
                )}
              </span>
            </div>
            ${(['fit', 'cover', 'none'] as const).includes((clip.source?.scaleMode ?? 'fit') as any)
              ? html`<div class="row">
                  <label>Placement</label>
                  <span class="val" style="flex:1; min-width:0;">
                    <source-transform-widget
                      .canvasW=${store.composition.meta.resolution.width}
                      .canvasH=${store.composition.meta.resolution.height}
                      .videoW=${clip.source?.width ?? 0}
                      .videoH=${clip.source?.height ?? 0}
                      .srcUrl=${clip.source?.url ?? ''}
                      .mode=${clip.source?.scaleMode ?? 'fit'}
                      .transform=${resolveSourceTransform(clip.source?.transform)}
                      .onChange=${(patch: any, ck?: string) => store.setClipSourceTransform(found.track.id, clip.id, patch, ck)}
                    ></source-transform-widget>
                  </span>
                </div>`
              : ''}`
          : ''}

        ${this.renderDashboard(clip, path)}

        <div class="group-title chain-hdr"><span>Chain (sketch)</span></div>
        <column-group
          class="chain"
          .colIdx=${0}
          .sketchId=${`clip/${found.track.id}/${clip.id}`}
          .columnWidth=${280}
          .adapter=${this.adapterFor(clipTarget(found.track.id, clip.id))}
          .callbacks=${this.columnCallbacks}
        ></column-group>

        ${clip.warps.length
          ? html`<div class="group-title">Beat warp</div>
              ${clip.warps.map(
                (w) => html`<div class="row">
                  <label>${w.waveform} · ${w.periodBeats}b</label>
                  <span class="val">amp ${w.amplitude.toFixed(2)}</span>
                </div>`,
              )}`
          : ''}

        ${clip.exports.length
          ? html`<div class="group-title">Rail exports</div>
              ${clip.exports.map((ex) => {
                const rail = store.composition.rails.find((r) => r.id === ex.railId);
                return html`<div class="row">
                  <label>→ ${rail?.name ?? ex.railId}</label>
                  <span class="val"><span class="tag">${ex.combine}</span><span class="tag">${ex.magnitude}</span></span>
                </div>`;
              })}`
          : ''}
        <!-- Clip envelopes are edited ONLY in the clip panel, not the inspector. -->
      </div>
    `;
  }

  private renderTrackInspector(path: string): TemplateResult {
    const track = store.trackById(path.split('/')[1]);
    if (!track) return html`<div class="empty">Track not found.</div>`;
    const isRail = track.kind === 'rail';
    return html`
      <div class="section-header">
        ${track.kind === 'group' ? 'Group' : isRail ? 'Return' : 'Track'} ·
        <editable-label
          .value=${track.name}
          .displayValue=${store.trackDisplayName(track)}
          placeholder=${track.kind === 'group' ? 'Untitled group' : isRail ? 'Untitled return' : 'Untitled track'}
          @commit=${(e: CustomEvent) => store.renameTrack(track.id, e.detail)}
        ></editable-label>
      </div>
      <div class="body">
        ${isRail
          ? html`<div class="row">
              <label>Range</label>
              <span class="val seg">
                ${([['Unsigned', false], ['Signed', true]] as const).map(
                  ([label, signed]) => html`<button
                    class="segbtn ${(track.railSigned ?? false) === signed ? 'on' : ''}"
                    @click=${() => store.setRailSigned(track.id, signed)}
                  >${label}</button>`,
                )}
              </span>
            </div>`
          : html`<div class="row">
              <label>Opacity</label>
              <span class="val" style="flex:1; min-width:0;">
                <arr-mixer-strip .trackId=${track.id}></arr-mixer-strip>
              </span>
            </div>
            ${track.kind === 'group' && !store.isMainBus(track)
              ? html`<div class="row">
                  <label title="What this group's children draw over, before the group's effect chain runs">Input</label>
                  <span class="val seg wrap">
                    ${(['underlying', 'transparent', 'black', 'custom'] as const).map(
                      (m) => html`<button
                        class="segbtn ${store.groupInputMode(track.id) === m ? 'on' : ''}"
                        title=${m === 'underlying' ? 'Pass-through: composite everything below the group, then run the group as an effects-only layer over it' : `Fresh ${m} base under the group's children`}
                        @click=${() => store.setGroupInput(track.id, m)}
                      >${m}</button>`,
                    )}
                    ${store.groupInputMode(track.id) === 'custom'
                      ? html`<input
                          type="color"
                          .value=${store.groupInputColor(track.id)}
                          @input=${(e: Event) => store.setGroupInput(track.id, 'custom', (e.target as HTMLInputElement).value)}
                          style="width:26px;height:22px;padding:0;border:1px solid var(--app-tint-4);background:none;cursor:pointer;margin-left:6px"
                        />`
                      : ''}
                  </span>
                </div>`
              : ''}
            <div class="row">
              <label>Blend</label>
              <span class="val seg wrap">
                ${BLEND_MODE_NAMES.map(
                  (name, i) => html`<button
                    class="segbtn ${(track.blendMode ?? 0) === i ? 'on' : ''}"
                    @click=${() => store.setTrackBlendMode(track.id, i)}
                  >${name}</button>`,
                )}
              </span>
            </div>`}
        ${isRail ? this.renderTriggerChannelNames(track) : ''}
        ${track.kind === 'scene' ? this.renderTrackTransportSection(track) : ''}
        ${isRail
          ? '' /* Returns carry no effect chain — they're value-only rails. */
          : html`<div class="group-title chain-hdr"><span>Chain (sketch)</span></div>
            <column-group
              class="chain"
              .colIdx=${0}
              .sketchId=${`track/${track.id}`}
              .columnWidth=${280}
              .adapter=${this.adapterFor(trackTarget(track.id))}
              .callbacks=${this.columnCallbacks}
            ></column-group>`}
        <!-- Track envelopes are edited ONLY on the timeline (automation lanes),
             not the inspector. -->
      </div>
    `;
  }

  /** A scene TRACK's TRANSPORT section (transition effects — e.g. Crossfade):
   *  the section's own effect card, palette restricted to transport_section
   *  effects. An empty card is the add affordance. */
  private renderTrackTransportSection(track: Track) {
    const has = (track.transport?.devices.length ?? 0) > 0;
    const target = trackTransportTarget(track.id);
    return html`
      <div class="row transport-head">
        <label>Transition</label>
        <span class="val">
          ${has
            ? html`<span class="tag">on scene launch</span>`
            : html`<span class="tag" style="opacity:0.6">cut (none)</span>`}
        </span>
      </div>
      <column-group
        class="chain transport-chain"
        .colIdx=${0}
        .sketchId=${target.id}
        .columnWidth=${280}
        .adapter=${this.adapterFor(target)}
        .callbacks=${this.columnCallbacks}
      ></column-group>
    `;
  }

  /** Per-return display names for trigger channels: 8 rows by default (plus
   *  any higher explicitly-named ids), placeholder = the numeric id. Scene
   *  badges resolve their channel label through the scene's LISTEN rail. */
  private renderTriggerChannelNames(track: Track): TemplateResult {
    const names = track.triggerChannelNames ?? {};
    const ids = new Set<number>(Array.from({ length: 8 }, (_, i) => i + 1));
    for (const k of Object.keys(names)) {
      const n = Number(k);
      if (Number.isFinite(n) && n >= 1) ids.add(n);
    }
    return html`<div class="group-title"><span>Trigger channels</span></div>
      ${[...ids].sort((a, b) => a - b).map(
        (ch) => html`<div class="row">
          <label>${ch}</label>
          <span class="val" style="flex:1; min-width:0;">
            <input
              type="text"
              style="width:100%"
              placeholder=${String(ch)}
              .value=${names[String(ch)] ?? ''}
              @change=${(e: Event) =>
                store.setTriggerChannelName(track.id, ch, (e.target as HTMLInputElement).value)}
            />
          </span>
        </div>`,
      )}`;
  }

  private renderRailInspector(path: string): TemplateResult {
    const rail = store.composition.rails.find((r) => r.id === path.split('/')[1]);
    if (!rail) return html`<div class="empty">Rail not found.</div>`;
    return html`
      <div class="section-header">Rail · ${rail.name}</div>
      <div class="body">
        <div class="row"><label>Default</label><span class="val">${rail.defaultValue}</span></div>
        <div class="row"><label>Range</label><span class="val">${rail.range.min} … ${rail.range.max}</span></div>
      </div>
    `;
  }

  // ── Settings (composition + app, combined) ────────────────────────────
  // ── Workspace (files on disk) ──────────────────────────────────────────
  private async pickFolder() {
    try {
      await store.mountFolderViaPicker();
      store.showRightTab('workspace');
    } catch (err) {
      // AbortError = user cancelled the picker; anything else is worth a note.
      if ((err as Error)?.name !== 'AbortError') console.warn('[workspace] mount failed', err);
    }
  }

  private async reopenLast() {
    if (!(await store.reopenLastWorkspace())) {
      console.warn('[workspace] could not reopen last folder (permission denied or none remembered)');
    }
  }

  private renderWorkspace(): TemplateResult {
    // Read the OBSERVABLE label/entries up front so this panel re-renders when a
    // mount completes — `store.hasWorkspace` reads the non-observable `backend`,
    // so branching on it alone would never track the mount.
    const label = store.workspaceLabel;
    const entries = store.workspaceEntries;
    const mounted = label != null;
    if (!mounted) {
      return html`
        <div class="section-header">Workspace</div>
        <div class="body">
          <div class="ws-drop-hint">
            Drag a folder here to open it as a workspace.<br />
            Arrangements are saved as <code>.nano-arr</code> files inside it.
          </div>
          <div class="ws-toolbar">
            <button class="btn primary" @click=${() => this.pickFolder()}>
              <ui-icon icon="la-folder-open"></ui-icon> Open folder…
            </button>
            ${this.rememberedLabel
              ? html`<button class="btn" @click=${() => this.reopenLast()}>
                  Reopen "${this.rememberedLabel}"
                </button>`
              : ''}
          </div>
          <div class="ws-drop-hint" style="margin-top:14px">
            Or explore a populated example (not saved to disk):
          </div>
          <div class="ws-toolbar">
            <button class="btn" @click=${() => store.loadDemoComposition()}>
              <ui-icon icon="la-play"></ui-icon> Load demo
            </button>
          </div>
        </div>
      `;
    }

    // Group the (recursively listed) files by their directory.
    const byDir = new Map<string, typeof entries>();
    for (const e of entries) {
      const arr = byDir.get(e.dir) ?? [];
      arr.push(e);
      byDir.set(e.dir, arr);
    }
    // Root first, then directories alphabetically.
    const dirs = [...byDir.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));

    return html`
      <div class="section-header">Workspace</div>
      <div class="body">
        <div class="ws-cur">
          <ui-icon icon="la-folder"></ui-icon>
          <span class="folder">${label}</span>
        </div>
        <div class="ws-toolbar">
          <button class="btn" @click=${() => store.newArrangement(`untitled-${Date.now().toString(36)}`)}>
            <ui-icon icon="la-plus"></ui-icon> New
          </button>
          <button class="btn" @click=${() => store.refreshWorkspaceList()} title="Re-scan folder">
            <ui-icon icon="la-sync"></ui-icon>
          </button>
          <button class="btn" @click=${() => this.pickFolder()} title="Switch folder">
            <ui-icon icon="la-folder-open"></ui-icon>
          </button>
        </div>
        ${entries.length === 0
          ? html`<div class="empty" style="padding:12px 0">No arrangements yet.</div>`
          : html`<div class="ws-list">
              ${dirs.map(
                (dir) => html`
                  ${dir ? html`<div class="ws-dir">${dir}/</div>` : ''}
                  ${byDir.get(dir)!.map((e) => this.renderFileRow(e))}
                `,
              )}
            </div>`}
      </div>
    `;
  }

  private renderFileRow(e: typeof store.workspaceEntries[number]): TemplateResult {
    const base = e.fileName.slice(0, -'.nano-arr'.length);
    return html`<div
      class="ws-file ${e.name === store.currentName ? 'active' : ''}"
      @click=${() => store.openEntry(e.name)}
      @dblclick=${(ev: Event) => (ev.currentTarget as HTMLElement).querySelector<EditableLabel>('editable-label')?.beginEdit()}
    >
      <ui-icon icon="la-file"></ui-icon>
      <editable-label
        flat
        class="ws-name"
        .value=${base}
        @commit=${(ev: CustomEvent) => store.renameEntry(e.name, ev.detail as string)}
      ></editable-label>
      ${e.modified ? html`<span class="ws-ago" title=${new Date(e.modified).toLocaleString()}>${timeAgo(e.modified)}</span>` : ''}
      <button
        class="ws-del"
        title="Delete"
        @click=${(ev: PointerEvent) =>
          this.openConfirm(ev, {
            message: `Delete "${base}"?`,
            confirmLabel: 'Delete',
            onYes: () => store.deleteEntry(e.name),
          })}
      ><ui-icon icon="la-trash"></ui-icon></button>
    </div>`;
  }

  /** Open the shared confirmation popover, anchored leftward of the click. */
  private openConfirm(
    ev: { stopPropagation(): void; clientX: number; clientY: number },
    opts: { message: string; confirmLabel?: string; danger?: boolean; onYes: () => void | Promise<void> },
  ) {
    ev.stopPropagation();
    this.confirm = {
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? 'OK',
      danger: opts.danger ?? true,
      x: ev.clientX,
      y: ev.clientY,
      onYes: opts.onYes,
    };
  }

  private renderConfirm(): TemplateResult | '' {
    const c = this.confirm;
    if (!c) return '';
    // Open leftward from the click (trash/remove buttons hug the panel's right
    // edge), clamped on-screen. The popover is 220px wide.
    const x = Math.max(8, Math.min(c.x - 210, window.innerWidth - 232));
    const y = Math.min(c.y, window.innerHeight - 110);
    return html`
      <div class="pop-backdrop" @click=${() => { this.confirm = null; }}></div>
      <div class="confirm-pop" style="left:${x}px;top:${y}px" @click=${(e: Event) => e.stopPropagation()}>
        <div class="cp-msg">${c.message}</div>
        <div class="cp-actions">
          <button class="btn" @click=${() => { this.confirm = null; }}>Cancel</button>
          <button class="btn ${c.danger ? 'danger' : 'primary'}" @click=${() => this.runConfirm()}>${c.confirmLabel}</button>
        </div>
      </div>
    `;
  }

  private async runConfirm() {
    const c = this.confirm;
    this.confirm = null;
    if (c) await c.onYes();
  }

  private renderSettings(): TemplateResult {
    const meta = store.composition.meta;
    return html`
      <div class="section-header">Settings</div>
      <div class="body">
        <div class="group-title" style="border-top:none;margin-top:0;padding-top:0">Composition</div>
        <div class="row">
          <label>Resolution</label>
          <span class="val">
            <editable-number
              class="num"
              .value=${meta.resolution.width}
              .step=${1}
              .min=${1}
              .precision=${0}
              @input=${(e: CustomEvent<number>) => store.setResolution(e.detail, meta.resolution.height)}
            ></editable-number>×
            <editable-number
              class="num"
              .value=${meta.resolution.height}
              .step=${1}
              .min=${1}
              .precision=${0}
              @input=${(e: CustomEvent<number>) => store.setResolution(meta.resolution.width, e.detail)}
            ></editable-number>
          </span>
        </div>
        <div class="row">
          <label>Base BPM</label>
          <editable-number
            class="num"
            .value=${meta.baseBPM}
            .step=${1}
            .min=${1}
            .max=${999}
            .precision=${0}
            @input=${(e: CustomEvent<number>) => store.setBpm(e.detail)}
          ></editable-number>
        </div>
        <div class="row">
          <label>Frame rate</label>
          <span class="val">
            <editable-number
              class="num"
              .value=${store.compositionFps}
              .step=${1}
              .min=${1}
              .max=${240}
              .precision=${0}
              @input=${(e: CustomEvent<number>) => store.setCompositionFps(e.detail)}
            ></editable-number> fps
          </span>
        </div>
        <div class="row">
          <label>Time signature</label>
          <span class="val">${meta.timeSignature[0]} / ${meta.timeSignature[1]}</span>
        </div>
        <div class="row">
          <label>Background</label>
          <span class="val seg">
            ${(['black', 'transparent', 'custom'] as const).map(
              (m) => html`<button
                class="segbtn ${store.backgroundMode === m ? 'on' : ''}"
                @click=${() => store.setBackground(m)}
              >${m}</button>`,
            )}
            ${store.backgroundMode === 'custom'
              ? html`<input
                  type="color"
                  .value=${store.backgroundColor}
                  @input=${(e: Event) => store.setBackground('custom', (e.target as HTMLInputElement).value)}
                  style="width:26px;height:22px;padding:0;border:1px solid var(--app-tint-4);background:none;cursor:pointer;margin-left:6px"
                />`
              : ''}
          </span>
        </div>

        <div class="group-title">Application</div>
        <div class="row"><label>Theme</label><span class="val"><span class="tag">Dark (Pro)</span></span></div>
        <div class="row"><label>Snap to grid</label><span class="val"><span class="tag">¼ beat</span></span></div>
        <div class="row"><label>Default play mode</label><span class="val">${store.composition.playMode.defaultMode}</span></div>

        <div class="group-title">Library paths</div>
        <div
          class="lib-drop ${this.libDragOver ? 'over' : ''}"
          @dragover=${this.onLibraryDragOver}
          @dragleave=${() => { this.libDragOver = false; }}
          @drop=${this.onLibraryDrop}
        >
          <div class="lib-hint">
            Root folders the app can resolve files under. File &amp; workspace
            references are stored relative to these, so one permission grant covers
            everything beneath. Drag folders here to add them.
            <br />
            An <b>absolute path</b> is what the native engine resolves with — the
            browser can't discover one, so set it here or run the desktop app.
          </div>
          <div class="ws-list">
            ${libraryPaths.paths.length === 0
              ? html`<div class="dash-empty" style="padding:6px 0">No library paths yet.</div>`
              : libraryPaths.paths.map((p) => this.renderLibraryPath(p))}
          </div>
          <div class="ws-toolbar" style="margin-top:6px">
            <button class="btn" @click=${() => this.addLibraryPath()}>
              <ui-icon icon="la-folder-plus"></ui-icon> Add library path…
            </button>
            <button class="btn" @click=${() => this.addAbsoluteLibraryPath()}>
              <ui-icon icon="la-keyboard"></ui-icon> Add by path…
            </button>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * One library-path row. The badges are the important part: a handle-only row
   * works on the web but is invisible to the native engine, and a path-only row
   * is the reverse — without saying so, a row that silently half-works looks
   * broken.
   */
  private renderLibraryPath(p: LibraryPath): TemplateResult {
    const hasHandle = !!p.handle;
    const abs = p.absolutePath ?? '';
    return html`<div class="lib-row">
      <div class="ws-file">
        <ui-icon icon="la-folder"></ui-icon>
        <span class="ws-name" title=${p.label}>${p.label}</span>
        <span class="lib-badge ${hasHandle ? 'ok' : 'off'}" title=${hasHandle
          ? 'Granted in this browser — resolves locally.'
          : 'No browser handle — this row only helps the native engine.'}>browser</span>
        <span class="lib-badge ${abs ? 'ok' : 'off'}" title=${abs
          ? 'Has an absolute path — the native engine can resolve it.'
          : 'No absolute path — the native engine cannot resolve files here.'}>native</span>
        <button
          class="ws-del"
          title="Remove library path"
          @click=${(ev: PointerEvent) =>
            this.openConfirm(ev, {
              message: `Remove "${p.label}"? This invalidates any files referenced under it (you'd need to relink them).`,
              confirmLabel: 'Remove',
              onYes: () => libraryPaths.remove(p.id),
            })}
        ><ui-icon icon="la-trash"></ui-icon></button>
      </div>
      <div class="lib-abs">
        <input
          class="lib-abs-input"
          .value=${abs}
          placeholder="/absolute/path/to/folder"
          spellcheck="false"
          @change=${(e: Event) =>
            libraryPaths.setAbsolutePath(p.id, (e.target as HTMLInputElement).value.trim())}
        />
        ${isElectron()
          ? html`<button class="btn" title="Pick this folder to record where it lives"
              @click=${() => libraryPaths.locate(p.id)}>Locate…</button>`
          : nothing}
      </div>
    </div>`;
  }

  private onLibraryDragOver = (e: DragEvent) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation(); // don't let arrangement-app's drop handler also fire
    e.dataTransfer.dropEffect = 'copy';
    this.libDragOver = true;
  };

  private onLibraryDrop = async (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // Must start reading the DataTransfer synchronously — it clears once we await.
    const pending = handlesFromDataTransfer(dt);
    e.preventDefault();
    e.stopPropagation();
    this.libDragOver = false;
    for (const h of await pending) {
      if (h.kind === 'directory') await libraryPaths.add(h as PathsDirectoryHandle);
    }
  };

  private async addLibraryPath() {
    try {
      const dir = await showDirectoryPicker();
      if (dir) await libraryPaths.add(dir);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') console.warn('[library-paths] add failed', err);
    }
  }

  /** Add by typing a path — the only way to give the native engine a root when
   *  running in a browser, which can't discover absolute paths. */
  private async addAbsoluteLibraryPath() {
    const abs = window.prompt('Absolute path to the library folder:')?.trim();
    if (!abs) return;
    try {
      await libraryPaths.addAbsolute(abs);
    } catch (err) {
      console.warn('[library-paths] add by path failed', err);
    }
  }

  // ── Export ────────────────────────────────────────────────────────────
  private onResMode(mode: string) {
    if (mode === 'custom') {
      // Seed the explicit dimensions from the current effective resolution.
      const r = store.exportResolution;
      store.setExportSettings({ resolutionMode: 'custom', width: r.width, height: r.height });
    } else {
      store.setExportSettings({ resolutionMode: mode as ExportResolutionMode });
    }
  }

  private renderExport(): TemplateResult {
    const s = store.exportSettings;
    const eff = store.exportResolution;
    const ec = exportController;
    const rendering = ec.phase === 'rendering';
    const pct = Math.round(ec.progress * 100);
    return html`
      <div class="section-header">Export</div>
      <div class="body">
        <div class="row">
          <label>Resolution</label>
          <select .value=${s.resolutionMode} ?disabled=${rendering}
            @change=${(e: Event) => this.onResMode((e.target as HTMLSelectElement).value)}>
            <option value="default">Default (composition)</option>
            <option value="2x">2× composition</option>
            <option value="scale">Custom scale</option>
            <option value="custom">Custom resolution</option>
          </select>
        </div>
        ${s.resolutionMode === 'scale' ? html`
          <div class="row">
            <label>Scale</label>
            <span class="val">
              <editable-number class="num" .value=${s.scale} .step=${0.25} .min=${0.1} .max=${8} .precision=${2}
                ?disabled=${rendering}
                @input=${(e: CustomEvent<number>) => store.setExportSettings({ scale: e.detail })}></editable-number> ×
            </span>
          </div>` : ''}
        ${s.resolutionMode === 'custom' ? html`
          <div class="row">
            <label>Dimensions</label>
            <span class="val">
              <editable-number class="num" .value=${s.width} .step=${2} .min=${2} .precision=${0}
                ?disabled=${rendering}
                @input=${(e: CustomEvent<number>) => store.setExportSettings({ width: e.detail })}></editable-number> ×
              <editable-number class="num" .value=${s.height} .step=${2} .min=${2} .precision=${0}
                ?disabled=${rendering}
                @input=${(e: CustomEvent<number>) => store.setExportSettings({ height: e.detail })}></editable-number>
            </span>
          </div>` : ''}
        <div class="row"><label></label><span class="val muted">→ ${eff.width}×${eff.height}</span></div>
        <div class="row">
          <label>Frame rate</label>
          <select .value=${s.fpsMode} ?disabled=${rendering}
            @change=${(e: Event) => store.setExportSettings({ fpsMode: (e.target as HTMLSelectElement).value as ExportFpsMode })}>
            <option value="default">Default (composition)</option>
            <option value="custom">Custom</option>
          </select>
        </div>
        ${s.fpsMode === 'custom' ? html`
          <div class="row">
            <label>FPS</label>
            <span class="val">
              <editable-number class="num" .value=${s.fps} .step=${1} .min=${1} .max=${240} .precision=${0}
                ?disabled=${rendering}
                @input=${(e: CustomEvent<number>) => store.setExportSettings({ fps: e.detail })}></editable-number> fps
            </span>
          </div>` : html`
          <div class="row"><label></label><span class="val muted">→ ${store.exportFps} fps</span></div>`}
        <div class="row">
          <label>Range</label>
          <span class="val seg">
            <button class="segbtn ${s.range === 'all' ? 'on' : ''}" ?disabled=${rendering}
              @click=${() => store.setExportSettings({ range: 'all' })}>Whole</button>
            <button class="segbtn ${s.range === 'loop' ? 'on' : ''}"
              ?disabled=${rendering || !ec.hasLoop}
              title=${ec.hasLoop ? 'Export the loop region' : 'No loop region set'}
              @click=${() => store.setExportSettings({ range: 'loop' })}>Loop</button>
            <button class="segbtn ${s.range === 'selection' ? 'on' : ''}"
              ?disabled=${rendering || !ec.hasSelection}
              title=${ec.hasSelection
                ? 'Export the current time selection'
                : 'No time selection — drag a region on the timeline'}
              @click=${() => store.setExportSettings({ range: 'selection' })}>Selection</button>
          </span>
        </div>
        <div class="row"><label></label><span class="val muted">
          → ${ec.range.startBeat.toFixed(2)}–${ec.range.endBeat.toFixed(2)}b
        </span></div>
        <div class="row">
          <label>Solo</label>
          <span class="val seg">
            <button class="segbtn ${!s.ignoreSolo ? 'on' : ''}" ?disabled=${rendering}
              title="Respect soloed tracks (export only the soloed mix)"
              @click=${() => store.setExportSettings({ ignoreSolo: false })}>Respect</button>
            <button class="segbtn ${s.ignoreSolo ? 'on' : ''}" ?disabled=${rendering}
              title="Ignore solo — export the full mix"
              @click=${() => store.setExportSettings({ ignoreSolo: true })}>Ignore</button>
          </span>
        </div>
        <div class="row">
          <label>Quality</label>
          <span class="val seg">
            <button class="segbtn ${s.quality === 'low' ? 'on' : ''}" ?disabled=${rendering}
              @click=${() => store.setExportSettings({ quality: 'low' })}>Low</button>
            <button class="segbtn ${s.quality === 'medium' ? 'on' : ''}" ?disabled=${rendering}
              @click=${() => store.setExportSettings({ quality: 'medium' })}>Med</button>
            <button class="segbtn ${s.quality === 'high' ? 'on' : ''}" ?disabled=${rendering}
              @click=${() => store.setExportSettings({ quality: 'high' })}>High</button>
          </span>
        </div>
        <div class="row"><label>Format</label><span class="val">MP4 · H.264</span></div>
        <div class="row"><label>Length</label><span class="val muted">~${ec.estimateFrames} frames · ${(ec.estimateFrames / Math.max(1, store.exportFps)).toFixed(1)}s</span></div>

        ${rendering ? html`
          <div class="exp-progress"><i style="width:${pct}%"></i></div>
          <div class="muted" style="margin-top:4px">${ec.framesDone} / ${ec.framesTotal} frames (${pct}%)</div>
          <button class="btn" style="margin-top:8px" @click=${() => ec.cancel()}>Cancel</button>
        ` : html`
          <button class="btn primary" style="margin-top:8px" ?disabled=${ec.estimateFrames === 0}
            @click=${() => ec.run()}>
            <ui-icon icon="la-file-export"></ui-icon> Render…
          </button>
          ${ec.phase === 'done' ? html`<div class="muted" style="margin-top:6px">✓ ${ec.message}</div>` : ''}
          ${ec.phase === 'canceled' ? html`<div class="muted" style="margin-top:6px">${ec.message}</div>` : ''}
          ${ec.phase === 'error' ? html`<div class="err" style="margin-top:6px">${ec.message}</div>` : ''}
        `}
      </div>
    `;
  }
}
