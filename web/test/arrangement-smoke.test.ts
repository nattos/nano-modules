/**
 * Smoke test for arrangement.html (Milestone 1 mockup). Confirms the page
 * boots without runtime errors and the core surfaces mount, and that
 * double-clicking an empty lane creates a clip in the store.
 *
 * Point at a running dev server: ARR_BASE_URL=http://localhost:5175 npx jest arrangement-smoke
 */

const BASE = process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

describe('Arrangement mockup smoke', () => {
  jest.setTimeout(30_000);

  it('boots and mounts all surfaces without errors', async () => {
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
    await new Promise((r) => setTimeout(r, 400));

    // All top-level surfaces present in the shell's shadow DOM.
    const surfaces = await page.evaluate(() => {
      const app = document.querySelector('arrangement-app');
      const root = app?.shadowRoot;
      const has = (sel: string) => !!root?.querySelector(sel);
      return {
        transport: has('transport-bar'),
        ruler: has('arr-ruler'),
        grid: has('arr-grid'),
        inspector: has('arr-inspector'),
        monitor: has('arr-monitor'),
        tabbar: has('arr-tabbar'),
      };
    });
    expect(surfaces).toEqual({
      transport: true,
      ruler: true,
      grid: true,
      inspector: true,
      monitor: true,
      tabbar: true,
    });

    // The fake composition seeded clips.
    const clipCount = await page.evaluate(() => {
      const s = (window as any).arrangementStore;
      return s.composition.tracks.reduce(
        (n: number, t: any) => n + t.clips.length,
        0,
      );
    });
    expect(clipCount).toBeGreaterThan(0);

    // Programmatic create-clip via the store (double-click path it backs).
    const created = await page.evaluate(() => {
      const s = (window as any).arrangementStore;
      const track = s.composition.tracks.find((t: any) => t.kind === 'track');
      const before = track.clips.length;
      s.createEmptyClip(track.id, 40);
      return { before, after: track.clips.length, kind: track.clips.at(-1).kind };
    });
    expect(created.after).toBe(created.before + 1);
    expect(created.kind).toBe('effect');

    expect(errors).toEqual([]);
  });
});
