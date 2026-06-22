/**
 * e2e: effect editors are COMPLETE — the inspector renders the real engine schema
 * (color / bool / enum / vec), not just the catalog's float synthesis. Selecting a
 * `source.solid_color` clip (whose only input is an RGB color) must surface a real
 * color editor; before the runtime-schema wiring its inspector was empty.
 *
 *   GPU_TEST_BASE_URL=http://localhost:5174 npx jest arrangement-editors
 */

const BASE = process.env.GPU_TEST_BASE_URL || process.env.ARR_BASE_URL || 'http://localhost:5173';
const URL = `${BASE}/arrangement.html`;

/** Recursively search this element + all shadow roots for a tag. */
const deepHasTag = (tag: string) =>
  page.evaluate((t) => {
    const found = (root: Document | ShadowRoot | Element): boolean => {
      if ((root as Element).shadowRoot && find((root as Element).shadowRoot!)) return true;
      return find(root as ShadowRoot);
    };
    const find = (root: Document | ShadowRoot): boolean => {
      if (root.querySelector(t)) return true;
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if ((el as any).shadowRoot && find((el as any).shadowRoot)) return true;
      }
      return false;
    };
    return found(document);
  }, tag);

describe('Arrangement effect editors (real schema)', () => {
  jest.setTimeout(60_000);

  beforeAll(async () => {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => !!(window as any).arrangementStore && !!customElements.get('arrangement-app'),
      { timeout: 20_000 },
    );
  });

  it('surfaces the real schema (color editor) for solid_color', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.on('pageerror', (err) => errors.push(String(err)));

    // A clip whose sole device is the RGB-only solid_color generator.
    const ids = await page.evaluate(() => {
      const store = (window as any).arrangementStore;
      const track = store.composition.tracks.find((t: any) => t.kind === 'track');
      const path = store.createEmptyClip(track.id, 40, 8);
      const [, trackId, clipId] = path.split('/');
      store.addClipDeviceType(trackId, clipId, 'source.solid_color');
      const deviceId = store.clipByPath(path).clip.sketch.devices[0].id;
      store.select(path);
      store.positionBeat = 40;
      return { trackId, clipId, deviceId };
    });

    // The engine warms the bundle and broadcasts the real schema into the store.
    await page.waitForFunction(
      () => {
        const s = (window as any).arrangementStore;
        const p = s.enginePlugin && s.enginePlugin('source.solid_color');
        return !!(p && p.schema && p.schema.color);
      },
      { timeout: 30_000 },
    );

    // The real schema carries an RGB `color` field (float3, hint=color).
    const colorField = await page.evaluate(() => {
      const s = (window as any).arrangementStore;
      const d = s.enginePlugin('source.solid_color').schema.color;
      return { type: d.type, hint: d.hint };
    });
    expect(colorField.type).toBe('float3');
    expect(colorField.hint).toBe('color');

    // …and the inspector actually renders a color editor (not an empty card).
    await page.waitForFunction(
      () => {
        const find = (root: Document | ShadowRoot): boolean => {
          if (root.querySelector('field-color')) return true;
          for (const el of Array.from(root.querySelectorAll('*'))) {
            const sr = (el as any).shadowRoot;
            if (sr && find(sr)) return true;
          }
          return false;
        };
        return find(document);
      },
      { timeout: 10_000 },
    );
    expect(await deepHasTag('field-color')).toBe(true);

    // Editing the rgb color writes an array into device state; it must cross the
    // worker postMessage boundary without a DataCloneError (the sketch is
    // sanitized of MobX proxies before send).
    await page.evaluate((d) => {
      const s = (window as any).arrangementStore;
      for (const rgb of [[1, 0, 0], [0, 0.6, 0.9], [0.2, 0.8, 0.3]]) {
        s.setClipDeviceField(d.trackId, d.clipId, d.deviceId, 'color', rgb);
      }
    }, ids);
    await page.waitForFunction(() => (window as any).__engineBridge?.framesSeen > 6, { timeout: 15_000 });
    expect(errors.filter((e) => /DataClone|could not be cloned/.test(e))).toEqual([]);
  });
});
