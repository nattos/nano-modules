import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from './wasm-host';

const WASM_PATH = resolve(__dirname, '../public/nanolooper.wasm');

// Helper: load WASM module directly from bytes (bypassing fetch)
async function loadHost(): Promise<{ host: WasmHost; module: ReturnType<Awaited<ReturnType<WasmHost['load']>>> }> {
  const host = new WasmHost();
  const bytes = readFileSync(WASM_PATH);

  // Patch the load method to use bytes directly instead of fetch
  const importObject = (host as any).buildImportObject
    ? (host as any).buildImportObject()
    : undefined;

  // We need to instantiate manually since fetch() doesn't work in Node
  const result = await WebAssembly.instantiate(bytes, buildImports(host));
  const instance = result.instance;
  (host as any).instance = instance;
  (host as any).memory = instance.exports.memory as WebAssembly.Memory;

  const exports = instance.exports;
  const wasmModule = {
    init: exports.init as () => void,
    tick: exports.tick as (dt: number) => void,
    render: exports.render as (vpW: number, vpH: number) => void,
    onParamChange: exports.on_param_change as (index: number, value: number) => void,
    onStateChanged: exports.on_state_changed as () => void,
  };

  return { host, module: wasmModule };
}

// Build the same import object that WasmHost.load() would
function buildImports(host: WasmHost): WebAssembly.Imports {
  const decoder = new TextDecoder();
  const getMemory = () => (host as any).memory as WebAssembly.Memory;
  const readString = (ptr: number, len: number) =>
    decoder.decode(new Uint8Array(getMemory().buffer, ptr, len));

  return {
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
      set_metadata: (_idPtr: number, _idLen: number, _versionPacked: number) => {},
      console_log: (_level: number, _msgPtr: number, _msgLen: number) => {},
      set: (_pathPtr: number, _pathLen: number, _jsonPtr: number, _jsonLen: number) => {
        try {
          host.pluginState = JSON.parse(new TextDecoder().decode(
            new Uint8Array(getMemory().buffer, _jsonPtr, _jsonLen)));
        } catch {}
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

    module.onParamChange(0, 1.0);
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

  it('on_state_changed reads grid from canonical state', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.barPhase = 0.1;

    // Trigger some events normally
    module.onParamChange(0, 1.0);
    module.onParamChange(0, 0.0);
    module.tick(0.016);

    // Now externally modify the canonical state (simulating a client edit)
    host.pluginState = {
      phase: 0,
      recording: false,
      event_count: 3,
      grid: [[0, 4], [8], [], []]
    };

    // Notify the module — it should read the grid via state.read
    module.onStateChanged();

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

  it('on_state_changed preserves all channels when editing one', async () => {
    const { host, module } = await loadHost();
    module.init();
    host.frameState.barPhase = 0.0;

    // Set up events on all 4 channels via the state
    host.pluginState = {
      phase: 0, recording: false, event_count: 4,
      grid: [[1], [3], [5], [7]]
    };
    module.onStateChanged();
    module.tick(0.016);

    // Verify all 4 channels loaded
    expect(host.pluginState.event_count).toBe(4);
    expect(host.pluginState.grid).toEqual([[1], [3], [5], [7]]);

    // Now edit: remove only channel 0's event
    host.pluginState = {
      phase: 0, recording: false, event_count: 3,
      grid: [[], [3], [5], [7]]
    };
    module.onStateChanged();
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
