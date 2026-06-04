/*
 * parity_dump.mjs — run text_engine.wasm on a spec and print a deterministic
 * digest (metrics + glyph quads + atlas hash). The native tool
 * native/src/text/tools/parity_dump.cpp prints the SAME digest from the natively
 * compiled engine; comparing the two proves the web simulator reproduces the
 * native "for realz" output byte-for-byte.
 *
 *   node parity_dump.mjs '<spec-json>'
 *   node parity_dump.mjs            # uses a default multiline spec
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(here, '../../../build/wasm/text_engine.wasm');

const spec = process.argv[2] ??
  JSON.stringify({
    text: 'Hello\nWorld!',
    runs: [{ start: 0, len: 12, family: 'Inter', size_px: 48, rgba: [1, 1, 1, 1] }],
    constraints: { max_width_px: 300, align: 'start', direction: 'ltr', line_spacing: 1.2 },
  });

// Minimal WASI stubs — the engine never does real I/O on the happy path.
const wasi = {
  args_get: () => 0, args_sizes_get: () => 0,
  fd_close: () => 0, fd_seek: () => 0, fd_write: () => 0,
  proc_exit: (c) => { throw new Error('proc_exit ' + c); },
};

const bytes = readFileSync(wasmPath);
const mod = new WebAssembly.Module(bytes);
// Generic no-op stubs for every import (wasi_snapshot_preview1 + the unused
// env setjmp/longjmp FreeType pulls in but never calls).
const importObject = {};
for (const i of WebAssembly.Module.imports(mod)) {
  (importObject[i.module] ??= {});
  if (i.kind === 'function') importObject[i.module][i.name] = (i.module === 'wasi_snapshot_preview1' && wasi[i.name]) || (() => 0);
}
const instance = await WebAssembly.instantiate(mod, importObject);
const ex = instance.exports;
ex.__wasm_call_ctors?.();

const mem = () => new DataView(ex.memory.buffer);
const u8 = () => new Uint8Array(ex.memory.buffer);

// Install the same font the native tool uses (env TE_FONT, default Monaco).
const fontPath = process.env.TE_FONT || '/System/Library/Fonts/Monaco.ttf';
const fontBytes = readFileSync(fontPath);
const fontPtr = ex.malloc(fontBytes.length);
u8().set(fontBytes, fontPtr);
if (!ex.te_set_font(fontPtr, fontBytes.length)) { console.error('te_set_font failed'); process.exit(1); }
ex.free(fontPtr);

// Optional second face (multi-family parity): register TE_FONT2 under TE_FAMILY2,
// matching the native tool byte-for-byte.
if (process.env.TE_FONT2 && process.env.TE_FAMILY2) {
  const f2 = readFileSync(process.env.TE_FONT2);
  const f2p = ex.malloc(f2.length); u8().set(f2, f2p);
  const fam = new TextEncoder().encode(process.env.TE_FAMILY2);
  const famp = ex.malloc(fam.length); u8().set(fam, famp);
  ex.te_add_font(famp, fam.length, f2p, f2.length);
  ex.free(famp); ex.free(f2p);
}

// Optional fallback CHAIN (CJK/missing-codepoint parity): TE_FALLBACK is a
// colon-separated list of font paths registered in order via te_add_fallback_font,
// matching the native tool byte-for-byte.
if (process.env.TE_FALLBACK) {
  for (const path of process.env.TE_FALLBACK.split(':').filter(Boolean)) {
    const fb = readFileSync(path);
    const fbp = ex.malloc(fb.length); u8().set(fb, fbp);
    const lang = path.includes('-sc') ? 'zh-Hans' : path.includes('-tc') ? 'zh-Hant'
               : path.includes('-jp') ? 'ja' : path.includes('-kr') ? 'ko' : '';
    const lb = new TextEncoder().encode(lang); const lp = ex.malloc(lb.length || 1); u8().set(lb, lp);
    ex.te_add_fallback_font(fbp, fb.length, lp, lb.length);
    ex.free(lp); ex.free(fbp);
  }
}

// Stage the spec JSON into engine memory.
const enc = new TextEncoder().encode(spec);
const specPtr = ex.malloc(enc.length);
u8().set(enc, specPtr);

const id = ex.te_layout(specPtr, enc.length);
ex.free(specPtr);
if (id <= 0) { console.error('te_layout failed'); process.exit(1); }

// Metrics (32-byte AbiMetrics).
const mPtr = ex.malloc(32);
ex.te_measure(id, mPtr);
const dv = mem();
const metrics = {
  width: dv.getFloat32(mPtr + 0, true),
  height: dv.getFloat32(mPtr + 4, true),
  line_count: dv.getInt32(mPtr + 8, true),
  first_baseline: dv.getFloat32(mPtr + 12, true),
  glyph_count: dv.getInt32(mPtr + 16, true),
  atlas_kind: dv.getInt32(mPtr + 20, true),
  atlas_px_range: dv.getFloat32(mPtr + 24, true),
};
ex.free(mPtr);

// Glyph quads (96 bytes each); the digest covers the first 16 floats (rect, uv,
// rgba, aux) — same as the native tool. The trailing clip fields are 0 here.
const count = ex.te_glyph_count(id);
const gPtr = ex.malloc(count * 96);
const written = ex.te_glyphs(id, gPtr, count * 96);
const quads = [];
for (let i = 0; i < written; i++) {
  const b = gPtr + i * 96;
  const d = mem();
  quads.push(Array.from({ length: 16 }, (_, k) => +d.getFloat32(b + k * 4, true).toFixed(4)));
}
ex.free(gPtr);

// Atlas FNV-1a hash over every dirty page (page index folded in), matching the
// native tool. 24-byte AbiDirtyRegion: page, x, y, w, h, rgba_ptr.
const aw = ex.te_atlas_width(), ah = ex.te_atlas_height();
let atlasHash = 0x811c9dc5 >>> 0;
const rPtr = ex.malloc(24);
while (ex.te_next_dirty_region(rPtr)) {
  const d = mem();
  const page = d.getInt32(rPtr, true);
  const w = d.getInt32(rPtr + 12, true), h = d.getInt32(rPtr + 16, true), ptr = d.getInt32(rPtr + 20, true);
  atlasHash ^= page >>> 0; atlasHash = Math.imul(atlasHash, 0x01000193) >>> 0;
  const bytes = u8();
  const n = w * h * 4;
  for (let i = 0; i < n; i++) { atlasHash ^= bytes[ptr + i]; atlasHash = Math.imul(atlasHash, 0x01000193) >>> 0; }
}
ex.free(rPtr);
const pages = ex.te_atlas_page_count();

// CPU reference composite → real pixels (same deterministic canvas as the
// native tool: layout bounds + 16px margin, opaque-black bg).
const MARGIN = 16;
const cw = Math.max(1, Math.ceil(metrics.width) + 2 * MARGIN);
const ch = Math.max(1, Math.ceil(metrics.height) + 2 * MARGIN);
const outPtr = ex.malloc(cw * ch * 4);
ex.te_rasterize(id, cw, ch, MARGIN, MARGIN, 0, outPtr);
const img = u8().slice(outPtr, outPtr + cw * ch * 4);
ex.free(outPtr);
let chash = 0x811c9dc5 >>> 0;
for (let i = 0; i < img.length; i++) { chash ^= img[i]; chash = Math.imul(chash, 0x01000193) >>> 0; }
if (process.env.TE_PNG) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TE_PNG, encodePNG(img, cw, ch));
}
if (process.env.TE_RAW) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.TE_RAW, Buffer.from(img));   // tolerant native↔wasm compare
}
ex.te_release(id);

console.log(JSON.stringify({
  metrics, quad_count: written, quads,
  atlas: { w: aw, h: ah, pages, hash: atlasHash.toString(16) },
  composite: { w: cw, h: ch, hash: chash.toString(16) },
}, null, 2));

// --- Minimal RGBA8 PNG encoder (stored DEFLATE), mirrors png_write.h ---
function encodePNG(rgba, w, h) {
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const u32 = (x) => Uint8Array.of((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  const chunk = (tag, data) => { const tb = new TextEncoder().encode(tag); const body = new Uint8Array(tb.length + data.length); body.set(tb); body.set(data, tb.length); return [u32(data.length), body, u32(crc32(body))]; };
  // raw scanlines with filter byte 0
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1); }
  // zlib stored blocks
  const blocks = []; let off = 0;
  blocks.push(Uint8Array.of(0x78, 0x01));
  while (off < raw.length) {
    const n = Math.min(65535, raw.length - off); const last = off + n >= raw.length;
    blocks.push(Uint8Array.of(last ? 1 : 0, n & 255, (n >> 8) & 255, (~n) & 255, ((~n) >> 8) & 255));
    blocks.push(raw.subarray(off, off + n)); off += n;
  }
  let a = 1, b = 0; for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  blocks.push(u32(((b << 16) | a) >>> 0));
  const zlen = blocks.reduce((s, x) => s + x.length, 0); const z = new Uint8Array(zlen); let zo = 0; for (const x of blocks) { z.set(x, zo); zo += x.length; }
  const ihdr = new Uint8Array(13); ihdr.set(u32(w)); ihdr.set(u32(h), 4); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...chunk('IHDR', ihdr), ...chunk('IDAT', z), ...chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, x) => s + x.length, 0); const out = new Uint8Array(total); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return Buffer.from(out);
}
