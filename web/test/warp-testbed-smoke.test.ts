/**
 * Smoke test for warp-testbed.html (Component E — offline beat warp).
 * Drives window.__warp: identity grid is evenly spaced, the warped grid clumps
 * (spacing variance jumps), and the beat⇄seconds clock round-trips.
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5174 npx jest warp-testbed
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/warp-testbed.html`;

describe('Beat warp testbed smoke', () => {
  jest.setTimeout(30_000);

  it('warps the grid and keeps a consistent beat⇄seconds clock', async () => {
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
    await new Promise((r) => setTimeout(r, 150));

    const res = await page.evaluate(() => {
      const w = (window as any).__warp;
      w.setWarp(false);
      const flat = w.spacingVariance();
      w.setWarp(true);
      const warped = w.spacingVariance();
      return {
        flat,
        warped,
        rt7: w.roundtrip(7),
        rt19: w.roundtrip(19),
        // warped duration ≈ identity duration (32 beats × 0.5s) — warp averages out
        dur: w.secondsAt(32),
      };
    });

    // Identity grid: integer beats evenly spaced (variance ≈ 0).
    expect(res.flat).toBeLessThan(0.5);
    // Warp clumps/spreads the lines → spacing variance is clearly non-zero.
    expect(res.warped).toBeGreaterThan(5);
    // Seek clock round-trips through seconds.
    expect(res.rt7).toBeCloseTo(7, 1);
    expect(res.rt19).toBeCloseTo(19, 1);
    // Overall duration preserved (~16s for 32 beats @ 120bpm).
    expect(res.dur).toBeGreaterThan(15);
    expect(res.dur).toBeLessThan(17);

    expect(errors).toEqual([]);
  });
});
