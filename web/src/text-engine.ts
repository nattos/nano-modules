/*
 * text-engine.ts — host-side text service for the web runtime.
 *
 * Loads the shared text_engine.wasm ONCE (the same FreeType+msdfgen engine that
 * compiles natively for FFGL), installs a default font, and owns the WebGPU MSDF
 * compositor. The `text.*` import group in wasm-host.ts delegates here; effects
 * (e.g. gen.text) call text::layout / text::render and the pixels land in their
 * output texture.
 *
 * The compositor (WGSL below) and the marshalling mirror, byte-for-byte, the
 * standalone harness (web/public/text-gpu-test.html) that was verified
 * pixel-identical to the native/CPU reference — this module is that proven logic
 * refactored to render into a caller-provided GPUTexture.
 */

// MSDF compositor — mirrors native/src/text/shaders/text_composite.hlsl.
const WGSL = `
struct Glyph { rect: vec4<f32>, uv: vec4<f32>, rgba: vec4<f32> };
struct U {
  canvas_w:u32, canvas_h:u32, glyph_count:u32, atlas_w:u32, atlas_h:u32,
  origin_x:f32, origin_y:f32, atlas_kind:u32, atlas_px_range:f32,
  _p0:f32, _p1:f32, _p2:f32,
};
@group(0) @binding(0) var<storage, read> glyphs: array<Glyph>;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var bg_tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> u: U;

fn median3(a:f32, b:f32, c:f32) -> f32 { return max(min(a,b), min(max(a,b), c)); }
// LINEAR-filtered sample — bilinear interpolation of the distance field is what
// makes MSDF smooth (and corner-sharp) at any magnification.
fn atlas_texel(uu:f32, vv:f32) -> vec4<f32> {
  return textureSampleLevel(atlas_tex, samp, vec2<f32>(uu, vv), 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.canvas_w || gid.y >= u.canvas_h) { return; }
  let p = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let bg_uv = p / vec2<f32>(f32(u.canvas_w), f32(u.canvas_h));
  var col = textureSampleLevel(bg_tex, samp, bg_uv, 0.0).rgb;
  for (var i:u32 = 0u; i < u.glyph_count; i = i + 1u) {
    let g = glyphs[i];
    let gx = g.rect.x + u.origin_x;
    let gy = g.rect.y + u.origin_y;
    if (p.x < gx || p.y < gy || p.x >= gx + g.rect.z || p.y >= gy + g.rect.w) { continue; }
    let lu = (p.x - gx) / g.rect.z;
    let lv = (p.y - gy) / g.rect.w;
    let au = g.uv.x + lu * (g.uv.z - g.uv.x);
    let av = g.uv.y + lv * (g.uv.w - g.uv.y);
    let texel = atlas_texel(au, av);
    var cov: f32;
    if (u.atlas_kind == 0u) {
      let tile_h_px = (g.uv.w - g.uv.y) * f32(u.atlas_h);
      let spr = select(1.0, u.atlas_px_range * g.rect.w / tile_h_px, tile_h_px > 0.0);
      let sd = median3(texel.r, texel.g, texel.b);
      cov = clamp(spr * (sd - 0.5) + 0.5, 0.0, 1.0);
    } else {
      cov = texel.a;
    }
    let a = cov * g.rgba.a;
    col = g.rgba.rgb * a + col * (1.0 - a);
  }
  textureStore(out_tex, vec2<i32>(gid.xy), vec4<f32>(col, 1.0));
}`;

interface TEExports {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  __wasm_call_ctors?(): void;
  te_set_font(ptr: number, len: number): number;
  te_layout(ptr: number, len: number): number;
  te_measure(id: number, outPtr: number): number;
  te_glyph_count(id: number): number;
  te_glyphs(id: number, outPtr: number, outBytes: number): number;
  te_release(id: number): void;
  te_rasterize(id: number, w: number, h: number, ox: number, oy: number, bg: number, out: number): number;
  te_atlas_width(): number;
  te_atlas_height(): number;
  te_atlas_ptr(): number;
  te_next_dirty_region(outPtr: number): number;
}

// Back the singleton with globalThis so it survives module duplication across
// vite/HMR boundaries (wasm-host.ts and gpu-test-runner.html can otherwise end
// up with separate module instances, splitting a plain `static` singleton).
const G = globalThis as unknown as {
  __textEngine?: TextEngine;
  __textEngineInit?: Promise<TextEngine>;
};

export class TextEngine {
  private ex!: TEExports;
  private device!: GPUDevice;
  private pipeline!: GPUComputePipeline;
  private bgTex!: GPUTexture;
  private sampler!: GPUSampler;
  private atlasTex: GPUTexture | null = null;

  static get instance(): TextEngine | null { return G.__textEngine ?? null; }

  /** Idempotent async init. Safe to call repeatedly; the first call wins. */
  static init(device: GPUDevice, opts?: { wasmUrl?: string; fontUrl?: string }): Promise<TextEngine> {
    if (G.__textEngine) return Promise.resolve(G.__textEngine);
    if (!G.__textEngineInit) {
      const e = new TextEngine();
      G.__textEngineInit = e
        ._init(device, opts?.wasmUrl ?? '/wasm/text_engine.wasm', opts?.fontUrl ?? '/fonts/default.ttf')
        .then(() => (G.__textEngine = e));
    }
    return G.__textEngineInit;
  }

  private async _init(device: GPUDevice, wasmUrl: string, fontUrl: string) {
    this.device = device;
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    const mod = await WebAssembly.compile(bytes);
    // Generic no-op stubs for wasi + the unused env setjmp/longjmp.
    const importObject: WebAssembly.Imports = {};
    for (const i of WebAssembly.Module.imports(mod)) {
      (importObject[i.module] ??= {} as any);
      if (i.kind === 'function') (importObject[i.module] as any)[i.name] = () => 0;
    }
    const inst = await WebAssembly.instantiate(mod, importObject);
    this.ex = inst.exports as unknown as TEExports;
    this.ex.__wasm_call_ctors?.();

    const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
    const fp = this.ex.malloc(font.length);
    new Uint8Array(this.ex.memory.buffer).set(font, fp);
    if (!this.ex.te_set_font(fp, font.length)) throw new Error('text-engine: te_set_font failed');
    this.ex.free(fp);

    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'main' },
    });
    this.bgTex = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.bgTex }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);
    // LINEAR filtering — required for MSDF distance-field interpolation.
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  private u8() { return new Uint8Array(this.ex.memory.buffer); }

  layout(specJson: string): number {
    const enc = new TextEncoder().encode(specJson);
    const p = this.ex.malloc(enc.length);
    this.u8().set(enc, p);
    const id = this.ex.te_layout(p, enc.length);
    this.ex.free(p);
    return id;
  }

  /** Copy the 32-byte TextMetrics for `id` out of engine memory. */
  measureBytes(id: number): Uint8Array {
    const p = this.ex.malloc(32);
    this.ex.te_measure(id, p);
    const out = this.u8().slice(p, p + 32);
    this.ex.free(p);
    return out;
  }

  glyphCount(id: number): number { return this.ex.te_glyph_count(id); }
  release(id: number): void { this.ex.te_release(id); }

  /** Composite the laid-out text for `id` into `target` at (originX, originY). */
  render(id: number, target: GPUTexture, originX: number, originY: number): void {
    const ex = this.ex;
    const device = this.device;

    const count = ex.te_glyph_count(id);
    if (count <= 0) return;
    const gPtr = ex.malloc(count * 48);
    const written = ex.te_glyphs(id, gPtr, count * 48);
    const glyphBytes = this.u8().slice(gPtr, gPtr + written * 48);
    ex.free(gPtr);

    const mPtr = ex.malloc(32);
    ex.te_measure(id, mPtr);
    const dv = new DataView(ex.memory.buffer);
    const atlasKind = dv.getInt32(mPtr + 20, true);
    const atlasPxRange = dv.getFloat32(mPtr + 24, true);
    ex.free(mPtr);

    const aw = ex.te_atlas_width(), ah = ex.te_atlas_height();
    // Drain dirty regions; re-upload the atlas texture if anything changed.
    let dirty = false;
    const rPtr = ex.malloc(20);
    while (ex.te_next_dirty_region(rPtr)) dirty = true;
    ex.free(rPtr);
    if (!this.atlasTex) {
      this.atlasTex = device.createTexture({ size: [aw, ah], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      dirty = true;
    }
    if (dirty) {
      const aPtr = ex.te_atlas_ptr();
      const atlasBytes = this.u8().slice(aPtr, aPtr + aw * ah * 4);
      device.queue.writeTexture({ texture: this.atlasTex }, atlasBytes, { bytesPerRow: aw * 4, rowsPerImage: ah }, [aw, ah]);
    }

    const cw = target.width, ch = target.height;
    const glyphBuf = device.createBuffer({ size: Math.max(48, glyphBytes.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(glyphBuf, 0, glyphBytes);

    const uni = new ArrayBuffer(48);
    const uv = new DataView(uni);
    uv.setUint32(0, cw, true); uv.setUint32(4, ch, true); uv.setUint32(8, written, true);
    uv.setUint32(12, aw, true); uv.setUint32(16, ah, true);
    uv.setFloat32(20, originX, true); uv.setFloat32(24, originY, true);
    uv.setUint32(28, atlasKind, true); uv.setFloat32(32, atlasPxRange, true);
    const uniBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniBuf, 0, uni);

    const bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: glyphBuf } },
        { binding: 1, resource: this.atlasTex.createView() },
        { binding: 2, resource: this.bgTex.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: target.createView() },
        { binding: 5, resource: { buffer: uniBuf } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(cw / 8), Math.ceil(ch / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}
