/**
 * Engine E2E test helpers.
 *
 * Boots the engine worker in a real browser (via Puppeteer),
 * sends commands (load modules, create sketches, set params, set trace points),
 * waits for frames, and reads back traced pixels for assertions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { Frame, RGBA } from './gpu-test-helpers';

const DUMP_DIR = '/tmp/gpu-test-dumps';

export interface EngineTestConfig {
  width?: number;
  height?: number;
  /** Module types to load as "real" instances. */
  modules?: string[];
  /** Extra commands to run after loading modules. */
  commands?: any[];
  /** Trace points to set. */
  tracePoints?: any[];
  /** Frames to wait before capturing (default 15). */
  waitFrames?: number;
  /** Which trace IDs to capture pixels for. */
  captureTraceIds?: string[];
  /** Name for PNG dumps. */
  dumpName?: string;
}

/** Multi-phase test: each phase sends commands, waits, and captures independently. */
export interface EnginePhaseConfig {
  commands?: any[];
  waitFrames?: number;
  captureTraceIds?: string[];
}

export interface EngineMultiPhaseTestConfig {
  width?: number;
  height?: number;
  /** Module types to load in the first phase. */
  modules?: string[];
  /** Phases to execute sequentially. */
  phases: EnginePhaseConfig[];
  dumpName?: string;
}

export interface EngineTestResult {
  success: boolean;
  error?: string;
  state: any;
  tracedFrames: Record<string, Frame | null>;
  /** Per-sketch rail values from the last frame. */
  sketchState: Record<string, any>;
  trace(id: string): Frame;
}

export interface EngineMultiPhaseResult {
  success: boolean;
  error?: string;
  state: any;
  phases: { tracedFrames: Record<string, Frame | null>; sketchState: Record<string, any>; trace(id: string): Frame }[];
}

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

let testCounter = 0;

function decodeTracedFrames(rawFrames: Record<string, any>, baseName: string, phaseSuffix: string): Record<string, Frame | null> {
  const tracedFrames: Record<string, Frame | null> = {};
  for (const [traceId, data] of Object.entries(rawFrames)) {
    if (!data) { tracedFrames[traceId] = null; continue; }
    const pixels = new Uint8Array(Buffer.from(data.pixelsBase64, 'base64'));
    const frameRaw = {
      success: true, width: data.width, height: data.height,
      pixelCount: data.width * data.height,
      samples: [], consoleLog: [], pluginState: {}, metadata: null, params: [],
    };
    let dumpPath: string | undefined;
    try {
      fs.mkdirSync(DUMP_DIR, { recursive: true });
      dumpPath = path.join(DUMP_DIR, `${baseName}${phaseSuffix}_${traceId}.png`);
      fs.writeFileSync(dumpPath, encodePNG(pixels, data.width, data.height));
    } catch (e) { console.warn('PNG dump failed:', e); }
    tracedFrames[traceId] = new Frame(frameRaw, pixels, dumpPath);
  }
  return tracedFrames;
}

function makeTraceAccessor(tracedFrames: Record<string, Frame | null>) {
  return (id: string): Frame => {
    const f = tracedFrames[id];
    if (!f) throw new Error(`Trace '${id}' not found. Available: ${Object.keys(tracedFrames).join(', ')}`);
    return f;
  };
}

// --- Run test against engine-test-runner.html ---

async function runRawEngineTest(runnerConfig: any): Promise<any> {
  const logs: string[] = [];
  const onConsole = async (msg: any) => {
    let body = msg.text();
    try {
      const args = await Promise.all(msg.args().map(async (a: any) => {
        try {
          return await a.evaluate((v: any) => {
            if (v && typeof v === 'object' && 'stack' in v) return String(v.stack);
            if (v && typeof v === 'object') {
              try { return JSON.stringify(v); } catch { return String(v); }
            }
            return String(v);
          });
        } catch { return null; }
      }));
      const joined = args.filter((s: any) => s !== null).join(' ').trim();
      if (joined.length > 0) body = joined;
    } catch {}
    logs.push(`[${msg.type()}] ${body}`);
  };
  const onPageError = (err: Error) => logs.push(`[pageerror] ${err.message}`);
  const onResponse = (res: any) => {
    if (!res.ok() && res.status() >= 400) logs.push(`[http ${res.status()}] ${res.url()}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  try {
    await page.goto('http://localhost:5174/engine-test-runner.html', { waitUntil: 'networkidle0' });
    await page.evaluate((cfg: any) => {
      (window as any).__engineTestConfig = cfg;
      (window as any).__engineTestRun();
    }, runnerConfig);
    await page.waitForFunction(
      () => {
        const el = document.getElementById('result');
        return el && !el.textContent!.includes('Waiting') && !el.textContent!.includes('Running');
      },
      { timeout: 25000 },
    );
    const text = await page.$eval('#result', (el) => el.textContent);
    const result = JSON.parse(text!);
    if (!result.success || process.env.DEBUG_E2E) {
      console.error('--- browser logs ---\n' + logs.join('\n') + '\n--- end logs ---');
    }
    return result;
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }
}

// --- Single-phase test ---

/**
 * All built-in effects are bundled into com.nattos.nano_effects. Tests still
 * list the logical module_type (e.g. 'com.nattos.spinningtris'); expand
 * those into a loadModule(bundle) + instantiateEffect(<registered id>).
 */
const LEGACY_MODULE_TO_EFFECT_ID: Record<string, string> = {
  'com.nattos.spinningtris': 'generator.spinningtris',
  'com.nattos.gpu_test': 'debug.gpu_test',
  'com.nattos.brightness_contrast': 'video.brightness_contrast',
  'com.nattos.solid_color': 'generator.solid_color',
  'com.nattos.env_lfo': 'data.lfo',
  'com.nattos.video_blend': 'video.blend',
  'com.nattos.nanolooper': 'sequencer.nanolooper',
  'com.nattos.paramlinker': 'utility.paramlinker',
  // Also accept the effect IDs themselves so new-style tests work.
  'generator.spinningtris': 'generator.spinningtris',
  'debug.gpu_test': 'debug.gpu_test',
  'video.brightness_contrast': 'video.brightness_contrast',
  'generator.solid_color': 'generator.solid_color',
  'data.lfo': 'data.lfo',
  'video.blend': 'video.blend',
  'sequencer.nanolooper': 'sequencer.nanolooper',
  'utility.paramlinker': 'utility.paramlinker',
};
const BUNDLE_MODULE_TYPE = 'com.nattos.nano_effects';

function expandModulesList(modules: string[]): any[] {
  const cmds: any[] = [];
  const seenBundle = new Set<string>();
  for (const m of modules) {
    const effectId = LEGACY_MODULE_TO_EFFECT_ID[m];
    if (effectId) {
      if (!seenBundle.has(BUNDLE_MODULE_TYPE)) {
        cmds.push({ type: 'loadModule', moduleType: BUNDLE_MODULE_TYPE });
        seenBundle.add(BUNDLE_MODULE_TYPE);
      }
      cmds.push({ type: 'instantiateEffect', effectId });
    } else {
      cmds.push({ type: 'loadModule', moduleType: m });
    }
  }
  return cmds;
}

export async function runEngineTest(config: EngineTestConfig): Promise<EngineTestResult> {
  const W = config.width || 64;
  const H = config.height || 64;
  const commands: any[] = [];

  commands.push(...expandModulesList(config.modules || []));
  if (config.tracePoints?.length) commands.push({ type: 'setTracePoints', tracePoints: config.tracePoints });
  commands.push(...(config.commands || []));

  const raw = await runRawEngineTest({
    width: W, height: H, commands,
    waitFrames: config.waitFrames ?? 15,
    captureTraceIds: config.captureTraceIds,
  });

  if (!raw.success) {
    return { success: false, error: raw.error, state: null, tracedFrames: {},
      trace() { throw new Error(`Test failed: ${raw.error}`); } };
  }

  const baseName = config.dumpName || `engine_${testCounter++}`;
  const tracedFrames = decodeTracedFrames(raw.tracedFrames || {}, baseName, '');

  return { success: true, state: raw.state, tracedFrames, sketchState: raw.sketchState ?? {}, trace: makeTraceAccessor(tracedFrames) };
}

// --- Multi-phase test ---

export async function runEngineMultiPhaseTest(config: EngineMultiPhaseTestConfig): Promise<EngineMultiPhaseResult> {
  const W = config.width || 64;
  const H = config.height || 64;

  // Build phases: first phase includes module loading
  const phases = config.phases.map((p, i) => {
    const cmds = [...(p.commands || [])];
    if (i === 0 && config.modules) {
      cmds.unshift(...expandModulesList(config.modules));
    }
    return { commands: cmds, waitFrames: p.waitFrames || 15, captureTraceIds: p.captureTraceIds };
  });

  const raw = await runRawEngineTest({ width: W, height: H, phases });

  if (!raw.success) {
    return { success: false, error: raw.error, state: null, phases: [] };
  }

  const baseName = config.dumpName || `engine_mp_${testCounter++}`;
  const phaseResults = (raw.phases || []).map((p: any, i: number) => {
    const traced = decodeTracedFrames(p.tracedFrames || {}, baseName, `_p${i}`);
    return { tracedFrames: traced, sketchState: p.sketchState ?? {}, trace: makeTraceAccessor(traced) };
  });

  return { success: true, state: raw.state, phases: phaseResults };
}
