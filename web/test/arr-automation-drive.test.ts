/**
 * GPU proof that parameter AUTOMATION drives a real device param through the
 * executor side-channel (Phase B). Drives the ArrEngine composite path
 * (arr-engine-testbed.html): a brightness_contrast clip over a green background,
 * then pushes a brightness automation value via engine.setAutomation — the
 * executor folds the normalized value into the field's [-1,1] range and the
 * output luminance tracks it (high → bright, low → dark).
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arr-automation-drive
 */

const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arr-engine-testbed.html`;

const lum = (p: { r: number; g: number; b: number }) => 0.299 * p.r + 0.587 * p.g + 0.114 * p.b;

async function waitFrames() {
  const f0 = await page.evaluate(() => (window as any).__arrEngine.frames);
  await page.waitForFunction((f: number) => (window as any).__arrEngine.frames > f + 2, { timeout: 5000 }, f0);
}

describe('parameter automation drives a param (GPU)', () => {
  jest.setTimeout(60_000);

  it('a brightness automation value changes the output luminance', async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => (document.getElementById('status') as HTMLElement)?.textContent === 'ready',
      { timeout: 20_000 },
    );

    // A brightness_contrast clip over a green background (brightness state 0).
    await page.evaluate(() => (window as any).__arrEngine.showBgProbe('#00cc44'));
    await waitFrames();

    // Automation HIGH → brightness +1 → toward white.
    await page.evaluate(() => (window as any).__arrEngine.setAuto('brightness', 1.0));
    await waitFrames();
    const bright = await page.evaluate(() => (window as any).__arrEngine.readCenter());

    // Automation LOW → brightness -1 → toward black.
    await page.evaluate(() => (window as any).__arrEngine.setAuto('brightness', 0.0));
    await waitFrames();
    const dark = await page.evaluate(() => (window as any).__arrEngine.readCenter());

    // The same static composite, only the automation value changed → the executor
    // applied it (no sketch re-issue).
    expect(lum(bright)).toBeGreaterThan(lum(dark) + 40);
  });
});
