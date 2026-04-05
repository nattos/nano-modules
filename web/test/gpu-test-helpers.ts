/**
 * GPU E2E test framework.
 *
 * Load a WASM module, run it in the browser with WebGPU, read back all pixels,
 * dump PNGs, and assert on pixel data using high-level helpers.
 *
 * Usage:
 *   const frame = await runGpuTest({ module: 'gpu_test.wasm', ticks: 5 });
 *   frame.expectPixelAt(32, 32, { r: 0, g: 128, b: 255 });
 *   frame.expectUniformColor({ r: 0, g: 128, b: 255 });
 *   frame.expectCoverage(color => color.r > 100, { min: 0.1 });
 *
 *   const frame2 = await runGpuTest({ module: 'my.wasm', ticks: 60 });
 *   frame2.expectDifferentFrom(frame);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const DUMP_DIR = '/tmp/gpu-test-dumps';

// --- Config & raw result types ---

export interface GpuTestConfig {
  module: string;
  width?: number;
  height?: number;
  params?: [number, number][];
  ticks?: number;
  samplePoints?: [number, number][];
  dumpName?: string;
}

/** Config for an effect test: single module with a solid-color input texture. */
export interface GpuEffectTestConfig {
  module: string;
  width?: number;
  height?: number;
  params?: [number, number][];
  ticks?: number;
  /** RGBA color (0-1 floats) to fill the input texture with. */
  inputColor: [number, number, number, number];
  samplePoints?: [number, number][];
  dumpName?: string;
}

/** Config for a chain test: multiple modules executed in sequence. */
export interface GpuChainTestConfig {
  chain: { module: string; params?: [number, number][]; ticks?: number }[];
  width?: number;
  height?: number;
  samplePoints?: [number, number][];
  dumpName?: string;
}

export interface RGBA { r: number; g: number; b: number; a: number; }

// --- PNG encoder ---

function crc32(buf: Buffer) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, cr]);
}

function encodePNG(rgba: Uint8Array, width: number, height: number) {
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
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Frame: full pixel buffer with assertion helpers ---

export class Frame {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly pixelCount: number;
  readonly consoleLog: string[];
  readonly pluginState: any;
  readonly metadata: { id: string; version: string } | null;
  readonly params: any[];
  readonly dumpPath?: string;
  readonly success: boolean;
  readonly error?: string;
  readonly samples: { x: number; y: number; r: number; g: number; b: number; a: number }[];

  constructor(raw: any, pixels: Uint8Array, dumpPath?: string) {
    this.width = raw.width;
    this.height = raw.height;
    this.pixels = pixels;
    this.pixelCount = raw.pixelCount;
    this.consoleLog = raw.consoleLog;
    this.pluginState = raw.pluginState;
    this.metadata = raw.metadata;
    this.params = raw.params;
    this.success = raw.success;
    this.error = raw.error;
    this.samples = raw.samples;
    this.dumpPath = dumpPath;
  }

  /** Get the RGBA color at (x, y). */
  pixelAt(x: number, y: number): RGBA {
    x = Math.floor(x); y = Math.floor(y);
    const o = (y * this.width + x) * 4;
    return { r: this.pixels[o], g: this.pixels[o + 1], b: this.pixels[o + 2], a: this.pixels[o + 3] };
  }

  /** Get all pixels in a rectangular region. */
  region(x: number, y: number, w: number, h: number): RGBA[] {
    const out: RGBA[] = [];
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        out.push(this.pixelAt(px, py));
      }
    }
    return out;
  }

  /** Iterate over all pixels. */
  forEachPixel(fn: (color: RGBA, x: number, y: number) => void) {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        fn(this.pixelAt(x, y), x, y);
      }
    }
  }

  /** Count pixels matching a predicate. */
  countPixels(pred: (color: RGBA) => boolean): number {
    let n = 0;
    this.forEachPixel(c => { if (pred(c)) n++; });
    return n;
  }

  /** Fraction of pixels matching a predicate (0-1). */
  coverage(pred: (color: RGBA) => boolean): number {
    return this.countPixels(pred) / this.pixelCount;
  }

  /** Build a histogram of a channel (0-255 → count). */
  histogram(channel: 'r' | 'g' | 'b' | 'a'): number[] {
    const hist = new Array(256).fill(0);
    this.forEachPixel(c => hist[c[channel]]++);
    return hist;
  }

  /** Average color across all pixels (or a subset). */
  averageColor(pred?: (color: RGBA) => boolean): RGBA {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    this.forEachPixel(c => {
      if (!pred || pred(c)) { r += c.r; g += c.g; b += c.b; a += c.a; n++; }
    });
    return n > 0 ? { r: r / n, g: g / n, b: b / n, a: a / n } : { r: 0, g: 0, b: 0, a: 0 };
  }

  /** Count pixels that differ from another frame (by more than tolerance per channel). */
  diffCount(other: Frame, tolerance = 1): number {
    if (this.width !== other.width || this.height !== other.height) {
      throw new Error('Frame dimensions must match for diff');
    }
    let n = 0;
    for (let i = 0; i < this.pixels.length; i += 4) {
      if (Math.abs(this.pixels[i] - other.pixels[i]) > tolerance ||
          Math.abs(this.pixels[i + 1] - other.pixels[i + 1]) > tolerance ||
          Math.abs(this.pixels[i + 2] - other.pixels[i + 2]) > tolerance) {
        n++;
      }
    }
    return n;
  }

  // --- Assertion methods ---

  /** Assert a pixel at (x,y) is approximately the expected color. */
  expectPixelAt(x: number, y: number, expected: Partial<RGBA>, tolerance = 5) {
    const p = this.pixelAt(x, y);
    if (expected.r !== undefined) expect(Math.abs(p.r - expected.r)).toBeLessThanOrEqual(tolerance);
    if (expected.g !== undefined) expect(Math.abs(p.g - expected.g)).toBeLessThanOrEqual(tolerance);
    if (expected.b !== undefined) expect(Math.abs(p.b - expected.b)).toBeLessThanOrEqual(tolerance);
    if (expected.a !== undefined) expect(Math.abs(p.a - expected.a)).toBeLessThanOrEqual(tolerance);
  }

  /** Assert all pixels are approximately the same color. */
  expectUniformColor(expected: Partial<RGBA>, tolerance = 10) {
    this.forEachPixel((c, x, y) => {
      if (expected.r !== undefined) expect(Math.abs(c.r - expected.r)).toBeLessThanOrEqual(tolerance);
      if (expected.g !== undefined) expect(Math.abs(c.g - expected.g)).toBeLessThanOrEqual(tolerance);
      if (expected.b !== undefined) expect(Math.abs(c.b - expected.b)).toBeLessThanOrEqual(tolerance);
      if (expected.a !== undefined) expect(Math.abs(c.a - expected.a)).toBeLessThanOrEqual(tolerance);
    });
  }

  /** Assert a minimum fraction of pixels match a predicate. */
  expectCoverage(pred: (color: RGBA) => boolean, opts: { min?: number; max?: number }) {
    const cov = this.coverage(pred);
    if (opts.min !== undefined) expect(cov).toBeGreaterThanOrEqual(opts.min);
    if (opts.max !== undefined) expect(cov).toBeLessThanOrEqual(opts.max);
  }

  /** Assert all pixels in a region match approximately. */
  expectRegionColor(x: number, y: number, w: number, h: number, expected: Partial<RGBA>, tolerance = 10) {
    for (const c of this.region(x, y, w, h)) {
      if (expected.r !== undefined) expect(Math.abs(c.r - expected.r)).toBeLessThanOrEqual(tolerance);
      if (expected.g !== undefined) expect(Math.abs(c.g - expected.g)).toBeLessThanOrEqual(tolerance);
      if (expected.b !== undefined) expect(Math.abs(c.b - expected.b)).toBeLessThanOrEqual(tolerance);
    }
  }

  /** Assert this frame is visually different from another. */
  expectDifferentFrom(other: Frame, minDiffPixels = 10) {
    expect(this.diffCount(other)).toBeGreaterThanOrEqual(minDiffPixels);
  }

  /** Assert this frame is visually identical to another. */
  expectSameAs(other: Frame, tolerance = 1) {
    expect(this.diffCount(other, tolerance)).toBe(0);
  }

  /** Assert that at least some pixels are NOT the given background color. */
  expectNotSolidColor(bg: Partial<RGBA>, tolerance = 5) {
    const isBg = (c: RGBA) => {
      if (bg.r !== undefined && Math.abs(c.r - bg.r) > tolerance) return false;
      if (bg.g !== undefined && Math.abs(c.g - bg.g) > tolerance) return false;
      if (bg.b !== undefined && Math.abs(c.b - bg.b) > tolerance) return false;
      return true;
    };
    expect(this.countPixels(c => !isBg(c))).toBeGreaterThan(0);
  }
}

// --- Test runner ---

let testCounter = 0;

export async function runGpuTest(config: GpuTestConfig): Promise<Frame> {
  await page.goto('http://localhost:5174/gpu-test-runner.html', { waitUntil: 'networkidle0' });

  await page.evaluate((cfg) => {
    (window as any).__gpuTestConfig = cfg;
    (window as any).__gpuTestRun();
  }, { ...config, dumpPixels: true });

  await page.waitForFunction(
    () => {
      const el = document.getElementById('result');
      return el && !el.textContent!.includes('Waiting') && !el.textContent!.includes('Running');
    },
    { timeout: 15000 },
  );

  const text = await page.$eval('#result', (el) => el.textContent);
  const raw = JSON.parse(text!);

  // Decode pixels
  const pixels = raw.pixelsBase64 ? new Uint8Array(Buffer.from(raw.pixelsBase64, 'base64')) : new Uint8Array(0);

  // Dump PNG
  let dumpPath: string | undefined;
  if (raw.success && pixels.length > 0) {
    try {
      fs.mkdirSync(DUMP_DIR, { recursive: true });
      const name = config.dumpName || `${config.module.replace('.wasm', '')}_${testCounter++}`;
      dumpPath = path.join(DUMP_DIR, `${name}.png`);
      fs.writeFileSync(dumpPath, encodePNG(pixels, raw.width, raw.height));
    } catch (e) {
      console.warn('PNG dump failed:', e);
    }
  }

  return new Frame(raw, pixels, dumpPath);
}

// --- Internal: run a raw config against the test runner ---

async function runRawConfig(cfg: any, dumpName?: string): Promise<Frame> {
  await page.goto('http://localhost:5174/gpu-test-runner.html', { waitUntil: 'networkidle0' });

  await page.evaluate((c: any) => {
    (window as any).__gpuTestConfig = c;
    (window as any).__gpuTestRun();
  }, { ...cfg, dumpPixels: true });

  await page.waitForFunction(
    () => {
      const el = document.getElementById('result');
      return el && !el.textContent!.includes('Waiting') && !el.textContent!.includes('Running');
    },
    { timeout: 15000 },
  );

  const text = await page.$eval('#result', (el: any) => el.textContent);
  const raw = JSON.parse(text!);
  const pixels = raw.pixelsBase64 ? new Uint8Array(Buffer.from(raw.pixelsBase64, 'base64')) : new Uint8Array(0);

  let dumpPath: string | undefined;
  if (raw.success && pixels.length > 0 && dumpName) {
    try {
      fs.mkdirSync(DUMP_DIR, { recursive: true });
      dumpPath = path.join(DUMP_DIR, `${dumpName}.png`);
      fs.writeFileSync(dumpPath, encodePNG(pixels, raw.width, raw.height));
    } catch (e) {
      console.warn('PNG dump failed:', e);
    }
  }

  return new Frame(raw, pixels, dumpPath);
}

/**
 * Run an effect module test with a solid-color input texture.
 * The effect receives the solid color as its input and processes it.
 */
export async function runGpuEffectTest(config: GpuEffectTestConfig): Promise<Frame> {
  return runRawConfig({
    module: config.module,
    width: config.width || 64,
    height: config.height || 64,
    params: config.params || [],
    ticks: config.ticks || 0,
    samplePoints: config.samplePoints || [],
    inputColor: config.inputColor,
  }, config.dumpName || `effect_${config.module.replace('.wasm', '')}_${testCounter++}`);
}

/**
 * Run a chain of modules. The output of each module becomes the input of the next.
 * The first module in the chain is a generator (no input texture).
 */
export async function runGpuChainTest(config: GpuChainTestConfig): Promise<Frame> {
  return runRawConfig({
    chain: config.chain,
    width: config.width || 64,
    height: config.height || 64,
    samplePoints: config.samplePoints || [],
  }, config.dumpName || `chain_${testCounter++}`);
}
