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
// 64-byte glyph: aux.x = atlas-array page (layer). ("meta" is a WGSL keyword.)
struct Glyph { rect: vec4<f32>, uv: vec4<f32>, rgba: vec4<f32>, aux: vec4<f32> };
// 48-byte background box: rect(x,y,w,h), rgba, radius(tl,tr,br,bl).
struct Box { rect: vec4<f32>, rgba: vec4<f32>, radius: vec4<f32> };
struct U {
  canvas_w:u32, canvas_h:u32, glyph_count:u32, atlas_w:u32, atlas_h:u32,
  origin_x:f32, origin_y:f32, atlas_kind:u32, atlas_px_range:f32,
  box_count:u32, _p1:f32, _p2:f32,
};
@group(0) @binding(0) var<storage, read> glyphs: array<Glyph>;
@group(0) @binding(1) var atlas_arr: texture_2d_array<f32>;
@group(0) @binding(2) var bg_tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var out_tex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<uniform> u: U;
@group(0) @binding(6) var<storage, read> boxes: array<Box>;

fn median3(a:f32, b:f32, c:f32) -> f32 { return max(min(a,b), min(max(a,b), c)); }
// Signed distance (px) to a rounded box; radius = (tl,tr,br,bl), selected per
// quadrant and clamped to half-extent. Matches the engine's CPU sdRoundBox, so
// the GPU composite is byte-equal to the te_rasterize reference.
fn sd_round_box(p:vec2<f32>, c:vec2<f32>, h:vec2<f32>, rad:vec4<f32>) -> f32 {
  let d = p - c;
  let top = d.y < 0.0;
  var r = select(select(rad.w, rad.x, top), select(rad.z, rad.y, top), d.x > 0.0);
  r = clamp(r, 0.0, min(h.x, h.y));
  let q = abs(d) - h + vec2<f32>(r, r);
  return min(max(q.x, q.y), 0.0) + length(max(q, vec2<f32>(0.0, 0.0))) - r;
}
// LINEAR-filtered sample of the glyph's atlas PAGE (array layer) — bilinear
// distance-field interpolation = smooth, corner-sharp MSDF at any magnification.
fn atlas_texel(uu:f32, vv:f32, page:i32) -> vec4<f32> {
  return textureSampleLevel(atlas_arr, samp, vec2<f32>(uu, vv), page, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.canvas_w || gid.y >= u.canvas_h) { return; }
  let p = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let bg_uv = p / vec2<f32>(f32(u.canvas_w), f32(u.canvas_h));
  var col = textureSampleLevel(bg_tex, samp, bg_uv, 0.0).rgb;
  // Background fills, behind the glyphs, in document order.
  for (var b:u32 = 0u; b < u.box_count; b = b + 1u) {
    let bq = boxes[b];
    let c = vec2<f32>(bq.rect.x + u.origin_x + bq.rect.z * 0.5,
                      bq.rect.y + u.origin_y + bq.rect.w * 0.5);
    let sd = sd_round_box(p, c, vec2<f32>(bq.rect.z * 0.5, bq.rect.w * 0.5), bq.radius);
    let bcov = clamp(0.5 - sd, 0.0, 1.0);
    let ba = bcov * bq.rgba.a;
    col = bq.rgba.rgb * ba + col * (1.0 - ba);
  }
  for (var i:u32 = 0u; i < u.glyph_count; i = i + 1u) {
    let g = glyphs[i];
    let gx = g.rect.x + u.origin_x;
    let gy = g.rect.y + u.origin_y;
    if (p.x < gx || p.y < gy || p.x >= gx + g.rect.z || p.y >= gy + g.rect.w) { continue; }
    let lu = (p.x - gx) / g.rect.z;
    let lv = (p.y - gy) / g.rect.w;
    let au = g.uv.x + lu * (g.uv.z - g.uv.x);
    let av = g.uv.y + lv * (g.uv.w - g.uv.y);
    let texel = atlas_texel(au, av, i32(g.aux.x));
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
  te_box_count(id: number): number;
  te_boxes(id: number, outPtr: number, outBytes: number): number;
  te_release(id: number): void;
  te_rasterize(id: number, w: number, h: number, ox: number, oy: number, bg: number, out: number): number;
  te_atlas_width(): number;
  te_atlas_height(): number;
  te_atlas_page_count(): number;
  te_atlas_page_ptr(page: number): number;
  te_next_dirty_region(outPtr: number): number;
  // Blitz complex-layout mode: rasterize pre-shaped runs + background boxes
  // from text_blitz.wasm.
  te_layout_glyphs(runsPtr: number, count: number, boxPtr: number, boxCount: number): number;
}

/** Exports of text_blitz.wasm — the Rust Blitz layout lib (Stylo + Taffy +
 *  parley). Lays out HTML/CSS with the host's font bytes and returns pre-shaped
 *  glyph runs (TbGlyph == text_engine::PreGlyph, 48 bytes) for the GID seam. */
interface TBExports {
  memory: WebAssembly.Memory;
  _initialize?(): void;
  tb_alloc(n: number): number;
  tb_dealloc(p: number, n: number): void;
  tb_create(): number;
  tb_destroy(s: number): void;
  tb_add_font(s: number, namePtr: number, nameLen: number, weight: number, italic: number, bytesPtr: number, len: number): number;
  tb_layout(s: number, htmlPtr: number, len: number, w: number, h: number, scale: number): number;
  tb_glyph_count(r: number): number;
  tb_glyph_ptr(r: number): number;
  tb_box_count(r: number): number;
  tb_box_ptr(r: number): number;
  tb_free_layout(r: number): void;
}

/** Minimal correct wasi_snapshot_preview1 shim for text_blitz.wasm (Stylo/std).
 *  Out-params are written and preopen enumeration is terminated (EBADF=8);
 *  randomness/time are zeroed — they don't affect layout output, which is why
 *  the runs stay byte-parity with native (proven in blitz_parity.sh). */
function makeBlitzWasi(mem: () => WebAssembly.Memory): Record<string, (...a: number[]) => number> {
  const dv = () => new DataView(mem().buffer);
  const u8 = () => new Uint8Array(mem().buffer);
  return {
    random_get: (p, n) => { u8().fill(0, p, p + n); return 0; },
    environ_sizes_get: (c, s) => { const d = dv(); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (_id, _prec, tp) => { dv().setBigUint64(tp, 0n, true); return 0; },
    fd_close: () => 0,
    fd_fdstat_get: (_fd, p) => { u8().fill(0, p, p + 24); return 0; },
    fd_filestat_get: () => 8,
    fd_prestat_get: () => 8,
    fd_prestat_dir_name: () => 8,
    fd_write: (_fd, iovs, n, nwr) => { const d = dv(); let t = 0; for (let i = 0; i < n; i++) t += d.getUint32(iovs + i * 8 + 4, true); d.setUint32(nwr, t, true); return 0; },
    path_open: () => 8,
    proc_exit: (code) => { throw new Error('text_blitz.wasm proc_exit ' + code); },
    sched_yield: () => 0,
  };
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
  const fam = family.toLowerCase();
  if (!fam) return '';
  if (weight === 400 && !italic) return fam;
  return `${fam}\u0001${Math.round(weight)}${italic ? 'i' : ''}`;
}

/** Split a CSS-style font-family value into ordered family names (comma-split,
 *  trimmed, quotes stripped). MUST match parseFamilyList() in
 *  native/src/text/text_engine.cpp so the engine resolves the same list. */
export function parseFamilyList(s: string): string[] {
  const out: string[] = [];
  for (let tok of s.split(',')) {
    tok = tok.trim();
    const q = tok[0];
    if (tok.length >= 2 && (q === '"' || q === "'") && tok[tok.length - 1] === q) tok = tok.slice(1, -1);
    if (tok) out.push(tok);
  }
  return out;
}

// CSS generic family keywords — resolved host-side (serif → bundled Noto Serif;
// the rest fall through to the primary font), so we don't try to resolve them as
// OS fonts via Local Font Access.
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

// Bundled families guaranteed on the web side — the parity-guaranteed set, OFL
// Noto faces fetched by web/scripts/fetch_fonts.sh (see FONTS.md). Their bytes
// match what the native host bundles, so a run naming one of these families is
// reproduced pixel-for-pixel. Missing files (script not run) load-fail softly
// → fallback to the primary font. The app can override via init({ fonts }).
const DEFAULT_FONTS: FontSource[] = [
  { family: 'Noto Sans',  url: '/fonts/noto-sans.ttf' },
  { family: 'Noto Serif', url: '/fonts/noto-serif.ttf' },
  { family: 'serif',      url: '/fonts/noto-serif.ttf' },  // CSS generic → Noto Serif
  // sans-serif / monospace are left to fall through to the primary font (Noto Sans).
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
  // Sans-serif CJK (matched to sans primaries / the default Noto Sans).
  { url: '/fonts/noto-sans-jp.ttf', lang: 'ja' },        // Japanese (kana + kanji)
  { url: '/fonts/noto-sans-sc.ttf', lang: 'zh-Hans' },   // Simplified Chinese / Han
  { url: '/fonts/noto-sans-tc.ttf', lang: 'zh-Hant' },   // Traditional Chinese
  { url: '/fonts/noto-sans-kr.ttf', lang: 'ko' },        // Korean (hangul)
  // Serif CJK — chosen for serif primaries (the engine style-matches via OS/2;
  // missing if fetch_fonts.sh wasn't run → serif text falls back to sans CJK).
  { url: '/fonts/noto-serif-jp.ttf', lang: 'ja' },
  { url: '/fonts/noto-serif-sc.ttf', lang: 'zh-Hans' },
  { url: '/fonts/noto-serif-tc.ttf', lang: 'zh-Hant' },
  { url: '/fonts/noto-serif-kr.ttf', lang: 'ko' },
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
  private atlasTex: GPUTexture | null = null;   // texture-array (one layer per atlas page)
  private atlasPages = 0;
  // Blitz complex-layout mode (optional): text_blitz.wasm + a session whose
  // faces are registered in the SAME order as the engine's, so faceId N is the
  // same bytes on both. Loaded best-effort; null → mode:"html" specs no-op.
  private blz: TBExports | null = null;
  private blzSess = 0;
  // Engine keys already mirrored into Blitz — guards against a duplicate
  // te_add_font (idempotent, no new engine face) adding a stray Blitz face and
  // shifting faceIds out of lock-step.
  private blzMirrored = new Set<string>();

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
    opts?: { wasmUrl?: string; blitzUrl?: string; fontUrl?: string; fonts?: FontSource[]; fallbacks?: FallbackSource[] },
  ): Promise<TextEngine> {
    if (G.__textEngine) return Promise.resolve(G.__textEngine);
    if (!G.__textEngineInit) {
      const e = new TextEngine();
      G.__textEngineInit = e
        ._init(device, opts?.wasmUrl ?? '/wasm/text_engine.wasm',
               opts?.fontUrl ?? '/fonts/default.ttf', opts?.fonts ?? DEFAULT_FONTS,
               opts?.fallbacks ?? DEFAULT_FALLBACKS,
               opts?.blitzUrl ?? '/wasm/text_blitz.wasm')
        .then(() => (G.__textEngine = e));
    }
    return G.__textEngineInit;
  }

  private async _init(device: GPUDevice, wasmUrl: string, fontUrl: string,
                      fonts: FontSource[], fallbacks: FallbackSource[], blitzUrl?: string) {
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

    // Optional Blitz complex-layout mode. Best-effort: if text_blitz.wasm isn't
    // served (or fails), mode:"html" specs simply no-op — the simple paragraph
    // engine is unaffected.
    if (blitzUrl) await this.initBlitz(blitzUrl).catch((e) =>
      console.warn('text-engine: Blitz mode unavailable', e));

    const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
    const fp = this.ex.malloc(font.length);
    new Uint8Array(this.ex.memory.buffer).set(font, fp);
    if (!this.ex.te_set_font(fp, font.length)) throw new Error('text-engine: te_set_font failed');
    this.ex.free(fp);
    this.blzAddFont(null, font);   // mirror primary (faceId 0) into Blitz

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
    // Blitz complex-layout mode: spec carries {mode:"html", html, width, height,
    // scale?}. Routed to the two-wasm path; everything downstream (measure,
    // glyphs, render) is identical because it produces the same GlyphQuads.
    if (specJson.includes('"mode"')) {
      try {
        const o = JSON.parse(specJson);
        if (o && o.mode === 'html' && typeof o.html === 'string') {
          return this.layoutHtml(o.html, o.width | 0 || 1920, o.height | 0 || 1080, o.scale || 1);
        }
      } catch { /* fall through to the paragraph engine */ }
    }
    const enc = new TextEncoder().encode(specJson);
    const p = this.ex.malloc(enc.length);
    this.u8().set(enc, p);
    const id = this.ex.te_layout(p, enc.length);
    this.ex.free(p);
    return id;
  }

  /** True if the Blitz complex-layout mode (text_blitz.wasm) is available. */
  get blitzReady(): boolean { return this.blz !== null; }

  /** Lay out an HTML/CSS document via Blitz (Stylo+Taffy+parley) into a w×h px
   *  viewport, feeding the pre-shaped runs through the engine's GID seam. Returns
   *  a layoutId usable with measure/glyphs/render, or 0 if Blitz isn't loaded.
   *  Pixel-parity with native is proven in blitz_parity.sh. */
  layoutHtml(html: string, width: number, height: number, scale = 1): number {
    const blz = this.blz;
    if (!blz || !this.blzSess) return 0;
    const htmlEnc = new TextEncoder().encode(html);
    // Empty / blank HTML → an empty engine layout (valid id, 0 glyphs) so the
    // effect still renders and CLEARS its target, rather than skipping and
    // leaving the previous frame.
    if (htmlEnc.length === 0) return this.ex.te_layout_glyphs(0, 0, 0, 0);
    const hp = blz.tb_alloc(htmlEnc.length);
    new Uint8Array(blz.memory.buffer).set(htmlEnc, hp);
    const bl = blz.tb_layout(this.blzSess, hp, htmlEnc.length, width, height, scale);
    blz.tb_dealloc(hp, htmlEnc.length);
    if (!bl) return this.ex.te_layout_glyphs(0, 0, 0, 0);  // layout failed → clear, not stale
    const n = blz.tb_glyph_count(bl);
    const gp = blz.tb_glyph_ptr(bl);
    const bn = blz.tb_box_count(bl);
    const bp = blz.tb_box_ptr(bl);
    // Copy glyph runs (52B) and background boxes (48B) out of Blitz memory.
    const runs = new Uint8Array(blz.memory.buffer).slice(gp, gp + n * 52); // PreGlyph = 52 bytes
    const boxes = new Uint8Array(blz.memory.buffer).slice(bp, bp + bn * 48); // BoxQuad = 48 bytes
    blz.tb_free_layout(bl);
    const rp = this.ex.malloc(runs.length || 1);
    this.u8().set(runs, rp);
    const bxp = bn > 0 ? this.ex.malloc(boxes.length) : 0;
    if (bxp) this.u8().set(boxes, bxp);
    const id = this.ex.te_layout_glyphs(rp, n, bxp, bn);
    this.ex.free(rp);
    if (bxp) this.ex.free(bxp);
    return id;
  }

  // Load text_blitz.wasm and start a layout session. Best-effort (see _init).
  private async initBlitz(url: string): Promise<void> {
    const bytes = await (await fetch(url)).arrayBuffer();
    const mod = await WebAssembly.compile(bytes);
    let inst: WebAssembly.Instance;
    const blzRef = { ex: null as TBExports | null };
    inst = await WebAssembly.instantiate(mod, {
      wasi_snapshot_preview1: makeBlitzWasi(() => blzRef.ex!.memory),
    });
    const ex = inst.exports as unknown as TBExports;
    blzRef.ex = ex;
    ex._initialize?.();           // cdylib reactor: run ctors
    this.blz = ex;
    this.blzSess = ex.tb_create();
  }

  // Register a face into the Blitz session, in lock-step with the engine's
  // faceId assignment. `weight` (0 = the font's own axes) + `italic` set its
  // fontique attributes so CSS font-weight/font-style select the right static OS
  // face. No-op if Blitz isn't loaded.
  private blzAddFont(family: string | null, bytes: Uint8Array, weight = 0, italic = false): void {
    const blz = this.blz;
    if (!blz || !this.blzSess) return;
    let np = 0, nl = 0;
    if (family) {
      const ne = new TextEncoder().encode(family);
      np = blz.tb_alloc(ne.length); new Uint8Array(blz.memory.buffer).set(ne, np); nl = ne.length;
    }
    const bp = blz.tb_alloc(bytes.length);
    new Uint8Array(blz.memory.buffer).set(bytes, bp);
    blz.tb_add_font(this.blzSess, np, nl, weight, italic ? 1 : 0, bp, bytes.length);
    blz.tb_dealloc(bp, bytes.length);
    if (np) blz.tb_dealloc(np, nl);
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

  /** Register a face from sfnt bytes under engine face `key`. Returns the faceId
   *  (>=0), or -1 on failure. Idempotent by key. `blitzFamily` is the real CSS
   *  family name registered into Blitz/fontique (so HTML `font-family` matches);
   *  it defaults to `key` for the bundled fonts where the two are the same, and
   *  is passed explicitly for OS faces (whose engine key is a styled faceKey). */
  registerFontBytes(key: string, bytes: Uint8Array, blitzFamily = key,
                    weight = 0, italic = false): number {
    const nameEnc = new TextEncoder().encode(key);
    const np = this.ex.malloc(nameEnc.length);
    this.u8().set(nameEnc, np);
    const bp = this.ex.malloc(bytes.length);
    this.u8().set(bytes, bp);
    const id = this.ex.te_add_font(np, nameEnc.length, bp, bytes.length);
    this.ex.free(bp);
    this.ex.free(np);
    // Mirror into Blitz once per engine key (te_add_font is idempotent by key),
    // with the face's true weight/style so fontique matches CSS exactly.
    if (id >= 0 && !this.blzMirrored.has(key)) {
      this.blzMirrored.add(key);
      this.blzAddFont(blitzFamily, bytes, weight, italic);  // Blitz matches by family
    }
    return id;
  }

  /** Register an OS-resolved face: engine under its faceKey, Blitz under the
   *  real family with its true weight/style (so HTML `font-weight`/`font-style`
   *  pick the right static face instead of synthesizing). Returns the faceId. */
  registerOsFace(family: string, weight: number, italic: boolean, bytes: Uint8Array): number {
    return this.registerFontBytes(faceKey(family, weight, italic), bytes, family, weight, italic);
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
    if (id >= 0) this.blzAddFont(null, bytes);    // mirror into the Blitz chain
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
    // `family` may be a CSS list — request each concrete candidate (so any could
    // win); generics resolve host-side (bundled alias / fallthrough).
    const add = (familyList: string, weight: number, italic: boolean) => {
      for (const family of parseFamilyList(familyList)) {
        if (GENERIC_FAMILIES.has(family.toLowerCase())) continue;
        const key = faceKey(family, weight, italic);
        if (!out.some((r) => r.key === key)) out.push({ key, family, weight, italic });
      }
    };
    let runs: any[] | null = null;
    let parsed: any = null;
    try { parsed = JSON.parse(specJson); if (Array.isArray(parsed?.runs)) runs = parsed.runs; } catch { /* regex below */ }
    // Blitz (mode:"html") path: families live in CSS `font-family:` declarations,
    // not a runs[] array — scan them so OS fonts named in CSS get resolved.
    if (parsed && parsed.mode === 'html' && typeof parsed.html === 'string') {
      const re = /font-family\s*:\s*([^;}{]+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(parsed.html)) !== null) add(m[1], 400, false);
      return out;
    }
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

  /** Upload page `p`'s pixels into atlas-array layer `p`. */
  private uploadPage(p: number, aw: number, ah: number): void {
    const ptr = this.ex.te_atlas_page_ptr(p);
    const bytes = this.u8().slice(ptr, ptr + aw * ah * 4);
    this.device.queue.writeTexture(
      { texture: this.atlasTex!, origin: { x: 0, y: 0, z: p } },
      bytes, { bytesPerRow: aw * 4, rowsPerImage: ah }, [aw, ah, 1]);
  }

  /** Composite the laid-out text for `id` into `target` at (originX, originY). */
  render(id: number, target: GPUTexture, originX: number, originY: number): void {
    const ex = this.ex;
    const device = this.device;

    // 0 glyphs is a VALID layout (empty / whitespace-only doc). We still run the
    // compositor below — it writes background-over-glyphs to every pixel, so an
    // empty layout CLEARS the target to the background instead of leaving the
    // previous frame on screen.
    const count = ex.te_glyph_count(id);
    let written = 0;
    let glyphBytes = new Uint8Array(0);
    if (count > 0) {
      const gPtr = ex.malloc(count * 64);
      written = ex.te_glyphs(id, gPtr, count * 64);
      glyphBytes = this.u8().slice(gPtr, gPtr + written * 64);
      ex.free(gPtr);
    }

    // Background boxes (48B each), drawn behind the glyphs by the shader.
    const boxCount = ex.te_box_count(id);
    let boxesWritten = 0;
    let boxBytes = new Uint8Array(0);
    if (boxCount > 0) {
      const bPtr = ex.malloc(boxCount * 48);
      boxesWritten = ex.te_boxes(id, bPtr, boxCount * 48);
      boxBytes = this.u8().slice(bPtr, bPtr + boxesWritten * 48);
      ex.free(bPtr);
    }

    const mPtr = ex.malloc(32);
    ex.te_measure(id, mPtr);
    const dv = new DataView(ex.memory.buffer);
    const atlasKind = dv.getInt32(mPtr + 20, true);
    const atlasPxRange = dv.getFloat32(mPtr + 24, true);
    ex.free(mPtr);

    const aw = ex.te_atlas_width(), ah = ex.te_atlas_height();
    const pageCount = Math.max(1, ex.te_atlas_page_count());
    // Drain dirty pages (24-byte region: page at offset 0).
    const dirtyPages = new Set<number>();
    const rPtr = ex.malloc(24);
    while (ex.te_next_dirty_region(rPtr)) dirtyPages.add(new DataView(ex.memory.buffer).getInt32(rPtr, true));
    ex.free(rPtr);
    // (Re)create the atlas texture-array when the layer count grows; that
    // invalidates old contents, so re-upload every page.
    if (!this.atlasTex || this.atlasPages !== pageCount) {
      this.atlasTex = device.createTexture({
        size: [aw, ah, pageCount], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.atlasPages = pageCount;
      for (let p = 0; p < ex.te_atlas_page_count(); p++) this.uploadPage(p, aw, ah);
    } else {
      for (const p of dirtyPages) if (p < ex.te_atlas_page_count()) this.uploadPage(p, aw, ah);
    }

    const cw = target.width, ch = target.height;
    const glyphBuf = device.createBuffer({ size: Math.max(64, glyphBytes.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(glyphBuf, 0, glyphBytes);
    const boxBuf = device.createBuffer({ size: Math.max(48, boxBytes.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(boxBuf, 0, boxBytes);

    const uni = new ArrayBuffer(48);
    const uv = new DataView(uni);
    uv.setUint32(0, cw, true); uv.setUint32(4, ch, true); uv.setUint32(8, written, true);
    uv.setUint32(12, aw, true); uv.setUint32(16, ah, true);
    uv.setFloat32(20, originX, true); uv.setFloat32(24, originY, true);
    uv.setUint32(28, atlasKind, true); uv.setFloat32(32, atlasPxRange, true);
    uv.setUint32(36, boxesWritten, true);
    const uniBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniBuf, 0, uni);

    const bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: glyphBuf } },
        { binding: 1, resource: this.atlasTex.createView({ dimension: '2d-array' }) },
        { binding: 2, resource: this.bgTex.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: target.createView() },
        { binding: 5, resource: { buffer: uniBuf } },
        { binding: 6, resource: { buffer: boxBuf } },
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
