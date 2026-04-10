import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from './wasm-host';

// Try combined module first, fall back to standalone
const NANO_EFFECTS_PATH = resolve(__dirname, '../public/wasm/nano_effects.wasm');
const NANOLOOPER_PATH = resolve(__dirname, '../public/wasm/nanolooper.wasm');

function getWasmBytes(): Buffer | null {
  try { return readFileSync(NANO_EFFECTS_PATH); } catch {}
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
  const result = await WebAssembly.instantiate(bytes, imports);
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
    const wasmModule = host.activateEffect('com.nattos.nanolooper');
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
        const key = 'com.nattos.nanolooper@0';
        const enc = new TextEncoder().encode(key);
        const len = Math.min(enc.length, bufLen);
        new Uint8Array(getMemory().buffer, bufPtr, len).set(enc.subarray(0, len));
        return len;
      },
      set_metadata: (_idPtr: number, _idLen: number, _versionPacked: number) => {},
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
    gpu: {
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
      get_input_texture: () => -1,
      get_input_texture_count: () => 0,
      texture_for_field: () => -1,
    },
    module: {
      register_effect: (descPtr: number) => {
        const mem = new DataView(getMemory().buffer);
        const memBytes = new Uint8Array(getMemory().buffer);
        const version = mem.getInt32(descPtr, true);
        if (version !== 1) return;

        const readCStr = (ptr: number) => {
          let end = ptr;
          while (memBytes[end] !== 0) end++;
          return new TextDecoder().decode(memBytes.slice(ptr, end));
        };

        host.registeredEffects.push({
          id: readCStr(mem.getUint32(descPtr + 4, true)),
          name: readCStr(mem.getUint32(descPtr + 8, true)),
          description: readCStr(mem.getUint32(descPtr + 12, true)),
          category: readCStr(mem.getUint32(descPtr + 16, true)),
          keywords: readCStr(mem.getUint32(descPtr + 20, true)).split(',').filter((k: string) => k.length > 0),
          _initIdx: mem.getUint32(descPtr + 24, true),
          _tickIdx: mem.getUint32(descPtr + 28, true),
          _renderIdx: mem.getUint32(descPtr + 32, true),
          _onStatePatchedIdx: mem.getUint32(descPtr + 36, true),
          _onResolumeParamIdx: mem.getUint32(descPtr + 40, true),
        });
      },
    },
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

  it('render produces draw commands', async () => {
    const { host, module } = await loadHost();
    module.init();

    host.frameState.elapsedTime = 1.0;
    host.frameState.barPhase = 0.25;
    host.frameState.viewportW = 1920;
    host.frameState.viewportH = 1080;

    host.drawList = [];
    module.render(1920, 1080);

    expect(host.drawList.length).toBeGreaterThan(0);
    expect(host.drawList.filter(c => c.type === 'fill_rect').length).toBeGreaterThan(0);
    expect(host.drawList.filter(c => c.type === 'draw_text').length).toBeGreaterThan(0);
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

  it('draw commands contain expected text', async () => {
    const { host, module } = await loadHost();
    module.init();

    host.frameState.elapsedTime = 1.0;
    host.frameState.viewportW = 1920;
    host.frameState.viewportH = 1080;

    host.drawList = [];
    module.render(1920, 1080);

    const texts = host.drawList.filter(c => c.type === 'draw_text').map(c => c.text);
    expect(texts).toContain('Looper');
    expect(texts).toContain('Connecting...');
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

    host.drawList = [];
    host.frameState.viewportW = 800;
    host.frameState.viewportH = 600;
    module.render(800, 600);
    expect(host.drawList.length).toBeGreaterThan(0);
  });
});
