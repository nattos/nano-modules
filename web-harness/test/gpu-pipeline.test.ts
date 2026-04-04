// GPU Pipeline Integration Test
//
// Tests the full shader build pipeline end-to-end:
// HLSL → SPIR-V → WGSL → WebGPU compute + render → pixel readback
//
// Loads a minimal WASM module that fills the screen with a known color
// (R=0, G=0.5, B=1.0) via compute shader → render pass, then reads
// back pixels and asserts they match.
//
// Requires dev server on port 5174.

describe('GPU Pipeline E2E', () => {
  jest.setTimeout(30000);

  it('full pipeline: HLSL shaders → compute → render → correct pixels', async () => {
    await page.goto('http://localhost:5174/gpu-test.html', { waitUntil: 'networkidle0' });

    // Wait for the test to complete (result element gets populated)
    await page.waitForFunction(
      () => {
        const el = document.getElementById('result');
        return el && !el.textContent!.includes('Running');
      },
      { timeout: 10000 },
    );

    const resultText = await page.$eval('#result', el => el.textContent);
    const result = JSON.parse(resultText!);

    // Basic success
    expect(result.success).toBe(true);
    expect(result.pixelCount).toBe(64 * 64);

    // Module initialized
    expect(result.consoleLog).toContain('gpu_test: initialized');

    // Center pixel should be approximately (0, 128, 255, 255)
    // The compute shader sets R=0.0, G=0.5, B=1.0, A=1.0
    const cp = result.centerPixel;
    expect(cp.r).toBeLessThanOrEqual(5);        // R ≈ 0
    expect(cp.g).toBeGreaterThanOrEqual(120);    // G ≈ 128
    expect(cp.g).toBeLessThanOrEqual(136);
    expect(cp.b).toBeGreaterThanOrEqual(250);    // B ≈ 255
    expect(cp.a).toBeGreaterThanOrEqual(250);    // A ≈ 255

    expect(result.centerCorrect).toBe(true);
  });

  it('all sampled pixels have uniform color', async () => {
    // Re-use the same page from previous test (or reload)
    const resultText = await page.$eval('#result', el => el.textContent);
    const result = JSON.parse(resultText!);

    if (!result.success) {
      console.log('Skipping: GPU test failed', result.error);
      return;
    }

    // All sampled pixels should be approximately the same color
    const tolerance = 10;
    for (const sample of result.samples) {
      expect(sample.r).toBeLessThanOrEqual(tolerance);
      expect(sample.g).toBeGreaterThanOrEqual(128 - tolerance);
      expect(sample.g).toBeLessThanOrEqual(128 + tolerance);
      expect(sample.b).toBeGreaterThanOrEqual(255 - tolerance);
      expect(sample.a).toBeGreaterThanOrEqual(255 - tolerance);
    }
  });
});
