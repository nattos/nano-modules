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
const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi });
const ex = instance.exports;
ex.__wasm_call_ctors?.();

const mem = () => new DataView(ex.memory.buffer);
const u8 = () => new Uint8Array(ex.memory.buffer);

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

// Glyph quads (48 bytes each).
const count = ex.te_glyph_count(id);
const gPtr = ex.malloc(count * 48);
const written = ex.te_glyphs(id, gPtr, count * 48);
const quads = [];
for (let i = 0; i < written; i++) {
  const b = gPtr + i * 48;
  const d = mem();
  quads.push([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((k) => +d.getFloat32(b + k * 4, true).toFixed(4)));
}
ex.free(gPtr);

// Atlas FNV-1a hash over the dirty region the engine reports.
const aw = ex.te_atlas_width(), ah = ex.te_atlas_height();
let atlasHash = 0x811c9dc5 >>> 0;
const rPtr = ex.malloc(20);
let region = null;
if (ex.te_next_dirty_region(rPtr)) {
  const d = mem();
  region = {
    x: d.getInt32(rPtr, true), y: d.getInt32(rPtr + 4, true),
    w: d.getInt32(rPtr + 8, true), h: d.getInt32(rPtr + 12, true),
    ptr: d.getInt32(rPtr + 16, true),
  };
  const bytes = u8();
  const n = region.w * region.h * 4;
  for (let i = 0; i < n; i++) {
    atlasHash ^= bytes[region.ptr + i];
    atlasHash = Math.imul(atlasHash, 0x01000193) >>> 0;
  }
}
ex.free(rPtr);
ex.te_release(id);

console.log(JSON.stringify({
  metrics, quad_count: written, quads,
  atlas: { w: aw, h: ah, region, hash: atlasHash.toString(16) },
}, null, 2));
