/**
 * End-to-end test for the dxv_decoder WASM service module.
 *
 * Drives /dxv-test-runner.html via Puppeteer:
 *   1. boots WebGPU + DxvDecoder,
 *   2. fetches /test-videos/test01_dxv.mov (symlink — see web/public/test-videos),
 *   3. asserts container metadata,
 *   4. decodes frame 0 (and a couple more) into RGBA8 textures,
 *   5. reads back pixels and checks for structural correctness:
 *      - non-zero (decode actually wrote something),
 *      - reasonable luminance variance (not a solid color),
 *      - distinct frames at non-adjacent indices (frame table is keyed
 *        correctly, not all returning frame 0).
 *
 * Pixel-perfect comparison vs. an h264 reference is deferred — BC1 is
 * lossy and DXV3's LZ + BC1 round-trip will differ from any h264 frame
 * by a few codepoints. The structural assertions catch silent
 * regressions (wrong frame, all-black, broken LZ producing noise).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const RUNNER = 'http://localhost:5173/dxv-test-runner.html';
const VIDEO  = '/test-videos/test01_dxv.mov';
const DUMP_DIR = '/tmp/gpu-test-dumps';

// Minimal RGBA8 → PNG encoder. Duplicated from gpu-test-helpers (which
// doesn't export it) to keep this test self-contained.
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, cr]);
}
function encodePNG(rgba: Uint8Array, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const o = y * (1 + width * 4);
    raw[o] = 0;
    for (let i = 0; i < width * 4; i++) raw[o + 1 + i] = rgba[y * width * 4 + i];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Browser-side helpers run inside page.evaluate. Keep them self-contained
// — they execute in the test runner page's context, not the test's.
async function decodeFrameInBrowser(idx: number): Promise<{
  width: number; height: number; pixels: number[];
}> {
  return await page.evaluate(async (i: number) => {
    const dec = (window as any).__dxvDecoder.decoder;
    const gpuHost = (window as any).__dxvDecoder.gpuHost;
    const info = dec.videoInfo;
    const tex = gpuHost.createTexture(info.width, info.height, 1);
    await dec.decode(i, tex);
    const px = await gpuHost.readbackTexture(tex, info.width, info.height);
    // Subsample to keep the postMessage payload reasonable — we only
    // need a few rows for structural assertions, not the whole frame.
    // Center stripe (a 1-pixel-tall row across width) is plenty.
    const stride = info.width * 4;
    const row = Math.floor(info.height / 2);
    const slice = Array.from(px.slice(row * stride, (row + 1) * stride));
    return { width: info.width, height: info.height, pixels: slice };
  }, idx);
}

describe('DXV decoder E2E', () => {
  jest.setTimeout(60000);

  beforeAll(async () => {
    page.removeAllListeners('console');
    page.on('console', (msg) => {
      const t = msg.text();
      if (t.includes('Synchronous XMLHttpRequest')) return;
      // Surface browser-side errors/warnings — invaluable when the
      // naga bridge or WGSL compile blows up.
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}] ${t}`);
    });

    await page.goto(`${RUNNER}?video=${encodeURIComponent(VIDEO)}`,
                    { waitUntil: 'networkidle0' });

    await page.waitForFunction(
      () => {
        const w = (window as any).__dxvDecoder;
        return w && (w.status.ready || w.status.error);
      },
      { timeout: 45000 },
    );

    const status = await page.evaluate(() => (window as any).__dxvDecoder.status);
    if (status.error) {
      throw new Error(`runner setup failed: ${status.error}`);
    }
    // Helpful diagnostic for the BC1 fast-path roadmap.
    // eslint-disable-next-line no-console
    console.log('[dxv-test] adapter features:', status.adapterFeatures.join(', '));
    // eslint-disable-next-line no-console
    console.log('[dxv-test] BC textures supported?', status.bcSupported);
  });

  it('parses container metadata for test01_dxv.mov', async () => {
    const info = await page.evaluate(() => (window as any).__dxvDecoder.decoder.videoInfo);
    expect(info.width).toBe(1920);
    expect(info.height).toBe(1080);
    expect(info.frameCount).toBe(250);   // ffprobe reports 250 frames
    expect(info.fourccStr).toBe('DXD3');
  });

  it('decodes frame 0 into RGBA8 with non-trivial content', async () => {
    const out = await decodeFrameInBrowser(0);
    expect(out.pixels.length).toBe(out.width * 4);

    // Sanity: decode actually wrote something. A failed/empty decode
    // would leave the storage texture at its initial zero state.
    let nonZero = 0;
    let minV = 255, maxV = 0;
    for (let i = 0; i < out.pixels.length; i += 4) {
      const r = out.pixels[i], g = out.pixels[i+1], b = out.pixels[i+2];
      if (r + g + b > 0) nonZero++;
      const lum = Math.max(r, g, b);
      if (lum < minV) minV = lum;
      if (lum > maxV) maxV = lum;
    }
    // At least 10% of the middle row has any color (rules out all-black
    // output even for fade-from-black opening frames).
    expect(nonZero / (out.pixels.length / 4)).toBeGreaterThan(0.1);
    // Real video content has luminance range — flat output would mean
    // the shader wrote a constant.
    expect(maxV - minV).toBeGreaterThan(20);
  });

  it('dumps frame 0 to PNG for visual inspection', async () => {
    const { width, height, base64 } = await page.evaluate(async () => {
      const dec = (window as any).__dxvDecoder.decoder;
      const gpuHost = (window as any).__dxvDecoder.gpuHost;
      const info = dec.videoInfo;
      const tex = gpuHost.createTexture(info.width, info.height, 1);
      await dec.decode(0, tex);
      const px = await gpuHost.readbackTexture(tex, info.width, info.height);
      // Base64 encode in browser for transport.
      let s = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < px.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, Array.from(px.subarray(i, i + CHUNK)) as any);
      }
      return { width: info.width, height: info.height, base64: btoa(s) };
    });
    const pixels = new Uint8Array(Buffer.from(base64, 'base64'));
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const dumpPath = path.join(DUMP_DIR, 'dxv_frame_0.png');
    fs.writeFileSync(dumpPath, encodePNG(pixels, width, height));
    // eslint-disable-next-line no-console
    console.log(`[dxv-test] dumped frame 0 → ${dumpPath}`);
  });

  it('different frames produce different pixels (frame table is keyed correctly)', async () => {
    const f0   = await decodeFrameInBrowser(0);
    const f125 = await decodeFrameInBrowser(125);
    const f249 = await decodeFrameInBrowser(249);

    const diff = (a: number[], b: number[]) => {
      let acc = 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) acc += Math.abs(a[i] - b[i]);
      return acc;
    };
    expect(diff(f0.pixels, f125.pixels)).toBeGreaterThan(1000);
    expect(diff(f0.pixels, f249.pixels)).toBeGreaterThan(1000);
    expect(diff(f125.pixels, f249.pixels)).toBeGreaterThan(1000);
  });
});
