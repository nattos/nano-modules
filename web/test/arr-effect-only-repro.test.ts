/**
 * GPU reproduction for the "effect-only clip only renders the first activation"
 * bug. Drives the REAL ArrEngine composite path (arr-engine-testbed.html):
 *   1. show a brightness=1.0 chain as the composite → pure white
 *   2. tear the composite down (playhead leaves all clips)
 *   3. show the IDENTICAL composite again → must STILL be white (not identity →
 *      passthrough of the black source)
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arr-effect-only-repro
 */

const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arr-engine-testbed.html`;

const isWhite = (p: { r: number; g: number; b: number }) =>
  p.r > 200 && p.g > 200 && p.b > 200;

describe('effect-only clip re-activation (GPU)', () => {
  jest.setTimeout(60_000);

  it('a brightness=1.0 effect stays white after teardown + identical recreate', async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => (document.getElementById('status') as HTMLElement)?.textContent === 'ready',
      { timeout: 20_000 },
    );

    // Activation 1.
    await page.evaluate(() => (window as any).__arrEngine.showBrightness());
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });
    const p1 = await page.evaluate(() => (window as any).__arrEngine.readCenter());
    expect(isWhite(p1)).toBe(true);

    // Playhead leaves all clips → composite torn down.
    await page.evaluate(() => (window as any).__arrEngine.clearComposite());
    await new Promise((r) => setTimeout(r, 400));

    // Activation 2: identical composite re-shown.
    await page.evaluate(() => (window as any).__arrEngine.showBrightness());
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });
    const p2 = await page.evaluate(() => (window as any).__arrEngine.readCenter());
    expect(isWhite(p2)).toBe(true); // ← the bug: p2 comes back black (identity)
  });

  it('stays white across an UPDATE-path swap (composite re-issued, not deleted)', async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => (document.getElementById('status') as HTMLElement)?.textContent === 'ready',
      { timeout: 20_000 },
    );

    await page.evaluate(() => (window as any).__arrEngine.showBrightness());
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });
    expect(isWhite(await page.evaluate(() => (window as any).__arrEngine.readCenter()))).toBe(true);

    // Composite re-issued as a plain solid (playhead moved to another clip).
    await page.evaluate(() => (window as any).__arrEngine.showSolidOnly());
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });

    // Back to the brightness chain — must re-render white, not identity.
    await page.evaluate(() => (window as any).__arrEngine.showBrightness());
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });
    const p3 = await page.evaluate(() => (window as any).__arrEngine.readCenter());
    expect(isWhite(p3)).toBe(true);
  });

  it('bakes the composition background at the compositor level (buildCompositeSketch)', async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => (document.getElementById('status') as HTMLElement)?.textContent === 'ready',
      { timeout: 20_000 },
    );
    // A neutral (identity) effect over a custom green background → the output IS
    // the background, proving the solid base is baked into the composite.
    await page.evaluate(() => (window as any).__arrEngine.showBgProbe('#00cc44'));
    await page.waitForFunction(() => (window as any).__arrEngine.frames > 4, { timeout: 25_000 });
    const px = await page.evaluate(() => (window as any).__arrEngine.readCenter());
    expect(Math.abs(px.r - 0)).toBeLessThan(24);
    expect(Math.abs(px.g - 204)).toBeLessThan(28);
    expect(Math.abs(px.b - 68)).toBeLessThan(28);
  });
});
