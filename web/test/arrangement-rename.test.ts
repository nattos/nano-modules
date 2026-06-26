/**
 * E2E for the shared <editable-label> as adopted in the arrangement: renaming a
 * track (grid header) and a clip (inspector header) by double-click → type →
 * Enter mutates the real store (and the commit is undoable).
 *
 *   ARR_BASE_URL=http://localhost:5174 npx jest arrangement-rename
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Double-click an <editable-label> (found via `find`), type `text`, press Enter.
 *  Runs as two page.evaluate steps so Lit can swap in the <input> between them. */
async function renameVia(findExpr: string, text: string) {
  await page.evaluate((find) => {
    const el = (window as any).__find(find) as any;
    if (!el) throw new Error('editable-label not found: ' + find);
    const span = el.shadowRoot.querySelector('.display') as HTMLElement;
    span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }, findExpr);
  await new Promise((r) => setTimeout(r, 60));
  await page.evaluate(
    ({ find, value }) => {
      const el = (window as any).__find(find) as any;
      // <editable-label> now hosts the IME-guarded <editable-text>, so the real
      // <input> lives in the nested element's shadow root (fallback to a direct
      // input for any provider variant that still renders one inline).
      const et = el.shadowRoot.querySelector('editable-text') as any;
      const input = (et?.shadowRoot?.querySelector('input') ??
        el.shadowRoot.querySelector('input')) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    },
    { find: findExpr, value: text },
  );
}

describe('Arrangement inline rename (editable-label)', () => {
  jest.setTimeout(60_000);

  it('renames a track and a clip via double-click editing', async () => {
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
    await page.waitForFunction(() => !!(window as any).arrangementStore, { timeout: 20_000 });

    // A cross-shadow locator the rename helper can call by name.
    await page.evaluate(() => {
      const app = document.querySelector('arrangement-app') as any;
      (window as any).__find = (which: string) => {
        if (which === 'track') {
          const grid = app.shadowRoot.querySelector('arr-grid');
          return grid?.shadowRoot?.querySelector('editable-label.tname') ?? null;
        }
        if (which === 'clip') {
          const insp = app.shadowRoot.querySelector('arr-inspector');
          // The clip header label lives in the .section-header.
          return insp?.shadowRoot?.querySelector('.section-header editable-label') ?? null;
        }
        return null;
      };
    });

    // ── Track rename ──
    const trackBefore = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const t = store.displayTracks.find((x: any) => x.kind === 'track');
      return { id: t.id, name: t.name };
    });

    await renameVia('track', 'Renamed Track');
    await page.waitForFunction(
      (id) => {
        const store = (window as any).arrangementStore;
        return store.composition.tracks.find((t: any) => t.id === id)?.name === 'Renamed Track';
      },
      { timeout: 5_000 },
      trackBefore.id,
    );

    // Undo restores the prior name (commit is a real, undoable mutation).
    const restored = await page.evaluate((before) => {
      const store = (window as any).arrangementStore;
      store.undo();
      return store.composition.tracks.find((t: any) => t.id === before.id)?.name;
    }, trackBefore);
    expect(restored).toBe(trackBefore.name);

    // ── Clip rename (via the inspector header) ──
    const clip = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 0, 8);
      store.select(path);
      const [, trackId, clipId] = path.split('/');
      return { trackId, clipId };
    });
    // let the inspector render the selected clip
    await page.waitForFunction(
      () => !!(window as any).__find('clip'),
      { timeout: 5_000 },
    );

    await renameVia('clip', 'Renamed Clip');
    await page.waitForFunction(
      ({ trackId, clipId }) => {
        const store = (window as any).arrangementStore;
        const c = store.composition.tracks
          .find((t: any) => t.id === trackId)
          ?.clips.find((x: any) => x.id === clipId);
        return c?.name === 'Renamed Clip';
      },
      { timeout: 5_000 },
      clip,
    );

    expect(errors).toEqual([]);
  });
});
