import type { GPUHost } from './gpu-host';
import type { BridgeCore } from './bridge-core';
import type { StreamsRegistry } from './streams-registry';
import { createWasiShim } from './wasi-shim';
import * as fakeResolume from './fake-resolume';
import { TextEngine } from './text-engine';

export interface FrameState {
  elapsedTime: number;
  deltaTime: number;
  barPhase: number;
  bpm: number;
  viewportW: number;
  viewportH: number;
  params: number[];
}

export interface PatchOp {
  op: string;
  path: string;
  value?: any;
}

export interface WasmModule {
  init(): void;
  tick(dt: number): void;
  render(vpW: number, vpH: number): void;
  /** State change notification with patch details. All modules implement this. */
  onStatePatched(patchCount: number, pathsBuf: number, offsets: number, lengths: number, ops: number): void;
  /**
   * Pure passthrough predicate. Returns true when the effect, with its
   * current applied state, is an identity (output == primary input) — lets
   * the executor skip its dispatch and alias input→output. Returns false
   * when the effect did not register an is_identity predicate.
   */
  isIdentity(): boolean;
  /**
   * Device on/off ("bypass") transition. `active` is true when turned ON,
   * false when turned OFF. The executor calls this only on a change. Absent
   * when the effect didn't register an on_active callback.
   */
  onActive?(active: boolean): void;
  /**
   * Seek/prefill a stateful effect to a target time without ticking every
   * intervening frame (see EffectDesc_v2::seek). Absent when the effect didn't
   * export seek. Declared ABI — no executor caller yet, no effect implements it.
   */
  seek?(fromSeconds: number, toSeconds: number): void;
}

/** Metadata for an effect discovered via nano_module_main registration. */
export interface EffectInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
  /** Optional Line Awesome icon class the effect declares for its picker glyph. */
  icon?: string;
  /** Optional base64 PNG thumbnail (bare or data: URI) for the picker glyph. */
  thumbnail?: string;
  /**
   * @internal Lifecycle callbacks by name → WASM indirect-function-table index,
   * captured from the name-keyed `module.register_effect_*` builder imports.
   * Known names: module_init, create, destroy, init, tick, render,
   * on_state_patched, is_identity, on_active, seek. A name absent from the map
   * means the effect doesn't provide that hook — adding a new hook needs no
   * change here.
   */
  _fns: Map<string, number>;
}

export interface ConsoleEntry {
  timestamp: number;
  level: string;
  message: string;
  data?: any;  // structured data (from console_log_structured)
}

export interface ParamDecl {
  index: number;
  name: string;
  type: number;  // 0=boolean, 10=standard(float 0-1), 13=int, 100=string
  defaultValue: number;
  /// Slider range. Always populated; defaults to [0, 1] for fields
  /// without an explicit range (e.g. booleans, events).
  min: number;
  max: number;
}

export type AudioCallback = (channel: number) => void;
export type StateChangeCallback = (state: any) => void;
export type LogCallback = (entry: ConsoleEntry) => void;

const decoder = new TextDecoder();
const LEVELS = ['log', 'warn', 'error'];

/**
 * Strip the synthetic wrapper main from a transpiled fusion fragment
 * WGSL. Mirrors the build-time `_fragment_strip.py` so the runtime
 * can do the extraction itself when the build only ships SPV.
 *
 *   - var<private> global: vec3<u32>;          (synthetic builtin shim)
 *   - var _fuse_out: texture_storage_2d<...>;  (synthetic output)
 *   - fn main_1() { ... }                       (wrapper body)
 *   - @compute @workgroup_size(...) fn main(...) { ... }
 *
 * What's left is exactly the per-pixel fragment: struct definitions,
 * the cbuffer's uniform var, helper functions, and fuse_transform.
 *
 * The runtime caller is expected to verify the output still contains
 * `fuse_transform` (otherwise the dispatcher will produce a broken
 * shader). We log a warning here but don't throw, so the fusion
 * dispatcher can fall back to the standalone path if needed.
 */
/** FNV-1a (32-bit) over a byte buffer → base36 string. Cheap, used only as a
 *  content key for the SPV→WGSL translation cache (paired with byte length, so a
 *  collision would also need an identical length — astronomically unlikely). */
function fnv1a32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function stripFragmentMain(text: string): string {
  // Drop standalone `var<private> global:` and `var _fuse_out:` lines.
  text = text.replace(/^\s*var<private>\s+global\s*:[^\n]*\n/gm, '');
  text = text.replace(/^\s*var\s+_fuse_out\s*:[^\n]*\n/gm, '');
  // Orphaned binding annotations (the line above _fuse_out) — only
  // remove when the next line is blank, to avoid clobbering the
  // u_fuse binding which is followed by `var<uniform>`.
  text = text.replace(
    /@group\(\d+\)\s*@binding\(\d+\)\s*\n(?=\s*\n)/g,
    '',
  );
  text = stripBalancedBlock(text, /\bfn\s+main_1\s*\(\s*\)/);
  text = stripBalancedBlock(text, /@compute[^{]*?\bfn\s+main\s*\([^)]*\)/);
  if (!text.includes('fuse_transform')) {
    console.warn('[wasm-host] fragment strip lost fuse_transform — fusion will likely fail to compile');
  }
  return text;
}

/**
 * Find the first match of `headerPattern`, locate the `{` that
 * follows it on the same line or the next nonblank, then drop the
 * brace-balanced block (including its closing `}` and any trailing
 * `;` or whitespace + newline). Returns the stripped string.
 */
function stripBalancedBlock(text: string, headerPattern: RegExp): string {
  const m = headerPattern.exec(text);
  if (!m) return text;
  const headStart = m.index;
  const headEnd = m.index + m[0].length;
  const braceStart = text.indexOf('{', headEnd - 1);
  if (braceStart < 0) {
    // No body — drop to end of line.
    const eol = text.indexOf('\n', headEnd);
    return text.slice(0, headStart) + text.slice(eol < 0 ? text.length : eol + 1);
  }
  let depth = 0;
  let k = braceStart;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { k++; break; }
    }
    k++;
  }
  // Eat optional trailing whitespace + `;` + newline.
  while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  if (text[k] === ';') k++;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
  if (text[k] === '\n') k++;
  return text.slice(0, headStart) + text.slice(k);
}

/**
 * Recursively strip GPU-resident array leaves from `state`, based on a
 * schema shape of `{ [name]: { type, gpu?, fields?, ... } }`. GPU leaves
 * become 0 so serialized/transported snapshots never carry stale
 * in-process buffer handles.
 */
export function stripGpuFields(state: any, schema: Record<string, any>): any {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!schema || typeof schema !== 'object') return state;
  const out: any = Array.isArray(state) ? state.slice() : { ...state };
  for (const [name, def] of Object.entries(schema) as [string, any][]) {
    if (!def || typeof def !== 'object') continue;
    if (!(name in out)) continue;
    if (def.type === 'array' && def.gpu) {
      out[name] = 0;
    } else if (def.type === 'object' && def.fields) {
      out[name] = stripGpuFields(out[name], def.fields);
    }
  }
  return out;
}

export class WasmHost {
  private instance!: WebAssembly.Instance;
  private memory!: WebAssembly.Memory;

  /** Effects registered by the module during nano_module_main. */
  registeredEffects: EffectInfo[] = [];

  /**
   * In-progress effect registrations. `module.register_effect_begin` allocates
   * a builder (returns its handle); `register_effect_str`/`_fn` fill it by name;
   * `register_effect_end` moves it into registeredEffects.
   */
  private effectBuilders = new Map<number, { meta: Map<string, string>; fns: Map<string, number> }>();
  private nextEffectBuilder = 1;

  /** The compiled WebAssembly.Module (for reuse across instances). */
  compiledModule: WebAssembly.Module | null = null;

  frameState: FrameState = {
    elapsedTime: 0, deltaTime: 0, barPhase: 0, bpm: 120,
    viewportW: 0, viewportH: 0, params: new Array(16).fill(0),
  };

  // Seekable-streams registry backing the streams.* imports (streams-registry
  // .ts — the web twin of the native StreamsTable). Null outside comp mode:
  // the imports then answer as the session-clock-only world (frameState).
  streams: StreamsRegistry | null = null;
  // This host's engine instance key ("clip_<clipId>_<devId>", instance-keys
  // .ts) — the streams.* self-scoping input (parent()/content() resolve the
  // owning clip from it). '' for hosts outside the engine chain.
  instanceKey = '';

  // Bridge core (shared protocol engine)
  bridgeCore: BridgeCore | null = null;
  pluginKey: string = '';

  // I/O declarations
  ioDecls: { index: number; name: string; kind: number; role: number }[] = [];

  // Legacy direct state (used when no bridge core is available)
  pluginState: any = {};
  consoleLogs: ConsoleEntry[] = [];
  metadata: { id: string; version: string } | null = null;
  params: ParamDecl[] = [];

  // Schema (populated by set_schema)
  schema: Record<string, any> = {};

  // Declarative capability tags from the schema's top-level `capabilities`
  // array (e.g. ['modulation_source', 'modulation_source_single']). Classifies
  // what the effect is FOR; see host.h Capability. Empty when none declared.
  capabilities: string[] = [];

  // Parameter GROUPS from the schema's top-level `groups` object (a first-class
  // section per group id → { name, short?, help?, order? }). Bridge core keeps
  // only `fields`, so — like capabilities/moduleVersion — this rides the host and
  // a static per-id map so DISCOVERED-but-not-instantiated effects surface it too.
  groups: Record<string, any> = {};

  // Host<->effect ABI version this bundle was built against (its
  // `nano_abi_version()` export; see NANO_ABI_VERSION in module_api.h). 0 when
  // the export is absent (a legacy bundle). A coarse compatibility signal — the
  // web twin of RegisteredModule::abiVersion. With name-keyed registration it
  // no longer gates descriptor layout (absent names are simply "not provided").
  abiVersion = 0;

  // Bundle (module) version "major.minor.patch" from the schema's top-level
  // `moduleVersion`, distinct from the per-effect `metadata.version`. Both are
  // recorded onto serialized instances. Defaults to 0.0.0 until a schema is seen.
  moduleVersion = '0.0.0';

  // Per-effect-id module version, captured on EVERY set_schema and kept here so
  // broadcastState can read it by id even after the transient init-time host is
  // gone (the per-instance `moduleVersion` field above only exists while a host
  // is live; effect version rides bridgeCore, module version rides this map).
  static moduleVersionsById = new Map<string, string>();

  // Per-effect-id capability tags, captured on EVERY set_schema and kept here for
  // the same reason as moduleVersionsById: broadcastState must surface an effect's
  // capabilities (e.g. 'generator') even for effects that were merely LOADED but
  // never instantiated (no live host) — the entire palette. The per-instance
  // `capabilities` field below only exists while a host is live.
  static capabilitiesById = new Map<string, string[]>();

  // Per-effect-id parameter groups, captured on EVERY set_schema and kept here so
  // broadcastState can surface an effect's groups (section headers + group help)
  // even for effects that were merely LOADED but never instantiated.
  static groupsById = new Map<string, Record<string, any>>();

  // Global SPV→WGSL translation cache, keyed by shader content (see fetchShaderWgsl).
  // Shared across ALL host instances so re-instantiating an effect never re-pays the
  // synchronous naga round-trip per shader — the fix for the heavy-effect re-entry hitch.
  static spvWgslCache = new Map<string, string>();

  // Pending patches for the current on_state_patched call
  pendingPatches: PatchOp[] = [];

  // Val handle store (shared between val imports and state.get_patch)
  _valStore = {
    values: new Map<number, any>(),
    nextHandle: 1,
    alloc(v: any): number { const h = this.nextHandle++; this.values.set(h, v); return h; },
    get(h: number): any { return this.values.get(h); },
    release(h: number) { this.values.delete(h); },
  };

  // Named texture fields (populated by sketch executor from schema)
  textureFields: Map<string, number> = new Map();

  // GPU buffer fields — path -> GPU buffer handle (allocated by GPUHost).
  // Populated by state::setGpuBuffer and read by gpu::bufferForField.
  gpuBufferFields: Map<string, number> = new Map();

  // Per-frame connection state populated by the sketch executor before
  // tick/render. Each set holds the schema field paths whose tap topology
  // resolves to a complementary tap on the same rail this frame —
  // i.e. fieldsWithWriter contains paths this effect READS that are
  // produced by some upstream writer; fieldsWithReader contains paths
  // this effect WRITES that are consumed by some downstream reader.
  // Cleared and rebuilt per chain entry so the answer always reflects
  // the current sketch's wiring.
  fieldsWithWriter: Set<string> = new Set();
  fieldsWithReader: Set<string> = new Set();

  // Per-stage "will this effect's output be drawn this frame" flag, exposed to
  // the effect via state::willRender(). The executor sets it before each tick();
  // false only when opacity is 0 (render skipped). Defaults true.
  willRender: boolean = true;

  // textureFields keys installed by the executor's read-tap loop last
  // frame for NAMED (non-numeric) texture taps. Cleared and rewritten
  // each frame; lets us drop stale entries when a tap is removed
  // without trampling on producer-published handles (state::setGpuTexture)
  // or struct-rail texture leaves, which the executor has no visibility
  // into.
  tapInstalledTextureFields: Set<string> = new Set();

  // Paths pending a "dirty" notification. Drained by the sketch executor
  // and fed back into notifyStatePatched as dirty-op patches.
  pendingDirtyPaths: string[] = [];

  // UI-visibility overlay set by `state::setFieldHidden`. The schema
  // registered with bridge core stays full-fat; broadcastState reads
  // this set and stamps `hidden:true` on the matching fields before
  // shipping the schema to the main thread.
  hiddenFields: Set<string> = new Set();

  // Non-null only DURING an `evaluateVisibility()` call: `set_field_hidden`
  // writes here (and skips `hiddenFields` + `onSchemaChanged`) so a static
  // visibility query never disturbs the host's live overlay. See
  // `evaluateVisibility`.
  private evalHiddenScratch: Set<string> | null = null;

  // Function-table callable for the effect's STATIC visibility evaluator
  // (EffectDesc_v2.eval_visibility), or null if the effect didn't register one.
  // Self-less: computes the hidden-field set purely from a candidate state.
  // Resolved in `activateEffect`.
  evalVisibilityFn: ((n: number, pb: number, off: number, len: number, ops: number) => void) | null = null;

  // Optional callback fired when the visibility overlay (or any other
  // schema-affecting state) changes, so the engine worker can mark the
  // engine state dirty and trigger a broadcast.
  onSchemaChanged?: () => void;

  // Function-table index registered via `state::setOnStateReady(fn)`.
  // 0 (the WASM ABI's "no function") means the effect didn't register
  // a callback — `fireStateReady()` is a no-op in that case.
  onStateReadyIdx = 0;
  // The per-instance `self` pointer returned by the active effect's
  // create() (EffectDesc_v2). Threaded into every instance callback
  // (tick/render/on_state_patched/on_state_ready/prepare). 0 until an
  // effect is activated. One WasmHost == one effect instance on the
  // real render path; the warmup host reuses one host across effects,
  // where activeSelf just tracks the most recently activated effect.
  activeSelf = 0;
  // Effect ids whose module_init() has already run on this host (type-
  // level setup is once-per-type; a host may host many effect types).
  private moduleInitedIds: Set<string> = new Set();
  /// True once `fireStateReady()` has dispatched the registered
  /// callback (or noticed there's nothing to dispatch). Re-arming
  /// would require a new instance, since the callback is a one-shot
  /// "post-restoration" signal.
  stateReadyFired = false;

  // SPIR-V shader registry, populated via state::registerShaderSPV.
  // Each effect registers its shaders by name during init(); the
  // host translates SPIR-V → WGSL on demand when the effect calls
  // gpu::Device::createShaderModuleByName(name). Bytes are kept so a
  // re-translation request (e.g. after HMR) doesn't need a re-upload.
  // Optional storageFormat / storageAccess override naga's default
  // rgba32float substitution for shaders that bind non-rgba8unorm
  // storage textures (HDR, R32F read_write, etc.).
  shaderSPV: Map<string, {
    bytes: Uint8Array;
    storageFormat: string;
    storageAccess: string;
  }> = new Map();
  // Cached compiled WGSL keyed by name. Re-create-shader-module from
  // the same name is rare in practice, but keeping the WGSL avoids a
  // second naga round-trip if it does happen.
  private shaderWgslCache: Map<string, string> = new Map();

  // Fusion metadata — populated when an effect calls
  // `state::registerFusion(...)` during init(). `fusionKind === 0`
  // (Freeform) means the effect opted out (or never registered) and the
  // engine will never fuse it. The fragment name resolves to a SPV blob
  // (registered via state::registerShaderSPV); the runtime fetches WGSL
  // via the naga endpoint and runs the strip pass on demand, lazily
  // cached in fusionFragmentWgslCached.
  fusionKind: number = 0;
  fusionFragmentName: string = '';
  private fusionFragmentWgslCached: string | null = null;
  fusionUniformBufferHandle: number = 0;
  fusionUniformSize: number = 0;
  /// Function-table index of the `prepare` callback. 0 means none —
  /// the engine should fall back to the effect's `render()` even when
  /// fusing.
  fusionPrepareIdx: number = 0;

  // Input textures (injected by sketch executor for chaining)
  inputTextureHandles: number[] = [];

  // Resolume param subscriptions
  subscribeQueries: string[] = [];
  onResolumeParamSet: ((id: bigint, value: number) => void) | null = null;

  gpuHost: GPUHost | null = null;

  onAudioTrigger: AudioCallback = () => {};
  onStateChange: StateChangeCallback = () => {};
  onLog: LogCallback = () => {};

  private readString(ptr: number, len: number): string {
    return decoder.decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  /** Read a null-terminated C string from WASM memory. */
  private readCString(ptr: number): string {
    const mem = new Uint8Array(this.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0) end++;
    return decoder.decode(mem.slice(ptr, end));
  }

  private writeString(ptr: number, maxLen: number, str: string): number {
    const encoded = new TextEncoder().encode(str);
    const len = Math.min(encoded.length, maxLen);
    new Uint8Array(this.memory.buffer, ptr, len).set(encoded.subarray(0, len));
    return len;
  }

  private get useBridgeCore(): boolean {
    return this.bridgeCore !== null;
  }

  /** Convert a JS value to a bridge core val handle (recursive). */
  private jsValueToBcVal(bc: BridgeCore, value: any): number {
    if (value === null || value === undefined) return bc.valNull();
    if (typeof value === 'boolean') return bc.valBool(value);
    if (typeof value === 'number') return bc.valNumber(value);
    if (typeof value === 'string') return bc.valString(value);
    if (Array.isArray(value)) {
      const arr = bc.valArray();
      for (const item of value) {
        const itemH = this.jsValueToBcVal(bc, item);
        bc.valPush(arr, itemH);
        bc.valRelease(itemH);
      }
      return arr;
    }
    if (typeof value === 'object') {
      const obj = bc.valObject();
      for (const [k, v] of Object.entries(value)) {
        const valH = this.jsValueToBcVal(bc, v);
        bc.valSet(obj, k, valH);
        bc.valRelease(valH);
      }
      return obj;
    }
    return bc.valNull();
  }

  async load(source: string | WebAssembly.Module): Promise<void> {
    let compiled: WebAssembly.Module;
    if (typeof source === 'string') {
      const response = await fetch(source);
      const bytes = await response.arrayBuffer();
      compiled = await WebAssembly.compile(bytes);
    } else {
      compiled = source;
    }
    this.compiledModule = compiled;
    this.registeredEffects = [];
    this.effectBuilders.clear();
    const bc = this.bridgeCore;

    const importObject: WebAssembly.Imports = {
      wasi_snapshot_preview1: createWasiShim(() => this.memory),
      env: {
        resolume_get_param: (id: bigint) =>
          bc ? bc.getParam(id) : 0,
        resolume_set_param: (id: bigint, value: number) => {
          if (bc) {
            bc.setParam(id, value);
            bc.queueParamWrite(id, value);
          }
          if (this.onResolumeParamSet) this.onResolumeParamSet(id, value);
        },
        log: (ptr: number, len: number) => {
          console.log('[wasm]', this.readString(ptr, len));
        },
        fmod: (a: number, b: number) => a - Math.trunc(a / b) * b,
        fmodf: (a: number, b: number) => a - Math.trunc(a / b) * b,
        sinf: (a: number) => Math.sin(a),
        floor: (a: number) => Math.floor(a),
        fabs: (a: number) => Math.abs(a),
        strlen: (ptr: number) => {
          const mem = new Uint8Array(this.memory.buffer);
          let len = 0;
          while (mem[ptr + len] !== 0) len++;
          return len;
        },
      },
      host: {
        get_time: () => this.frameState.elapsedTime,
        get_delta_time: () => this.frameState.deltaTime,
        get_bar_phase: () => this.frameState.barPhase,
        get_bpm: () => this.frameState.bpm,
        get_param: (index: number) => this.frameState.params[index] ?? 0,
        get_viewport_w: () => this.frameState.viewportW,
        get_viewport_h: () => this.frameState.viewportH,
        log: (ptr: number, len: number) => {
          console.log('[wasm]', this.readString(ptr, len));
        },
        trigger_audio: (channel: number) => {
          this.onAudioTrigger(channel);
        },
      },
      resolume: {
        get_param: (id: bigint) =>
          bc ? bc.getParam(id) : 0,
        set_param: (id: bigint, value: number) => {
          if (bc) {
            bc.setParam(id, value);
            bc.queueParamWrite(id, value);
          }
          if (this.onResolumeParamSet) this.onResolumeParamSet(id, value);
        },
        trigger_clip: (_clipId: bigint, _on: number) => {},
        subscribe_param: (_id: bigint) => {},
        subscribe_query: (queryPtr: number, queryLen: number) => {
          const query = this.readString(queryPtr, queryLen);
          this.subscribeQueries.push(query);
        },
        get_param_path: (paramId: bigint, bufPtr: number, bufLen: number): number => {
          const path = bc ? bc.getParamPath(paramId) : `param/${paramId}`;
          return this.writeString(bufPtr, bufLen, path);
        },
        get_clip_count: () => fakeResolume.getClipCount(),
        get_clip_id: (index: number) => fakeResolume.getClipId(index),
        get_clip_channel: (index: number) => fakeResolume.getClipChannel(index),
        get_clip_name: (index: number, bufPtr: number, bufLen: number) => {
          const name = fakeResolume.getClipName(index);
          return this.writeString(bufPtr, bufLen, name);
        },
        get_clip_connected: (index: number) => fakeResolume.getClipConnected(index),
        get_bpm: () => fakeResolume.getBpm(),
        load_thumbnail: (_clipIndex: number) => -1,
      },
      // Seekable-streams surface — the web twin of the native "streams" host
      // module (host_functions.cpp; effect header streams.h). Backed by
      // this.streams (StreamsRegistry) or, when null, the session-clock-only
      // fallback. All per-frame answers are flat scalars or fixed-layout
      // copies — never JSON.
      streams: {
        parent: (): bigint =>
          this.streams ? this.streams.parentOf(this.instanceKey) : 1n,
        content: (): bigint =>
          this.streams ? this.streams.contentOf(this.instanceKey) : 0n,
        timeline: (): bigint => (this.streams ? 2n : 0n),
        count: (): number => this.streams?.enumCount ?? 1,
        at: (i: number): bigint => {
          if (!this.streams) return i === 0 ? 1n : 0n;
          if (i < 0 || i >= this.streams.enumCount) return 0n;
          return this.streams.streams[i].handle;
        },
        name: (h: bigint, bufPtr: number, bufLen: number): number => {
          const s = this.streams?.find(h);
          if (!s) return 0;
          const bytes = new TextEncoder().encode(s.name);
          if (bufLen > 0 && bytes.length > 0) {
            const copy = Math.min(bytes.length, bufLen);
            new Uint8Array(this.memory.buffer, bufPtr, copy).set(bytes.subarray(0, copy));
          }
          return bytes.length; // full length (grow-and-retry)
        },
        describe: (h: bigint, descPtr: number): number => {
          const dv = new DataView(this.memory.buffer);
          const sent = dv.getInt32(descPtr, true);
          const fill = Math.min(sent, 48);
          if (fill < 4) return 0;
          const reg = this.streams;
          const s = reg?.find(h);
          // [struct_size, kind, flags, axis, frame_count, event_count,
          //  doc_rev, index, clip_count, r0, r1, r2] — streams.h StreamDesc.
          let fields = [sent, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0];
          if (s && reg) {
            const isContent = s.kind === 5 || s.kind === 6;
            const evCount = isContent
              ? reg.contentEventCount(s, reg.elapsed(s, this.frameState.elapsedTime))
              : s.events.length;
            const flags = s.flags | (s.declared ? 64 : 0); // kDriven
            fields = [sent, s.kind, flags, s.axis, s.frameCount, evCount,
                      s.eventRev, s.index, s.clipCount, 0, 0, 0];
          } else if (!reg && h === 1n) {
            // Session clock (kind 1, kLiveOnly, seconds axis).
            fields = [sent, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          }
          const words = (fill / 4) | 0;
          for (let k = 1; k < words; k++) dv.setInt32(descPtr + 4 * k, fields[k], true);
          return fields[1] !== 0 ? 1 : 0;
        },
        rev: (h: bigint): number => {
          const s = this.streams?.find(h);
          return s ? s.eventRev : this.streams?.docRev ?? 0;
        },
        pos: (h: bigint): number => {
          const s = this.streams?.find(h);
          if (!s) return h === 1n ? this.frameState.elapsedTime : NaN;
          return this.streams!.pos(s, this.frameState.elapsedTime);
        },
        pos_sec: (h: bigint): number => {
          const s = this.streams?.find(h);
          if (!s) return h === 1n ? this.frameState.elapsedTime : NaN;
          return this.streams!.posSec(s, this.frameState.elapsedTime);
        },
        playing: (h: bigint): number => {
          const s = this.streams?.find(h);
          if (!s) return h === 1n ? 1 : 0;
          return this.streams!.playing(s);
        },
        loop: (h: bigint, outPtr: number): number => {
          const s = this.streams?.find(h);
          if (!s) return 0;
          const region = this.streams!.loopRegion(s);
          if (!region) return 0;
          const out = new Float64Array(this.memory.buffer, outPtr, 2);
          out[0] = region[0];
          out[1] = region[1];
          return 1;
        },
        duration: (h: bigint): number => this.streams?.find(h)?.durationPrimary ?? -1,
        duration_sec: (h: bigint): number => this.streams?.find(h)?.durationSec ?? -1,
        bpm: (h: bigint): number => this.streams?.find(h)?.bpm ?? this.frameState.bpm,
        fps: (h: bigint): number => this.streams?.find(h)?.fps ?? 0,
        anchor: (h: bigint): number => {
          const s = this.streams?.find(h);
          return s && (s.kind === 5 || s.kind === 6) ? s.anchorBeat : NaN;
        },
        anchor_sec: (h: bigint): number => {
          const s = this.streams?.find(h);
          if (!s || (s.kind !== 5 && s.kind !== 6)) return NaN;
          return s.anchorSec;
        },
        elapsed: (h: bigint): number => {
          const s = this.streams?.find(h);
          if (!s) return h === 1n ? this.frameState.elapsedTime : NaN;
          return this.streams!.elapsed(s, this.frameState.elapsedTime);
        },
        clip_duration: (h: bigint, ordinal: number): number => {
          const s = this.streams?.find(h);
          return s ? this.streams!.clipDuration(s, ordinal) : NaN;
        },
        clip_group: (h: bigint, ordinal: number): number => {
          const s = this.streams?.find(h);
          return s ? this.streams!.clipGroup(s, ordinal) : NaN;
        },
        seek: (h: bigint, t: number, cls: number): number =>
          this.streams?.queueSeek(h, t, cls === 0 ? 'instant' : 'loose') ? 1 : 0,
        stop: (h: bigint): number => (this.streams?.queueStop(h) ? 1 : 0),
        announce: (h: bigint, t: number, eta: number, cls: number): number =>
          this.streams?.queueAnnounce(h, t, eta, cls === 0 ? 'instant' : 'loose') ? 1 : 0,
        event_count: (h: bigint): number => {
          const s = this.streams?.find(h);
          if (!s) return !this.streams && h === 1n ? 0 : -1;
          if (s.kind === 5 || s.kind === 6) {
            return this.streams!.contentEventCount(
              s, this.streams!.elapsed(s, this.frameState.elapsedTime));
          }
          return s.events.length;
        },
        read_events: (h: bigint, first: number, outPtr: number, capEvents: number): number => {
          const s = this.streams?.find(h);
          if (!s) return !this.streams && h === 1n ? 0 : -1;
          if (first < 0 || capEvents <= 0) return 0;
          const content = s.kind === 5 || s.kind === 6;
          const total = content
            ? this.streams!.contentEventCount(
                s, this.streams!.elapsed(s, this.frameState.elapsedTime))
            : s.events.length;
          const n = Math.max(0, Math.min(total - first, capEvents));
          if (n === 0) return 0;
          const out = new Float64Array(this.memory.buffer, outPtr, n * 5);
          for (let k = 0; k < n; k++) {
            const e = content ? this.streams!.contentEventAt(s, first + k)
                              : s.events[first + k];
            out[k * 5 + 0] = e.time;
            out[k * 5 + 1] = e.kind;
            out[k * 5 + 2] = e.clipOrdinal;
            out[k * 5 + 3] = e.idHash48;
            out[k * 5 + 4] = e.channel;
          }
          return n;
        },
        event_lower_bound: (h: bigint, t: number): number => {
          const s = this.streams?.find(h);
          return s ? this.streams!.eventLowerBound(s, t) : 0;
        },
      },
      // Resources surface (ABI v4) — the ASSET namespace behind streams (web
      // twin of the native "resources" host module; effect header
      // resources.h). resources.stream fetches the seekable-stream view.
      resources: {
        content: (): bigint =>
          this.streams ? this.streams.resourceContentOf(this.instanceKey) : 0n,
        live: (h: bigint): bigint => this.streams?.resourceLive(h) ?? 0n,
        clip_at: (h: bigint, ordinal: number): bigint =>
          this.streams?.resourceClipAt(h, ordinal) ?? 0n,
        describe: (h: bigint, descPtr: number): number => {
          const dv = new DataView(this.memory.buffer);
          const sent = dv.getInt32(descPtr, true);
          const fill = Math.min(sent, 64);
          if (fill < 4) return 0;
          const r = this.streams?.findResource(h);
          // ResourceDesc image as (offset, write) pairs — 8-byte fields sit
          // at 8-aligned offsets (resources.h layout).
          const scratch = new ArrayBuffer(64);
          const sv = new DataView(scratch);
          sv.setInt32(0, sent, true);
          sv.setInt32(4, r ? r.kind : 0, true);
          sv.setInt32(8, r ? r.flags : 0, true);
          sv.setInt32(12, r ? this.streams!.resourceRevOf(r) : 0, true);
          sv.setBigInt64(16, r ? BigInt.asIntN(64, r.stream) : 0n, true);
          sv.setBigInt64(24, r ? BigInt(r.sizeBytes) : -1n, true);
          sv.setFloat64(32, r ? r.durationSec : -1, true);
          sv.setInt32(40, r ? r.width : 0, true);
          sv.setInt32(44, r ? r.height : 0, true);
          new Uint8Array(this.memory.buffer, descPtr + 4, fill - 4)
            .set(new Uint8Array(scratch, 4, fill - 4));
          return r ? 1 : 0;
        },
        rev: (h: bigint): number => {
          const r = this.streams?.findResource(h);
          return r ? this.streams!.resourceRevOf(r) : this.streams?.docRev ?? 0;
        },
        stream: (h: bigint): bigint =>
          this.streams?.findResource(h)?.stream ?? 0n,
        // Fork engine arrives with the transition work; until then a valid
        // forkable resource still answers 0 (native twin agrees).
        fork: (_h: bigint): bigint => 0n,
      },
      state: {
        get_key: (bufPtr: number, bufLen: number): number => {
          const key = this.pluginKey || (this.metadata?.id
            ? `${this.metadata.id}@0`
            : 'unknown@0');
          return this.writeString(bufPtr, bufLen, key);
        },
        set_metadata: (idPtr: number, idLen: number, versionPacked: number) => {
          const id = this.readString(idPtr, idLen);
          const major = (versionPacked >> 16) & 0xFF;
          const minor = (versionPacked >> 8) & 0xFF;
          const patch = versionPacked & 0xFF;
          this.metadata = { id, version: `${major}.${minor}.${patch}` };
          if (bc) {
            this.pluginKey = bc.registerPlugin(id, major, minor, patch);
          }
        },
        set_schema: (idPtr: number, idLen: number, versionPacked: number,
                      schemaPtr: number, schemaLen: number) => {
          const id = this.readString(idPtr, idLen);
          const major = (versionPacked >> 16) & 0xFF;
          const minor = (versionPacked >> 8) & 0xFF;
          const patch = versionPacked & 0xFF;
          this.metadata = { id, version: `${major}.${minor}.${patch}` };

          const schemaStr = this.readString(schemaPtr, schemaLen);
          try {
            const schemaJson = JSON.parse(schemaStr);
            this.schema = schemaJson.fields ?? {};
            this.capabilities = Array.isArray(schemaJson.capabilities)
              ? schemaJson.capabilities.filter((c: any) => typeof c === 'string')
              : [];
            this.groups = (schemaJson.groups && typeof schemaJson.groups === 'object')
              ? schemaJson.groups
              : {};
            if (Array.isArray(schemaJson.moduleVersion) && schemaJson.moduleVersion.length === 3) {
              this.moduleVersion = schemaJson.moduleVersion.map((n: any) => n | 0).join('.');
            }
            WasmHost.moduleVersionsById.set(id, this.moduleVersion);
            WasmHost.capabilitiesById.set(id, this.capabilities);
            WasmHost.groupsById.set(id, this.groups);

            // Derive params and ioDecls from schema for backward compat
            this.params = [];
            this.ioDecls = [];
            let paramIdx = 0;
            for (const [name, field] of Object.entries(this.schema) as [string, any][]) {
              const ioFlags = field.io ?? 0;
              if (field.type === 'help') {
                // UI-only documentation slot — no param row, no io declaration.
                continue;
              } else if (field.type === 'texture') {
                const dir = (ioFlags & 1) ? 0 : 1; // Input=0, Output=1
                const role = (ioFlags & 4) ? 0 : 1; // Primary=0, Secondary=1
                this.ioDecls.push({ index: this.ioDecls.length, name, kind: dir, role });
              } else if (field.type === 'object' || field.type === 'array'
                         || field.type === 'float2' || field.type === 'float3'
                         || field.type === 'float4') {
                // Non-scalar fields: still surface as data outputs when the
                // schema marks them Output, but skip the legacy params row.
                if (ioFlags & 2) {
                  const role = (ioFlags & 4) ? 0 : 1;
                  this.ioDecls.push({ index: this.ioDecls.length, name, kind: 2, role });
                }
              } else {
                let type = 10; // Standard
                if (field.type === 'bool') type = 0;
                else if (field.type === 'event') type = 1;
                else if (field.type === 'int') type = 13;
                else if (field.type === 'string') type = 100;
                // Booleans round-trip as numbers in the param list so
                // ParamDecl stays uniformly numeric (downstream
                // widgets compare via `> 0.5`); the typed schema
                // payload stays bool, this is just the param-row view.
                let defaultValue: number = 0;
                const fd = field.default;
                if (typeof fd === 'number') defaultValue = fd;
                else if (typeof fd === 'boolean') defaultValue = fd ? 1 : 0;
                this.params.push({
                  index: paramIdx++,
                  name,
                  type,
                  defaultValue,
                  // Always emit min/max — downstream slider widgets
                  // disable range mapping when these are undefined.
                  // [0, 1] is the safe default for unranged fields
                  // (booleans, events, strings) where the value won't
                  // be drag-edited anyway.
                  min: typeof field.min === 'number' ? field.min : 0,
                  max: typeof field.max === 'number' ? field.max : 1,
                });
                // Non-texture fields with Output flag → data_output io declaration
                if (ioFlags & 2) { // Output bit
                  const role = (ioFlags & 4) ? 0 : 1; // Primary=0, Secondary=1
                  this.ioDecls.push({ index: this.ioDecls.length, name, kind: 2, role });
                }
              }
            }
          } catch {
            this.schema = {};
            this.capabilities = [];
            this.groups = {};
            WasmHost.capabilitiesById.set(id, []);
            WasmHost.groupsById.set(id, {});
          }

          if (bc) {
            try {
              this.pluginKey = bc.registerWithSchema(id, major, minor, patch, schemaStr);
            } catch (e) {
              console.warn('[wasm-host] registerWithSchema failed, falling back to registerPlugin:', e);
              this.pluginKey = bc.registerPlugin(id, major, minor, patch);
            }
            // Seed local pluginState with the schema-derived defaults so
            // downstream consumers (struct rail snapshot, inspector, etc.)
            // can read scalar fields without waiting for the module to
            // call set_val explicitly.
            if (this.pluginKey) {
              try { this.pluginState = bc.getPluginState(this.pluginKey); } catch {}
            }
          }
        },
        console_log: (level: number, msgPtr: number, msgLen: number) => {
          const message = this.readString(msgPtr, msgLen);
          const entry: ConsoleEntry = {
            timestamp: this.frameState.elapsedTime,
            level: LEVELS[level] ?? 'log',
            message,
          };
          this.consoleLogs.push(entry);
          if (this.consoleLogs.length > 200) {
            this.consoleLogs = this.consoleLogs.slice(-100);
          }
          // Also surface to the browser/devtools console so E2E test
          // logging can see what the WASM module emitted. A SCHEMA-ONLY host
          // (no gpu backend — the bundle warm-up describes) demotes to debug:
          // its effects legitimately complain about the backend they'll never
          // render with ("no GPU backend"), which isn't an app error.
          const tag = `[wasm:${this.metadata?.id ?? this.pluginKey ?? '?'}]`;
          if (!this.gpuHost) console.debug(tag, message);
          else if (level === 1) console.warn(tag, message);
          else if (level === 2) console.error(tag, message);
          else console.log(tag, message);
          this.onLog(entry);
          if (bc && this.pluginKey) {
            bc.log(this.pluginKey, entry.timestamp, level, message);
          }
        },
        console_log_structured: (level: number, msgPtr: number, msgLen: number,
                                  jsonPtr: number, jsonLen: number) => {
          const message = this.readString(msgPtr, msgLen);
          const jsonStr = this.readString(jsonPtr, jsonLen);
          let data: any;
          try {
            data = JSON.parse(jsonStr);
          } catch {
            data = jsonStr;
          }
          const entry: ConsoleEntry = {
            timestamp: this.frameState.elapsedTime,
            level: LEVELS[level] ?? 'log',
            message,
            data,
          };
          this.consoleLogs.push(entry);
          if (this.consoleLogs.length > 200) {
            this.consoleLogs = this.consoleLogs.slice(-100);
          }
          this.onLog(entry);
          if (bc && this.pluginKey) {
            bc.logStructured(this.pluginKey, entry.timestamp, level, message, jsonStr);
          }
        },
        set_val: (pathPtr: number, pathLen: number, valHandle: number) => {
          if (bc && this.pluginKey) {
            // Direct commit — no JSON serialization round-trip
            const path = pathLen > 0 ? this.readString(pathPtr, pathLen) : '';
            bc.commitVal(this.pluginKey, path, valHandle);
            this.pluginState = bc.getPluginState(this.pluginKey);
          } else {
            const value = this._valStore.get(valHandle);
            if (value === undefined) return;
            if (pathLen === 0) {
              this.pluginState = value;
            } else {
              const path = this.readString(pathPtr, pathLen);
              const keys = path.replace(/^\//, '').split('/');
              let obj = this.pluginState;
              for (let i = 0; i < keys.length - 1; i++) {
                if (!(keys[i] in obj)) obj[keys[i]] = {};
                obj = obj[keys[i]];
              }
              obj[keys[keys.length - 1]] = value;
            }
          }
          this.onStateChange(this.pluginState);
        },
        mark_gpu_dirty: (pathPtr: number, pathLen: number) => {
          const path = pathLen > 0 ? this.readString(pathPtr, pathLen) : '';
          this.pendingDirtyPaths.push(path);
        },
        set_gpu_buffer: (pathPtr: number, pathLen: number, bufferHandle: number) => {
          const path = pathLen > 0 ? this.readString(pathPtr, pathLen) : '';
          const prev = this.gpuBufferFields.get(path) ?? 0;
          if (prev !== bufferHandle) {
            this.gpuBufferFields.set(path, bufferHandle);
          }
          // Dirty fires every call — producer convention is to elide this
          // call on frames where the buffer is reused, so reaching here
          // means the consumer should re-resolve.
          this.pendingDirtyPaths.push(path);
        },
        set_gpu_texture: (pathPtr: number, pathLen: number, textureHandle: number) => {
          const path = pathLen > 0 ? this.readString(pathPtr, pathLen) : '';
          const prev = this.textureFields.get(path) ?? -1;
          if (prev !== textureHandle) {
            this.textureFields.set(path, textureHandle);
          }
          this.pendingDirtyPaths.push(path);
        },
        set_field_hidden: (pathPtr: number, pathLen: number, hidden: number) => {
          // UI-overlay only: the field's data path keeps working
          // (notifyStatePatched still routes to it, rails still bind to
          // it). The IDE inspector skips fields with hidden=true on the
          // next broadcastState. Effects use this to gate which params
          // appear under the current "mode" without reshaping their
          // schema or losing serialized state.
          const path = pathLen > 0 ? this.readString(pathPtr, pathLen) : '';
          const isHidden = hidden !== 0;
          // During a static visibility query, route into the scratch set and
          // leave the live overlay (and onSchemaChanged) untouched.
          if (this.evalHiddenScratch) {
            if (isHidden) this.evalHiddenScratch.add(path);
            else this.evalHiddenScratch.delete(path);
            return;
          }
          const wasHidden = this.hiddenFields.has(path);
          if (isHidden === wasHidden) return;
          if (isHidden) this.hiddenFields.add(path);
          else this.hiddenFields.delete(path);
          // Schema visibility propagates only via broadcastState, which
          // fires when the engine state is dirty — let the worker know.
          this.onSchemaChanged?.();
        },
        is_field_connected: (pathPtr: number, pathLen: number, direction: number): number => {
          // direction 0 → "is anyone WRITING this field" (input check).
          // direction 1 → "is anyone READING this field"  (output check).
          // The set is populated by the sketch executor each frame from
          // the chain entry's tap topology.
          const path = pathLen > 0 ? this.readString(pathPtr, pathLen) : '';
          if (direction === 0) return this.fieldsWithWriter.has(path) ? 1 : 0;
          if (direction === 1) return this.fieldsWithReader.has(path) ? 1 : 0;
          return 0;
        },
        will_render: (): number => {
          // False only when the executor is skipping render() this frame
          // because opacity is 0 (tick still runs). Set per-stage before tick.
          return this.willRender ? 1 : 0;
        },
        set_on_state_ready: (fnIdx: number) => {
          // Effect's `init()` registers a callback to be fired once
          // after init + initial state replay. Stored as a function
          // table index; dispatched by `fireStateReady()`.
          this.onStateReadyIdx = fnIdx | 0;
        },
        register_shader_spv: (namePtr: number, nameLen: number,
                               spvPtr: number, spvLen: number,
                               fmtPtr: number, fmtLen: number,
                               accPtr: number, accLen: number) => {
          // Snapshot the SPV bytes — the WASM linear memory will be
          // reused for other allocations and we want the registry to
          // outlive the call. Slice copies into a fresh buffer.
          const name = this.readString(namePtr, nameLen);
          const src = new Uint8Array(this.memory.buffer, spvPtr, spvLen);
          // Empty format = "sketch default": resolved at translation time
          // (fetchShaderWgsl) against the GPU host's working format, so a 16F
          // sketch gets rgba16float storage decls. Effects that need a pinned
          // format pass it explicitly (or via [[vk::image_format]]).
          const storageFormat = fmtLen > 0 ? this.readString(fmtPtr, fmtLen) : '';
          const storageAccess = accLen > 0 ? this.readString(accPtr, accLen) : 'write';
          this.shaderSPV.set(name, {
            bytes: new Uint8Array(src), // copy
            storageFormat,
            storageAccess,
          });
        },
        register_fusion_by_name: (kind: number,
                                   namePtr: number, nameLen: number,
                                   uniformBufHandle: number,
                                   uniformSize: number,
                                   prepareIdx: number) => {
          // Name-based variant — the fragment SPV must already live
          // in `shaderSPV` under this name (registered earlier via
          // state::registerShaderSPV). WGSL is fetched lazily from
          // the naga endpoint by getFusionFragmentWgsl().
          this.fusionKind = kind | 0;
          this.fusionFragmentName = nameLen > 0 ? this.readString(namePtr, nameLen) : '';
          this.fusionFragmentWgslCached = null;
          this.fusionUniformBufferHandle = uniformBufHandle | 0;
          this.fusionUniformSize = uniformSize | 0;
          this.fusionPrepareIdx = prepareIdx | 0;
        },
        read: (layoutPtr: number, fieldCount: number, pathsPtr: number,
               outputPtr: number, outputSize: number, resultsPtr: number): number => {
          // Read state from bridge core if available, else use local
          const stateSource = (bc && this.pluginKey)
            ? bc.getPluginState(this.pluginKey)
            : this.pluginState;

          const mem = new DataView(this.memory.buffer);
          const bytes = new Uint8Array(this.memory.buffer);
          let overflowCount = 0;

          const FIELD_SIZE = 20;
          const RESULT_SIZE = 8;

          for (let i = 0; i < fieldCount; i++) {
            const fOff = layoutPtr + i * FIELD_SIZE;
            const pathOffset = mem.getInt32(fOff, true);
            const pathLen = mem.getInt32(fOff + 4, true);
            const type = mem.getInt32(fOff + 8, true);
            const bufOffset = mem.getInt32(fOff + 12, true);
            const capacity = mem.getInt32(fOff + 16, true);

            const rOff = resultsPtr + i * RESULT_SIZE;

            const pathStr = decoder.decode(bytes.slice(pathsPtr + pathOffset, pathsPtr + pathOffset + pathLen));

            let val: any = stateSource;
            if (pathStr.length > 0) {
              const tokens = pathStr.split('/').filter(t => t !== '');
              for (const token of tokens) {
                if (val == null) { val = undefined; break; }
                val = val[token];
              }
            }

            if (val === undefined || val === null) {
              bytes[rOff] = 0;
              bytes[rOff + 1] = 0;
              mem.setInt32(rOff + 4, 0, true);
              continue;
            }

            bytes[rOff] = 1;
            const absOff = outputPtr + bufOffset;

            if (type === 0) { // JDOC_F64
              mem.setFloat64(absOff, Number(val), true);
              bytes[rOff + 1] = 0;
              mem.setInt32(rOff + 4, 8, true);
            } else if (type === 1) { // JDOC_I32
              mem.setInt32(absOff, Number(val), true);
              bytes[rOff + 1] = 0;
              mem.setInt32(rOff + 4, 4, true);
            } else if (type === 3) { // JDOC_BOOL
              mem.setInt32(absOff, val ? 1 : 0, true);
              bytes[rOff + 1] = 0;
              mem.setInt32(rOff + 4, 4, true);
            } else if (type === 5 && Array.isArray(val)) { // JDOC_ARRAY_I32
              const actualCount = val.length;
              const writeCount = Math.min(actualCount, capacity);
              mem.setInt32(absOff, writeCount, true);
              for (let j = 0; j < writeCount; j++) {
                mem.setInt32(absOff + 4 + j * 4, Number(val[j]), true);
              }
              const overflowed = actualCount > capacity ? 1 : 0;
              bytes[rOff + 1] = overflowed;
              if (overflowed) overflowCount++;
              mem.setInt32(rOff + 4, actualCount, true);
            } else if (type === 4 && Array.isArray(val)) { // JDOC_ARRAY_F64
              const actualCount = val.length;
              const writeCount = Math.min(actualCount, capacity);
              mem.setInt32(absOff, writeCount, true);
              for (let j = 0; j < writeCount; j++) {
                mem.setFloat64(absOff + 4 + j * 8, Number(val[j]), true);
              }
              const overflowed = actualCount > capacity ? 1 : 0;
              bytes[rOff + 1] = overflowed;
              if (overflowed) overflowCount++;
              mem.setInt32(rOff + 4, actualCount, true);
            }
          }
          return overflowCount;
        },
        get_patch: (index: number) => {
          if (index < 0 || index >= this.pendingPatches.length) return 0;
          const patch = this.pendingPatches[index];
          if (bc) {
            // Build patch object as bridge core val handles
            const obj = bc.valObject();
            const opH = bc.valString(patch.op);
            bc.valSet(obj, 'op', opH);
            bc.valRelease(opH);
            const pathH = bc.valString(patch.path);
            bc.valSet(obj, 'path', pathH);
            bc.valRelease(pathH);
            if (patch.value !== undefined) {
              // Serialize value through JSON for complex types
              const valJson = JSON.stringify(patch.value);
              const valStr = bc.valString(valJson);
              // Parse it back — we need the actual value, not a string
              // Use a simpler approach: allocate based on type
              bc.valRelease(valStr);
              const valH = this.jsValueToBcVal(bc, patch.value);
              bc.valSet(obj, 'value', valH);
              bc.valRelease(valH);
            }
            return obj;
          }
          return this._valStore.alloc(patch);
        },
      },
      // Legacy: no module uses io.declare_*() anymore (all use set_schema).
      // Imports must exist so old WASM modules don't fail to instantiate.
      io: {
        declare_texture_input: () => {},
        declare_texture_output: () => {},
        declare_data_output: () => {},
      },
      val: (() => {
        // Handle-based value container. When bridge core is available, val handles
        // live in bridge core's WASM memory (nlohmann::json). Otherwise, fall back
        // to the local JS _valStore.
        if (bc) {
          return {
            null: () => bc.valNull(),
            bool: (v: number) => bc.valBool(v !== 0),
            number: (v: number) => bc.valNumber(v),
            string: (ptr: number, len: number) => bc.valString(this.readString(ptr, len)),
            array: () => bc.valArray(),
            object: () => bc.valObject(),
            type_of: (h: number) => bc.valTypeOf(h),
            as_number: (h: number) => bc.valAsNumber(h),
            as_bool: (h: number) => bc.valAsBool(h) ? 1 : 0,
            as_string: (h: number, bufPtr: number, bufLen: number) => {
              const s = bc.valAsString(h);
              return s.length > 0 ? this.writeString(bufPtr, bufLen, s) : 0;
            },
            get: (objH: number, keyPtr: number, keyLen: number) => {
              return bc.valGet(objH, this.readString(keyPtr, keyLen));
            },
            set: (objH: number, keyPtr: number, keyLen: number, valH: number) => {
              bc.valSet(objH, this.readString(keyPtr, keyLen), valH);
            },
            keys_count: (h: number) => bc.valKeysCount(h),
            key_at: (h: number, index: number, bufPtr: number, bufLen: number) => {
              const key = bc.valKeyAt(h, index);
              return key.length > 0 ? this.writeString(bufPtr, bufLen, key) : 0;
            },
            get_index: (arrH: number, index: number) => bc.valGetIndex(arrH, index),
            push: (arrH: number, valH: number) => { bc.valPush(arrH, valH); },
            length: (h: number) => bc.valLength(h),
            release: (h: number) => { bc.valRelease(h); },
            to_json: (h: number, bufPtr: number, bufLen: number) => {
              const json = bc.valToJson(h);
              return json.length > 0 ? this.writeString(bufPtr, bufLen, json) : 0;
            },
          };
        }
        // Fallback: local JS val store (no bridge core)
        const valStore = this._valStore;
        const alloc = valStore.alloc.bind(valStore);
        const getVal = valStore.get.bind(valStore);
        return {
          null: () => alloc(null),
          bool: (v: number) => alloc(v !== 0),
          number: (v: number) => alloc(v),
          string: (ptr: number, len: number) => alloc(this.readString(ptr, len)),
          array: () => alloc([]),
          object: () => alloc({}),
          type_of: (h: number) => {
            const v = getVal(h);
            if (v === null || v === undefined) return 0;
            if (typeof v === 'boolean') return 1;
            if (typeof v === 'number') return 2;
            if (typeof v === 'string') return 3;
            if (Array.isArray(v)) return 4;
            if (typeof v === 'object') return 5;
            return 0;
          },
          as_number: (h: number) => {
            const v = getVal(h);
            if (typeof v === 'number') return v;
            // Coerce booleans so `state::patchFloat(i)` on a bool patch
            // returns 1.0/0.0 instead of always 0 — otherwise effects
            // can't read their boolField patches via the float path,
            // and the schema-typed bool patches get silently dropped.
            if (typeof v === 'boolean') return v ? 1 : 0;
            return 0;
          },
          as_bool: (h: number) => { const v = getVal(h); return v ? 1 : 0; },
          as_string: (h: number, bufPtr: number, bufLen: number) => {
            const v = getVal(h);
            return typeof v === 'string' ? this.writeString(bufPtr, bufLen, v) : 0;
          },
          get: (objH: number, keyPtr: number, keyLen: number) => {
            const obj = getVal(objH);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0;
            const key = this.readString(keyPtr, keyLen);
            return key in obj ? alloc(obj[key]) : 0;
          },
          set: (objH: number, keyPtr: number, keyLen: number, valH: number) => {
            const obj = getVal(objH);
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
            const key = this.readString(keyPtr, keyLen);
            obj[key] = getVal(valH);
            // set CONSUMES the child handle. Without releasing it, every
            // intermediate val (number/object/array/...) built into a published
            // tree leaks in _valStore — the effect only releases the ROOT — so a
            // busy per-frame publisher (control.nanolooper) grows the store every
            // frame until the worker OOMs and the executor stops. Mirrors the C++
            // WasmContext::set_val_member consume semantics.
            if (valH !== objH) valStore.release(valH);
          },
          keys_count: (h: number) => {
            const v = getVal(h);
            return (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).length : 0;
          },
          key_at: (h: number, index: number, bufPtr: number, bufLen: number) => {
            const v = getVal(h);
            if (!v || typeof v !== 'object' || Array.isArray(v)) return 0;
            const keys = Object.keys(v);
            if (index < 0 || index >= keys.length) return 0;
            return this.writeString(bufPtr, bufLen, keys[index]);
          },
          get_index: (arrH: number, index: number) => {
            const arr = getVal(arrH);
            if (!Array.isArray(arr) || index < 0 || index >= arr.length) return 0;
            return alloc(arr[index]);
          },
          push: (arrH: number, valH: number) => {
            const arr = getVal(arrH);
            if (!Array.isArray(arr)) return;
            arr.push(getVal(valH));
            // push CONSUMES the child handle — see `set` above.
            if (valH !== arrH) valStore.release(valH);
          },
          length: (h: number) => {
            const v = getVal(h);
            return Array.isArray(v) ? v.length : 0;
          },
          release: (h: number) => { valStore.release(h); },
          to_json: (h: number, bufPtr: number, bufLen: number) => {
            const v = getVal(h);
            if (v === undefined) return 0;
            return this.writeString(bufPtr, bufLen, JSON.stringify(v));
          },
        };
      })(),
      // On a SCHEMA-ONLY host (no gpuHost — the bundle warm-up describes) the
      // WHOLE gpu import module is Proxy-wrapped so ANY name resolves: a
      // hand-kept stub list silently rotted when the gpu ABI grew
      // (create_instanced_render_pso_blend_layout), LinkError'ing three
      // bundles out of discovery — no schemas, no generator roles, no palette
      // entries, no thumbnails. The fallback is a no-op returning -1; spreads
      // can't carry a Proxy's get trap, hence the wrap at this outer level.
      gpu: ((gpuImports: WebAssembly.ModuleImports) =>
        this.gpuHost
          ? gpuImports
          : new Proxy(gpuImports, { get: (t, name: string) => (name in t ? (t as any)[name] : () => -1) }))({
        ...(this.gpuHost
          ? {
              ...this.gpuHost.buildImports(
                (ptr, len) => new Uint8Array(this.memory.buffer).slice(ptr, ptr + len),
                (ptr, len) => decoder.decode(new Uint8Array(this.memory.buffer, ptr, len)),
              ),
              // Override the gpu-host's stub for this import: the
              // SPV → WGSL plumbing lives on the WasmHost since the
              // shaderSPV registry is per-WasmHost.
              create_shader_module_named: (namePtr: number, nameLen: number) => {
                const name = this.readString(namePtr, nameLen);
                return this.createShaderModuleByName(name);
              },
              // Override the gpu-host stub: poll_readback must write the latest
              // completed snapshot into wasm linear memory (re-derive the view
              // every call — memory may have grown). Returns bytes copied.
              poll_readback: (buf: number, destPtr: number, byteLen: number) => {
                const gh = this.gpuHost;
                if (!gh) return 0;
                const { bytes, len } = gh.getReadback(buf);
                if (!bytes || len <= 0) return 0;
                const n = Math.min(byteLen, len);
                new Uint8Array(this.memory.buffer, destPtr, n).set(bytes.subarray(0, n));
                return n;
              },
            }
          : {
              // Stubs if no GPU host (see the Proxy wrap on the whole `gpu`
              // object below — this explicit list only keeps tuned return
              // values; unknown names fall through to the () => -1 fallback).
              get_backend: () => -1,
              create_shader_module_named: () => -1,
              create_buffer: () => -1,
              create_texture: () => -1,
              create_texture_3d: () => -1,
              create_texture_mips: () => -1,
              compute_set_texture_mip: () => {},
              create_sampler: () => -1,
              create_compute_pso_v2: () => -1,
              create_render_pso_layout: () => -1,
              create_instanced_render_pso_layout: () => -1,
              create_instanced_render_pso_mrt_layout: () => -1,
              write_buffer: () => {},
              request_readback: () => {},
              poll_readback: () => 0,
              begin_compute_pass: () => -1,
              compute_set_pso: () => {},
              compute_set_buffer: () => {},
              compute_set_texture: () => {},
              compute_set_sampler: () => {},
              compute_dispatch: () => {},
              end_compute_pass: () => {},
              begin_render_pass: () => -1,
              begin_render_pass_mrt: () => -1,
              render_set_pso: () => {},
              render_set_vertex_buffer: () => {},
              render_set_buffer: () => {},
              render_draw: () => {},
              end_render_pass: () => {},
              submit: () => {},
              get_render_target: () => -1,
              get_render_target_width: () => 0,
              get_render_target_height: () => 0,
              release: () => {},
              clear_texture: () => {},
              copy_texture: () => {},
            }),
        // Input texture API (for chaining modules)
        get_input_texture: (index: number) =>
          (index >= 0 && index < this.inputTextureHandles.length) ? this.inputTextureHandles[index] : -1,
        get_input_texture_count: () => this.inputTextureHandles.length,
        // Unified texture access by field path
        texture_for_field: (pathPtr: number, pathLen: number) => {
          const path = this.readString(pathPtr, pathLen);
          return this.textureFields.get(path) ?? -1;
        },
        // GPU buffer access by field path — mirrors texture_for_field.
        // Returns 0 when unassigned (convention for gpu::Buffer::valid()).
        buffer_for_field: (pathPtr: number, pathLen: number) => {
          const path = this.readString(pathPtr, pathLen);
          return this.gpuBufferFields.get(path) ?? 0;
        },
      }),
      // text — host text shaping/rendering service. Delegates to the shared
      // TextEngine (one text_engine.wasm + the WebGPU MSDF compositor). Must be
      // initialized (TextEngine.init) before any effect that uses text renders.
      text: {
        layout: (specPtr: number, specLen: number): number => {
          const te = TextEngine.instance;
          if (!te) return 0;
          const spec = this.readString(specPtr, specLen);
          // Font resolution / layout must never trap the calling effect (that
          // would abort its render and leave stale output). Scan failures are
          // non-fatal (the frame falls back to bundled fonts); a layout error
          // returns 0 so the effect simply skips this frame.
          try { te.ensureFontsForSpec(spec); }
          catch (e) { console.warn('[text] font scan failed', e); }
          try { return te.layout(spec); }
          catch (e) { console.warn('[text] layout failed', e); return 0; }
        },
        measure: (id: number, outPtr: number): number => {
          const te = TextEngine.instance;
          if (!te) return 0;
          const bytes = te.measureBytes(id);          // 32-byte TextMetrics
          new Uint8Array(this.memory.buffer).set(bytes, outPtr);
          return 1;
        },
        render: (id: number, targetTex: number, bgTex: number, xformPtr: number, xformLen: number): void => {
          const te = TextEngine.instance;
          if (!te || !this.gpuHost) return;
          const target = this.gpuHost.getTextureByHandle(targetTex);
          if (!target) return;
          // Background sampled behind the text: a caller-supplied input texture
          // (overlay), else null → the engine's 1×1 opaque-black fallback. Must
          // differ from the target (WebGPU forbids same-texture read+write).
          const bg = (bgTex >= 0 && bgTex !== targetTex)
            ? this.gpuHost.getTextureByHandle(bgTex)
            : null;
          let ox = 0, oy = 0;
          if (xformLen > 0) {
            try { const x = JSON.parse(this.readString(xformPtr, xformLen)); ox = x.x ?? 0; oy = x.y ?? 0; } catch { /* default */ }
          }
          te.render(id, target, ox, oy, bg);
        },
        // Escape hatch (Phase 2): expose the shared atlas + positioned glyphs.
        atlas: (_id: number): number => -1,
        glyphs: (_id: number, _outPtr: number, _outBytes: number): number => 0,
        release: (id: number): void => { TextEngine.instance?.release(id); },
      },
      module: {
        // Name-keyed effect registration (mirror of the native host_functions.cpp
        // module_register_effect_* handlers). The effect descriptor is NOT a
        // fixed-layout struct here: each metadata string and lifecycle callback
        // is registered by string name, so a new hook or field needs no byte-
        // offset/version change on this boundary.
        register_effect_begin: (): number => {
          const handle = this.nextEffectBuilder++;
          this.effectBuilders.set(handle, { meta: new Map(), fns: new Map() });
          return handle;
        },
        register_effect_str: (handle: number, namePtr: number, nameLen: number,
                              valPtr: number, valLen: number): void => {
          const b = this.effectBuilders.get(handle);
          if (!b) return;
          b.meta.set(this.readString(namePtr, nameLen), this.readString(valPtr, valLen));
        },
        register_effect_fn: (handle: number, namePtr: number, nameLen: number,
                             fnIdx: number): void => {
          const b = this.effectBuilders.get(handle);
          if (!b || fnIdx === 0) return; // null callback == "not provided"
          const name = this.readString(namePtr, nameLen);
          if (name) b.fns.set(name, fnIdx >>> 0);
        },
        register_effect_end: (handle: number): void => {
          const b = this.effectBuilders.get(handle);
          if (!b) return;
          this.effectBuilders.delete(handle);
          const keywords = b.meta.get('keywords') ?? '';
          this.registeredEffects.push({
            id: b.meta.get('id') ?? '',
            name: b.meta.get('name') ?? '',
            description: b.meta.get('description') ?? '',
            category: b.meta.get('category') ?? '',
            keywords: keywords.split(',').filter(k => k.length > 0),
            // Optional picker glyph — kept raw here (an untrusted wasm string);
            // the UI sanitizes/validates it at render (see effect-glyph.ts).
            icon: b.meta.get('icon') || undefined,
            thumbnail: b.meta.get('thumbnail') || undefined,
            _fns: b.fns,
          });
        },
      },
    };

    this.instance = await WebAssembly.instantiate(compiled, importObject);
    this.memory = this.instance.exports.memory as WebAssembly.Memory;

    // Initialize WASI runtime (C++ static constructors, etc.)
    const _initialize = this.instance.exports._initialize as (() => void) | undefined;
    if (_initialize) _initialize();

    // Read the host<->effect ABI version BEFORE nano_module_main as a coarse
    // compatibility signal (it no longer gates descriptor layout). Absent
    // export (legacy bundle) → 0.
    const abiVersionFn = this.instance.exports.nano_abi_version as (() => number) | undefined;
    this.abiVersion = abiVersionFn ? (abiVersionFn() | 0) : 0;

    // Call nano_module_main to discover registered effects
    const nanoMain = this.instance.exports.nano_module_main as (() => void) | undefined;
    if (nanoMain) {
      nanoMain();
    }
  }

  /**
   * Activate a specific effect from those registered during load().
   * Calls the effect's init() via the function table and returns a
   * WasmModule interface that dispatches through the table.
   */
  /**
   * Resolve an effect's name-keyed callbacks to indirect-table functions. The
   * returned `fn(name)` yields the function or undefined when the effect didn't
   * register that name ("not provided"). Throws if the effect id is unknown.
   */
  private effectFns(effectId: string): {
    effect: EffectInfo;
    fn: <T>(name: string) => T | undefined;
  } {
    const effect = this.registeredEffects.find(e => e.id === effectId);
    if (!effect) {
      throw new Error(`Effect "${effectId}" not found. Available: ${this.registeredEffects.map(e => e.id).join(', ')}`);
    }
    const table = this.instance.exports.__indirect_function_table as WebAssembly.Table;
    const fn = <T>(name: string): T | undefined => {
      const idx = effect._fns.get(name);
      return idx ? (table.get(idx) as T) : undefined;
    };
    return { effect, fn };
  }

  /**
   * Run an effect's TYPE-LEVEL setup WITHOUT creating an instance: `module_init`
   * (once per type) publishes the schema via the `set_schema` host import, which
   * registers the plugin (schema + capabilities + `<id>@0` pluginKey + schema-
   * derived default state) in bridge core — everything the editor needs to show
   * the palette/inspector and resolve drop-time defaults. Also resolves the
   * self-less `eval_visibility` evaluator so this host can answer static
   * visibility queries. `create()`/`init()` are NOT called — there is no live
   * instance until `activateEffect`. Idempotent per effect id.
   *
   * This is the cheap path for schema discovery (bundle warmup) and for static
   * visibility hosts: neither needs a rendering instance.
   */
  describeEffect(effectId: string): void {
    const { effect, fn } = this.effectFns(effectId);
    if (!this.moduleInitedIds.has(effect.id)) {
      const moduleInitFn = fn<() => void>('module_init');
      if (moduleInitFn) moduleInitFn();
      this.moduleInitedIds.add(effect.id);
    }
    // Static (self-less) visibility evaluator — type-level, stored on the host
    // so `evaluateVisibility()` can run it against an arbitrary candidate state.
    this.evalVisibilityFn = fn<
      (n: number, pb: number, off: number, len: number, ops: number) => void>('eval_visibility') ?? null;
  }

  activateEffect(effectId: string): WasmModule {
    // Type-level setup first (module_init publishes the schema; resolves the
    // visibility evaluator). Skips module_init if a prior describeEffect/
    // activateEffect already ran it on this host.
    this.describeEffect(effectId);
    const { fn } = this.effectFns(effectId);

    // Class-like instance ABI: (module_init, above) → create() → init(self),
    // then instance callbacks thread self.
    let self = 0;
    const createFn = fn<() => number>('create');
    if (createFn) self = createFn() | 0;
    this.activeSelf = self;

    const initFn = fn<(self: number) => void>('init');
    const tickFn = fn<(self: number, dt: number) => void>('tick');
    const renderFn = fn<(self: number, vpW: number, vpH: number) => void>('render');
    const onStatePatchedFn = fn<
      (self: number, n: number, pb: number, off: number, len: number, ops: number) => void>('on_state_patched');
    // Optional hooks: absent from the name map => the effect doesn't provide
    // them (is_identity never skippable, no on_active, not seekable).
    const isIdentityFn = fn<(self: number) => number>('is_identity');
    const onActiveFn = fn<(self: number, active: number) => void>('on_active');
    const seekFn = fn<(self: number, from: number, to: number) => void>('seek');
    // (eval_visibility resolved type-level in describeEffect, above.)

    // Call init immediately, threading the instance's self pointer.
    if (initFn) initFn(self);

    return {
      init: () => {}, // Already called
      tick: (dt: number) => tickFn?.(self, dt),
      render: (vpW: number, vpH: number) => renderFn?.(self, vpW, vpH),
      onStatePatched: (n: number, pb: number, off: number, len: number, ops: number) =>
        onStatePatchedFn?.(self, n, pb, off, len, ops),
      isIdentity: () => isIdentityFn ? (isIdentityFn(self) | 0) !== 0 : false,
      onActive: onActiveFn ? (active: boolean) => onActiveFn!(self, active ? 1 : 0) : undefined,
      seek: seekFn ? (from: number, to: number) => seekFn!(self, from, to) : undefined,
    };
  }

  /**
   * Activate a module that registered zero effects (a "service" module).
   * Returns the underlying instance + memory so the caller can invoke
   * exports directly. Used by the DXV decoder, which exposes a small
   * C ABI (dxv_parse_container, dxv_decode_frame, etc.) instead of the
   * effect init/tick/render lifecycle.
   *
   * Any SPV shaders the module registered in nano_module_main are
   * already in this.shaderSPV at this point and resolve through the
   * usual createShaderModuleByName() path.
   */
  activateServiceModule(): { instance: WebAssembly.Instance; memory: WebAssembly.Memory } {
    return { instance: this.instance, memory: this.memory };
  }

  /**
   * Fire the `on_state_ready` callback the effect registered in its
   * `init()` (via `state::setOnStateReady`). Callers should invoke
   * this once per instance, after the initial state replay (or
   * immediately after `activateEffect` if no state needs replaying).
   * Idempotent — subsequent calls are no-ops.
   */
  fireStateReady() {
    if (this.stateReadyFired) return;
    this.stateReadyFired = true;
    if (!this.onStateReadyIdx) return;
    const table = this.instance.exports.__indirect_function_table as WebAssembly.Table;
    const fn = table.get(this.onStateReadyIdx) as ((self: number) => void) | null;
    if (fn) fn(this.activeSelf);
  }

  /**
   * Get the WGSL form of a registered shader by name. Synchronous —
   * uses an XHR with async=false. Caches per-name. The optional
   * `mode` selects the naga post-process: 'compute' returns the
   * shader as-is (with rgba8unorm,write storage texture fixup);
   * 'pixel' additionally runs the fragment strip pass so the result
   * contains only the named functions + uniform struct (no synthetic
   * main, no _fuse_out binding) — what the fusion dispatcher needs
   * to splice into a composed shader.
   */
  fetchShaderWgsl(name: string, mode: 'compute' | 'pixel' = 'compute'): string | null {
    const entry = this.shaderSPV.get(name);
    if (!entry) {
      console.error(`[wasm-host] shader '${name}' not registered (state::registerShaderSPV missing?)`);
      return null;
    }
    // The SPV→WGSL naga translation is a PURE function of (bytes, storageFormat,
    // storageAccess, mode), so cache it GLOBALLY by content. Each effect instance is
    // a fresh WasmHost whose per-host cache starts empty, and the translation is a
    // SYNCHRONOUS XHR to the dev-server naga bridge — so re-instantiating a heavy
    // effect (e.g. a shape_fold clip the playhead re-enters) re-blocked the worker on
    // several round-trips (~½s+). Same SPV ⇒ same WGSL, so a content hash is a safe key
    // shared across all host instances; the first translation pays, every later one is free.
    // Resolve the sketch-default sentinel ('' — see register_shader_spv) to a
    // concrete format NOW, so the cache key + bridge request carry it and 8-bit
    // vs 16F variants of the same SPV coexist in the global cache.
    const storageFormat = entry.storageFormat
      || (this.gpuHost?.getDefaultFormatCode() === 3 ? 'rgba16float' : 'rgba8unorm');
    const key = `${entry.bytes.length}:${fnv1a32(entry.bytes)}:${storageFormat}:${entry.storageAccess}:${mode}`;
    const cached = WasmHost.spvWgslCache.get(key);
    if (cached !== undefined) return cached;
    try {
      const xhr = new XMLHttpRequest();
      const url = `/__naga/wgsl?storageFormat=${encodeURIComponent(storageFormat)}&storageAccess=${encodeURIComponent(entry.storageAccess)}`;
      xhr.open('POST', url, /*async=*/false);
      // Note: synchronous XHR forbids setting responseType from a
      // document context (Workers tolerate it, but we run in tests
      // from a regular page). Default text behavior is fine — we
      // read xhr.responseText below.
      xhr.send(entry.bytes as Uint8Array<ArrayBuffer>);
      if (xhr.status !== 200) {
        console.error(`[wasm-host] naga bridge returned ${xhr.status} for shader '${name}': ${xhr.responseText}`);
        return null;
      }
      let wgsl = xhr.responseText;
      if (mode === 'pixel') wgsl = stripFragmentMain(wgsl);
      WasmHost.spvWgslCache.set(key, wgsl);
      return wgsl;
    } catch (err) {
      console.error(`[wasm-host] naga bridge fetch failed for shader '${name}':`, err);
      return null;
    }
  }

  /**
   * Resolve a name registered via `state::registerShaderSPV` to a real
   * WebGPU shader module: fetches WGSL from the dev-server's naga
   * endpoint (`/__naga/wgsl`) using a synchronous XHR (workers and
   * test pages tolerate it; the call is one-shot per shader name and
   * happens during `init`, not in the hot loop), then hands the WGSL
   * to the gpu-host to compile. Returns the gpu-host handle, or -1
   * if the registry doesn't have the name.
   *
   * Caches WGSL per-name so a second createShaderModuleByName call
   * with the same name skips the fetch entirely.
   */
  createShaderModuleByName(name: string): number {
    if (!this.gpuHost) return -1;
    let wgsl = this.shaderWgslCache.get(name);
    if (!wgsl) {
      const fetched = this.fetchShaderWgsl(name, 'compute');
      if (!fetched) return -1;
      wgsl = fetched;
      this.shaderWgslCache.set(name, wgsl);
    }
    return this.gpuHost.createShaderModule(wgsl);
  }

  /**
   * Resolve the fusion fragment WGSL for this host. Used by the
   * fusion dispatcher when composing a fused shader: the registered
   * fragment name resolves to SPV → WGSL via the naga endpoint, with
   * the result lazily cached.
   */
  getFusionFragmentWgsl(): string {
    if (this.fusionFragmentWgslCached !== null) return this.fusionFragmentWgslCached;
    if (this.fusionFragmentName) {
      const wgsl = this.fetchShaderWgsl(this.fusionFragmentName, 'pixel');
      this.fusionFragmentWgslCached = wgsl ?? '';
      return this.fusionFragmentWgslCached;
    }
    return '';
  }

  /**
   * Invoke the `prepare(vp_w, vp_h)` callback the effect registered via
   * `state::registerFusion`. Used by the fusion dispatcher in place of
   * the effect's `render()` — `prepare` updates the uniform buffer
   * without dispatching, then the fused dispatch encodes one combined
   * compute pass over all the run's stages.
   *
   * No-op when the effect didn't register a fusion class. Idempotent.
   */
  firePrepare(vpW: number, vpH: number) {
    if (!this.fusionPrepareIdx) return;
    const table = this.instance.exports.__indirect_function_table as WebAssembly.Table;
    const fn = table.get(this.fusionPrepareIdx) as ((self: number, w: number, h: number) => void) | null;
    if (fn) fn(this.activeSelf, vpW, vpH);
  }

  /**
   * Drain any GPU "dirty" notifications buffered since the last call.
   * Each returned entry is a path whose owner called state::markGpuDirty
   * or state::setGpuBuffer. Callers should merge these into the patch
   * stream as {op: "dirty", path, value: {}} entries before invoking
   * notifyStatePatched, so downstream modules observe them.
   */
  drainDirtyPatches(): PatchOp[] {
    if (this.pendingDirtyPaths.length === 0) return [];
    const seen = new Set<string>();
    const out: PatchOp[] = [];
    for (const p of this.pendingDirtyPaths) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push({ op: 'dirty', path: p, value: {} });
    }
    this.pendingDirtyPaths = [];
    return out;
  }

  /**
   * Produce a copy of `state` with GPU-array leaves stripped (set to 0),
   * based on the module's schema. Used when serializing state across a
   * boundary where GPU handles are meaningless (worker postMessage,
   * persistence, etc.).
   */
  stripGpuFieldsForSerialization(state: any): any {
    return stripGpuFields(state, this.schema);
  }

  /**
   * Notify the module of state changes with full patch details.
   * If the module exports on_state_patched, marshals patch data into WASM memory.
   * Falls back to no-op if module doesn't export on_state_patched.
   */
  notifyStatePatched(module: WasmModule, patches: PatchOp[]) {
    if (patches.length === 0) return;
    this.dispatchPatches(patches, (n, pb, off, len, ops) =>
      module.onStatePatched(n, pb, off, len, ops));
  }

  /**
   * Marshal `patches` into WASM memory (paths buffer + offsets/lengths/ops
   * arrays) and the value-accessor (`pendingPatches`, served by
   * `state.get_patch`), invoke `dispatch` with the marshaled pointers, then
   * free everything. Shared by `notifyStatePatched` (instance on_state_patched)
   * and `evaluateVisibility` (the self-less static visibility evaluator).
   */
  private dispatchPatches(
    patches: PatchOp[],
    dispatch: (n: number, pb: number, off: number, len: number, ops: number) => void,
  ) {
    // Store patches for state.get_patch() value access.
    this.pendingPatches = patches;

    const encoder = new TextEncoder();
    const pathStrings = patches.map(p => encoder.encode(p.path));
    const totalPathBytes = pathStrings.reduce((sum, s) => sum + s.length, 0);

    const malloc = this.instance.exports.malloc as ((size: number) => number) | undefined;
    const free = this.instance.exports.free as ((ptr: number) => void) | undefined;

    if (!malloc || !free) {
      this.pendingPatches = [];
      return;
    }

    const n = patches.length;
    const pathsBufPtr = malloc(totalPathBytes);
    const offsetsPtr = malloc(n * 4);
    const lengthsPtr = malloc(n * 4);
    const opsPtr = malloc(n * 4);

    const mem = new Uint8Array(this.memory.buffer);
    const view = new DataView(this.memory.buffer);

    let pathOffset = 0;
    for (let i = 0; i < n; i++) {
      mem.set(pathStrings[i], pathsBufPtr + pathOffset);
      view.setInt32(offsetsPtr + i * 4, pathOffset, true);
      view.setInt32(lengthsPtr + i * 4, pathStrings[i].length, true);

      // Map op string to int
      let opCode = 2; // replace
      const op = patches[i].op;
      if (op === 'add') opCode = 0;
      else if (op === 'remove') opCode = 1;
      else if (op === 'replace') opCode = 2;
      else if (op === 'move') opCode = 3;
      else if (op === 'copy') opCode = 4;
      else if (op === 'dirty') opCode = 5;
      view.setInt32(opsPtr + i * 4, opCode, true);

      pathOffset += pathStrings[i].length;
    }

    dispatch(n, pathsBufPtr, offsetsPtr, lengthsPtr, opsPtr);

    free(pathsBufPtr);
    free(offsetsPtr);
    free(lengthsPtr);
    free(opsPtr);

    this.pendingPatches = [];
  }

  /**
   * STATIC visibility query: resolve which fields the effect hides for a given
   * candidate `state`, WITHOUT a live instance executing. The effect's
   * registered `eval_visibility` (self-less, pure over state) is run against the
   * state marshaled as replace-patches; its `set_field_hidden` calls are
   * captured into a scratch set (the host's live `hiddenFields` is untouched).
   * Returns the hidden field names, or `null` if this effect declared no static
   * evaluator (the caller should then fall back to live/last-known visibility).
   */
  evaluateVisibility(state: Record<string, unknown>): string[] | null {
    if (!this.evalVisibilityFn) return null;
    const patches: PatchOp[] = Object.entries(state)
      // Skip UI-only / internal keys (e.g. `__ui_only__`) — they never gate
      // visibility and would needlessly vary the query.
      .filter(([k]) => !k.startsWith('__'))
      .map(([path, value]) => ({ op: 'replace', path, value }));
    const scratch = new Set<string>();
    this.evalHiddenScratch = scratch;
    try {
      // An empty candidate state still resolves defaults: dispatch a single
      // no-op (the evaluator defaults every gating field itself).
      if (patches.length === 0) {
        this.evalVisibilityFn(0, 0, 0, 0, 0);
      } else {
        this.dispatchPatches(patches, (n, pb, off, len, ops) =>
          this.evalVisibilityFn!(n, pb, off, len, ops));
      }
    } catch (err) {
      console.warn('[wasm-host] evaluateVisibility threw:', err);
    } finally {
      this.evalHiddenScratch = null;
    }
    return [...scratch];
  }
}
