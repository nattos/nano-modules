/**
 * Smoke test for opfs-thumb-testbed.html — the real persistence substrate:
 * thumbnail worker + OPFS pack files + WebP. Proves write→flush→reopen→read
 * round-trips through actual OPFS (tiles return from disk after the worker drops
 * its in-memory state), and a page reload (true cold start) still finds them.
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5174 npx jest opfs-thumb-testbed
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/opfs-thumb-testbed.html`;

describe('OPFS thumbnail store testbed smoke', () => {
  jest.setTimeout(45_000);

  it('persists tiles to OPFS and reads them back after reopen + reload', async () => {
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

    // Clean slate, then write the strip to OPFS and flush.
    const wrote = await page.evaluate(async () => {
      const t = (window as any).__opfsThumb;
      await t.clear();
      await t.writeStrip();
      return t.stats();
    });
    expect(wrote.bytes).toBeGreaterThan(0); // real WebP bytes landed in OPFS packs

    // Reopen: worker drops in-memory indexes + handles, re-reads from disk.
    const afterReopen = await page.evaluate(async () => {
      const t = (window as any).__opfsThumb;
      await t.reopen();
      const has = await t.has(8);
      await t.readStrip();
      return { has, drawn: t.drawn, total: t.frames.length, px: t.pixelAt(20, 20) };
    });
    expect(afterReopen.has).toBe(true);
    expect(afterReopen.drawn).toBe(afterReopen.total); // whole strip back from OPFS
    const isBlank =
      Math.abs(afterReopen.px.r - 34) < 6 && Math.abs(afterReopen.px.g - 37) < 6 && Math.abs(afterReopen.px.b - 46) < 6;
    expect(isBlank).toBe(false); // a real decoded WebP tile, not the placeholder

    // True cold start: reload the page (new worker), tiles must persist in OPFS.
    await page.reload({ waitUntil: 'networkidle0' });
    const afterReload = await page.evaluate(async () => {
      const t = (window as any).__opfsThumb;
      await t.readStrip();
      const result = { drawn: t.drawn, total: t.frames.length };
      await t.clear(); // cleanup so reruns start fresh
      return result;
    });
    expect(afterReload.drawn).toBe(afterReload.total);

    expect(errors).toEqual([]);
  });
});
