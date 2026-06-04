// run_blitz_wasm.mjs — drive text_blitz.wasm (the Rust Blitz layout lib) under
// Node's WASI and write the raw pre-shaped run buffer (TbGlyph/PreGlyph records,
// 48 bytes each) to stdout. blitz_parity.sh diffs this against the native lib's
// buffer to prove Blitz layout+shaping is byte-identical native↔wasm.
//
//   TE_FONT=... TE_FALLBACK=a:b node run_blitz_wasm.mjs <doc.html>
import { WASI } from 'node:wasi';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(
  here, '../../text_blitz/target/wasm32-wasip1/release/text_blitz.wasm');

const htmlPath = process.argv[2];
if (!htmlPath) { console.error('usage: run_blitz_wasm.mjs <doc.html>'); process.exit(2); }

const wasi = new WASI({ version: 'preview1', args: [], env: {}, returnOnExit: true });
const mod = await WebAssembly.compile(readFileSync(wasmPath));
const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
wasi.initialize(instance); // cdylib = WASI reactor (runs _initialize ctors)
const ex = instance.exports;

// Copy a byte buffer into wasm memory via the exported allocator; returns ptr.
// Re-read memory.buffer each time (it may detach if the heap grew).
function put(bytes) {
  const p = ex.tb_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
  return p;
}

const langFromName = (p) =>
  p.includes('-sc') ? 'zh-Hans' : p.includes('-tc') ? 'zh-Hant'
  : p.includes('-jp') ? 'ja' : p.includes('-kr') ? 'ko' : '';

const sess = ex.tb_create();

// Primary font (faceId 0), then the fallback chain — same order as native.
const fontPath = process.env.TE_FONT;
const fb = readFileSync(fontPath);
ex.tb_add_font(sess, 0, 0, 0, 0, put(fb), fb.length);
for (const p of (process.env.TE_FALLBACK || '').split(':').filter(Boolean)) {
  const cb = readFileSync(p);
  ex.tb_add_font(sess, 0, 0, 0, 0, put(cb), cb.length); // faceId assigned in order
  void langFromName; // (lang tags only matter to the engine's fallback, not Blitz)
}

const html = readFileSync(htmlPath);
const bl = ex.tb_layout(sess, put(html), html.length, 800, 600, 1.0);
const n = ex.tb_glyph_count(bl);
const gp = ex.tb_glyph_ptr(bl);
// Snapshot the run buffer immediately (no further allocations after this).
const runs = Buffer.from(new Uint8Array(ex.memory.buffer, gp, n * 48));
process.stdout.write(runs);
ex.tb_free_layout(bl);
ex.tb_destroy(sess);
