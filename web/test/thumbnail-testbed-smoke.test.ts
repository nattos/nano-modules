/**
 * Smoke test for thumbnail-testbed.html (Component D — film-strip thumbnail cache).
 * Drives the real ThumbnailCache (procedural producer) through window.__thumbs:
 * async fills land, thumbnails draw (non-placeholder pixels), and re-reads hit.
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5174 npx jest thumbnail-testbed
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/thumbnail-testbed.html`;

describe('Thumbnail cache testbed smoke', () => {
  jest.setTimeout(30_000);

  it('fills the strip asynchronously, draws thumbnails, and serves hits', async () => {
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
    await new Promise((r) => setTimeout(r, 200));

    const hasHook = await page.evaluate(() => !!(window as any).__thumbs);
    expect(hasHook).toBe(true);

    // get() on a miss lazily schedules the fill, so drawing the strip
    // self-populates it; requestStrip() prewarms the same set explicitly.
    await page.evaluate(() => (window as any).__thumbs.requestStrip());
    await page.waitForFunction(
      () => (window as any).__thumbs.stats().size >= (window as any).__thumbs.slots,
      { timeout: 15_000 },
    );

    const after = await page.evaluate(() => {
      const t = (window as any).__thumbs;
      t.redraw();
      return { drawn: t.drawn, stats: t.stats(), px: t.pixelAt(0) };
    });
    expect(after.drawn).toBe(after.stats.capacity); // all 16 slots drawn
    // Slot 0 is a decoded film cell, not the #22252e placeholder (34,37,46).
    const isPlaceholder =
      Math.abs(after.px.r - 34) < 6 && Math.abs(after.px.g - 37) < 6 && Math.abs(after.px.b - 46) < 6;
    expect(isPlaceholder).toBe(false);

    // A second redraw reads from cache → hit count climbs, no new misses.
    const before = after.stats.hits;
    const second = await page.evaluate(() => {
      const t = (window as any).__thumbs;
      t.redraw();
      return t.stats();
    });
    expect(second.hits).toBeGreaterThan(before);
    expect(second.inflight).toBe(0);

    expect(errors).toEqual([]);
  });
});
