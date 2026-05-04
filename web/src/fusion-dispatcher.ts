/**
 * fusion-dispatcher.ts — runtime composition + dispatch of fused
 * effect runs.
 *
 * Each "stage" in a run publishes a per-pixel WGSL fragment via
 * `state::registerFusion` (see WasmHost.fusionFragment*). The fragment
 * defines a `fuse_transform(gid, c) -> vec4<f32>` function plus a
 * `FuseUniforms` cbuffer at `@binding(2)`. This dispatcher namespaces
 * those fragments to avoid identifier and binding collisions, then
 * composes them into one compute shader and dispatches in a single
 * pass — ping-pong textures collapse into in-register chaining.
 *
 * Phase 2 scope: PerPixelMapper top + zero-or-more PerPixelMapper
 * tails. StrictOutput tops and trace variants land in later phases.
 */
import type { GPUHost } from './gpu-host';

// Mirror state::FusionKind values (host.h).
export const FUSION_KIND_FREEFORM = 0;
export const FUSION_KIND_PER_PIXEL_MAPPER = 1;
export const FUSION_KIND_STRICT_OUTPUT = 2;

export interface FusionStage {
  /** Effect ID, used to key the pipeline cache. */
  effectId: string;
  /** FusionKind value declared by the effect. */
  fusionKind: number;
  /** Per-pixel WGSL fragment as published by the effect. */
  fragmentWgsl: string;
  /** GPUHost handle of the effect's uniform buffer. */
  uniformBufferHandle: number;
}

interface CachedPipeline {
  pipelineHandle: number;
  /** WGSL source kept for debugging / golden snapshots. */
  composedWgsl: string;
}

/**
 * Binding kind values — keep in sync with C++ enum BindingKind in
 * `native/wasm_modules/include/gpu.h` and the BIND_* constants in
 * `gpu-host.ts`. The pipeline layout decl array threads these to
 * `bindingDeclToLayoutEntry` via `createComputePipelineWithLayout`.
 */
const KIND_UNIFORM = 0;
const KIND_TEXTURE_2D = 4;
const KIND_STORAGE_TEXTURE_2D = 7;
// Format codes — see textureFormatFromCode in gpu-host.ts:
//   0 = bgra8unorm, 1 = rgba8unorm, 2 = surfaceFormat, 3 = rgba16float, ...
const FORMAT_RGBA8 = 1;
const ACCESS_WRITE = 1;

const COMPUTE_PASS_HANDLE = 1; // GPUHost only supports one compute pass at a time.

export class FusionDispatcher {
  private cache = new Map<string, CachedPipeline>();
  constructor(private gpuHost: GPUHost) {}

  /**
   * Cache key for a fused run. Identical sequences of effect IDs +
   * kinds reuse the compiled pipeline. (We deliberately key on the
   * effect IDENTITY rather than the fragment text, so the same effect
   * always hits the same cache entry; HMR invalidation lives one level
   * up — `invalidate(effectId)` evicts every entry that mentions the
   * id.)
   */
  private cacheKey(stages: FusionStage[]): string {
    return stages.map(s => `${s.effectId}@${s.fusionKind}`).join('|');
  }

  /** Drop every cached pipeline whose run mentions `effectId`. Called
   *  on HMR so a recompiled effect's new fragment takes effect. */
  invalidate(effectId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.split('|').some(seg => seg.startsWith(`${effectId}@`))) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Dispatch a fused run. `inputTexHandle` may be < 0 when the run's
   * top is a StrictOutput stage — that branch generates pixels
   * itself and the composed shader doesn't bind an input texture.
   */
  dispatch(
    stages: FusionStage[],
    inputTexHandle: number,
    outputTexHandle: number,
    vpW: number,
    vpH: number,
  ): void {
    if (stages.length === 0 || vpW <= 0 || vpH <= 0) return;
    const cached = this.ensurePipeline(stages);
    if (!cached || cached.pipelineHandle <= 0) return;
    const topStrictOut = stages[0].fusionKind === FUSION_KIND_STRICT_OUTPUT;

    this.gpuHost.beginComputePass();
    this.gpuHost.computeSetPipeline(COMPUTE_PASS_HANDLE, cached.pipelineHandle);
    if (!topStrictOut) {
      // Mapper top — slot 0 is the input texture. Strict-output top
      // skips this binding entirely; the pipeline layout omits it.
      this.gpuHost.computeSetTexture(COMPUTE_PASS_HANDLE, inputTexHandle, 0, /*access*/0);
    }
    this.gpuHost.computeSetTexture(COMPUTE_PASS_HANDLE, outputTexHandle, 1, ACCESS_WRITE);
    for (let i = 0; i < stages.length; i++) {
      this.gpuHost.computeSetBuffer(
        COMPUTE_PASS_HANDLE, stages[i].uniformBufferHandle, 0, /*slot*/2 + i);
    }
    this.gpuHost.computeDispatch(
      COMPUTE_PASS_HANDLE, Math.ceil(vpW / 8), Math.ceil(vpH / 8), 1);
    this.gpuHost.endComputePass(COMPUTE_PASS_HANDLE);
    // Mirror the standalone path: each effect's render() submits its
    // encoder via gpu::Device::submit() (gpuHost.flush). Tests read
    // pixels right after the chain completes, so the fused dispatch
    // must submit too.
    this.gpuHost.flush();
  }

  private ensurePipeline(stages: FusionStage[]): CachedPipeline | null {
    const key = this.cacheKey(stages);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const composedWgsl = composeWgsl(stages);
    const shader = this.gpuHost.createShaderModule(composedWgsl);
    if (shader <= 0) {
      console.error('[fusion-dispatcher] shader compile failed for', key,
        '\n--- composed WGSL ---\n', composedWgsl);
      return null;
    }

    // Bindings: 0 = inputTex (only when top is mapper),
    // 1 = outputTex, 2..2+N-1 = per-stage uniforms. WebGPU bind group
    // layouts allow sparse slot indices — for a strict-output top we
    // simply omit slot 0 and the shader doesn't reference it.
    const topStrictOut = stages[0].fusionKind === FUSION_KIND_STRICT_OUTPUT;
    const bindings: { slot: number; kind: number; format: number; access: number }[] = [];
    if (!topStrictOut) {
      bindings.push({ slot: 0, kind: KIND_TEXTURE_2D, format: 0, access: 0 });
    }
    bindings.push({ slot: 1, kind: KIND_STORAGE_TEXTURE_2D, format: FORMAT_RGBA8, access: ACCESS_WRITE });
    for (let i = 0; i < stages.length; i++) {
      bindings.push({ slot: 2 + i, kind: KIND_UNIFORM, format: 0, access: 0 });
    }

    const pipelineHandle = this.gpuHost.createComputePipelineWithLayout(
      shader, 'main', bindings);
    if (pipelineHandle <= 0) {
      console.error('[fusion-dispatcher] pipeline creation failed for', key,
        '\n--- composed WGSL ---\n', composedWgsl);
      return null;
    }
    const entry = { pipelineHandle, composedWgsl };
    this.cache.set(key, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// WGSL composition
// ---------------------------------------------------------------------------

/**
 * Compose a single fused compute shader from a list of stages. Each
 * stage's fragment is "namespaced" by prefixing every top-level
 * identifier with `s<i>_`, then the host shader is appended with the
 * input/output texture declarations and a chained main().
 */
export function composeWgsl(stages: FusionStage[]): string {
  const parts: string[] = [];
  const topStrictOut = stages[0].fusionKind === FUSION_KIND_STRICT_OUTPUT;
  parts.push('// Auto-composed fused compute shader.');
  parts.push('// Effect order: ' + stages.map(s => s.effectId).join(' → '));
  parts.push('');
  // inputTex is only declared when the top is a mapper. Strict-output
  // tops generate their own pixel value — no input sampling.
  if (!topStrictOut) {
    parts.push('@group(0) @binding(0) var inputTex: texture_2d<f32>;');
  }
  parts.push('@group(0) @binding(1) var outputTex: texture_storage_2d<rgba8unorm, write>;');
  parts.push('');

  for (let i = 0; i < stages.length; i++) {
    const namespaced = namespaceFragment(stages[i].fragmentWgsl, i);
    parts.push(`// === Stage ${i}: ${stages[i].effectId} (${i === 0 && topStrictOut ? 'strict-output top' : 'mapper'}) ===`);
    parts.push(namespaced);
  }

  parts.push('');
  parts.push('@compute @workgroup_size(8, 8, 1)');
  parts.push('fn main(@builtin(global_invocation_id) gid_in: vec3<u32>) {');
  parts.push('  let dims = textureDimensions(outputTex);');
  parts.push('  if (gid_in.x >= dims.x || gid_in.y >= dims.y) { return; }');
  parts.push('  var gid_local: vec2<u32> = gid_in.xy;');

  let firstTailIdx: number;
  if (topStrictOut) {
    // Strict-output top: call its fuse_transform with (gid, vp_size)
    // to seed `c`, then mapper tails chain off it.
    parts.push('  var vp_size_local: vec2<u32> = dims;');
    parts.push(`  var c: vec4<f32> = s0_fuse_transform(&gid_local, &vp_size_local);`);
    firstTailIdx = 1;
  } else {
    // Mapper top: read the input texture, then chain through every
    // stage starting at index 0.
    parts.push('  var c: vec4<f32> = textureLoad(inputTex, vec2<i32>(gid_in.xy), 0);');
    firstTailIdx = 0;
  }

  for (let i = firstTailIdx; i < stages.length; i++) {
    // Mapper tail: pass the running `c` through the per-stage
    // fragment. We have to hand it as a writable variable since
    // DXC + naga emits ptr<function, vec4<f32>> for the parameter.
    parts.push(`  var c_arg_${i}: vec4<f32> = c;`);
    parts.push(`  c = s${i}_fuse_transform(&gid_local, &c_arg_${i});`);
  }

  parts.push('  textureStore(outputTex, vec2<i32>(gid_in.xy), c);');
  parts.push('}');
  return parts.join('\n');
}

/**
 * Prefix every top-level identifier (struct, fn, var) in `src` with
 * `s<i>_`, and renumber the cbuffer's `@binding(2)` to
 * `@binding(2 + i)`.
 *
 * This is the safety net that lets us paste two effects' fragments
 * into the same shader without name collisions, and assign each its
 * own bind slot. Fragments are produced by the build pipeline (see
 * compile_shaders_compute_fused) and follow a predictable shape:
 * top-level `struct`, `var<uniform>`, and `fn` declarations in flat
 * file scope.
 */
export function namespaceFragment(src: string, stageIdx: number): string {
  const prefix = `s${stageIdx}_`;
  const renames: { from: string; to: string }[] = [];

  // Find top-level identifier declarations. The strip pass guarantees
  // these live at column 0 (no indentation) in the emitted WGSL.
  const declRe = /^(struct|fn|var(?:<[^>]*>)?)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src)) !== null) {
    const ident = m[2];
    renames.push({ from: ident, to: prefix + ident });
  }

  // Rename longest-first so a name like `fuse_transform` isn't
  // shadowed by a partial match against `fuse`.
  renames.sort((a, b) => b.from.length - a.from.length);

  // De-duplicate (same ident might appear twice if both a struct and
  // a var share a name — unlikely but harmless to guard).
  const seen = new Set<string>();
  let out = src;
  for (const r of renames) {
    if (seen.has(r.from)) continue;
    seen.add(r.from);
    out = out.replace(
      new RegExp(`\\b${escapeRe(r.from)}\\b`, 'g'),
      r.to,
    );
  }

  // Renumber the cbuffer binding (the strip output puts it at
  // @binding(2)). Stage 0 keeps slot 2; later stages shift up.
  if (stageIdx > 0) {
    out = out.replace(
      /@binding\(2\)/g,
      `@binding(${2 + stageIdx})`,
    );
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
