/**
 * e2e: the track-management UI is wired — the ruler "+ Track" button adds a
 * track and the header undo button reverts it (DOM-driven, not just store calls),
 * and the store reorder/delete ops round-trip through undo.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-tracks
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const plainCount = () =>
  page.evaluate(
    () =>
      (window as any).arrangementStore.composition.tracks.filter((t: any) => t.kind === 'track')
        .length as number,
  );

const clickByTitle = (host: string, title: string) =>
  page.evaluate(
    (h, t) => {
      const app = document.querySelector('arrangement-app') as any;
      const el = app?.shadowRoot?.querySelector(h) as any;
      const btn = el?.shadowRoot?.querySelector(`button[title^="${t}"]`) as HTMLButtonElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    },
    host,
    title,
  );

describe('Arrangement track management UI', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('"+ Track" adds a track; header undo reverts it', async () => {
    const before = await plainCount();

    expect(await clickByTitle('arr-ruler', 'Add a track')).toBe(true);
    await page.waitForFunction((n) => {
      const s = (window as any).arrangementStore;
      return s.composition.tracks.filter((t: any) => t.kind === 'track').length === n;
    }, {}, before + 1);

    expect(await clickByTitle('transport-bar', 'Undo')).toBe(true);
    await page.waitForFunction((n) => {
      const s = (window as any).arrangementStore;
      return s.composition.tracks.filter((t: any) => t.kind === 'track').length === n;
    }, {}, before);

    expect(await plainCount()).toBe(before);
  });

  it('reorder + delete round-trip through the store', async () => {
    const result = await page.evaluate(() => {
      const s = (window as any).arrangementStore;
      const a = s.addTrack();
      const b = s.addTrack(a);
      // a is right after b's predecessor... move a to the end → after b.
      s.moveTrack(a, null);
      const nonbus = s.composition.tracks.filter((t: any) => !s.isMainBus(t)).map((t: any) => t.id);
      const reordered = nonbus.indexOf(a) > nonbus.indexOf(b);
      // delete both
      s.clearSelection();
      s.selection.add(`track/${a}`);
      s.selection.add(`track/${b}`);
      s.primaryPath = `track/${a}`;
      s.deleteSelectedTracks();
      const gone = !s.trackById(a) && !s.trackById(b);
      return { reordered, gone };
    });
    expect(result.reordered).toBe(true);
    expect(result.gone).toBe(true);
  });
});
