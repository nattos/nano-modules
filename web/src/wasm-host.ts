import type { DrawCmd } from './gpu-renderer';
import type { GPUHost } from './gpu-host';
import type { BridgeCore } from './bridge-core';
import { createWasiShim } from './wasi-shim';
import * as fakeResolume from './fake-resolume';

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
  onResolumeParam?(paramId: bigint, value: number): void;
}

/** Metadata for an effect discovered via nano_module_main registration. */
export interface EffectInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  keywords: string[];
  /** @internal function table indices */
  _initIdx: number;
  _tickIdx: number;
  _renderIdx: number;
  _onStatePatchedIdx: number;
  _onResolumeParamIdx: number; // 0 = not supported
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
  type: number;  // 0=boolean, 10=standard(float 0-1)
  defaultValue: number;
}

export type AudioCallback = (channel: number) => void;
export type StateChangeCallback = (state: any) => void;
export type LogCallback = (entry: ConsoleEntry) => void;

const decoder = new TextDecoder();
const LEVELS = ['log', 'warn', 'error'];

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

  /** The compiled WebAssembly.Module (for reuse across instances). */
  compiledModule: WebAssembly.Module | null = null;

  drawList: DrawCmd[] = [];
  frameState: FrameState = {
    elapsedTime: 0, deltaTime: 0, barPhase: 0, bpm: 120,
    viewportW: 0, viewportH: 0, params: new Array(16).fill(0),
  };

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

  // Paths pending a "dirty" notification. Drained by the sketch executor
  // and fed back into notifyStatePatched as dirty-op patches.
  pendingDirtyPaths: string[] = [];

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
      canvas: {
        fill_rect: (x: number, y: number, w: number, h: number,
                     r: number, g: number, b: number, a: number) => {
          this.drawList.push({ type: 'fill_rect', x, y, w, h, r, g, b, a });
        },
        draw_image: (texId: number, x: number, y: number, w: number, h: number) => {
          this.drawList.push({ type: 'draw_image', x, y, w, h, r: 1, g: 1, b: 1, a: 1, texId });
        },
        draw_text: (ptr: number, len: number, x: number, y: number, size: number,
                     r: number, g: number, b: number, a: number) => {
          const text = this.readString(ptr, len);
          this.drawList.push({ type: 'draw_text', x, y, w: 0, h: 0, r, g, b, a, text, fontSize: size });
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
      state: {
        // Legacy: no module uses this anymore (all use set_schema), but the import
        // must exist so old WASM modules don't fail to instantiate.
        declare_param: (_index: number, _namePtr: number, _nameLen: number,
                        _type: number, _defaultValue: number) => {},
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

            // Derive params and ioDecls from schema for backward compat
            this.params = [];
            this.ioDecls = [];
            let paramIdx = 0;
            for (const [name, field] of Object.entries(this.schema) as [string, any][]) {
              const ioFlags = field.io ?? 0;
              if (field.type === 'texture') {
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
                this.params.push({
                  index: paramIdx++,
                  name,
                  type,
                  defaultValue: field.default ?? 0,
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
          // logging can see what the WASM module emitted.
          const tag = `[wasm:${this.metadata?.id ?? this.pluginKey ?? '?'}]`;
          if (level === 1) console.warn(tag, message);
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
        // Legacy: no module uses state::set() anymore (all use set_val).
        // Import must exist so old WASM modules don't fail to instantiate.
        set: (_pathPtr: number, _pathLen: number, _jsonPtr: number, _jsonLen: number) => {},
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
          as_number: (h: number) => { const v = getVal(h); return typeof v === 'number' ? v : 0; },
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
      gpu: {
        ...(this.gpuHost
          ? this.gpuHost.buildImports(
              (ptr, len) => new Uint8Array(this.memory.buffer).slice(ptr, ptr + len),
              (ptr, len) => decoder.decode(new Uint8Array(this.memory.buffer, ptr, len)),
            )
          : {
              // Stubs if no GPU host
              get_backend: () => -1,
              create_shader_module: () => -1,
              create_buffer: () => -1,
              create_texture: () => -1,
              create_compute_pso: () => -1,
              create_render_pso: () => -1,
              create_instanced_render_pso: () => -1,
              render_set_buffer: () => {},
              write_buffer: () => {},
              begin_compute_pass: () => -1,
              compute_set_pso: () => {},
              compute_set_buffer: () => {},
              compute_set_texture: () => {},
              compute_dispatch: () => {},
              end_compute_pass: () => {},
              begin_render_pass: () => -1,
              render_set_pso: () => {},
              render_set_vertex_buffer: () => {},
              render_draw: () => {},
              end_render_pass: () => {},
              submit: () => {},
              get_render_target: () => -1,
              get_render_target_width: () => 0,
              get_render_target_height: () => 0,
              release: () => {},
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
      },
      module: {
        register_effect: (descPtr: number) => {
          const mem = new DataView(this.memory.buffer);
          const version = mem.getInt32(descPtr, true);
          if (version !== 1) return; // Unknown version, skip

          const idPtr = mem.getUint32(descPtr + 4, true);
          const namePtr = mem.getUint32(descPtr + 8, true);
          const descriptionPtr = mem.getUint32(descPtr + 12, true);
          const categoryPtr = mem.getUint32(descPtr + 16, true);
          const keywordsPtr = mem.getUint32(descPtr + 20, true);

          const initIdx = mem.getUint32(descPtr + 24, true);
          const tickIdx = mem.getUint32(descPtr + 28, true);
          const renderIdx = mem.getUint32(descPtr + 32, true);
          const onStatePatchedIdx = mem.getUint32(descPtr + 36, true);
          const onResolumeParamIdx = mem.getUint32(descPtr + 40, true);

          this.registeredEffects.push({
            id: this.readCString(idPtr),
            name: this.readCString(namePtr),
            description: this.readCString(descriptionPtr),
            category: this.readCString(categoryPtr),
            keywords: this.readCString(keywordsPtr).split(',').filter(k => k.length > 0),
            _initIdx: initIdx,
            _tickIdx: tickIdx,
            _renderIdx: renderIdx,
            _onStatePatchedIdx: onStatePatchedIdx,
            _onResolumeParamIdx: onResolumeParamIdx,
          });
        },
      },
    };

    this.instance = await WebAssembly.instantiate(compiled, importObject);
    this.memory = this.instance.exports.memory as WebAssembly.Memory;

    // Initialize WASI runtime (C++ static constructors, etc.)
    const _initialize = this.instance.exports._initialize as (() => void) | undefined;
    if (_initialize) _initialize();

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
  activateEffect(effectId: string): WasmModule {
    const effect = this.registeredEffects.find(e => e.id === effectId);

    // Legacy path: single-effect WASM modules predate nano_module_main
    // and export init/tick/render/on_state_patched as top-level exports.
    // Fall back to those exports either when no registration is found
    // at all or when the effect was synthesized by the engine worker
    // (all function-table indices zero).
    const isLegacy = !effect
      || (effect._initIdx === 0 && effect._tickIdx === 0
          && effect._renderIdx === 0 && effect._onStatePatchedIdx === 0);
    if (isLegacy) {
      const exports = this.instance.exports as any;
      const init = exports.init as (() => void) | undefined;
      const tick = exports.tick as ((dt: number) => void) | undefined;
      const render = exports.render as ((vpW: number, vpH: number) => void) | undefined;
      const onStatePatched = exports.on_state_patched as
        ((n: number, pb: number, off: number, len: number, ops: number) => void) | undefined;
      if (init && tick && render && onStatePatched) {
        init();
        const onResolumeParam = exports.on_resolume_param as
          ((paramId: bigint, value: number) => void) | undefined;
        return {
          init: () => {},
          tick, render, onStatePatched, onResolumeParam,
        };
      }
      if (!effect) {
        throw new Error(`Effect "${effectId}" not found. Available: ${this.registeredEffects.map(e => e.id).join(', ')}`);
      }
    }

    // From here on `effect` is non-null (not legacy).
    const effectEntry = effect!;

    const table = this.instance.exports.__indirect_function_table as WebAssembly.Table;

    const initFn = table.get(effectEntry._initIdx) as () => void;
    const tickFn = table.get(effectEntry._tickIdx) as (dt: number) => void;
    const renderFn = table.get(effectEntry._renderIdx) as (vpW: number, vpH: number) => void;
    const onStatePatchedFn = table.get(effectEntry._onStatePatchedIdx) as
      (n: number, pb: number, off: number, len: number, ops: number) => void;
    const onResolumeParamFn = effectEntry._onResolumeParamIdx !== 0
      ? table.get(effectEntry._onResolumeParamIdx) as (paramId: bigint, value: number) => void
      : undefined;

    // Call init immediately
    initFn();

    return {
      init: () => {}, // Already called
      tick: tickFn,
      render: renderFn,
      onStatePatched: onStatePatchedFn,
      onResolumeParam: onResolumeParamFn,
    };
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

    // Store patches for state.get_patch() access
    this.pendingPatches = patches;

    // Marshal patch paths and ops into WASM memory
    const encoder = new TextEncoder();
    const pathStrings = patches.map(p => encoder.encode(p.path));
    const totalPathBytes = pathStrings.reduce((sum, s) => sum + s.length, 0);

    // Allocate WASM memory for: paths_buf + offsets + lengths + ops
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

    module.onStatePatched(n, pathsBufPtr, offsetsPtr, lengthsPtr, opsPtr);

    free(pathsBufPtr);
    free(offsetsPtr);
    free(lengthsPtr);
    free(opsPtr);

    this.pendingPatches = [];
  }
}
