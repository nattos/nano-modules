/**
 * A WasmHost for node-side tests (vitest here; the extras' jest suites import
 * it as `@nano/web/src/testing/node-wasm-host`): instantiates a real effect
 * bundle from build/wasm with a hand-built import object — no GPU (gpu.* stubs
 * return -1), no fetch — and activates one of its effects.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from '../wasm-host';

/** The repo's build/wasm — where every bundle, in-repo or extras, is built. */
export const WASM_DIR = resolve(__dirname, '../../../build/wasm');
export const wasmPath = (stem: string) => resolve(WASM_DIR, `${stem}.wasm`);

const TESTONLY_PATH = wasmPath('testonly');

export function readBytes(path: string): Buffer | null {
  try { return readFileSync(path); } catch { return null; }
}

// Helper: load a bundle directly from bytes (bypassing fetch) and activate one
// of its effects.
export async function loadHost(
  path = TESTONLY_PATH, effectId = 'debug.trigger_probe',
): Promise<{ host: WasmHost; module: import('../wasm-host').WasmModule }> {
  const host = new WasmHost();
  const bytes = readBytes(path);
  if (!bytes) throw new Error(`No WASM file at ${path}`);

  // We need to instantiate manually since fetch() doesn't work in Node
  const imports = buildImports(host);
  const result = await WebAssembly.instantiate(bytes as BufferSource, imports);
  const instance = result.instance;
  (host as any).instance = instance;
  (host as any).memory = instance.exports.memory as WebAssembly.Memory;

  // Initialize WASI runtime (static constructors)
  const _initialize = instance.exports._initialize as (() => void) | undefined;
  if (_initialize) _initialize();

  // Call nano_module_main to discover effects, then activate the one we want.
  (instance.exports.nano_module_main as () => void)();
  return { host, module: host.activateEffect(effectId) };
}

// Build the same import object that WasmHost.load() would
export function buildImports(host: WasmHost): WebAssembly.Imports {
  const decoder = new TextDecoder();
  const getMemory = () => (host as any).memory as WebAssembly.Memory;

  // WASI stubs
  const wasi_snapshot_preview1: Record<string, Function> = {
    args_get: () => 0,
    args_sizes_get: (cp: number, sp: number) => {
      const v = new DataView(getMemory().buffer);
      v.setUint32(cp, 0, true); v.setUint32(sp, 0, true); return 0;
    },
    fd_close: () => 0,
    fd_seek: () => 0,
    fd_write: () => 0,
    proc_exit: () => {},
    environ_get: () => 0,
    environ_sizes_get: (cp: number, sp: number) => {
      const v = new DataView(getMemory().buffer);
      v.setUint32(cp, 0, true); v.setUint32(sp, 0, true); return 0;
    },
    clock_time_get: () => 0,
  };
  const readString = (ptr: number, len: number) =>
    decoder.decode(new Uint8Array(getMemory().buffer, ptr, len));
  const writeString = (ptr: number, maxLen: number, str: string): number => {
    const encoded = new TextEncoder().encode(str);
    const len = Math.min(encoded.length, maxLen);
    new Uint8Array(getMemory().buffer, ptr, len).set(encoded.subarray(0, len));
    return len;
  };

  // Share the host's val store so get_patch and val.* use the same handles
  const valStore = (host as any)._valStore;

  return {
    wasi_snapshot_preview1,
    env: {
      resolume_get_param: (_id: bigint) => 0,
      resolume_set_param: (_id: bigint, _value: number) => {},
      log: (ptr: number, len: number) => console.log('[wasm]', readString(ptr, len)),
      fmod: (a: number, b: number) => a - Math.trunc(a / b) * b,
      fmodf: (a: number, b: number) => a - Math.trunc(a / b) * b,
      sinf: (a: number) => Math.sin(a),
      floor: (a: number) => Math.floor(a),
      fabs: (a: number) => Math.abs(a),
      strlen: (ptr: number) => {
        const mem = new Uint8Array(getMemory().buffer);
        let len = 0;
        while (mem[ptr + len] !== 0) len++;
        return len;
      },
    },
    host: {
      get_time: () => host.frameState.elapsedTime,
      get_delta_time: () => host.frameState.deltaTime,
      get_bar_phase: () => host.frameState.barPhase,
      get_bpm: () => host.frameState.bpm,
      get_param: (index: number) => host.frameState.params[index] ?? 0,
      get_viewport_w: () => host.frameState.viewportW,
      get_viewport_h: () => host.frameState.viewportH,
      log: (ptr: number, len: number) => console.log('[wasm]', readString(ptr, len)),
      trigger_audio: (channel: number) => host.onAudioTrigger(channel),
    },
    // Session-clock-only streams stub (the null-registry world of the real
    // importObject) — core.wasm's transport effects import the module.
    streams: {
      parent: () => 1n,
      content: () => 0n,
      timeline: () => 0n,
      count: () => 1,
      at: (i: number) => (i === 0 ? 1n : 0n),
      name: () => 0,
      describe: () => 0,
      rev: () => 0,
      pos: () => host.frameState.elapsedTime,
      pos_sec: () => host.frameState.elapsedTime,
      playing: () => 1,
      loop: () => 0,
      duration: () => -1,
      duration_sec: () => -1,
      bpm: () => host.frameState.bpm,
      fps: () => 0,
      anchor: () => NaN,
      anchor_sec: () => NaN,
      elapsed: () => NaN,
      clip_duration: () => NaN,
      clip_group: () => NaN,
      announce: () => 0,
      seek: () => 0,
      stop: () => 0,
      event_count: () => 0,
      read_events: () => 0,
      event_lower_bound: () => 0,
      next_launch: () => 0,
    },
    // No-resource world stub (core.wasm's transition effect imports it).
    resources: {
      content: () => 0n,
      live: () => 0n,
      clip_at: () => 0n,
      describe: () => 0,
      rev: () => 0,
      stream: () => 0n,
      fork: () => 0n,
      release: () => 0,
    },
    resolume: {
      get_param: (_id: bigint) => 0,
      set_param: (_id: bigint, _value: number) => {},
      trigger_clip: (_clipId: bigint, _on: number) => {},
      subscribe_param: (_id: bigint) => {},
      subscribe_query: (_queryPtr: number, _queryLen: number) => {},
      get_param_path: (_paramId: bigint, _bufPtr: number, _bufLen: number) => 0,
      get_clip_count: () => 4,
      get_clip_id: (index: number) => BigInt(100 + index),
      get_clip_channel: (index: number) => index < 4 ? index : -1,
      get_clip_name: (index: number, bufPtr: number, bufLen: number) => {
        const names = ['Clip A', 'Clip B', 'Clip C', 'Clip D'];
        const name = names[index] ?? '';
        const encoded = new TextEncoder().encode(name);
        const len = Math.min(encoded.length, bufLen);
        new Uint8Array(getMemory().buffer, bufPtr, len).set(encoded.subarray(0, len));
        return len;
      },
      get_clip_connected: (_index: number) => 1,
      get_bpm: () => 120,
      load_thumbnail: (_index: number) => -1,
    },
    state: {
      set_schema: (_idPtr: number, _idLen: number, _versionPacked: number,
                    _schemaPtr: number, _schemaLen: number) => {},
      get_key: (bufPtr: number, bufLen: number): number => {
        const key = 'control.nanolooper@0';
        const enc = new TextEncoder().encode(key);
        const len = Math.min(enc.length, bufLen);
        new Uint8Array(getMemory().buffer, bufPtr, len).set(enc.subarray(0, len));
        return len;
      },
      set_metadata: (_idPtr: number, _idLen: number, _versionPacked: number) => {},
      // GPU-effect imports (the nano bundle now links motion_field /
      // flash_particles which reference these). nanolooper never calls
      // them, but they must exist for the bundle to instantiate.
      register_shader_spv: () => {},
      register_fusion_by_name: () => {},
      set_on_state_ready: () => {},
      set_field_hidden: () => {},
      console_log: (_level: number, _msgPtr: number, _msgLen: number) => {},
      console_log_structured: (level: number, msgPtr: number, msgLen: number,
                                jsonPtr: number, jsonLen: number) => {
        const mem = new Uint8Array(((host as any).memory as WebAssembly.Memory).buffer);
        host.consoleLogs.push({
          timestamp: host.frameState.elapsedTime,
          level: (['log', 'warn', 'error'] as const)[level] ?? 'log',
          message: decoder.decode(mem.subarray(msgPtr, msgPtr + msgLen)),
          data: JSON.parse(decoder.decode(mem.subarray(jsonPtr, jsonPtr + jsonLen))),
        });
      },
      set_val: (_pathPtr: number, _pathLen: number, valHandle: number) => {
        const v = valStore.get(valHandle);
        if (v !== undefined) {
          if (_pathLen === 0) {
            host.pluginState = v;
          } else {
            const path = readString(_pathPtr, _pathLen);
            const keys = path.replace(/^\//, '').split('/');
            let obj = host.pluginState;
            for (let i = 0; i < keys.length - 1; i++) {
              if (!(keys[i] in obj)) obj[keys[i]] = {};
              obj = obj[keys[i]];
            }
            obj[keys[keys.length - 1]] = v;
          }
        }
      },
      get_patch: (index: number) => {
        if (index < 0 || index >= host.pendingPatches.length) return 0;
        return valStore.alloc(host.pendingPatches[index]);
      },
      mark_gpu_dirty: (_pathPtr: number, _pathLen: number) => {},
      set_gpu_buffer: (_pathPtr: number, _pathLen: number, _handle: number) => {},
      set_gpu_texture: (_pathPtr: number, _pathLen: number, _handle: number) => {},
      is_field_connected: (_pathPtr: number, _pathLen: number, _direction: number) => 0,
      read: (layoutPtr: number, fieldCount: number, pathsPtr: number,
             outputPtr: number, outputSize: number, resultsPtr: number): number => {
        const mem = new DataView(getMemory().buffer);
        const bytes = new Uint8Array(getMemory().buffer);
        const dec = new TextDecoder();
        let overflowCount = 0;
        for (let i = 0; i < fieldCount; i++) {
          const fOff = layoutPtr + i * 20;
          const pathOffset = mem.getInt32(fOff, true);
          const pathLen = mem.getInt32(fOff + 4, true);
          const type = mem.getInt32(fOff + 8, true);
          const bufOffset = mem.getInt32(fOff + 12, true);
          const capacity = mem.getInt32(fOff + 16, true);
          const rOff = resultsPtr + i * 8;
          const pathStr = dec.decode(bytes.slice(pathsPtr + pathOffset, pathsPtr + pathOffset + pathLen));
          let val: any = host.pluginState;
          if (pathStr.length > 0) {
            for (const token of pathStr.split('/').filter((t: string) => t !== '')) {
              if (val == null) { val = undefined; break; }
              val = val[token];
            }
          }
          if (val === undefined || val === null) {
            bytes[rOff] = 0; bytes[rOff + 1] = 0; mem.setInt32(rOff + 4, 0, true);
            continue;
          }
          bytes[rOff] = 1;
          const absOff = outputPtr + bufOffset;
          if (type === 5 && Array.isArray(val)) {
            const wc = Math.min(val.length, capacity);
            mem.setInt32(absOff, wc, true);
            for (let j = 0; j < wc; j++) mem.setInt32(absOff + 4 + j * 4, Number(val[j]), true);
            bytes[rOff + 1] = val.length > capacity ? 1 : 0;
            if (val.length > capacity) overflowCount++;
            mem.setInt32(rOff + 4, val.length, true);
          } else {
            bytes[rOff + 1] = 0; mem.setInt32(rOff + 4, 0, true);
          }
        }
        return overflowCount;
      },
    },
    io: {
      declare_texture_input: () => {},
      declare_texture_output: () => {},
      declare_data_output: () => {},
    },
    // Host text engine. nanolooper's overlay now composites its labels through
    // text::layout/render (not the old canvas draw list). This GPU-less harness
    // just needs the imports to exist; returning 0 from layout makes render()
    // skip the composite (no fonts here), so the logic tests still run.
    text: {
      layout: () => 0,   // 0 = error → text::render skipped
      measure: () => 0,
      render: () => {},
      atlas: () => -1,
      glyphs: () => 0,
      release: () => {},
    },
    // GPU-less harness: EVERY gpu import resolves to a no-op returning -1
    // via the Proxy fallback (same shape as wasm-host.ts's schema-only
    // hosts). A hand-kept stub list silently rotted every time the gpu ABI
    // grew, LinkError'ing the whole suite.
    gpu: new Proxy({} as Record<string, () => number>, {
      get: () => () => -1,
    }),
    // Name-keyed effect registration — mirrors the production
    // module.register_effect_* builder imports in wasm-host.ts load().
    module: (() => {
      const builders = new Map<number, { meta: Map<string, string>; fns: Map<string, number> }>();
      let nextHandle = 1;
      return {
        register_effect_begin: (): number => {
          const h = nextHandle++;
          builders.set(h, { meta: new Map(), fns: new Map() });
          return h;
        },
        register_effect_str: (handle: number, namePtr: number, nameLen: number,
                              valPtr: number, valLen: number): void => {
          const b = builders.get(handle);
          if (!b) return;
          b.meta.set(readString(namePtr, nameLen), readString(valPtr, valLen));
        },
        register_effect_fn: (handle: number, namePtr: number, nameLen: number,
                             fnIdx: number): void => {
          const b = builders.get(handle);
          if (!b || fnIdx === 0) return;
          const name = readString(namePtr, nameLen);
          if (name) b.fns.set(name, fnIdx >>> 0);
        },
        register_effect_end: (handle: number): void => {
          const b = builders.get(handle);
          if (!b) return;
          builders.delete(handle);
          const keywords = b.meta.get('keywords') ?? '';
          host.registeredEffects.push({
            id: b.meta.get('id') ?? '',
            name: b.meta.get('name') ?? '',
            description: b.meta.get('description') ?? '',
            category: b.meta.get('category') ?? '',
            keywords: keywords.split(',').filter((k: string) => k.length > 0),
            _fns: b.fns,
          });
        },
      };
    })(),
    val: {
      null: () => valStore.alloc(null),
      bool: (v: number) => valStore.alloc(v !== 0),
      number: (v: number) => valStore.alloc(v),
      string: (ptr: number, len: number) => valStore.alloc(readString(ptr, len)),
      array: () => valStore.alloc([]),
      object: () => valStore.alloc({}),
      type_of: (h: number) => { const v = valStore.get(h); if (v === null || v === undefined) return 0; if (typeof v === 'boolean') return 1; if (typeof v === 'number') return 2; if (typeof v === 'string') return 3; if (Array.isArray(v)) return 4; return 5; },
      as_number: (h: number) => { const v = valStore.get(h); return typeof v === 'number' ? v : 0; },
      as_bool: (h: number) => valStore.get(h) ? 1 : 0,
      as_string: (h: number, bufPtr: number, bufLen: number) => { const v = valStore.get(h); return typeof v === 'string' ? writeString(bufPtr, bufLen, v) : 0; },
      get: (objH: number, keyPtr: number, keyLen: number) => { const obj = valStore.get(objH); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 0; const key = readString(keyPtr, keyLen); return key in obj ? valStore.alloc(obj[key]) : 0; },
      set: (objH: number, keyPtr: number, keyLen: number, valH: number) => { const obj = valStore.get(objH); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return; obj[readString(keyPtr, keyLen)] = valStore.get(valH); },
      keys_count: (h: number) => { const v = valStore.get(h); return (v && typeof v === 'object' && !Array.isArray(v)) ? Object.keys(v).length : 0; },
      key_at: (h: number, index: number, bufPtr: number, bufLen: number) => { const v = valStore.get(h); if (!v || typeof v !== 'object') return 0; const keys = Object.keys(v); return index >= 0 && index < keys.length ? writeString(bufPtr, bufLen, keys[index]) : 0; },
      get_index: (arrH: number, index: number) => { const arr = valStore.get(arrH); if (!Array.isArray(arr) || index < 0 || index >= arr.length) return 0; return valStore.alloc(arr[index]); },
      push: (arrH: number, valH: number) => { const arr = valStore.get(arrH); if (Array.isArray(arr)) arr.push(valStore.get(valH)); },
      length: (h: number) => { const v = valStore.get(h); return Array.isArray(v) ? v.length : 0; },
      release: (h: number) => valStore.release(h),
      to_json: (h: number, bufPtr: number, bufLen: number) => { const v = valStore.get(h); return v === undefined ? 0 : writeString(bufPtr, bufLen, JSON.stringify(v)); },
    },
  };
}

// Instantiate a real bundle and capture the schema JSON each requested effect
// publishes from its module_init (via a capturing set_schema override).
export async function captureSchemas(wasmPath: string, effectIds: string[]): Promise<Map<string, any>> {
  let bytes: Buffer | null = null;
  try { bytes = readFileSync(wasmPath); } catch {}
  if (!bytes) return new Map();
  const host = new WasmHost();
  const imports = buildImports(host);
  const raw = new Map<string, string>();
  const dec = new TextDecoder();
  (imports.state as any).set_schema = (idPtr: number, idLen: number, _v: number,
                                       sPtr: number, sLen: number) => {
    const mem = (host as any).memory as WebAssembly.Memory;
    raw.set(dec.decode(new Uint8Array(mem.buffer, idPtr, idLen)),
            dec.decode(new Uint8Array(mem.buffer, sPtr, sLen)));
  };
  let instance: WebAssembly.Instance;
  try {
    const result = await WebAssembly.instantiate(bytes as BufferSource, imports);
    instance = (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
  } catch (e) {
    // Bundle needs host imports this minimal harness doesn't stub (e.g. Blitz).
    console.warn(`skipping ${wasmPath}: ${(e as Error).message}`);
    return new Map();
  }
  (host as any).instance = instance;
  (host as any).memory = instance.exports.memory as WebAssembly.Memory;
  (instance.exports._initialize as (() => void) | undefined)?.();
  (instance.exports.nano_module_main as (() => void))();
  const out = new Map<string, any>();
  for (const id of effectIds) {
    host.activateEffect(id);   // runs module_init → set_schema
    const s = raw.get(id);
    if (s) out.set(id, JSON.parse(s));   // JSON.parse throws on truncation/corruption
  }
  return out;
}
