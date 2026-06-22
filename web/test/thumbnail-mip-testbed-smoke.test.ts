/**
 * Smoke test for thumbnail-mip-testbed.html — the tiered, zoom-aware,
 * persistent thumbnail cache end-to-end with real ImageBitmaps. Proves:
 *  - a window view prefetches + draws exact tiles at the chosen mip level,
 *  - a cold restart (drop memory, keep mocked disk) refills WITHOUT re-decoding,
 *  - drawn thumbnails are real (non-placeholder pixels).
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5174 npx jest thumbnail-mip-testbed
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/thumbnail-mip-testbed.html`;

describe('Thumbnail mip / persistence testbed smoke', () => {
  jest.setTimeout(30_000);

  it('prefetches a mip level, draws real tiles, and survives a cold restart without re-decoding', async () => {
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

    // Prefetch the current view; wait until the whole visible strip is resident.
    await page.evaluate(() => (window as any).__thumbMip.prewarm());
    await page.waitForFunction(
      () => {
        const t = (window as any).__thumbMip;
        return t.stats().memory.size >= t.visibleTileCount();
      },
      { timeout: 15_000 },
    );

    // Let the fire-and-forget persistence writes flush.
    await new Promise((r) => setTimeout(r, 150));
    const warm = await page.evaluate(() => {
      const t = (window as any).__thumbMip;
      t.redraw();
      return { drawnExact: t.drawnExact, stats: t.stats(), tiles: t.visibleTileCount(), px: t.pixelAt(20, 20) };
    });
    expect(warm.drawnExact).toBe(warm.tiles); // every visible slot is an exact tile
    expect(warm.stats.decodes).toBeGreaterThanOrEqual(warm.tiles); // visible + read-ahead
    expect(warm.stats.writes).toBe(warm.stats.decodes); // every decode persisted
    // A real decoded tile, not the #22252e placeholder (34,37,46).
    const isPlaceholder =
      Math.abs(warm.px.r - 34) < 6 && Math.abs(warm.px.g - 37) < 6 && Math.abs(warm.px.b - 46) < 6;
    expect(isPlaceholder).toBe(false);

    // Cold restart: drop the hot tier, keep the (mocked) disk. Refill must not decode again.
    await page.evaluate(() => (window as any).__thumbMip.coldStart());
    await page.waitForFunction(
      () => {
        const t = (window as any).__thumbMip;
        return t.stats().memory.size >= t.visibleTileCount();
      },
      { timeout: 15_000 },
    );

    const cold = await page.evaluate(() => {
      const t = (window as any).__thumbMip;
      t.redraw();
      return { drawnExact: t.drawnExact, stats: t.stats(), tiles: t.visibleTileCount() };
    });
    expect(cold.drawnExact).toBe(cold.tiles); // strip fully redrawn from disk
    expect(cold.stats.decodes).toBe(warm.stats.decodes); // NO new decodes
    expect(cold.stats.reads).toBeGreaterThan(warm.stats.reads); // came from the disk tier

    expect(errors).toEqual([]);
  });
});
