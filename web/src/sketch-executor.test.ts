import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from './wasm-host';
import type { Sketch, ChainEntry } from './sketch-types';

const BC_WASM_PATH = resolve(__dirname, '../public/wasm/brightness_contrast.wasm');

// Helper: load a WASM module from bytes (bypassing fetch)
async function loadModuleFromBytes(host: WasmHost, bytes: Buffer) {
  // Patch fetch to return our bytes
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as any;

  try {
    return await host.load('test.wasm');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Brightness/Contrast module', () => {
  it('loads and declares correct metadata', async () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(BC_WASM_PATH);
    } catch {
      console.warn('brightness_contrast.wasm not found, skipping test');
      return;
    }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    module.init();

    expect(host.metadata).not.toBeNull();
    expect(host.metadata!.id).toBe('com.nattos.brightness_contrast');
    expect(host.params.length).toBe(2);
    expect(host.params[0].name).toBe('Brightness');
    expect(host.params[0].defaultValue).toBeCloseTo(0.5);
    expect(host.params[1].name).toBe('Contrast');
    expect(host.params[1].defaultValue).toBeCloseTo(0.5);
  });

  it('declares I/O ports', async () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(BC_WASM_PATH);
    } catch {
      console.warn('brightness_contrast.wasm not found, skipping test');
      return;
    }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    module.init();

    expect(host.ioDecls.length).toBe(2);

    const texIn = host.ioDecls.find(d => d.kind === 0); // IO_TEXTURE_INPUT
    expect(texIn).toBeDefined();
    expect(texIn!.name).toBe('Input');
    expect(texIn!.role).toBe(0); // IO_PRIMARY

    const texOut = host.ioDecls.find(d => d.kind === 1); // IO_TEXTURE_OUTPUT
    expect(texOut).toBeDefined();
    expect(texOut!.name).toBe('Output');
    expect(texOut!.role).toBe(0); // IO_PRIMARY
  });

  it('on_param_change does not crash', async () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(BC_WASM_PATH);
    } catch {
      console.warn('brightness_contrast.wasm not found, skipping test');
      return;
    }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    module.init();
    module.onParamChange(0, 0.7); // brightness
    module.onParamChange(1, 0.3); // contrast
  });

  it('render without GPU host does not crash', async () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(BC_WASM_PATH);
    } catch {
      console.warn('brightness_contrast.wasm not found, skipping test');
      return;
    }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    module.init();
    // render without GPU — should not crash (GPU backend returns None/-1)
    module.render(640, 480);
  });
});

describe('Sketch data model', () => {
  it('creates a valid sketch structure', () => {
    const sketch: Sketch = {
      anchor: 'com.nattos.spinningtris@0',
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'primary_in' },
          {
            type: 'module',
            module_type: 'com.nattos.brightness_contrast',
            instance_key: 'virtual_bc@0',
            params: { '0': 0.5, '1': 0.25 },
          },
          { type: 'texture_output', id: 'primary_out' },
        ],
      }],
    };

    expect(sketch.anchor).toBe('com.nattos.spinningtris@0');
    expect(sketch.columns).toHaveLength(1);
    expect(sketch.columns[0].chain).toHaveLength(3);

    const moduleEntry = sketch.columns[0].chain[1];
    expect(moduleEntry.type).toBe('module');
    if (moduleEntry.type === 'module') {
      expect(moduleEntry.module_type).toBe('com.nattos.brightness_contrast');
      expect(moduleEntry.params['1']).toBe(0.25);
    }
  });
});
