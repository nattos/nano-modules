import { runGpuEffectTest, forEachBackend } from './gpu-test-helpers';

// Per-effect tests for `color.hue_basis` against `core`.
//
// The basis is built from three hues (HSV at S=V=1), each normalized
// so its three components sum to 1 (b'_i = b_i / dot(b_i, 1)). The
// matrix M with columns b'_i has the property that the SUM of any
// column = 1, so:
//   Forward (out = M^T·in): per-output sum across input channels =
//     column sum of M = 1  → white in always produces white out.
//   Reverse (out = M·in): linear combination of basis weighted by
//     input channels — exact inverse for an orthogonal basis,
//     graceful collapse otherwise (no NaNs).

forEachBackend((backend) => {
describe(`Hue Basis Effect E2E (${backend})`, () => {
  jest.setTimeout(30000);

  it('declares metadata and four scalar inputs', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'hue_basis_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('color.hue_basis');
    const names = frame.params.map(p => p.name).sort();
    expect(names).toEqual(['direction', 'hue_a', 'hue_b', 'hue_c']);
  });

  it('default basis (R,G,B) at default direction is pass-through', async () => {
    // Hues 0, 1/3, 2/3 → b = (R, G, B) → M = identity → both
    // directions are pass-through.
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      dumpName: 'hue_basis_default_passthrough',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('default basis Reverse is also pass-through', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [0.4, 0.6, 0.8, 1.0],
      params: [['direction', 1]],
      dumpName: 'hue_basis_default_reverse',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 153, b: 204, a: 255 }, 2);
  });

  it('forward preserves white for any basis (white-in → white-out)', async () => {
    // Pick a non-default basis: cyan, magenta, yellow at hues
    // 0.5, 0.833, 0.166. Each is a 2-component RGB → after
    // normalization each has components summing to 1. White stays
    // white in the forward direction by construction.
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [
        ['direction', 0],
        ['hue_a', 0.5],          // cyan
        ['hue_b', 0.833333],     // magenta
        ['hue_c', 0.166666],     // yellow
      ],
      dumpName: 'hue_basis_white_preserve',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 4);
  });

  it('forward(0,0,0) = (0,0,0) for any basis (linearity)', async () => {
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [0.0, 0.0, 0.0, 1.0],
      params: [
        ['direction', 0],
        ['hue_a', 0.1], ['hue_b', 0.4], ['hue_c', 0.7],
      ],
      dumpName: 'hue_basis_zero',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 2);
  });

  it('non-default basis produces a non-identity transform', async () => {
    // Same basis as the white-preserve test (CMY). A non-white
    // input should NOT match itself — the transform is non-trivial.
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [1.0, 0.0, 0.0, 1.0],
      params: [
        ['direction', 0],
        ['hue_a', 0.5],
        ['hue_b', 0.833333],
        ['hue_c', 0.166666],
      ],
      dumpName: 'hue_basis_red_through_cmy',
    });
    expect(frame.success).toBe(true);
    // Cyan basis has r=0 (after normalization (0, 0.5, 0.5)), magenta
    // (0.5, 0, 0.5), yellow (0.5, 0.5, 0). Forward = M^T·in.
    // M^T row 0 = column 0 of M = (b'_0.r, b'_1.r, b'_2.r) = (0, 0.5, 0.5)
    // dot with (1,0,0) = 0. So r → 0.
    // M^T row 1 = (b'_0.g, b'_1.g, b'_2.g) = (0.5, 0, 0.5). dot = 0.5.
    // M^T row 2 = (b'_0.b, b'_1.b, b'_2.b) = (0.5, 0.5, 0). dot = 0.5.
    // → (0, 0.5, 0.5) = (0, 128, 128).
    frame.expectUniformColor({ r: 0, g: 128, b: 128, a: 255 }, 4);
  });

  it('reverse round-trips the forward for an orthogonal basis (default)', async () => {
    // With identity basis, reverse(forward(x)) = x. Trivially since
    // both directions are pass-through, but worth pinning.
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [0.7, 0.3, 0.5, 1.0],
      params: [['direction', 1]],
      dumpName: 'hue_basis_reverse_default',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 178, g: 76, b: 128, a: 255 }, 2);
  });

  it('forward preserves white even with a degenerate (all-same-hue) basis', async () => {
    // Per-basis normalization (each column of M sums to 1) makes
    // M^T · (1,1,1) = (1,1,1) regardless of basis shape. Even with
    // all three basis vectors collapsed to red, white survives the
    // forward pass.
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [1.0, 1.0, 1.0, 1.0],
      params: [
        ['direction', 0],
        ['hue_a', 0.0], ['hue_b', 0.0], ['hue_c', 0.0],
      ],
      dumpName: 'hue_basis_degenerate_forward',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 4);
    expect(frame.gpuErrors).toEqual([]);
  });

  it('reverse on a degenerate basis falls back gracefully (no NaN)', async () => {
    // With all hues = 0 the matrix is rank-1 and has no inverse.
    // Reverse can't reconstruct the input — instead of
    // NaNing, the C++ side detects the singularity (|det| ≤ 1e-4)
    // and falls back to uploading M's columns again. Effect of
    // reverse becomes identical to forward, which on a degenerate
    // (all-red) basis maps each output channel to the input's red.
    // For grey (0.4, 0.4, 0.4) → (0.4, 0.4, 0.4) → (102, 102, 102).
    const frame = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: [0.4, 0.4, 0.4, 1.0],
      params: [
        ['direction', 1],
        ['hue_a', 0.0], ['hue_b', 0.0], ['hue_c', 0.0],
      ],
      dumpName: 'hue_basis_degenerate_reverse',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 102, g: 102, b: 102, a: 255 }, 4);
    expect(frame.gpuErrors).toEqual([]);
  });

  it('forward → reverse round-trip is identity for a non-orthogonal basis', async () => {
    // Pick a deliberately non-orthogonal basis (CMY) and run the
    // input through the chain: solid_color → hue_basis(forward) →
    // hue_basis(reverse). Output should equal the original solid
    // colour within 8-bit rounding.
    //
    // We can't easily express a 3-stage chain through the runner's
    // ping-pong setup without separate hosts, so emulate by
    // computing what forward(input) is on the CPU side, then
    // running reverse on that.
    //
    // Forward on CMY basis (hues 0.5, 0.833, 0.166) of (1, 0.5, 0):
    //   b'_0 = (0, 0.5, 0.5), b'_1 = (0.5, 0, 0.5), b'_2 = (0.5, 0.5, 0)
    //   out.r = dot(b'_0, in) = 0*1 + 0.5*0.5 + 0.5*0   = 0.25
    //   out.g = dot(b'_1, in) = 0.5*1 + 0*0.5 + 0.5*0   = 0.5
    //   out.b = dot(b'_2, in) = 0.5*1 + 0.5*0.5 + 0*0   = 0.75
    // → forward output = (64, 128, 191) when stored as rgba8.
    //
    // Now reverse-on-(64, 128, 191)/255 ≈ (0.251, 0.502, 0.749)
    // with the same basis should give back (255, 128, 0) ≈ the
    // original quantized to 8 bits.
    const fwdQuant: [number, number, number, number] = [64 / 255, 128 / 255, 191 / 255, 1.0];
    const reversed = await runGpuEffectTest({
      module: 'color.hue_basis',
      bundle: 'core',
      inputColor: fwdQuant,
      params: [
        ['direction', 1],         // Reverse
        ['hue_a', 0.5],
        ['hue_b', 0.833333],
        ['hue_c', 0.166666],
      ],
      dumpName: 'hue_basis_round_trip',
    });
    expect(reversed.success).toBe(true);
    // Original input was (1, 0.5, 0); allow ~1 LSB of rounding
    // through the 8-bit quantization in the intermediate.
    reversed.expectUniformColor({ r: 255, g: 128, b: 0, a: 255 }, 3);
  });
});
});
