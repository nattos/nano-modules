// web_blitz_path.mjs — exercise the EXACT web worker code path for the Blitz
// mode, in Node, without a GPU: load text_blitz.wasm AND text_engine.wasm and
//
//   HTML → tb_layout (Blitz) → run buffer → te_layout_glyphs (engine GID seam)
//        → te_rasterize → RGBA composite
//
// then compare the composite to the native blitz_dump pixels. Proves the web
// simulator (two cooperating wasms) reproduces the native "for realz" pixels.
//
//   TE_FONT=.. TE_FALLBACK=a:b TE_RAW=out.bin node web_blitz_path.mjs <doc.html>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const enginePath = resolve(ROOT, 'build/wasm/text_engine.wasm');
const blitzPath = resolve(here, '../../text_blitz/target/wasm32-wasip1/release/text_blitz.wasm');

const fontPath = process.env.TE_FONT;
const fallbacks = (process.env.TE_FALLBACK || '').split(':').filter(Boolean);
const htmlPath = process.argv[2];
const W = 800, H = 600;

// --- text_engine.wasm: imports are unused at runtime → no-op stubs (as the
//     real web loader does in text-engine.ts). ---
const engMod = await WebAssembly.compile(readFileSync(enginePath));
const engImports = {};
for (const i of WebAssembly.Module.imports(engMod)) {
  (engImports[i.module] ??= {});
  if (i.kind === 'function') engImports[i.module][i.name] = () => 0;
}
const eng = (await WebAssembly.instantiate(engMod, engImports)).exports;
eng.__wasm_call_ctors?.();

// --- text_blitz.wasm: minimal-but-correct WASI shim (Stylo/std need out-params
//     written and preopen enumeration terminated). Randomness/time don't affect
//     layout output (proven byte-parity), so they can be zeroed. ---
function makeWasi(mem) {
  const dv = () => new DataView(mem().buffer);
  const u8 = () => new Uint8Array(mem().buffer);
  return {
    random_get: (p, n) => { u8().fill(0, p, p + n); return 0; },
    environ_sizes_get: (c, s) => { const d = dv(); d.setUint32(c, 0, true); d.setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    clock_time_get: (id, prec, tp) => { dv().setBigUint64(tp, 0n, true); return 0; },
    fd_close: () => 0,
    fd_fdstat_get: (fd, p) => { u8().fill(0, p, p + 24); return 0; },
    fd_filestat_get: () => 8,
    fd_prestat_get: () => 8,        // no preopened dirs → stop enumeration (EBADF)
    fd_prestat_dir_name: () => 8,
    fd_write: (fd, iovs, n, nwr) => { const d = dv(); let t = 0; for (let i = 0; i < n; i++) t += d.getUint32(iovs + i * 8 + 4, true); d.setUint32(nwr, t, true); return 0; },
    path_open: () => 8,
    proc_exit: (c) => { throw new Error('blitz wasm proc_exit ' + c); },
    sched_yield: () => 0,
  };
}
const blzMod = await WebAssembly.compile(readFileSync(blitzPath));
const blz = (await WebAssembly.instantiate(blzMod, {
  wasi_snapshot_preview1: makeWasi(() => blz.memory),
})).exports;
blz._initialize?.();

const engU8 = () => new Uint8Array(eng.memory.buffer);
const blzU8 = () => new Uint8Array(blz.memory.buffer);
const engPut = (b) => { const p = eng.malloc(b.length); engU8().set(b, p); return p; };
const blzPut = (b) => { const p = blz.tb_alloc(b.length); blzU8().set(b, p); return p; };
const enc = (s) => new TextEncoder().encode(s);

// Register the same fonts into BOTH, in the same order, so faceId N ↔ same bytes.
const sess = blz.tb_create();
const font = readFileSync(fontPath);
{ const p = engPut(font); eng.te_set_font(p, font.length); eng.free(p); }
blz.tb_add_font(sess, 0, 0, 0, 0, blzPut(font), font.length);
for (const fp of fallbacks) {
  const cb = readFileSync(fp);
  const lang = fp.includes('-sc') ? 'zh-Hans' : fp.includes('-tc') ? 'zh-Hant'
    : fp.includes('-jp') ? 'ja' : fp.includes('-kr') ? 'ko' : '';
  const bp = engPut(cb); const lp = lang ? engPut(enc(lang)) : 0;
  eng.te_add_fallback_font(bp, cb.length, lp, lang.length);
  eng.free(bp); if (lp) eng.free(lp);
  blz.tb_add_font(sess, 0, 0, 0, 0, blzPut(cb), cb.length);
}

// Blitz layout → run buffer → engine GID seam.
const html = readFileSync(htmlPath);
const bl = blz.tb_layout(sess, blzPut(html), html.length, W, H, 1.0);
const n = blz.tb_glyph_count(bl);
const gp = blz.tb_glyph_ptr(bl);
const runs = blzU8().slice(gp, gp + n * 52);        // copy out before any realloc (PreGlyph=52B)
const rp = engPut(runs);
const id = eng.te_layout_glyphs(rp, n);
eng.free(rp);
if (id <= 0) { console.error('te_layout_glyphs failed'); process.exit(1); }

// Composite over the full viewport (origin 0,0).
const outPtr = eng.malloc(W * H * 4);
eng.te_rasterize(id, W, H, 0, 0, 0, outPtr);
const img = engU8().slice(outPtr, outPtr + W * H * 4);
eng.free(outPtr);

let chash = 0x811c9dc5 >>> 0;
for (const v of img) { chash = (chash ^ v) >>> 0; chash = Math.imul(chash, 0x01000193) >>> 0; }
if (process.env.TE_RAW) (await import('node:fs')).writeFileSync(process.env.TE_RAW, Buffer.from(img));
console.log(JSON.stringify({ runs: n, glyphs: eng.te_glyph_count(id), pages: eng.te_atlas_page_count(), composite: chash }));
