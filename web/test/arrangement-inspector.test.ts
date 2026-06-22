/**
 * E2E for the real clip inspector: the arrangement mounts the SHARED
 * <column-group> (not the retired <arr-chain>) via ArrColumnAdapter. It must
 * render real catalog param sliders and its FieldBinding must read/write the
 * store both ways.
 *
 *   ARR_BASE_URL=http://localhost:5174 npx jest arrangement-inspector
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Read the hue_shift scalar-slider inside the inspector's column-group. */
const probeSlider = () =>
  page.evaluate(() => {
    const app = document.querySelector('arrangement-app') as any;
    const insp = app?.shadowRoot?.querySelector('arr-inspector') as any;
    const cg = insp?.shadowRoot?.querySelector('column-group') as any;
    if (!cg) return { mounted: false };
    const sliders = Array.from(cg.shadowRoot.querySelectorAll('scalar-slider')) as any[];
    const hue = sliders.find((s) => s.fieldPath === 'hue_shift');
    return {
      mounted: true,
      paths: sliders.map((s) => s.fieldPath),
      hue: hue
        ? { label: hue.label, value: hue.binding?.getValue('hue_shift') }
        : null,
    };
  });

describe('Arrangement real clip inspector (column-group)', () => {
  jest.setTimeout(60_000);

  it('renders catalog param sliders and the binding reads/writes the store', async () => {
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

    // Effect clip with a real HSL device, selected → inspector shows its chain.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 0, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'color.hsl');
      store.select(path);
      const dev = store.clipByPath(path).clip.sketch.devices[0];
      return { trackId, clipId, deviceId: dev.id };
    });

    // The shared column-group mounts and renders the real catalog params.
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const cg = app?.shadowRoot?.querySelector('arr-inspector')?.shadowRoot?.querySelector('column-group') as any;
        return !!cg?.shadowRoot?.querySelector('scalar-slider');
      },
      { timeout: 10_000 },
    );

    const probed = await probeSlider();
    expect(probed.mounted).toBe(true);
    // color.hsl exposes hue_shift / saturation / lightness as real params.
    expect(probed.paths).toEqual(expect.arrayContaining(['hue_shift', 'saturation', 'lightness']));
    expect(probed.hue).not.toBeNull();
    expect(probed.hue!.label).toBe('Hue'); // catalog label, not the raw key

    // READ path: a store edit flows into the slider's binding.
    await page.evaluate((d) => {
      (window as any).arrangementStore.setClipDeviceField(d.trackId, d.clipId, d.deviceId, 'hue_shift', 0.3);
    }, ids);
    await page.waitForFunction(
      () => {
        const app = document.querySelector('arrangement-app') as any;
        const cg = app?.shadowRoot?.querySelector('arr-inspector')?.shadowRoot?.querySelector('column-group') as any;
        const hue = Array.from(cg.shadowRoot.querySelectorAll('scalar-slider')).find((s: any) => s.fieldPath === 'hue_shift') as any;
        return hue?.binding?.getValue('hue_shift') === 0.3;
      },
      { timeout: 5_000 },
    );

    // WRITE path: setValue through the binding mutates the store.
    const written = await page.evaluate((d) => {
      const app = document.querySelector('arrangement-app') as any;
      const cg = app?.shadowRoot?.querySelector('arr-inspector')?.shadowRoot?.querySelector('column-group') as any;
      const hue = Array.from(cg.shadowRoot.querySelectorAll('scalar-slider')).find((s: any) => s.fieldPath === 'hue_shift') as any;
      hue.binding.setValue('hue_shift', -0.4);
      const dev = (window as any).arrangementStore.clipByPath(`clip/${d.trackId}/${d.clipId}`).clip.sketch.devices[0];
      return dev.state.hue_shift;
    }, ids);
    expect(written).toBeCloseTo(-0.4, 5);

    expect(errors).toEqual([]);
  });
});
