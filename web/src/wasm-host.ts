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

export interface WasmModule {
  init(): void;
  tick(dt: number): void;
  render(vpW: number, vpH: number): void;
  onParamChange(index: number, value: number): void;
  onStateChanged(): void;
  onResolumeParam?(paramId: bigint, value: number): void;
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

export class WasmHost {
  private instance!: WebAssembly.Instance;
  private memory!: WebAssembly.Memory;

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

  // Named texture fields (populated by sketch executor from schema)
  textureFields: Map<string, number> = new Map();

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

  private writeString(ptr: number, maxLen: number, str: string): number {
    const encoded = new TextEncoder().encode(str);
    const len = Math.min(encoded.length, maxLen);
    new Uint8Array(this.memory.buffer, ptr, len).set(encoded.subarray(0, len));
    return len;
  }

  private get useBridgeCore(): boolean {
    return this.bridgeCore !== null;
  }

  async load(wasmUrl: string): Promise<WasmModule> {
    const response = await fetch(wasmUrl);
    const bytes = await response.arrayBuffer();
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
        declare_param: (index: number, namePtr: number, nameLen: number,
                        type: number, defaultValue: number) => {
          const name = this.readString(namePtr, nameLen);
          this.params.push({ index, name, type, defaultValue });
          if (bc && this.pluginKey) {
            bc.declareParam(this.pluginKey, index, name, type, defaultValue);
          }
        },
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
              }
            }
          } catch {
            this.schema = {};
          }

          if (bc) {
            this.pluginKey = bc.registerWithSchema(id, major, minor, patch, schemaStr);
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
        set: (pathPtr: number, pathLen: number, jsonPtr: number, jsonLen: number) => {
          const jsonStr = this.readString(jsonPtr, jsonLen);
          try {
            const value = JSON.parse(jsonStr);
            if (bc && this.pluginKey) {
              // Delegate to bridge core — it will diff and emit patches
              if (pathLen === 0) {
                bc.setPluginState(this.pluginKey, value);
              } else {
                // For sub-path sets, get current state, apply change, set whole state
                const path = this.readString(pathPtr, pathLen);
                const current = bc.getPluginState(this.pluginKey);
                const keys = path.replace(/^\//, '').split('/');
                let obj = current;
                for (let i = 0; i < keys.length - 1; i++) {
                  if (!(keys[i] in obj)) obj[keys[i]] = {};
                  obj = obj[keys[i]];
                }
                obj[keys[keys.length - 1]] = value;
                bc.setPluginState(this.pluginKey, current);
              }
              // Update local cache for backward compatibility
              this.pluginState = bc.getPluginState(this.pluginKey);
            } else {
              // Legacy: direct state management
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
          } catch { /* ignore invalid JSON */ }
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
      },
      io: {
        declare_texture_input: (index: number, namePtr: number, nameLen: number, role: number) => {
          const name = this.readString(namePtr, nameLen);
          this.ioDecls.push({ index, name, kind: 0, role }); // IO_TEXTURE_INPUT = 0
          if (bc && this.pluginKey) bc.declareIO(this.pluginKey, index, name, 0, role);
        },
        declare_texture_output: (index: number, namePtr: number, nameLen: number, role: number) => {
          const name = this.readString(namePtr, nameLen);
          this.ioDecls.push({ index, name, kind: 1, role }); // IO_TEXTURE_OUTPUT = 1
          if (bc && this.pluginKey) bc.declareIO(this.pluginKey, index, name, 1, role);
        },
        declare_data_output: (index: number, namePtr: number, nameLen: number, role: number) => {
          const name = this.readString(namePtr, nameLen);
          this.ioDecls.push({ index, name, kind: 2, role }); // IO_DATA_OUTPUT = 2
          if (bc && this.pluginKey) bc.declareIO(this.pluginKey, index, name, 2, role);
        },
      },
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
      },
    };

    const result = await WebAssembly.instantiate(bytes, importObject);
    this.instance = result.instance;
    this.memory = this.instance.exports.memory as WebAssembly.Memory;

    // Initialize WASI runtime (C++ static constructors, etc.)
    const _initialize = this.instance.exports._initialize as (() => void) | undefined;
    if (_initialize) _initialize();

    const exports = this.instance.exports;
    return {
      init: exports.init as () => void,
      tick: exports.tick as (dt: number) => void,
      render: exports.render as (vpW: number, vpH: number) => void,
      onParamChange: exports.on_param_change as (index: number, value: number) => void,
      onStateChanged: exports.on_state_changed as () => void,
      onResolumeParam: exports.on_resolume_param as ((paramId: bigint, value: number) => void) | undefined,
    };
  }
}
