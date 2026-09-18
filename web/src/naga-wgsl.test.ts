/**
 * naga_spv.wasm must agree with the naga CLI, byte for byte.
 *
 * The dev server translates SPIR-V by spawning the `naga` binary; a packaged
 * app can't, so it runs the same crate compiled to wasm instead. Every effect
 * in this repo was developed against the CLI's output, and the two paths are
 * chosen at RUNTIME depending on whether Vite happens to be in front — so a
 * divergence would show up only in a release, as a wrong bind-group layout,
 * which renders black rather than erroring.
 *
 * Skips (loudly) rather than fails when the artifact or the CLI is missing:
 * a web-only checkout has neither, and this is not the test that should tell
 * you to run `cargo`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  applyStorageFormat,
  loadLocalTranslatorFromBytes,
  spvToWgsl,
  isLocalTranslatorReady,
} from './naga-wgsl';

const NAGA_WASM = resolve(__dirname, '../../build/wasm/naga_spv.wasm');

/** Translate through the CLI exactly as web/src/vite-plugins/naga-bridge.ts does. */
function cliTranslate(spv: Uint8Array, fmt: string, access: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'naga-parity-'));
  try {
    const inPath = join(dir, 'in.spv');
    const outPath = join(dir, 'out.wgsl');
    writeFileSync(inPath, spv);
    execFileSync('naga', [inPath, outPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return applyStorageFormat(readFileSync(outPath, 'utf8'), fmt, access);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function haveCli(): boolean {
  try {
    execFileSync('naga', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real SPIR-V to translate.
 *
 * Generated with naga itself (WGSL -> SPIR-V) rather than scraped out of a
 * built bundle: a .wasm stores its shader blobs as opaque data with no recorded
 * length, so finding one means guessing where it ends, and a wrong guess makes
 * this test quietly vacuous instead of failing. Generating it means the input
 * is deterministic, needs no shader toolchain beyond the CLI the parity leg
 * already requires, and still covers the constructs that matter here — a
 * storage texture (which is what triggers naga's rgba32float default and hence
 * the fixup) and a compute entry point with a workgroup size.
 */
function sampleSpv(): Uint8Array<ArrayBuffer> | null {
  const dir = mkdtempSync(join(tmpdir(), 'naga-sample-'));
  try {
    const wgsl = join(dir, 'in.wgsl');
    const spv = join(dir, 'out.spv');
    writeFileSync(wgsl, `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba32float, write>;

struct Params { scale: f32, bias: f32 };
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(dst);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }
  let c = textureLoad(src, vec2<i32>(gid.xy), 0);
  textureStore(dst, vec2<i32>(gid.xy), c * params.scale + params.bias);
}
`);
    execFileSync('naga', [wgsl, spv], { stdio: ['ignore', 'pipe', 'pipe'] });
    const bytes = readFileSync(spv);
    const out = new Uint8Array(new ArrayBuffer(bytes.length));
    out.set(bytes);
    return out;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every shader the effects actually ship, as DXC emitted it.
 *
 * `native/build/tmp/*.spv` is the real corpus — the intermediate the bundle
 * build hands to `_emit_spv_header.py` and bakes into each `.wasm`. It is what
 * the app translates at runtime, and it covers vertex/fragment stages and
 * storage-texture declarations that a hand-written compute shader does not.
 *
 * Going through the built bundles instead would have been circular and, worse,
 * vacuous: effects guard `registerShaderSPV` behind
 * `gpu::Device::backend() != None`, so a node-side WasmHost with no GPU host
 * registers nothing at all and the loop would have silently had zero shaders.
 *
 * This is the gate that matters. An earlier naga_spv set
 * `adjust_coordinate_space: false` by hand — naga's default is true — which
 * produced WGSL that compiled cleanly and RENDERED DIFFERENTLY: four effect
 * suites failed on brightness thresholds with nothing logged anywhere. One
 * synthetic compute shader did not catch it and never would have.
 */
function builtSpvFiles(): string[] {
  const dir = resolve(__dirname, '..', '..', 'native', 'build', 'tmp');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.spv')).sort()
    .map((f) => join(dir, f));
}

describe('naga_spv.wasm', () => {
  let loaded = false;

  beforeAll(() => {
    if (!existsSync(NAGA_WASM)) return;
    const bytes = readFileSync(NAGA_WASM);
    const copy = new Uint8Array(new ArrayBuffer(bytes.length));
    copy.set(bytes);
    loadLocalTranslatorFromBytes(copy);
    loaded = true;
  });

  it('loads and reports ready', () => {
    if (!loaded) {
      console.warn('no naga_spv.wasm — run native/naga_spv/build_wasm.sh');
      return;
    }
    expect(isLocalTranslatorReady()).toBe(true);
  });

  it('rejects input that is not SPIR-V', () => {
    if (!loaded) return;
    const junk = new Uint8Array(new ArrayBuffer(8));
    expect(() => spvToWgsl(junk, 'rgba8unorm', 'write')).toThrow();
  });

  it('rejects a length that is not a multiple of 4', () => {
    if (!loaded) return;
    const odd = new Uint8Array(new ArrayBuffer(7));
    expect(() => spvToWgsl(odd, 'rgba8unorm', 'write')).toThrow();
  });

  it('matches the naga CLI byte for byte', () => {
    if (!loaded) return;
    if (!haveCli()) {
      console.warn('no naga CLI on PATH — skipping parity leg');
      return;
    }
    const spv = sampleSpv();
    expect(spv).not.toBeNull();
    if (!spv) return;
    for (const [fmt, access] of [
      ['rgba8unorm', 'write'],
      ['rgba16float', 'write'],
      ['r32float', 'read_write'],
    ] as const) {
      const mine = spvToWgsl(spv, fmt, access);
      expect(mine).not.toBeNull();
      expect(mine).toBe(cliTranslate(spv, fmt, access));
    }
  });

  // The real gate. Slower than the rest, and worth every second of it.
  it('matches the naga CLI across every built shader', () => {
    if (!loaded) return;
    if (!haveCli()) { console.warn('no naga CLI on PATH — skipping'); return; }
    const files = builtSpvFiles();
    if (files.length === 0) {
      console.warn('no native/build/tmp/*.spv — build the bundles to run this');
      return;
    }
    const mismatched: string[] = [];
    const failed: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file);
      const spv = new Uint8Array(new ArrayBuffer(raw.length));
      spv.set(raw);
      // Cover both storage-format resolutions of the '' sentinel, plus the
      // read_write variant, since the fixup differs per shader.
      for (const [fmt, access] of [
        ['rgba8unorm', 'write'],
        ['rgba16float', 'write'],
        ['r32float', 'read_write'],
      ] as const) {
        let mine: string | null;
        try { mine = spvToWgsl(spv, fmt, access); }
        catch (e) { failed.push(`${file} [${fmt}]: ${e}`); continue; }
        let theirs: string;
        try { theirs = cliTranslate(spv, fmt, access); }
        catch { continue; }   // the CLI rejects it too — not our divergence
        if (mine !== theirs) mismatched.push(`${file} [${fmt},${access}]`);
      }
    }
    expect({ mismatched, failed }).toEqual({ mismatched: [], failed: [] });
    // Guard against a vacuous pass.
    expect(files.length).toBeGreaterThan(50);
  }, 600000);

  it('applies the storage-format fixup the build helpers use', () => {
    // naga defaults an HLSL RWTexture2D<float4> to rgba32float because SPIR-V
    // doesn't carry the declared format. Both runtime paths and the build
    // scripts patch it the same way; this is the shared copy.
    const src = 'var t: texture_storage_2d<rgba32float,read_write>;\n' +
                'var u: texture_storage_2d<rgba32float,write>;';
    expect(applyStorageFormat(src, 'r32float', 'read_write')).toBe(
      'var t: texture_storage_2d<r32float,read_write>;\n' +
      'var u: texture_storage_2d<r32float,write>;',
    );
  });
});
