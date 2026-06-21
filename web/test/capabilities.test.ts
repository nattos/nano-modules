/**
 * Effect capability surfacing E2E.
 *
 * Effects declare temporal capabilities (time_independent /
 * seekable_approximate / seekable_prefill) and others in their schema's
 * top-level `capabilities` array. The WasmHost parses that array into
 * `host.capabilities` when the effect publishes its schema during
 * module_init. This verifies the array round-trips to the web host the
 * same way it does to the native ModuleRegistry, and that the optional
 * `seek` effect-export (declared in the ABI but implemented by no effect)
 * surfaces as an absent `module.seek`.
 */

describe('Effect capabilities (schema → WasmHost)', () => {
  jest.setTimeout(30000);

  it('surfaces temporal capability tags and the (unimplemented) seek export', async () => {
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto('http://localhost:5173/gpu-test-runner.html', { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const { WasmHost } = await import('/src/wasm-host.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();

      // One fresh host per effect — set_schema (which fills host.capabilities)
      // only fires on an effect type's first module_init, so a per-effect host
      // gives each a clean read.
      async function capsOf(effectId) {
        const gpuHost = new GPUHost(device, 'rgba8unorm');
        const tex = device.createTexture({
          size: [16, 16], format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
               | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        gpuHost.setSurface(tex, 16, 16);
        const host = new WasmHost();
        host.gpuHost = gpuHost;
        host.textureFields.set('tex_in', gpuHost.injectTexture(tex));
        host.textureFields.set('tex_out', gpuHost.injectTexture(tex));
        await host.load('/wasm/core.wasm');
        const mod = host.activateEffect(effectId);
        return {
          caps: Array.from(host.capabilities).sort(),
          hasSeek: typeof mod.seek === 'function',
          abiVersion: host.abiVersion,
        };
      }

      return {
        brightness: await capsOf('color.tone.brightness_contrast'),
        lfo: await capsOf('mod.source.lfo'),
        adsr: await capsOf('mod.source.adsr'),
      };
    })()`);

    const r = result as any;

    // Stateless tone op → time_independent, none of the seek tags.
    expect(r.brightness.caps).toContain('time_independent');
    expect(r.brightness.caps).not.toContain('seekable_approximate');
    expect(r.brightness.caps).not.toContain('seekable_prefill');

    // Free-running LFO → seekable_approximate (not time_independent).
    expect(r.lfo.caps).toContain('seekable_approximate');
    expect(r.lfo.caps).not.toContain('time_independent');

    // ADSR (trigger/voice state machine) → no temporal tag at all.
    expect(r.adsr.caps).not.toContain('time_independent');
    expect(r.adsr.caps).not.toContain('seekable_approximate');
    expect(r.adsr.caps).not.toContain('seekable_prefill');

    // seek() is declared in the ABI but no effect implements it, so the
    // optional export resolves to absent on the module wrapper.
    expect(r.brightness.hasSeek).toBe(false);
    expect(r.lfo.hasSeek).toBe(false);
    expect(r.adsr.hasSeek).toBe(false);

    // The bundle reports its host<->effect ABI version (from nano_abi_version()).
    // 0 would mean the export wasn't found / wired.
    expect(r.brightness.abiVersion).toBeGreaterThanOrEqual(1);
    expect(r.lfo.abiVersion).toBe(r.brightness.abiVersion);
  });
});
