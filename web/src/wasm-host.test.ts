import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from './wasm-host';

// This test exercises nanolooper, which lives in the `nano` bundle. Old
// standalone nanolooper.wasm is kept as a fallback for environments where
// only that artefact is available.
const NANO_BUNDLE_PATH = resolve(__dirname, '../public/wasm/nano.wasm');
const NANOLOOPER_PATH = resolve(__dirname, '../public/wasm/nanolooper.wasm');

function getWasmBytes(): Buffer | null {
  try { return readFileSync(NANO_BUNDLE_PATH); } catch {}
  try { return readFileSync(NANOLOOPER_PATH); } catch {}
  return null;
}

// Helper: load WASM module directly from bytes (bypassing fetch)
async function loadHost(): Promise<{ host: WasmHost; module: import('./wasm-host').WasmModule }> {
  const host = new WasmHost();
  const bytes = getWasmBytes();
  if (!bytes) throw new Error('No WASM file found');

  // We need to instantiate manually since fetch() doesn't work in Node
  const imports = buildImports(host);
  const result = await WebAssembly.instantiate(bytes as BufferSource, imports);
  const instance = result.instance;
  (host as any).instance = instance;
  (host as any).memory = instance.exports.memory as WebAssembly.Memory;

  // Initialize WASI runtime (static constructors)
  const _initialize = instance.exports._initialize as (() => void) | undefined;
  if (_initialize) _initialize();

  // Call nano_module_main to discover effects, then activate nanolooper
  const nanoMain = instance.exports.nano_module_main as (() => void) | undefined;
  if (nanoMain) {
    nanoMain();
    const wasmModule = host.activateEffect('control.nanolooper');
    return { host, module: wasmModule };
  }

  // Legacy fallback: directly access exports
  const exports = instance.exports;
  const wasmModule = {
    init: exports.init as () => void,
    tick: exports.tick as (dt: number) => void,
    render: exports.render as (vpW: number, vpH: number) => void,
    onStatePatched: exports.on_state_patched as
      (n: number, pb: number, off: number, len: number, ops: number) => void,
    isIdentity: () => false,
  };
  wasmModule.init();

  return { host, module: wasmModule };
}

// Build the same import object that WasmHost.load() would
function buildImports(host: WasmHost): WebAssembly.Imports {
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
    canvas: {
      fill_rect: (x: number, y: number, w: number, h: number,
                   r: number, g: number, b: number, a: number) => {
        host.drawList.push({ type: 'fill_rect', x, y, w, h, r, g, b, a });
      },
      draw_image: (texId: number, x: number, y: number, w: number, h: number) => {
        host.drawList.push({ type: 'draw_image', x, y, w, h, r: 1, g: 1, b: 1, a: 1, texId });
      },
      draw_text: (ptr: number, len: number, x: number, y: number, size: number,
                   r: number, g: number, b: number, a: number) => {
        const text = readString(ptr, len);
        host.drawList.push({ type: 'draw_text', x, y, w: 0, h: 0, r, g, b, a, text, fontSize: size });
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
      declare_param: (_index: number, _namePtr: number, _nameLen: number,
                      _type: number, _defaultValue: number) => {},
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
      register_fusion: () => {},
      register_fusion_by_name: () => {},
      set_on_state_ready: () => {},
      set_field_hidden: () => {},
      console_log: (_level: number, _msgPtr: number, _msgLen: number) => {},
      console_log_structured: (_level: number, _msgPtr: number, _msgLen: number,
                                _jsonPtr: number, _jsonLen: number) => {},
      set: (_pathPtr: number, _pathLen: number, _jsonPtr: number, _jsonLen: number) => {
        try {
          host.pluginState = JSON.parse(new TextDecoder().decode(
            new Uint8Array(getMemory().buffer, _jsonPtr, _jsonLen)));
        } catch {}
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
    gpu: {
      get_backend: () => -1,
      create_shader_module: () => -1,
      create_buffer: () => -1,
      create_texture: () => -1,
      create_compute_pso: () => -1,
      create_render_pso: () => -1,
      write_buffer: () => {},
      request_readback: () => {},
      poll_readback: () => 0,
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
      get_input_texture: () => -1,
      get_input_texture_count: () => 0,
      texture_for_field: () => -1,
      buffer_for_field: () => 0,
      create_instanced_render_pso: () => -1,
      render_set_buffer: () => {},
      // Additional gpu imports referenced by the bundle's GPU effects
      // (motion_field / flash_particles). Unused by nanolooper; present
      // only so instantiation links.
      create_shader_module_named: () => -1,
      create_compute_pso_layout: () => -1,
      create_compute_pso_v2: () => -1,
      create_render_pso_layout: () => -1,
      create_instanced_render_pso_layout: () => -1,
      create_instanced_render_pso_mrt_layout: () => -1,
      create_instanced_render_pso_blend_layout: () => -1,
      create_texture_mips: () => -1,
      create_texture_3d: () => -1,
      create_sampler: () => -1,
      compute_set_texture_mip: () => {},
      compute_set_sampler: () => {},
      clear_texture: () => {},
      copy_texture: () => {},
      begin_render_pass_load: () => -1,
      begin_render_pass_mrt: () => -1,
    },
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

describe('WasmHost', () => {
  it('loads nanolooper.wasm and calls init', async () => {
    const { module } = await loadHost();
    module.init();
  });

  it('tick runs without error', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.barPhase = 0.1;
    host.frameState.bpm = 120;
    module.tick(0.016);
  });

  // The overlay is now drawn via the in-effect overlay toolbox (GPU solid-quad
  // rects + text::render), not the old host canvas draw list. Without a GPU
  // backend (this harness stubs gpu.* to -1) render() resolves no writable
  // target and returns cleanly — so here we only assert it runs without error.
  it('render runs without error (GPU-less host)', async () => {
    const { host, module } = await loadHost();
    module.init();

    host.frameState.elapsedTime = 1.0;
    host.frameState.barPhase = 0.25;
    host.frameState.viewportW = 1920;
    host.frameState.viewportH = 1080;

    expect(() => module.render(1920, 1080)).not.toThrow();
  });

  it('on_param_change triggers audio callback', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.barPhase = 0.1;

    let triggeredChannel = -1;
    host.onAudioTrigger = (ch) => { triggeredChannel = ch; };

    host.notifyStatePatched(module, [{ op: 'replace', path: 'trigger_1', value: 1.0 }]);
    expect(triggeredChannel).toBe(0);
  });

  it('on_state_patched reads grid from canonical state', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.barPhase = 0.1;

    // Trigger some events normally
    host.notifyStatePatched(module, [{ op: 'replace', path: 'trigger_1', value: 1.0 }]);
    host.notifyStatePatched(module, [{ op: 'replace', path: 'trigger_1', value: 0.0 }]);
    module.tick(0.016);

    // Now externally modify the canonical state (simulating a client edit)
    host.pluginState = {
      phase: 0,
      recording: false,
      event_count: 3,
      grid: [[0, 4], [8], [], []]
    };

    // Notify the module via state patches
    host.notifyStatePatched(module as any, [{ op: 'replace', path: 'grid', value: host.pluginState.grid }]);

    // Tick to publish updated state — the module should now reflect the edited grid
    host.frameState.viewportW = 1920;
    host.frameState.viewportH = 1080;
    host.drawList = [];
    module.tick(0.016);

    // After tick, the module publishes its internal state which should match the edit
    expect(host.pluginState.event_count).toBe(3);
    expect(host.pluginState.grid[0]).toEqual([0, 4]);
    expect(host.pluginState.grid[1]).toEqual([8]);
    expect(host.pluginState.grid[2]).toEqual([]);
    expect(host.pluginState.grid[3]).toEqual([]);
  });

  it('on_state_patched preserves all channels when editing one', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.barPhase = 0.0;

    // Set up events on all 4 channels via the state
    host.pluginState = {
      phase: 0, recording: false, event_count: 4,
      grid: [[1], [3], [5], [7]]
    };
    host.notifyStatePatched(module as any, [{ op: 'replace', path: 'grid', value: host.pluginState.grid }]);
    module.tick(0.016);

    // Verify all 4 channels loaded
    expect(host.pluginState.event_count).toBe(4);
    expect(host.pluginState.grid).toEqual([[1], [3], [5], [7]]);

    // Now edit: remove only channel 0's event
    host.pluginState = {
      phase: 0, recording: false, event_count: 3,
      grid: [[], [3], [5], [7]]
    };
    host.notifyStatePatched(module as any, [{ op: 'replace', path: 'grid', value: host.pluginState.grid }]);
    module.tick(0.016);

    // Channels 1-3 must still have their events
    expect(host.pluginState.event_count).toBe(3);
    expect(host.pluginState.grid[0]).toEqual([]);
    expect(host.pluginState.grid[1]).toEqual([3]);
    expect(host.pluginState.grid[2]).toEqual([5]);
    expect(host.pluginState.grid[3]).toEqual([7]);
  });

  it('multiple ticks then render works', async () => {
    const { host, module } = await loadHost();
    module.init();

    for (let i = 0; i < 10; i++) {
      host.frameState.barPhase = i * 0.1;
      host.frameState.elapsedTime = i * 0.016;
      module.tick(0.016);
    }

    host.frameState.viewportW = 800;
    host.frameState.viewportH = 600;
    expect(() => module.render(800, 600)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// is_identity ABI dispatch
//
// The effect's optional `is_identity` predicate is registered by name (it may
// be absent). The host exposes it as the activated module's isIdentity()
// method, threading the per-instance `self` through the indirect function table
// exactly like tick/render/on_state_patched.
//
// This test synthesizes a name-keyed EffectInfo and a fake indirect-function-
// table (an object exposing .get(idx)), drives the host's real activateEffect,
// and asserts isIdentity() resolves through the table — covering both the
// name→index lookup and the self-threading wrapper without GPU.
// ---------------------------------------------------------------------------
describe('is_identity name-keyed dispatch', () => {
  // Build a host with a synthetic name-keyed descriptor + fake function table.
  // `identityResult` is what the fake is_identity table entry returns
  // (a number, like the wasm function would); pass `null` to omit the
  // predicate entirely (absent name => never skippable).
  function makeHostWithDescriptor(identityResult: number | null): {
    host: WasmHost; capturedSelf: { value: number };
  } {
    const host = new WasmHost();
    const memory = new WebAssembly.Memory({ initial: 1 });

    // Fake indirect function table: we only ever need .get(idx).
    const SELF = 0xABCD;       // sentinel "self" pointer create() returns
    const capturedSelf = { value: 0 };
    const IDX_CREATE = 1, IDX_INIT = 2, IDX_TICK = 3, IDX_RENDER = 4,
          IDX_ONPATCH = 5, IDX_IS_IDENTITY = 9;
    const table = {
      get(idx: number): any {
        switch (idx) {
          case IDX_CREATE: return () => SELF;
          case IDX_INIT: return (_self: number) => {};
          case IDX_TICK: return (_self: number, _dt: number) => {};
          case IDX_RENDER: return (_self: number, _w: number, _h: number) => {};
          case IDX_ONPATCH: return () => {};
          case IDX_IS_IDENTITY:
            return (self: number) => { capturedSelf.value = self; return identityResult; };
          default: return null;
        }
      },
    };

    (host as any).memory = memory;
    (host as any).instance = { exports: { __indirect_function_table: table } };

    // Name-keyed callbacks. is_identity is simply absent when not provided.
    const fns = new Map<string, number>([
      ['create', IDX_CREATE],
      ['init', IDX_INIT],
      ['tick', IDX_TICK],
      ['render', IDX_RENDER],
      ['on_state_patched', IDX_ONPATCH],
    ]);
    if (identityResult !== null) fns.set('is_identity', IDX_IS_IDENTITY);

    (host as any).registeredEffects.push({
      id: 'video.test_identity',
      name: 'Test Identity',
      description: 'desc',
      category: 'video',
      keywords: [],
      _fns: fns,
    });

    return { host, capturedSelf };
  }

  it('isIdentity() returns true when the predicate returns nonzero', () => {
    const { host } = makeHostWithDescriptor(1);
    const module = host.activateEffect('video.test_identity');
    expect(module.isIdentity()).toBe(true);
  });

  it('isIdentity() returns false when the predicate returns zero', () => {
    const { host } = makeHostWithDescriptor(0);
    const module = host.activateEffect('video.test_identity');
    expect(module.isIdentity()).toBe(false);
  });

  it('isIdentity() returns false when no predicate is registered (idx 0)', () => {
    const { host } = makeHostWithDescriptor(null);
    const module = host.activateEffect('video.test_identity');
    expect(module.isIdentity()).toBe(false);
  });

  it('isIdentity() threads the per-instance self pointer', () => {
    const { host, capturedSelf } = makeHostWithDescriptor(1);
    const module = host.activateEffect('video.test_identity');
    module.isIdentity();
    // create() returned 0xABCD; the wrapper must pass that as `self`.
    expect(capturedSelf.value).toBe(0xABCD);
  });
});

// ---------------------------------------------------------------------------
// describeEffect — type-level schema discovery WITHOUT an instance
//
// The schema is published by module_init (type-level, self-less, GPU-guarded),
// so describeEffect runs only module_init + resolves the self-less
// eval_visibility fn — never create()/init(). A later activateEffect on the
// same host PROMOTES it to a live instance (create()+init()) WITHOUT re-running
// module_init. This is the bundle-warmup / visibility-host path.
// ---------------------------------------------------------------------------
describe('describeEffect — schema-only, no instance', () => {
  function makeHost(): {
    host: WasmHost;
    counts: { moduleInit: number; create: number; init: number };
  } {
    const host = new WasmHost();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const counts = { moduleInit: 0, create: 0, init: 0 };
    const SELF = 0x1234;
    const IDX_MODULE_INIT = 1, IDX_CREATE = 2, IDX_INIT = 3, IDX_EVAL = 4;
    const table = {
      get(idx: number): any {
        switch (idx) {
          case IDX_MODULE_INIT: return () => { counts.moduleInit++; };
          case IDX_CREATE: return () => { counts.create++; return SELF; };
          case IDX_INIT: return (_self: number) => { counts.init++; };
          case IDX_EVAL: return () => {};
          default: return null;
        }
      },
    };
    (host as any).memory = memory;
    (host as any).instance = { exports: { __indirect_function_table: table } };
    (host as any).registeredEffects.push({
      id: 'video.test_identity', name: 'Test', description: '', category: 'video', keywords: [],
      _fns: new Map<string, number>([
        ['module_init', IDX_MODULE_INIT], ['create', IDX_CREATE],
        ['init', IDX_INIT], ['eval_visibility', IDX_EVAL],
      ]),
    });
    return { host, counts };
  }

  it('runs module_init once + resolves eval_visibility, never creating an instance', () => {
    const { host, counts } = makeHost();
    host.describeEffect('video.test_identity');
    expect(counts.moduleInit).toBe(1);
    expect(counts.create).toBe(0);
    expect(counts.init).toBe(0);
    expect(host.evalVisibilityFn).not.toBeNull();
  });

  it('is idempotent — module_init runs once across repeated describes', () => {
    const { host, counts } = makeHost();
    host.describeEffect('video.test_identity');
    host.describeEffect('video.test_identity');
    expect(counts.moduleInit).toBe(1);
  });

  it('promotion: activateEffect after describe creates the instance but does NOT re-run module_init', () => {
    const { host, counts } = makeHost();
    host.describeEffect('video.test_identity');
    const mod = host.activateEffect('video.test_identity');
    expect(counts.moduleInit).toBe(1); // already ran in describe — not repeated
    expect(counts.create).toBe(1);
    expect(counts.init).toBe(1);
    expect(mod).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Schema metadata round-trip — the C++ Schema builder (host.h) emits groups,
// per-field display/short names + group ids, and help fields; this asserts they
// survive native emission → JSON. Instantiates the real nano bundle and captures
// the schema JSON brutal_fold publishes from its module_init.
// ---------------------------------------------------------------------------
describe('schema metadata round-trip (groups / names / help)', () => {
  // Instantiate a real bundle and capture the schema JSON each requested effect
  // publishes from its module_init (via a capturing set_schema override).
  async function captureSchemas(wasmPath: string, effectIds: string[]): Promise<Map<string, any>> {
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

  it('brutal_fold emits groups, per-field name/short/group, and a help field', async () => {
    const schemas = await captureSchemas(NANO_BUNDLE_PATH, ['source.brutal_fold']);
    const schema = schemas.get('source.brutal_fold');
    if (!schema) { console.warn('no nano.wasm — skipping'); return; }

    // First-class groups with metadata.
    expect(schema.groups?.shape?.name).toBe('Form');
    expect(typeof schema.groups?.shape?.help).toBe('string');
    expect(schema.groups.shape.help).toContain('atlas');
    expect(schema.groups?.volumetrics?.name).toBe('Volumetrics');
    expect(schema.groups?.autopilot?.name).toBe('Autopilot');

    // Per-field display name + short name + group id.
    expect(schema.fields?.complexity?.name).toBe('Complexity');
    expect(schema.fields?.complexity?.short).toBe('Cplx');
    expect(schema.fields?.complexity?.group).toBe('shape');
    expect(schema.fields?.vol_softness_xy?.name).toBe('Screen Softness');
    expect(schema.fields?.vol_softness_xy?.group).toBe('volumetrics');

    // Help field — a help slot with no instance-state backing.
    expect(schema.fields?.intro?.type).toBe('help');
    expect(schema.fields?.intro?.io).toBe(0);
    expect(schema.fields?.intro?.default).toContain('Brutal Fold');
  });

  it('core bundle: every effect emits VALID schema JSON; edited effects have groups/labels/help', async () => {
    const CORE = resolve(__dirname, '../public/wasm/core.wasm');
    const ids = [
      'color.tone.auto_level', 'composite.bake_alpha', 'control.barrel_macros', 'filter.blur.gaussian',
      'color.tone.brightness_contrast', 'color.color_space', 'color.temperature', 'warp.crop',
      'color.tone.curve', 'util.dashboard', 'filter.edges', 'mod.source.adsr', 'mod.source.lfo',
      'color.tone.exposure', 'filter.blur.fast', 'source.gradient', 'source.grid', 'color.hsl',
      'color.hue_basis', 'color.invert', 'color.tone.levels', 'mod.shaper.delay', 'mod.shaper.envelope',
      'mod.shaper.flip', 'mod.shaper.motion', 'mod.shaper.remap', 'mod.shaper.smooth', 'mod.source.time', 'mod.source.bpm',
      'motion.blur', 'source.noise', 'color.posterize',
      'color.saturate', 'filter.sharpen', 'util.sketch_output', 'source.solid_color', 'warp.transform',
      'filter.glitch.twitch_mask', 'color.vibrance', 'color.colorize', 'composite.blend',
      'filter.vignette',
    ];
    const schemas = await captureSchemas(CORE, ids);   // JSON.parse per effect — throws on corruption
    if (schemas.size === 0) { console.warn('no core.wasm — skipping'); return; }
    expect(schemas.size).toBe(ids.length);   // all present, all valid JSON (no truncation)

    // Spot-check representative effects across domains: intro help + groups + a labelled input.
    for (const id of ['color.tone.brightness_contrast', 'color.tone.levels', 'motion.blur',
                      'util.dashboard', 'source.noise', 'mod.source.lfo']) {
      const s = schemas.get(id);
      expect(s?.fields?.intro?.type, `${id} intro`).toBe('help');
      expect(Object.keys(s?.groups ?? {}).length, `${id} groups`).toBeGreaterThan(0);
      const labelled = Object.values(s?.fields ?? {})
        .filter((f: any) => f?.type !== 'help' && (f?.io & 1) && typeof f?.name === 'string');
      expect(labelled.length, `${id} labelled inputs`).toBeGreaterThan(0);
    }
  });

  it('nano bundle: edited effects emit VALID schema JSON with groups/labels/intro help', async () => {
    const ids = [
      'source.particles.flash_particles', 'source.particles.flow_swarm', 'filter.height_from_gradient',
      'motion.local_delay', 'mod.shaper.spectral', 'motion.field', 'source.phase_fold',
      'source.shape_fold', 'mod.source.spectral_lfo', 'source.brutal_fold',
    ];
    const schemas = await captureSchemas(NANO_BUNDLE_PATH, ids);
    if (schemas.size === 0) { console.warn('no nano.wasm — skipping'); return; }
    expect(schemas.size).toBe(ids.length);   // all valid JSON (no truncation on the 41-field phase_fold)
    for (const id of ids) {
      const s = schemas.get(id);
      expect(s?.fields?.intro?.type, `${id} intro`).toBe('help');
      expect(Object.keys(s?.groups ?? {}).length, `${id} groups`).toBeGreaterThan(0);
    }
  });

  // (text/richtext are single-effect Blitz-linked bundles whose extra host
  // imports this minimal harness doesn't stub; they're verified by their build
  // + the shared host.h emission path exercised by the bundles above.)

  it('lights bundle: every effect emits VALID schema JSON with groups + labels + intro help', async () => {
    const LIGHTS = resolve(__dirname, '../public/wasm/lights.wasm');
    const ids = [
      'source.light.chroma_wave', 'source.light.orthomod', 'warp.dispersion',
      'source.light.plasma_beam_cannon', 'source.light.motion_blobs', 'filter.lights_sim',
      'source.light.side_jet', 'source.light.bounce_resonator', 'source.light.strobe_channel',
      'source.light.soft_glow', 'source.light.tingle_top', 'filter.glitch.block_dehance',
    ];
    // captureSchemas JSON.parses each — a truncated/corrupt schema would throw here.
    const schemas = await captureSchemas(LIGHTS, ids);
    if (schemas.size === 0) { console.warn('no lights.wasm — skipping'); return; }
    expect(schemas.size).toBe(ids.length);   // all present, all valid JSON

    for (const [id, schema] of schemas) {
      // Every lights effect gained groups + an intro help field + labelled inputs.
      expect(Object.keys(schema.groups ?? {}).length, `${id} groups`).toBeGreaterThan(0);
      expect(schema.fields?.intro?.type, `${id} intro`).toBe('help');
      const labelled = Object.values(schema.fields ?? {})
        .filter((f: any) => f?.type !== 'help' && (f?.io & 1) && typeof f?.name === 'string');
      expect(labelled.length, `${id} labelled inputs`).toBeGreaterThan(0);
      // Every labelled field points at a declared group.
      for (const f of labelled) {
        if ((f as any).group !== undefined) {
          expect(schema.groups?.[(f as any).group], `${id} field group ${(f as any).group}`).toBeTruthy();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Core mod effects: beat-clock behaviors, driven frame-exactly.
//
// Instantiates the real core bundle with the fake host clock (dt 0.016 s at
// 120 BPM → 0.032 beats/frame, barPhase step 0.008) and reads the published
// scalar at host.pluginState.output after each tick — exact assertions the
// engine e2e's wall-clock rAF pacing can't make.
// ---------------------------------------------------------------------------
describe('core mod effects: beat-clock behaviors', () => {
  const CORE_PATH = resolve(__dirname, '../public/wasm/core.wasm');

  async function loadCore(effectId: string) {
    let bytes: Buffer | null = null;
    try { bytes = readFileSync(CORE_PATH); } catch {}
    if (!bytes) return null;
    const host = new WasmHost();
    const imports = buildImports(host);
    const result = await WebAssembly.instantiate(bytes as BufferSource, imports);
    (host as any).instance = result.instance;
    (host as any).memory = result.instance.exports.memory as WebAssembly.Memory;
    (result.instance.exports._initialize as (() => void) | undefined)?.();
    (result.instance.exports.nano_module_main as () => void)();
    const module = host.activateEffect(effectId);
    return { host, module };
  }

  const patch = (host: WasmHost, module: any, params: Record<string, number>) =>
    host.notifyStatePatched(module, Object.entries(params).map(
      ([path, value]) => ({ op: 'replace' as const, path, value })));

  // Advance the fake transport `frames` frames, collecting the published
  // output after each tick.
  function drive(host: WasmHost, module: any, frames: number, bpm = 120): number[] {
    const dt = 0.016;
    const outs: number[] = [];
    for (let i = 0; i < frames; i++) {
      host.frameState.bpm = bpm;
      host.frameState.deltaTime = dt;
      host.frameState.elapsedTime += dt;
      host.frameState.barPhase = (host.frameState.barPhase + dt * bpm / 60 / 4) % 1;
      module.tick(dt);
      outs.push(host.pluginState.output as number);
    }
    return outs;
  }

  const SAW = 3;  // env_lfo ShapeSaw: output = 2·phase − 1 at shape 0

  it('LFO Beats+Locked rides the bar exactly, across the bar wrap', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    // Start mid-bar: locked phase must equal the bar position (0.5 + i·0.008),
    // where a free clock (which always starts its cycle at 0) would lag it by
    // the 0.5 offset — this is what distinguishes Locked from Free.
    host.frameState.barPhase = 0.5;
    patch(host, module, { mode: 2, sync: 1, period_beats: 4, waveform: SAW });
    const outs = drive(host, module, 50);
    // Frame i: barPhase = 0.5 + (i+1)·0.008; phase == barPhase (period = 1 bar).
    expect(outs[24]).toBeCloseTo(2 * 0.7 - 1, 3);
    expect(outs[49]).toBeCloseTo(2 * 0.9 - 1, 3);
    // 100 more frames crosses the bar wrap: 0.5 + 150·0.008 = 1.7 → phase 0.7.
    const more = drive(host, module, 100);
    expect(more[99]).toBeCloseTo(2 * 0.7 - 1, 3);
  });

  it('LFO Beats+Free integrates the tempo-derived rate, ignoring bar position', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    host.frameState.barPhase = 0.77;   // free mode must ignore where the bar is
    patch(host, module, { mode: 2, sync: 0, period_beats: 4, waveform: SAW });
    const outs = drive(host, module, 50);
    // 4 beats at 120 BPM = 0.5 Hz → phase = 50·0.016·0.5 = 0.4.
    expect(outs[49]).toBeCloseTo(2 * 0.4 - 1, 3);
    // Halve the tempo live: rate drops to 0.25 Hz → 50 more frames add 0.2.
    const more = drive(host, module, 50, 60);
    expect(more[49]).toBeCloseTo(2 * 0.6 - 1, 3);
  });

  it('LFO Period+Locked re-anchors to host time (backward scrubs follow)', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    patch(host, module, { mode: 1, sync: 1, period: 2, waveform: SAW });
    const outs = drive(host, module, 25);
    // time = 25·0.016 = 0.4 s over a 2 s period → phase 0.2.
    expect(outs[24]).toBeCloseTo(2 * 0.2 - 1, 3);
    // Scrub the host clock backward: the locked phase follows it down.
    host.frameState.elapsedTime = 0.1 - 0.016;
    const after = drive(host, module, 1);
    expect(after[0]).toBeCloseTo(2 * 0.05 - 1, 3);
  });

  it('LFO defaults (Freq+Free) are unchanged: rate 0.5 = 5 Hz free-running', async () => {
    const loaded = await loadCore('mod.source.lfo');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;
    patch(host, module, { waveform: SAW });
    const outs = drive(host, module, 5);
    // phase = 5·0.016·5 = 0.4
    expect(outs[4]).toBeCloseTo(2 * 0.4 - 1, 3);
  });

  it('Beat Trigger: decay tail by default; Single Frame is an exact 1-frame gate', async () => {
    const loaded = await loadCore('mod.trigger.beat');
    if (!loaded) { console.warn('no core.wasm — skipping'); return; }
    const { host, module } = loaded;

    // Decay mode: the tick frame is exactly 1, the next ≈ exp(-dt/0.12) ≈ 0.875.
    const decay = drive(host, module, 80);
    const i0 = decay.findIndex((v) => v === 1);
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(decay[i0 + 1]).toBeGreaterThan(0.5);
    expect(decay[i0 + 1]).toBeLessThan(1);

    // Single-frame mode: output only ever exactly 0 or exactly 1, and every 1
    // is isolated (the frames around it are exact 0s).
    patch(host, module, { single_frame: 1 });
    const gate = drive(host, module, 80);
    expect(gate.every((v) => v === 0 || v === 1)).toBe(true);
    const ones = gate.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
    expect(ones.length).toBeGreaterThanOrEqual(2);   // every beat ≈ 31 frames
    for (const i of ones) {
      expect(gate[i - 1] ?? 0).toBe(0);
      expect(gate[i + 1] ?? 0).toBe(0);
    }
    // The trigger EVENT ring still fires in single-frame mode.
    const trig = (host.pluginState.triggers ?? []) as Array<{ on: boolean }>;
    expect(trig.some((t) => t.on === true)).toBe(true);
  });
});
