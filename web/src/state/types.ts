/**
 * App state types for the sketch editor.
 */

import type { Sketch, FieldOptions, Wire } from '../sketch-types';

// --- Plugin info (from engine worker) ---

export interface PluginInfo {
  key: string;
  id: string;
  version: string;        // per-effect version (state::init), "major.minor.patch"
  moduleVersion?: string; // bundle/module version, "major.minor.patch"
  params: ParamInfo[];
  io: IOInfo[];
  schema?: Record<string, any>;
  /**
   * Declarative capability tags from the effect's schema (top-level
   * `capabilities` array), e.g. `['modulation_source', 'modulation_source_single']`.
   * Classifies what the effect is FOR — used by the editor to build modulation
   * palettes / pickers. See `state::Capability` in host.h. Empty when none.
   */
  capabilities?: string[];
  /**
   * First-class parameter GROUPS from the schema's top-level `groups` object,
   * keyed by group id → { name?, short?, help?, order? }. See `.group()` in host.h.
   */
  groups?: Record<string, { name?: string; short?: string; help?: string; order?: number }>;
}

export interface ParamInfo {
  index: number;
  name: string;
  type: number;       // 0=bool, 1=event, 10=standard, 11=option, 13=integer, 100=text
  defaultValue: number;
  min: number;
  max: number;
}

export interface IOInfo {
  index: number;
  name: string;
  kind: number;   // 0=texture_input, 1=texture_output, 2=data_output
  role: number;   // 0=primary, 1=secondary
}

// --- Available effects (from module registration) ---

export interface AvailableEffect {
  id: string;           // "color.tone.brightness_contrast" (module-relative semantic ID)
  name: string;         // "Brightness & Contrast"
  description: string;
  category: string;
  keywords: string[];
  /** The wasm bundle that registered this effect (e.g. "com.nano.lights"). */
  bundle?: string;
  /**
   * Optional Line Awesome icon class (e.g. "la-bolt") the effect declares for
   * its picker glyph. Untrusted — sanitize via `effect-glyph.ts` before use.
   */
  icon?: string;
  /**
   * Optional 32×32 PNG thumbnail for the picker glyph, base64-encoded (bare, or
   * a full data: URI). Untrusted — validate via `effect-glyph.ts` before use.
   */
  thumbnail?: string;
  /**
   * Effect kind. Defaults to a normal WASM-backed image `'effect'`. Distinct
   * kinds (e.g. `'dashboard'`) are handled specially by the UI — different card
   * rendering, no generic inspector. See column-group's util.dashboard case.
   */
  kind?: 'effect' | 'dashboard' | 'sketch_output';
}

// --- Selectable system ---

import type { TemplateResult } from 'lit';
import type { TracePoint } from '../engine-types';

/**
 * Anything the user can click to inspect. Each selectable has a unique path
 * and an optional function to render its inspector content.
 */
export interface Selectable {
  /** Unique identifier, e.g. "effect/sketch_0/0/2" or "column/sketch_0/1". */
  path: string;
  /** Human-readable label shown in the inspector header. */
  label: string;
  /** Render the inspector panel content for this selection. */
  renderInspectorContent?(): TemplateResult | undefined;
  /**
   * The texture this selectable previews, if any. When selected, the main
   * sketch monitor switches to show it; with none selected (or a selection that
   * has no viewable texture, e.g. a scalar param), the monitor falls back to the
   * sketch's final output. See edit-tab's `edit_preview` registration.
   */
  traceTarget?: TracePoint['target'];
  /**
   * Optional copy/paste handlers, driven by the toolbar copy/paste buttons and
   * the Cmd/Ctrl+C/V shortcuts. `copy` produces a clipboard payload (or null if
   * this selectable can't be copied); `paste` inserts a previously-copied
   * payload relative to this selectable — an effect card pastes AFTER itself, an
   * insert tab pastes AT its slot. When nothing pasteable is selected the
   * controller falls back to appending at the bottom of the active stack. Today
   * only effect cards implement `copy`; effect cards and insert tabs `paste`.
   */
  copy?(): ClipboardPayload | null;
  paste?(payload: ClipboardPayload): void;
}

/** A single effect card captured to the in-app clipboard. */
export interface EffectClipboard {
  kind: 'effect';
  moduleType: string;
  /** Deep-copied instance state (params + `__opacity__`/`__bypass__`), minus
   *  UI-only view state like collapse. */
  state: Record<string, any>;
  /** Per-field engine options (smoothing, …), if the source had any. */
  fieldOptions?: Record<string, FieldOptions>;
}

/** One card inside a multi-card clipboard payload. */
export interface EffectClipboardItem {
  moduleType: string;
  /** Deep-copied instance state, minus UI-only view state (see EffectClipboard). */
  state: Record<string, any>;
  fieldOptions?: Record<string, FieldOptions>;
  /**
   * The SOURCE instance_key. Never inserted as-is — paste always mints fresh
   * keys — it exists only so `wires` endpoints can be remapped onto the fresh
   * keys. Also what makes the payload meaningful across surfaces (the OS
   * clipboard carries this JSON between the effect IDE / playground / live
   * Resolume tabs, where the source keys mean nothing).
   */
  key: string;
}

/** A multi-selected group of effect cards, in chain order, WITH the wires
 *  internal to the group (both endpoints inside it). External wires are not
 *  captured — their far endpoint wouldn't exist at the paste site. */
export interface EffectsClipboard {
  kind: 'effects';
  items: EffectClipboardItem[];
  wires: Wire[];
}

/** What the app clipboard can hold. */
export type ClipboardPayload = EffectClipboard | EffectsClipboard;

// --- Database state (persisted, undo/redo-able) ---

export interface DatabaseState {
  sketches: Record<string, Sketch>;
}

// --- User settings (persisted to IndexedDB, never in undo history) ---

/**
 * Per-user UI preferences. Lives in `appState.local.userSettings`. Auto-saved
 * via a debounced autorun. Never modified through `appController.mutate`.
 */
export interface UserSettings {
  /** Width in pixels of the IDE's left details panel. */
  ideLeftPanelWidth: number;
  /** Currently active left tab in the IDE. */
  ideLeftTab: 'explorer' | 'project_editor' | 'debug_info';
  /** Currently selected project id (`default:<effectId>` or `user:<uuid>`). */
  selectedProjectId: string | null;
  /** Scroll positions keyed by an arbitrary scope id. */
  scrollPositions: Record<string, number>;
  /** Whether the engine is paused. */
  paused: boolean;
  /** Resolume sketch-IDE: last active top tab (create/organize/edit). */
  activeTab: 'create' | 'organize' | 'edit';
  /** Resolume sketch-IDE: the sketch currently open in the edit tab. */
  editingSketchId: string | null;
  /** Target framerate the GPU headroom estimate is measured against (FPS). */
  targetFps: number;
  /** Width in pixels of the Resolume sketch-IDE edit tab's left panel. */
  editLeftPanelWidth: number;
  /**
   * Per-sidechannel display-name override templates, keyed by channel name
   * ("1".."8" or a custom text name). Within a template every "#" expands to
   * the channel's DEFAULT label ("3 — Instance 1"); an absent/empty entry
   * behaves as "#" (pure default). Client-side naming metadata only — the bus
   * itself knows nothing about it.
   */
  sidechannelNames: Record<string, string>;
  /**
   * Per-instance display-name override templates, keyed by instance key (a
   * barrel plugin key or a `pg:` sketch id). Within a template every "#"
   * expands to the instance's AUTO-name (the shared-server label); an
   * absent/empty entry behaves as "#" (pure default). Client-side naming
   * metadata only.
   */
  instanceNames: Record<string, string>;
}

// --- Local state (ephemeral, not in undo history) ---

export interface EngineStatus {
  fps: number;
  /**
   * Estimated GPU busy-time of the latest frame, in milliseconds. Currently a
   * CPU-fence proxy (queue-completion lag, smoothed) — see engine-worker's
   * `gpuTimeEma`. Compared against the target-frame budget (1000/targetFps) to
   * show GPU usage / headroom. 0 when idle, paused, or unmeasured (barrel mode).
   */
  gpuTimeMs: number;
  error: string | null;
  /** Traced output frames keyed by trace point ID. */
  tracedFrames: Record<string, ImageBitmap | null>;
  /** Incremented every time tracedFrames is updated, to force MobX reactivity. */
  frameGeneration: number;
  /** Per-sketch rail values from the executor, keyed by sketch ID. */
  sketchState: Record<string, any>;
  /** Live plugin state per instance, keyed by instance key. Updated per-frame from the worker. */
  pluginStates: Record<string, any>;
  /**
   * Per-frame modulation telemetry, keyed by instance key. For each modulated
   * scalar INPUT field: `{ value, min, max, neutral }` — the effective resolved
   * value, the swing band the modulation can reach, and the fill anchor the band
   * grows from (base value for add/mix; range min/midpoint for unsigned/signed
   * replace; 0 for `mul`). Drives the slider modulation band.
   */
  modulationData: Record<string, Record<string, { value: number; min: number; max: number; neutral: number }>>;
  /**
   * Latest per-frame debug stats. Only populated while the Debug Info
   * sidebar tab is active (the tab toggles `engine.setDebugMode`).
   */
  debugStats?: import('../engine-types').DebugStats;
  /**
   * Rolling buffer of recent console-log entries from any WASM
   * effect. Capped at the worker side; the UI keeps its own cap on
   * top so an off-tab session can't grow unbounded.
   */
  debugConsoleLog: import('../engine-types').DebugConsoleEntry[];
  /**
   * Sidechannel-bus channel metadata: channel name → last writer + texture
   * size. Updated only when it changes (never per frame). Labels the
   * sidechannel effects' channel selectors ("3 — Instance 2"). Writer is a
   * bus tag: a `pg:` sketch id (playground) or a plugin key (barrel).
   */
  sidechannels: Record<string, import('../engine-types').SidechannelInfo>;
}

export interface LocalState {
  activeTab: 'organize' | 'edit';
  plugins: PluginInfo[];
  availableEffects: AvailableEffect[];
  editingSketchId: string | null;
  engine: EngineStatus;
  /** Whether tap configuration mode is active. */
  tappingMode: boolean;
  /** Whether "?" help mode is active (help slots + section help shown inline). */
  helpMode: boolean;

  // --- Selection / Inspector ---
  /** Currently selected item (drives the inspector panel). */
  selection: Selectable | null;
  /**
   * Multi-selected effect-card paths (`effect/<sketchId>/<colIdx>/<chainIdx>`),
   * all within ONE sketch, kept in chain order. A superset of the primary
   * `selection` when that is an effect card (plain click → `[path]`); grown by
   * cmd/ctrl-click, shift-click ranges, and Cmd+A. Group operations (copy /
   * cut / delete) act on this when it holds 2+ cards; the inspector keeps
   * following the primary. Transient UI state — chain mutations may stale the
   * embedded indices, so operations re-resolve entries and skip gaps.
   */
  multiSelection: string[];
  /**
   * Path queued for selection before the component has registered its Selectable.
   * When a component calls defineSelectable() with this path, the selection activates.
   */
  queuedSelectionPath: string | null;
  /**
   * In-app clipboard for copy/paste of selectables (currently effect cards).
   * Ephemeral — lives only for the session, drives the paste button's enabled
   * state. Set by `copySelection`, consumed by `pasteClipboard`.
   */
  clipboard: ClipboardPayload | null;

  // --- Effect IDE / cross-cutting persisted preferences ---
  /** UI preferences persisted to IndexedDB (never undo/redo-able). */
  userSettings: UserSettings;

  /**
   * True when this editor session is bound to the shared NanoBarrel server
   * (entered via `?barrel` — URL defaults to ws://localhost:8081). The
   * remote bridge is the source of truth; the Organize tab lists the live
   * plugin instances and the edit tab edits the selected one.
   */
  barrelMode: boolean;

  /**
   * Live NanoBarrel instances enumerated from the shared server's
   * `/global/plugins` (or the playground's fake instances). The Instances
   * tab lists these; `selectedBarrelKey` is the one open in the edit tab.
   */
  barrelInstances: BarrelInstanceInfo[];
  /** Key (stable UUID) of the barrel instance currently being edited. */
  selectedBarrelKey: string | null;
  /**
   * Channel name of the sidechannel card selected on the Instances tab (its
   * inspector shows in the right panel), or null. Independent of the instance
   * selection — clicking an instance card clears it and vice-versa doesn't
   * (the panel shows the sidechannel while one is picked).
   */
  selectedSidechannel: string | null;

  /**
   * Health of the shared-server WebSocket (barrel mode only; stays
   * 'connecting' in the playground). Drives the "can't reach Resolume —
   * switch to Playground?" offer.
   */
  barrelConnection: 'connecting' | 'open' | 'closed';
  /**
   * Playground-mode background probe result: a shared NanoBarrel server
   * answered on the barrel port. Drives the "Resolume detected — switch to
   * Live?" offer.
   */
  barrelDetected: boolean;
}

/**
 * Sketch-id prefix for playground instances (`pg:<uuid>`). The prefix keeps
 * them disjoint from effect-IDE project ids (`user:`/`default:`) and resolume
 * `sketch_N` ids, so the projects persistence path can never touch them and
 * the playground engine filter can admit them wholesale.
 */
export const PLAYGROUND_ID_PREFIX = 'pg:';

/** One NanoBarrel plugin instance live on the shared server. */
export interface BarrelInstanceInfo {
  /** Stable per-instance key (the persisted UUID) — the routing key. */
  key: string;
  /** Plugin id, e.g. "com.nano.nanobarrel". */
  id: string;
  /** Short human label derived from the key (first UUID segment). */
  label: string;
}
