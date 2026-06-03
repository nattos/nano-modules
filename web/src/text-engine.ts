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
  te_add_font(namePtr: number, nameLen: number, ptr: number, len: number): number;
  te_has_font(namePtr: number, nameLen: number): number;
  te_add_fallback_font(ptr: number, len: number, langPtr: number, langLen: number): number;
  te_set_default_lang(langPtr: number, langLen: number): void;
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

import type { FontRequest } from './engine-types';

/** A named font the host resolves to sfnt bytes at a URL (the web font provider's
 *  bundled, parity-guaranteed set). A run's JSON `family` matches `family` here. */
export interface FontSource { family: string; url: string; }

/** Canonical face-registry key for a (family, weight, italic) style. MUST stay
 *  byte-identical to faceKey() in native/src/text/text_engine.cpp — regular
 *  (weight 400, upright) keeps the bare family name; styled faces append a
 *  0x01-separated weight (+ "i" for italic). */
export function faceKey(family: string, weight: number, italic: boolean): string {
  if (!family) return '';
  if (weight === 400 && !italic) return family;
  return `${family}\u0001${Math.round(weight)}${italic ? 'i' : ''}`;
}

// Bundled families guaranteed on the web side — the parity-guaranteed set, OFL
// Noto faces fetched by web/scripts/fetch_fonts.sh (see FONTS.md). Their bytes
// match what the native host bundles, so a run naming one of these families is
// reproduced pixel-for-pixel. Missing files (script not run) load-fail softly
// → fallback to the primary font. The app can override via init({ fonts }).
const DEFAULT_FONTS: FontSource[] = [
  { family: 'Noto Sans',  url: '/fonts/noto-sans.ttf' },
  { family: 'Noto Serif', url: '/fonts/noto-serif.ttf' },
];

/** A fallback face + its CJK region tag (for regional Han selection). */
interface FallbackSource { url: string; lang: string; }

/** Pick the default CJK language from the browser/OS locale. Scans
 *  navigator.languages (the ordered preference list) for the FIRST entry that
 *  maps to a CJK script — so a user whose primary UI is English but who lists
 *  Japanese as a preference still gets ja Han forms. Falls back to
 *  navigator.language (which normalizes to "" if non-CJK → chain order).
 *  Returns { chosen, language, languages } for diagnostics. */
function detectDefaultLang(): { chosen: string; language: string; languages: string[] } {
  const nav: any = (globalThis as any).navigator;
  const language: string = nav?.language ?? '';
  const languages: string[] = nav?.languages?.length ? [...nav.languages] : (language ? [language] : []);
  const isCjk = (l: string) => /^(ja|ko|zh)\b/i.test(l);
  const chosen = languages.find(isCjk) ?? language;
  return { chosen, language, languages };
}

// Fallback chain (priority order): consulted for codepoints the active face
// lacks, so CJK etc. render instead of tofu. `lang` lets a run pick the right
// regional Han forms (ja/ko/zh-Hant/zh-Hans). glyf-flavored Noto faces → byte
// parity. Extend with Arabic / Hebrew for full coverage.
const DEFAULT_FALLBACKS: FallbackSource[] = [
  { url: '/fonts/noto-sans-jp.ttf', lang: 'ja' },       // Japanese (kana + kanji)
  { url: '/fonts/noto-sans-sc.ttf', lang: 'zh-Hans' },  // Simplified Chinese / Han
  { url: '/fonts/noto-sans-tc.ttf', lang: 'zh-Hant' },  // Traditional Chinese
  { url: '/fonts/noto-sans-kr.ttf', lang: 'ko' },       // Korean (hangul)
];

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

  /** Resolves to the engine once init completes (or null if init never started).
   *  Lets late arrivals — e.g. a registerFont message that races init — wait. */
  static whenReady(): Promise<TextEngine | null> {
    return G.__textEngineInit ?? Promise.resolve(G.__textEngine ?? null);
  }

  // Host hook: invoked (once per face key, via ensureFontsForSpec) when a spec
  // names a styled face that isn't registered yet. The engine runs in a Worker
  // where Local Font Access (queryLocalFonts) is unavailable, so the worker sets
  // this to ask the MAIN thread to resolve the bytes and post them back to
  // registerFontBytes (under req.key). When unset (engine on the main thread,
  // e.g. tests), ensureFontsForSpec falls back to ensureLocalFont directly.
  onFontRequest: ((req: FontRequest) => void) | null = null;

  /** Idempotent async init. Safe to call repeatedly; the first call wins. */
  static init(
    device: GPUDevice,
    opts?: { wasmUrl?: string; fontUrl?: string; fonts?: FontSource[]; fallbacks?: FallbackSource[] },
  ): Promise<TextEngine> {
    if (G.__textEngine) return Promise.resolve(G.__textEngine);
    if (!G.__textEngineInit) {
      const e = new TextEngine();
      G.__textEngineInit = e
        ._init(device, opts?.wasmUrl ?? '/wasm/text_engine.wasm',
               opts?.fontUrl ?? '/fonts/default.ttf', opts?.fonts ?? DEFAULT_FONTS,
               opts?.fallbacks ?? DEFAULT_FALLBACKS)
        .then(() => (G.__textEngine = e));
    }
    return G.__textEngineInit;
  }

  private async _init(device: GPUDevice, wasmUrl: string, fontUrl: string,
                      fonts: FontSource[], fallbacks: FallbackSource[]) {
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

    // Register the bundled, parity-guaranteed font set (each family resolves to
    // byte-identical sfnt bytes on native + web). Failures are non-fatal — a run
    // referencing a missing family falls back to the primary font (face 0).
    for (const f of fonts) {
      try { await this.loadFont(f.family, f.url); }
      catch (e) { console.warn(`text-engine: bundled font "${f.family}" failed to load`, e); }
    }
    // Default the regional Han language to the system locale (navigator is
    // available in Web Workers too; reflects the OS locale under Electron). A
    // run/spec `lang` overrides it per-text. Logged so the choice is inspectable.
    const loc = detectDefaultLang();
    console.info('[text-engine] locale →', JSON.stringify(loc), '(set gen.text "lang" to override)');
    this.setDefaultLang(loc.chosen);

    // Register the fallback chain (CJK etc.) in priority order, each tagged with
    // its region so a run's language picks the right Han forms.
    for (const f of fallbacks) {
      try { await this.loadFallback(f.url, f.lang); }
      catch (e) { console.warn(`text-engine: fallback font ${f.url} failed to load`, e); }
    }

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

  // --- Font provider ---------------------------------------------------------
  // The host owns font resolution: a run's `family` is matched against faces
  // registered here. Resolution is necessarily async (fetch / Local Font Access)
  // while layout() is per-frame sync, so families must be registered BEFORE the
  // layouts that use them; an unregistered family falls back to the primary
  // font (face 0) for that frame.

  /** True if `family` is already registered (skip re-resolving its bytes). */
  hasFont(family: string): boolean {
    const enc = new TextEncoder().encode(family);
    const p = this.ex.malloc(enc.length);
    this.u8().set(enc, p);
    const has = this.ex.te_has_font(p, enc.length) !== 0;
    this.ex.free(p);
    return has;
  }

  /** Register a face from sfnt bytes under `family`. Returns the faceId (>=0),
   *  or -1 on failure. Idempotent by family name. */
  registerFontBytes(family: string, bytes: Uint8Array): number {
    const nameEnc = new TextEncoder().encode(family);
    const np = this.ex.malloc(nameEnc.length);
    this.u8().set(nameEnc, np);
    const bp = this.ex.malloc(bytes.length);
    this.u8().set(bytes, bp);
    const id = this.ex.te_add_font(np, nameEnc.length, bp, bytes.length);
    this.ex.free(bp);
    this.ex.free(np);
    return id;
  }

  /** Register a fallback face from sfnt bytes (appended to the chain consulted
   *  for codepoints the active face lacks). `lang` (ja/ko/zh-Hant/zh-Hans) tags
   *  its region for Han selection. Returns the faceId, or -1. */
  registerFallbackBytes(bytes: Uint8Array, lang = ''): number {
    const bp = this.ex.malloc(bytes.length);
    this.u8().set(bytes, bp);
    const lb = new TextEncoder().encode(lang);
    const lp = this.ex.malloc(lb.length || 1);
    this.u8().set(lb, lp);
    const id = this.ex.te_add_fallback_font(bp, bytes.length, lp, lb.length);
    this.ex.free(lp);
    this.ex.free(bp);
    return id;
  }

  /** Fetch sfnt bytes from `url` and register them as a fallback face, tagged
   *  with its CJK region `lang`. */
  async loadFallback(url: string, lang = ''): Promise<number> {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const id = this.registerFallbackBytes(bytes, lang);
    if (id < 0) throw new Error(`text-engine: failed to register fallback ${url}`);
    return id;
  }

  /** Set the default language (system locale) for text without its own `lang`. */
  setDefaultLang(lang: string): void {
    const lb = new TextEncoder().encode(lang);
    const lp = this.ex.malloc(lb.length || 1);
    this.u8().set(lb, lp);
    this.ex.te_set_default_lang(lp, lb.length);
    this.ex.free(lp);
  }

  /** Fetch sfnt bytes from `url` and register them under `family`. No-op if the
   *  family is already registered. */
  async loadFont(family: string, url: string): Promise<number> {
    if (this.hasFont(family)) return 0;
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const id = this.registerFontBytes(family, bytes);
    if (id < 0) throw new Error(`text-engine: failed to register font "${family}" from ${url}`);
    return id;
  }

  // Face keys already resolved or attempted, so a per-frame spec scan never
  // re-queries (Local Font Access is expensive and prompts permission once).
  private attemptedFaces = new Set<string>();

  /** Scan a layout spec's runs for styled faces (family + weight + italic) and
   *  kick off async resolution of any not yet registered. Fire-and-forget: the
   *  current frame falls back to the regular/primary font; the resolved face
   *  appears on a later frame. Each face key is attempted at most once. Call
   *  before layout(). */
  ensureFontsForSpec(specJson: string): void {
    for (const req of this.facesNeededBy(specJson)) {
      if (this.attemptedFaces.has(req.key) || this.hasFont(req.key)) continue;
      this.attemptedFaces.add(req.key);
      if (this.onFontRequest) this.onFontRequest(req);     // worker → main thread resolves
      else void this.ensureLocalFont(req.family);          // main-thread direct (tests)
    }
  }

  /** Extract the distinct styled faces a spec references as FontRequests. Parses
   *  the runs array (family/weight/italic); falls back to a family-name regex
   *  (regular only) if the spec isn't valid JSON. */
  private facesNeededBy(specJson: string): FontRequest[] {
    const out: FontRequest[] = [];
    const add = (family: string, weight: number, italic: boolean) => {
      if (!family) return;
      const key = faceKey(family, weight, italic);
      if (!out.some((r) => r.key === key)) out.push({ key, family, weight, italic });
    };
    let runs: any[] | null = null;
    try { const o = JSON.parse(specJson); if (Array.isArray(o?.runs)) runs = o.runs; } catch { /* regex below */ }
    if (runs) {
      for (const r of runs) {
        if (typeof r?.family !== 'string') continue;
        const weight = typeof r.weight === 'number' ? r.weight : 400;
        add(r.family, weight, r.italic === true || r.italic === 1);
      }
    } else {
      const re = /"family"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(specJson)) !== null) add(m[1].replace(/\\(.)/g, '$1'), 400, false);
    }
    return out;
  }

  /** Resolve `family` via the browser's Local Font Access API (Chromium, behind
   *  a permission prompt) and register its bytes. Returns true if registered,
   *  false if unavailable / not found / denied — callers should fall back to a
   *  bundled face. Off the per-frame path; call when the user picks a font. */
  async ensureLocalFont(family: string): Promise<boolean> {
    if (this.hasFont(family)) return true;
    const ql = (globalThis as any).queryLocalFonts as
      undefined | (() => Promise<Array<{ family: string; blob(): Promise<Blob> }>>);
    if (!ql) return false;
    try {
      const fonts = await ql();
      const hit = fonts.find((f) => f.family === family);
      if (!hit) return false;
      const bytes = new Uint8Array(await (await hit.blob()).arrayBuffer());
      return this.registerFontBytes(family, bytes) >= 0;
    } catch {
      return false;  // permission denied / not supported
    }
  }

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
