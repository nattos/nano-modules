/*
 * text_gpu_dump.mjs — drive the WebGPU text harness and prove GPU pixels match
 * the CPU golden reference.
 *
 *   node web/test-tools/text_gpu_dump.mjs '<spec>' <name>
 *
 * 1. Launches headless Chrome (WebGPU), navigates to /text-gpu-test.html, which
 *    runs the real text_engine + the compositor compute shader on WebGPU and
 *    returns the composited pixels.
 * 2. Computes the CPU reference (same text_engine.wasm via te_rasterize) in Node.
 * 3. Diffs them pixel-by-pixel and writes both PNGs to build/text-dumps.
 *
 * Exit 0 if the GPU output matches the CPU golden within tolerance.
 */
import puppeteer from 'puppeteer';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const PORT = process.env.PORT || '5174';
const spec = process.argv[2] ||
  '{"text":"Hello\\nWorld!","runs":[{"size_px":48}],"constraints":{"max_width_px":300}}';
const name = process.argv[3] || 'gpu_hello';
const fontPath = process.env.TE_FONT || '/System/Library/Fonts/Monaco.ttf';
const dumpDir = resolve(root, 'build/text-dumps');
mkdirSync(dumpDir, { recursive: true });

// Serve the font so the browser harness fetches the SAME bytes the CPU ref reads.
const servedFont = resolve(root, 'build/wasm/testfont.ttf');
copyFileSync(fontPath, servedFont);

// Optional second face for the multi-font path: serve it + describe it so both
// the GPU page and the CPU reference register identical bytes under the family.
const font2Path = process.env.TE_FONT2;
const family2 = process.env.TE_FAMILY2;
let extraFonts = [];
if (font2Path && family2) {
  const servedFont2 = resolve(root, 'build/wasm/testfont2.ttf');
  copyFileSync(font2Path, servedFont2);
  extraFonts = [{ family: family2, url: '/wasm/testfont2.ttf', served: servedFont2 }];
}

// ---- 1. GPU render in the browser ----
const cfg = (await import(resolve(root, 'web/jest-puppeteer.config.js'))).default;
const browser = await puppeteer.launch({
  headless: cfg.launch?.headless ?? 'new',
  args: cfg.launch?.args ?? ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
const fontsParam = extraFonts.length
  ? `&fonts=${encodeURIComponent(JSON.stringify(extraFonts.map(({ family, url }) => ({ family, url }))))}`
  : '';
const url = `http://localhost:${PORT}/text-gpu-test.html?spec=${encodeURIComponent(spec)}&font=/wasm/testfont.ttf${fontsParam}`;
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.getElementById('result').textContent !== 'pending', { timeout: 20000 });
const txt = await page.$eval('#result', (e) => e.textContent);
await browser.close();
if (txt.startsWith('ERROR')) { console.error(txt); process.exit(1); }
const gpu = JSON.parse(txt);
const gpuPixels = new Uint8Array(Buffer.from(gpu.pixelsBase64, 'base64'));

// ---- 2. CPU reference via the same engine in Node ----
const cpu = await cpuReference(spec);

// ---- 3. Diff ----
if (gpu.width !== cpu.w || gpu.height !== cpu.h) {
  console.error(`size mismatch: gpu ${gpu.width}x${gpu.height} vs cpu ${cpu.w}x${cpu.h}`);
  process.exit(1);
}
let maxDiff = 0, nDiff = 0;
for (let i = 0; i < gpuPixels.length; i++) {
  const d = Math.abs(gpuPixels[i] - cpu.rgba[i]);
  if (d > 0) { nDiff++; if (d > maxDiff) maxDiff = d; }
}
const totalPx = cpu.w * cpu.h;
const pctDiff = (100 * nDiff / gpuPixels.length).toFixed(3);

// ---- 4. PNGs ----
writeFileSync(resolve(dumpDir, `${name}_gpu.png`), encodePNG(gpuPixels, gpu.width, gpu.height));
writeFileSync(resolve(dumpDir, `${name}_cpu.png`), encodePNG(cpu.rgba, cpu.w, cpu.h));

console.log(`GPU ${gpu.width}x${gpu.height}, ${gpu.glyphs} glyphs | diff: ${nDiff} bytes (${pctDiff}%), maxChannelDiff=${maxDiff}`);
console.log(`PNGs: ${name}_gpu.png, ${name}_cpu.png in build/text-dumps`);
const TOL = 16; // GPU vs CPU bilinear: a few LSB coverage diff, amplified by run color on edges
if (maxDiff <= TOL) { console.log(`✅ GPU pixels match CPU golden (≤${TOL}/channel)`); process.exit(0); }
console.error(`❌ GPU vs CPU exceeds tolerance (maxChannelDiff=${maxDiff})`); process.exit(1);

// ---- helpers ----
async function cpuReference(spec) {
  const wasmPath = resolve(root, 'build/wasm/text_engine.wasm');
  const mod = new WebAssembly.Module(readFileSync(wasmPath));
  const importObject = {};
  for (const i of WebAssembly.Module.imports(mod)) { (importObject[i.module] ??= {}); if (i.kind === 'function') importObject[i.module][i.name] = () => 0; }
  const instance = await WebAssembly.instantiate(mod, importObject);
  const ex = instance.exports; ex.__wasm_call_ctors?.();
  // Same font as the browser harness.
  const font = readFileSync(servedFont);
  const fp = ex.malloc(font.length); new Uint8Array(ex.memory.buffer).set(font, fp);
  ex.te_set_font(fp, font.length); ex.free(fp);
  // Register the same extra faces the browser harness did (identical bytes).
  for (const f of extraFonts) {
    const b = readFileSync(f.served);
    const bp = ex.malloc(b.length); new Uint8Array(ex.memory.buffer).set(b, bp);
    const nameEnc = new TextEncoder().encode(f.family);
    const np = ex.malloc(nameEnc.length); new Uint8Array(ex.memory.buffer).set(nameEnc, np);
    ex.te_add_font(np, nameEnc.length, bp, b.length);
    ex.free(np); ex.free(bp);
  }
  const enc = new TextEncoder().encode(spec);
  const sp = ex.malloc(enc.length); new Uint8Array(ex.memory.buffer).set(enc, sp);
  const id = ex.te_layout(sp, enc.length); ex.free(sp);
  const mp = ex.malloc(32); ex.te_measure(id, mp);
  const dv = new DataView(ex.memory.buffer);
  const width = dv.getFloat32(mp, true), height = dv.getFloat32(mp + 4, true); ex.free(mp);
  const MARGIN = 16;
  const w = Math.max(1, Math.ceil(width) + 2 * MARGIN), h = Math.max(1, Math.ceil(height) + 2 * MARGIN);
  const op = ex.malloc(w * h * 4);
  ex.te_rasterize(id, w, h, MARGIN, MARGIN, 0, op);
  const rgba = new Uint8Array(ex.memory.buffer.slice(op, op + w * h * 4));
  ex.free(op); ex.te_release(id);
  return { w, h, rgba };
}

function encodePNG(rgba, w, h) {
  const ct = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = ct[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const u32 = (x) => Uint8Array.of((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  const ch = (tag, data) => { const tb = new TextEncoder().encode(tag); const b = new Uint8Array(tb.length + data.length); b.set(tb); b.set(data, tb.length); return [u32(data.length), b, u32(crc(b))]; };
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { raw[y * (1 + w * 4)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1); }
  const blk = [Uint8Array.of(0x78, 0x01)]; let off = 0;
  while (off < raw.length) { const n = Math.min(65535, raw.length - off); const last = off + n >= raw.length; blk.push(Uint8Array.of(last ? 1 : 0, n & 255, (n >> 8) & 255, (~n) & 255, ((~n) >> 8) & 255)); blk.push(raw.subarray(off, off + n)); off += n; }
  let a = 1, b = 0; for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; } blk.push(u32(((b << 16) | a) >>> 0));
  const zl = blk.reduce((s, x) => s + x.length, 0); const z = new Uint8Array(zl); let zo = 0; for (const x of blk) { z.set(x, zo); zo += x.length; }
  const ih = new Uint8Array(13); ih.set(u32(w)); ih.set(u32(h), 4); ih[8] = 8; ih[9] = 6;
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...ch('IHDR', ih), ...ch('IDAT', z), ...ch('IEND', new Uint8Array(0))];
  const tot = parts.reduce((s, x) => s + x.length, 0); const out = new Uint8Array(tot); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return Buffer.from(out);
}
