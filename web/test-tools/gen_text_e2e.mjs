/*
 * gen_text_e2e.mjs — render the gen.text effect through the REAL app path
 * (gpu-test-runner.html → WasmHost + text.* import group → TextEngine → WebGPU)
 * and dump the PNG. Proves the effect node renders text in the actual runtime,
 * not just the standalone harness.
 *
 *   node web/test-tools/gen_text_e2e.mjs
 */
import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const PORT = process.env.PORT || '5174';
const dumpDir = resolve(root, 'build/text-dumps');
mkdirSync(dumpDir, { recursive: true });

const cfg = (await import(resolve(root, 'web/jest-puppeteer.config.js'))).default;
const browser = await puppeteer.launch({
  headless: cfg.launch?.headless ?? 'new',
  args: cfg.launch?.args ?? ['--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log(`[page:${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`http://localhost:${PORT}/gpu-test-runner.html`, { waitUntil: 'networkidle0' });

await page.evaluate(() => {
  window.__gpuTestConfig = {
    module: 'gen.text',
    bundle: 'text',
    width: 512,
    height: 256,
    inputColor: [0, 0, 0, 1],
    params: [],
    dumpPixels: true,
  };
  window.__gpuTestRun();
});

await page.waitForFunction(() => {
  const el = document.getElementById('result');
  return el && !el.textContent.includes('Waiting') && !el.textContent.includes('Running');
}, { timeout: 20000 });

const text = await page.$eval('#result', (el) => el.textContent);
await browser.close();

const raw = JSON.parse(text);
if (!raw.success) { console.error('render failed:', JSON.stringify(raw, null, 2)); process.exit(1); }
console.log(`gen.text rendered ${raw.width}x${raw.height}, metadata=${raw.metadata?.id}`);

const pixels = new Uint8Array(Buffer.from(raw.pixelsBase64, 'base64'));
writeFileSync(resolve(dumpDir, 'gen_text_e2e.png'), encodePNG(pixels, raw.width, raw.height));
console.log('PNG: gen_text_e2e.png in build/text-dumps');
// quick non-black-pixel count as a sanity signal
let nonBlack = 0;
for (let i = 0; i < pixels.length; i += 4) if (pixels[i] || pixels[i+1] || pixels[i+2]) nonBlack++;
console.log(`non-black pixels: ${nonBlack} / ${raw.width * raw.height}`);
process.exit(nonBlack > 0 ? 0 : 1);

function encodePNG(rgba, w, h) {
  const ct = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = ct[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const u32 = (x) => Uint8Array.of((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  const ch = (tag, data) => { const tb = new TextEncoder().encode(tag); const b = new Uint8Array(tb.length + data.length); b.set(tb); b.set(data, tb.length); return [u32(data.length), b, u32(crc(b))]; };
  const rawb = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) { rawb[y * (1 + w * 4)] = 0; rawb.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1); }
  const blk = [Uint8Array.of(0x78, 0x01)]; let off = 0;
  while (off < rawb.length) { const n = Math.min(65535, rawb.length - off); const last = off + n >= rawb.length; blk.push(Uint8Array.of(last ? 1 : 0, n & 255, (n >> 8) & 255, (~n) & 255, ((~n) >> 8) & 255)); blk.push(rawb.subarray(off, off + n)); off += n; }
  let a = 1, b = 0; for (let i = 0; i < rawb.length; i++) { a = (a + rawb[i]) % 65521; b = (b + a) % 65521; } blk.push(u32(((b << 16) | a) >>> 0));
  const zl = blk.reduce((s, x) => s + x.length, 0); const z = new Uint8Array(zl); let zo = 0; for (const x of blk) { z.set(x, zo); zo += x.length; }
  const ih = new Uint8Array(13); ih.set(u32(w)); ih.set(u32(h), 4); ih[8] = 8; ih[9] = 6;
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...ch('IHDR', ih), ...ch('IDAT', z), ...ch('IEND', new Uint8Array(0))];
  const tot = parts.reduce((s, x) => s + x.length, 0); const out = new Uint8Array(tot); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; } return Buffer.from(out);
}
