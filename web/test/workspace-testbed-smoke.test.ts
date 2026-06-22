/**
 * Smoke test for workspace-testbed.html (Component A — workspace persistence).
 * Boots clean, then drives the OPFS backend through window.__workspace to prove
 * the full create / list / read / write / delete round-trip + serialization.
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5174 npx jest workspace-testbed
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/workspace-testbed.html`;

describe('Workspace testbed smoke', () => {
  jest.setTimeout(30_000);

  it('boots and round-trips an arrangement via the OPFS backend', async () => {
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
    await new Promise((r) => setTimeout(r, 300));

    const hasHook = await page.evaluate(() => !!(window as any).__workspace);
    expect(hasHook).toBe(true);

    const result = await page.evaluate(async () => {
      const w = (window as any).__workspace;
      await w.useOpfs('smoke-test-ws');
      // Clean slate (previous runs may have left files).
      for (const e of await w.list()) await w.remove(e.name);

      const comp = w.emptyComposition();
      comp.meta.baseBPM = 137;
      comp.meta.resolution = { width: 1280, height: 720 };
      await w.create('roundtrip', comp);

      const listed = (await w.list()).map((e: any) => e.name);
      const read = await w.read('roundtrip');
      const createdBpm = read.meta.baseBPM;
      const createdWidth = read.meta.resolution.width;

      // Overwrite + re-read to exercise write().
      read.meta.baseBPM = 90;
      await w.write('roundtrip', read);
      const reread = await w.read('roundtrip');

      await w.remove('roundtrip');
      const after = (await w.list()).map((e: any) => e.name);

      return {
        listed,
        bpm: createdBpm,
        width: createdWidth,
        rewriteBpm: reread.meta.baseBPM,
        after,
      };
    });

    expect(result.listed).toContain('roundtrip');
    expect(result.bpm).toBe(137);
    expect(result.width).toBe(1280);
    expect(result.rewriteBpm).toBe(90);
    expect(result.after).not.toContain('roundtrip');

    expect(errors).toEqual([]);
  });
});
