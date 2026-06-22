/**
 * E2E: the clip inspector's dashboard renders REAL widgets — <scalar-knob> for
 * rail-read inputs (bound to the target device field, reads/writes the store) and
 * <spark-chart> for rail-export outputs — replacing the faux SVG mockup.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-dashboard
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

const dash = () =>
  page.evaluate(() => {
    const app = document.querySelector('arrangement-app') as any;
    const insp = app?.shadowRoot?.querySelector('arr-inspector') as any;
    const root = insp?.shadowRoot;
    if (!root) return null;
    return {
      knobs: root.querySelectorAll('scalar-knob').length,
      sparks: root.querySelectorAll('spark-chart').length,
    };
  });

describe('Arrangement dashboard (real widgets)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('renders a real <scalar-knob> for a rail read; its binding reads/writes the store', async () => {
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

    // Select the (fake) clip that has rail reads.
    const sel = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      for (const t of store.composition.tracks) {
        for (const c of t.clips ?? []) {
          if ((c.reads?.length ?? 0) > 0) {
            store.select(`clip/${t.id}/${c.id}`);
            return { trackId: t.id, clipId: c.id, dev: c.reads[0].targetDeviceId, field: c.reads[0].targetField };
          }
        }
      }
      return null;
    });
    expect(sel).not.toBeNull();

    await page.waitForFunction(() => {
      const app = document.querySelector('arrangement-app') as any;
      return !!app?.shadowRoot?.querySelector('arr-inspector')?.shadowRoot?.querySelector('scalar-knob');
    }, { timeout: 10_000 });

    const counts = await dash();
    expect(counts!.knobs).toBeGreaterThan(0);

    // READ: a store edit flows into the knob's binding.
    await page.evaluate((s) => {
      (window as any).arrangementStore.setClipDeviceField(s.trackId, s.clipId, s.dev, s.field, 0.42);
    }, sel);
    const readBack = await page.evaluate((s) => {
      const app = document.querySelector('arrangement-app') as any;
      const knob = Array.from(
        app.shadowRoot.querySelector('arr-inspector').shadowRoot.querySelectorAll('scalar-knob'),
      ).find((k: any) => k.fieldPath === s.field) as any;
      return knob?.binding?.getValue(s.field);
    }, sel);
    expect(readBack).toBeCloseTo(0.42, 5);

    // WRITE: the knob's binding writes back to the store.
    const written = await page.evaluate((s) => {
      const app = document.querySelector('arrangement-app') as any;
      const knob = Array.from(
        app.shadowRoot.querySelector('arr-inspector').shadowRoot.querySelectorAll('scalar-knob'),
      ).find((k: any) => k.fieldPath === s.field) as any;
      knob.binding.setValue(s.field, -0.3);
      const dev = (window as any).arrangementStore
        .clipByPath(`clip/${s.trackId}/${s.clipId}`).clip.sketch.devices.find((d: any) => d.id === s.dev);
      return dev.state[s.field];
    }, sel);
    expect(written).toBeCloseTo(-0.3, 5);

    expect(errors).toEqual([]);
  });

  it('renders a real <spark-chart> for a rail export', async () => {
    const ok = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      for (const t of store.composition.tracks) {
        for (const c of t.clips ?? []) {
          if ((c.exports?.length ?? 0) > 0) {
            store.select(`clip/${t.id}/${c.id}`);
            return true;
          }
        }
      }
      return false;
    });
    expect(ok).toBe(true);

    await page.waitForFunction(() => {
      const app = document.querySelector('arrangement-app') as any;
      return !!app?.shadowRoot?.querySelector('arr-inspector')?.shadowRoot?.querySelector('spark-chart');
    }, { timeout: 10_000 });

    const counts = await dash();
    expect(counts!.sparks).toBeGreaterThan(0);
  });
});
