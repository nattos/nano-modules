import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { WasmHost } from './wasm-host';
import type { Sketch, ChainEntry } from './sketch-types';

const NANO_EFFECTS_WASM_PATH = resolve(__dirname, '../public/wasm/nano_effects.wasm');
// Fallback to individual module for backward compat
const BC_WASM_PATH = resolve(__dirname, '../public/wasm/brightness_contrast.wasm');

// Helper: load a WASM module from bytes, discover effects, and activate one
async function loadModuleFromBytes(host: WasmHost, bytes: Buffer, effectId = 'video.brightness_contrast') {
  // Patch fetch to return our bytes
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  })) as any;

  try {
    await host.load('test.wasm');
    return host.activateEffect(effectId);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function getWasmBytes(): Buffer | null {
  try {
    return readFileSync(NANO_EFFECTS_WASM_PATH);
  } catch {
    try { return readFileSync(BC_WASM_PATH); } catch { return null; }
  }
}

describe('Brightness/Contrast module', () => {
  it('loads and declares correct metadata', async () => {
    const bytes = getWasmBytes();
    if (!bytes) { console.warn('WASM not found, skipping test'); return; }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    expect(host.metadata).not.toBeNull();
    expect(host.metadata!.id).toBe('video.brightness_contrast');
    expect(host.params.length).toBe(2);
    expect(host.params[0].name).toBe('brightness');
    expect(host.params[0].defaultValue).toBeCloseTo(0.5);
    expect(host.params[1].name).toBe('contrast');
    expect(host.params[1].defaultValue).toBeCloseTo(0.5);
  });

  it('declares I/O ports', async () => {
    const bytes = getWasmBytes();
    if (!bytes) { console.warn('WASM not found, skipping test'); return; }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    expect(host.ioDecls.length).toBe(2);

    const texIn = host.ioDecls.find(d => d.kind === 0); // IO_TEXTURE_INPUT
    expect(texIn).toBeDefined();
    expect(texIn!.name).toBe('tex_in');
    expect(texIn!.role).toBe(0); // IO_PRIMARY

    const texOut = host.ioDecls.find(d => d.kind === 1); // IO_TEXTURE_OUTPUT
    expect(texOut).toBeDefined();
    expect(texOut!.name).toBe('tex_out');
    expect(texOut!.role).toBe(0); // IO_PRIMARY
  });

  it('on_param_change does not crash', async () => {
    const bytes = getWasmBytes();
    if (!bytes) { console.warn('WASM not found, skipping test'); return; }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    host.notifyStatePatched(module, [
      { op: 'replace', path: 'brightness', value: 0.7 },
      { op: 'replace', path: 'contrast', value: 0.3 },
    ]);
  });

  it('render without GPU host does not crash', async () => {
    const bytes = getWasmBytes();
    if (!bytes) { console.warn('WASM not found, skipping test'); return; }

    const host = new WasmHost();
    const module = await loadModuleFromBytes(host, bytes);

    // render without GPU — should not crash (GPU backend returns None/-1)
    module.render(640, 480);
  });
});

describe('Sketch data model', () => {
  it('creates a valid sketch structure', () => {
    const sketch: Sketch = {
      anchor: 'generator.spinningtris@0',
      columns: [{
        name: 'main',
        chain: [
          { type: 'texture_input', id: 'primary_in' },
          {
            type: 'module',
            module_type: 'video.brightness_contrast',
            instance_key: 'virtual_bc@0',
            params: { '0': 0.5, '1': 0.25 },
          },
          { type: 'texture_output', id: 'primary_out' },
        ],
      }],
    };

    expect(sketch.anchor).toBe('generator.spinningtris@0');
    expect(sketch.columns).toHaveLength(1);
    expect(sketch.columns[0].chain).toHaveLength(3);

    const moduleEntry = sketch.columns[0].chain[1];
    expect(moduleEntry.type).toBe('module');
    if (moduleEntry.type === 'module') {
      expect(moduleEntry.module_type).toBe('video.brightness_contrast');
      expect(moduleEntry.params?.['1']).toBe(0.25);
    }
  });
});
