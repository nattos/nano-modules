/**
 * Platform-feature smoke tests.
 *
 * These exercise GPU-host capabilities (texture formats, atomics, RW
 * storage textures, copy/clear, MRT, 3D textures) end-to-end via small
 * test-only effects in the testonly bundle. A regression in any feature
 * shows up as a recognizable pixel-level failure here, separately from
 * the dozens of effect-correctness tests that depend on the same
 * platform.
 */

import { runGpuEffectTest } from './gpu-test-helpers';
import { runEngineTest } from './engine-test-helpers';
import type { Sketch } from '../src/sketch-types';

describe('Platform features', () => {
  jest.setTimeout(30000);

  describe('rgba16float storage textures (HDR round-trip)', () => {
    it('preserves >1.0 values through an HDR scratch', async () => {
      // hdr_test pre-scales by 4 into an rgba16float scratch, then post-
      // scales by 0.25 into the rgba8unorm visible target. With genuine
      // float storage the round trip is identity (input 0.5 → output 0.5
      // → 128). With an 8-bit fallback, the 4x clips to 1.0 and the
      // round trip crushes to 0.25 → 64. The two outcomes are 64 LSBs
      // apart, so a comfortable tolerance still distinguishes them.
      const frame = await runGpuEffectTest({
        module: 'debug.hdr_test',
        inputColor: [0.5, 0.5, 0.5, 1.0],
        dumpName: 'hdr_test_roundtrip',
      });

      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('hdr_test: initialized');
      // Identity round trip — anything close to 128 means HDR survived.
      // 8-bit fallback would land near 64.
      frame.expectUniformColor({ r: 128, g: 128, b: 128, a: 255 }, 6);
    });

    it('handles fully saturated input (no over-bright clipping below 1.0)', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.hdr_test',
        inputColor: [1.0, 1.0, 1.0, 1.0],
        dumpName: 'hdr_test_saturated',
      });
      expect(frame.success).toBe(true);
      // input 1.0 → scratch 4.0 (fits in float16) → output 1.0 → 255.
      frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 4);
    });

    it('handles a dark input', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.hdr_test',
        inputColor: [0.1, 0.2, 0.3, 1.0],
        dumpName: 'hdr_test_dark',
      });
      expect(frame.success).toBe(true);
      // 0.1*255=25.5, 0.2*255=51, 0.3*255=76.5 — round-trip should land
      // within float16 / sRGB rounding.
      frame.expectUniformColor({ r: 26, g: 51, b: 77, a: 255 }, 4);
    });
  });

  describe('atomic ops on storage buffers (per-pixel histogram)', () => {
    // atomic_test bins each pixel into one of 4 luminance quartiles via
    // InterlockedAdd, then writes (bin0, bin1, bin2, bin3) / total to the
    // RGBA output. A solid input lands every pixel in exactly one bin, so
    // exactly one channel must be 1.0 and the others 0. If atomics or the
    // RW storage-buffer binding regressed, the bins are empty and every
    // channel is 0 — easy to detect.

    it('uniform mid-bright input fills bin 2 (luma in [0.5,0.75))', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.atomic_test',
        inputColor: [0.6, 0.6, 0.6, 1.0],  // luma == 0.6 → bin 2
        dumpName: 'atomic_test_mid',
      });
      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('atomic_test: initialized');
      frame.expectUniformColor({ r: 0, g: 0, b: 255, a: 0 }, 2);
    });

    it('uniform dark input fills bin 0 (luma in [0,0.25))', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.atomic_test',
        inputColor: [0.1, 0.1, 0.1, 1.0],  // luma == 0.1 → bin 0
        dumpName: 'atomic_test_dark',
      });
      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 255, g: 0, b: 0, a: 0 }, 2);
    });

    it('uniform bright input fills bin 3 (luma in [0.75,1])', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.atomic_test',
        inputColor: [0.9, 0.9, 0.9, 1.0],  // luma == 0.9 → bin 3
        dumpName: 'atomic_test_bright',
      });
      expect(frame.success).toBe(true);
      frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 2);
    });
  });

  describe('read-write storage textures (in-place RMW on r32float)', () => {
    // rw_storage_test writes 0.25 to a r32float scratch, reads it back,
    // adds 0.5, writes again, and reads — all from the SAME storage
    // texture binding declared with read_write access. The output is
    // (scratch, scratch, scratch, 1.0). Expected: 0.75 → 191/255.
    //
    // If the binding silently fell back to write-only, the read in the
    // RMW step would not compile (or would return 0), so a value of
    // 0.5 would be written and the final readback would land near
    // 128/255 — clearly distinguishable from 191.
    it('returns 0.75 after init+RMW round trip', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.rw_storage_test',
        inputColor: [0, 0, 0, 1],  // input is unused
        dumpName: 'rw_storage_roundtrip',
      });
      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('rw_storage_test: initialized');
      // 0.75 * 255 = 191.25 — uniform across the frame.
      frame.expectUniformColor({ r: 191, g: 191, b: 191, a: 255 }, 4);
    });
  });

  describe('texture clear + copy', () => {
    // clear_copy_test fills a scratch texture to (0.5, 0.0, 1.0, 1.0)
    // via gpu::Device::clear, then copies it byte-for-byte to the
    // visible output via gpu::Device::copy. A regression in either path
    // would leave the output unchanged from its previous frame (in
    // these tests, all-zeros), or smear a different color through.
    it('clears scratch then copies to output', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.clear_copy_test',
        // Input red would otherwise leak through if the copy or clear
        // failed silently.
        inputColor: [1, 0, 0, 1],
        dumpName: 'clear_copy_roundtrip',
      });
      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('clear_copy_test: initialized');
      frame.expectUniformColor({ r: 128, g: 0, b: 255, a: 255 }, 2);
    });

    // The same copy, but routed through the chain executor path, whose
    // intermediate pool backs tex_out. That pool was COPY_SRC-only, so a
    // gpu::Device::copy(scratch, tex_out) was a silent WebGPU validation failure
    // there (it only worked in the single-effect harness above, whose output has
    // COPY_DST). Now the pool allocates the COPY_SRC|COPY_DST superset, so a
    // stage can copy into its own output — e.g. to skip a passthrough dispatch.
    it('copies into tex_out through the chain executor (intermediate-pool COPY_DST)', async () => {
      const sketch: Sketch = {
        anchor: null,
        chain: [
          // Red bg that must be fully overwritten by the clear+copy.
          {
            type: 'module',
            module_type: 'source.solid_color',
            instance_key: 'bg@0',
            params: { color: [1.0, 0.0, 0.0] },
          },
          {
            type: 'module',
            module_type: 'debug.clear_copy_test',
            instance_key: 'cc@0',
          },
        ],
      };

      const result = await runEngineTest({
        width: 64, height: 64,
        modules: ['com.nano.testonly'],
        commands: [
          { type: 'createSketch', sketchId: 'cc', sketch },
          { type: 'setTracePoints', tracePoints: [
            { id: 'out', target: { type: 'sketch_output', sketchId: 'cc' } },
          ]},
        ],
        waitFrames: 4,
        captureTraceIds: ['out'],
        dumpName: 'clear_copy_chain',
      });
      expect(result.success).toBe(true);
      // scratch cleared to (0.5, 0.0, 1.0) → copied verbatim into tex_out.
      result.trace('out').expectUniformColor({ r: 128, g: 0, b: 255 }, 2);
    });
  });

  describe('multi-render-target', () => {
    // mrt_test runs a render pass with two color attachments. The
    // fragment shader writes (1,0,0,1) to target0 and (0,1,0,1) to
    // target1 over a fullscreen triangle. A combine compute pass merges
    // (target0.r, target1.g, 0, 1) into the visible output → yellow if
    // both attachments received their writes. If MRT silently degraded
    // to a single attachment, target1 would still be its clear color
    // (black) and the output would lose green → red.
    it('writes both attachments in one render pass (yellow round-trip)', async () => {
      const frame = await runGpuEffectTest({
        module: 'debug.mrt_test',
        inputColor: [0, 0, 0, 1],
        dumpName: 'mrt_test_yellow',
      });
      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('mrt_test: initialized');
      frame.expectUniformColor({ r: 255, g: 255, b: 0, a: 255 }, 4);
      expect(frame.gpuErrors).toEqual([]);
    });
  });

  describe('3D textures (identity color LUT)', () => {
    // lut3d_test fills a 16³ rgba8 LUT with identity (x/15, y/15, z/15)
    // via storage-3D writes, then samples it via textureLoad on a 3D
    // sampled binding. An identity LUT round-trips the input within
    // ~1 cell of quantization (255/15 ≈ 17 LSB worst case at the cell
    // boundary; midpoints round-trip exact). The test picks midpoint-y
    // colors so the tolerance is tight.
    it('input color survives a 16³ identity LUT round-trip', async () => {
      // (0.4, 0.6, 0.8) → cells (6, 9, 12) → values (6/15, 9/15, 12/15)
      // ≈ (0.4, 0.6, 0.8). Round-trip should match within ~1 LSB after
      // the rounding to the nearest 8-bit value.
      const frame = await runGpuEffectTest({
        module: 'debug.lut3d_test',
        inputColor: [0.4, 0.6, 0.8, 1.0],
        dumpName: 'lut3d_identity',
      });
      expect(frame.success).toBe(true);
      expect(frame.consoleLog).toContain('lut3d_test: initialized');
      expect(frame.gpuErrors).toEqual([]);
      frame.expectUniformColor(
        { r: Math.round(6 / 15 * 255), g: Math.round(9 / 15 * 255), b: Math.round(12 / 15 * 255), a: 255 },
        2,
      );
    });

    it('endpoints are exact (0 → 0 and 1 → 1)', async () => {
      const black = await runGpuEffectTest({
        module: 'debug.lut3d_test',
        inputColor: [0, 0, 0, 1],
        dumpName: 'lut3d_black',
      });
      expect(black.success).toBe(true);
      black.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 2);

      const white = await runGpuEffectTest({
        module: 'debug.lut3d_test',
        inputColor: [1, 1, 1, 1],
        dumpName: 'lut3d_white',
      });
      expect(white.success).toBe(true);
      white.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 2);
    });
  });

  describe('mip texture chain + LOD sampling', () => {
    // filter.blur.fast is the canonical exercise of the multi-mip
    // platform path: it allocates a scratch with a mip chain,
    // bounces through 4 down + 4 up passes alternating reads of one
    // mip with writes to another. If the platform binds full-chain
    // views for sampled reads (the original bug), WebGPU rejects
    // every dispatch with "writable + read in same sync scope" and
    // gpuErrors fills up. If anything else is wrong (mip view
    // dimension, view caching, etc.) the constant-input
    // round-trip drifts.
    it('fast_blur exercises the mip chain end-to-end', async () => {
      const frame = await runGpuEffectTest({
        module: 'filter.blur.fast',
        bundle: 'core',
        inputColor: [0.4, 0.6, 0.2, 1.0],
        params: [['iterations', 4]],
        dumpName: 'mip_chain_fast_blur_constant',
      });
      expect(frame.success).toBe(true);
      // Constant input → constant output (the kernels sum to 1.0,
      // so averaging a uniform field is exact).
      frame.expectPixelAt(32, 32, { r: 102, g: 153, b: 51, a: 255 }, 4);
      // No subresource conflicts in any of the dispatches.
      expect(frame.gpuErrors).toEqual([]);
    });
  });
});
