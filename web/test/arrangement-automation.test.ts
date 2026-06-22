/**
 * E2E: the clip-view automation editor is the SHARED <envelope-graph>, editable.
 * Dragging a node writes the clip's automation lane in the store (one undo per
 * gesture), and dragging on a clip with no lane creates one (create-on-edit).
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-automation
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Bounding rect of the editor's canvas, traversing the nested shadow roots. */
const canvasRect = () =>
  page.evaluate(() => {
    const app = document.querySelector('arrangement-app') as any;
    const cv = app?.shadowRoot?.querySelector('arr-clip-view') as any;
    const ed = cv?.shadowRoot?.querySelector('arr-automation-editor') as any;
    const g = ed?.shadowRoot?.querySelector('envelope-graph') as any;
    const canvas = g?.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | undefined;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });

async function dragLeftNodeUp(rect: { x: number; y: number; w: number; h: number }) {
  // The left endpoint sits at canvas (pad=10, mid-height). Drag it upward
  // (screen y decreases) → its normalized y increases.
  const sx = rect.x + 10;
  const sy = rect.y + rect.h / 2;
  const ey = rect.y + rect.h * 0.18;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(sx, sy + ((ey - sy) * i) / 6);
  }
  await page.mouse.up();
}

describe('Arrangement clip-view automation editor', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('drags a node → writes the lane; one undo reverts the gesture', async () => {
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

    // Effect clip with a real device, a pre-created automation lane, selected,
    // clip-view open in automation mode.
    const laneId = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 0, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'color.hsl');
      store.select(path);
      const id = store.ensureClipAutomationLane(trackId, clipId);
      if (!store.clipViewOpen) store.toggleClipView();
      store.setClipViewMode('automation');
      return id as string;
    });

    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const g = app?.shadowRoot
          ?.querySelector('arr-clip-view')
          ?.shadowRoot?.querySelector('arr-automation-editor')
          ?.shadowRoot?.querySelector('envelope-graph') as any;
        return !!g?.shadowRoot?.querySelector('canvas');
      },
      { timeout: 10_000 },
    );

    const yBefore = await page.evaluate(
      (id) => (window as any).arrangementStore.automationLane(id).points[0].y,
      laneId,
    );
    expect(yBefore).toBeCloseTo(0.5, 2); // seeded flat curve

    const rect = await canvasRect();
    expect(rect).not.toBeNull();
    await dragLeftNodeUp(rect!);

    const yAfter = await page.evaluate(
      (id) => (window as any).arrangementStore.automationLane(id).points[0].y,
      laneId,
    );
    expect(yAfter).toBeGreaterThan(yBefore + 0.15); // dragged the node up

    // The whole drag coalesced into ONE undo.
    const yUndone = await page.evaluate((id) => {
      const store = (window as any).arrangementStore;
      store.undo();
      return store.automationLane(id).points[0].y;
    }, laneId);
    expect(yUndone).toBeCloseTo(yBefore, 2);

    expect(errors).toEqual([]);
  });

  it('dragging on a clip with no lane creates one (create-on-edit)', async () => {
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 16, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'color.hsl');
      store.select(path);
      if (!store.clipViewOpen) store.toggleClipView();
      store.setClipViewMode('automation');
      return { trackId, clipId };
    });

    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const g = app?.shadowRoot
          ?.querySelector('arr-clip-view')
          ?.shadowRoot?.querySelector('arr-automation-editor')
          ?.shadowRoot?.querySelector('envelope-graph') as any;
        return !!g?.shadowRoot?.querySelector('canvas');
      },
      { timeout: 10_000 },
    );

    // No lane yet.
    const hadLane = await page.evaluate(
      (d) => (window as any).arrangementStore.clipByPath(`clip/${d.trackId}/${d.clipId}`).clip.automation.length,
      ids,
    );
    expect(hadLane).toBe(0);

    const rect = await canvasRect();
    await dragLeftNodeUp(rect!);

    const after = await page.evaluate(
      (d) => {
        const lanes = (window as any).arrangementStore.clipByPath(`clip/${d.trackId}/${d.clipId}`).clip.automation;
        return { count: lanes.length, y: lanes[0]?.points[0]?.y ?? null };
      },
      ids,
    );
    expect(after.count).toBe(1);
    expect(after.y).toBeGreaterThan(0.6);
  });
});
