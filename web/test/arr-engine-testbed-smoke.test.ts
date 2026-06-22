/**
 * GPU smoke test for arr-engine-testbed.html (Component C — engine vertical slice).
 * Boots ArrEngine (real engine worker), renders a real clip sketch through
 * executor.wasm, and asserts real pixels in the arrangement monitor:
 *   - gpu_test → solid blue (0,128,255)
 *   - spinningtris → non-trivial, animated (frames advance)
 *
 * Needs a dev server with WebGPU (the jest-puppeteer config enables it):
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arr-engine-testbed
 */

const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arr-engine-testbed.html`;

describe('Arrangement engine slice (GPU)', () => {
  jest.setTimeout(60_000);

  it('renders a real clip sketch (gpu_test → blue) into the monitor', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (t.includes('Failed to load resource')) return;
      errors.push(`[console] ${t}`);
    });

    await page.goto(URL, { waitUntil: 'networkidle0' });
    // Wait for the worker to boot (WebGPU + executor).
    await page.waitForFunction(
      () => (document.getElementById('status') as HTMLElement)?.textContent === 'ready',
      { timeout: 20_000 },
    );

    // Render the deterministic blue sketch and wait for a few real frames.
    await page.evaluate(async () => {
      await (window as any).__arrEngine.showGpuTest();
    });
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });

    const px = await page.evaluate(() => (window as any).__arrEngine.readCenter());
    // gpu_test fills (0, 128, 255).
    expect(Math.abs(px.r - 0)).toBeLessThan(24);
    expect(Math.abs(px.g - 128)).toBeLessThan(28);
    expect(Math.abs(px.b - 255)).toBeLessThan(24);

    expect(errors).toEqual([]);
  });

  it('switches to a different real sketch (spinningtris is not the blue scene)', async () => {
    await page.evaluate(async () => {
      await (window as any).__arrEngine.showSpinningTris();
    });
    // Poll the actual content: wait until the monitor stops showing gpu_test's
    // solid blue, proving the sketch switch landed (not just that frames advance).
    await page.waitForFunction(
      () => {
        const w = (window as any).__arrEngine;
        const p = w.readCenter();
        const isBlue = Math.abs(p.r - 0) < 24 && Math.abs(p.g - 128) < 28 && Math.abs(p.b - 255) < 24;
        return w.frames > 4 && !isBlue;
      },
      { timeout: 25_000 },
    );
    const px = await page.evaluate(() => (window as any).__arrEngine.readCenter());
    const isBlue = Math.abs(px.r - 0) < 24 && Math.abs(px.g - 128) < 28 && Math.abs(px.b - 255) < 24;
    expect(isBlue).toBe(false);
  });
});
