/**
 * GPUHost.copyTexture cross-format golden (web mirror of the native
 * metal_backend format-copy path).
 *
 * Same format → raw copyTextureToTexture. Different formats → a render blit
 * that reads through the source format and writes through the destination
 * format, so values and channel order survive: BGRA8→RGBA8 must keep red red
 * (a byte copy swaps R/B — the native bug this path exists to prevent), and
 * float sources (rgba16float, unfilterable rgba32float) must quantize to the
 * expected 8-bit values.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('GPUHost.copyTexture cross-format', () => {
  jest.setTimeout(30000);

  it('converts values and channel order across formats; same-format stays exact', async () => {
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto(`${BASE}/gpu-test-runner.html`, { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const g = new GPUHost(device, 'rgba8unorm');

      // Format codes (gpu.h TextureFormat): 0 BGRA8, 1 RGBA8, 3 RGBA16F, 5 RGBA32F.
      async function copyCase(srcFmt, clear) {
        const src = g.createTexture(16, 16, srcFmt);
        const dst = g.createTexture(16, 16, 1);
        g.clearTexture(src, clear[0], clear[1], clear[2], clear[3]);
        g.clearTexture(dst, 0, 1, 0, 1);   // green — must be fully overwritten
        g.copyTexture(src, dst);
        g.flush();
        const px = await g.readbackTexture(dst, 16, 16);
        // Corner + center of the copied region.
        return [px[0], px[1], px[2], px[3],
                px[(8 * 16 + 8) * 4], px[(8 * 16 + 8) * 4 + 1],
                px[(8 * 16 + 8) * 4 + 2], px[(8 * 16 + 8) * 4 + 3]];
      }

      return {
        same:    await copyCase(1, [0.25, 0.5, 0.75, 1.0]),
        f16to8:  await copyCase(3, [0.25, 0.5, 0.75, 1.0]),
        f32to8:  await copyCase(5, [0.25, 0.5, 0.75, 1.0]),
        bgraRed: await copyCase(0, [1.0, 0.0, 0.0, 1.0]),
      };
    })()`) as Record<string, number[]>;

    const near = (px: number[], want: number[], tol: number) => {
      for (let i = 0; i < 8; i++) {
        expect(Math.abs(px[i] - want[i % 4])).toBeLessThanOrEqual(tol);
      }
    };
    // 0.25/0.5/0.75/1.0 → 64/128/191/255 (±2 for f16 quantization).
    near(result.same, [64, 128, 191, 255], 1);
    near(result.f16to8, [64, 128, 191, 255], 2);
    near(result.f32to8, [64, 128, 191, 255], 1);
    // THE channel-order golden: red cleared into BGRA8 reads back red, not blue.
    near(result.bgraRed, [255, 0, 0, 255], 0);
  });
});
