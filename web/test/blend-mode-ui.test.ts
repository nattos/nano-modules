/**
 * Per-effect blend mode E2E (resolume shell, playground mode).
 *
 * The effect-card header gains a gear toggle right of the opacity slider; it
 * reveals an options row below the header with the `__blend__` tab bar (the
 * composite.blend mode vocabulary) and the `__xfade_shape__` crossfade-shape
 * curve widget. Selecting a mode writes the reserved key
 * into instance state, and the executor routes the stage through the wet/dry
 * blend's mode math — asserted here by pixels: a red generator followed by a
 * blue generator at Multiply must go BLACK (red × blue), while Normal shows
 * pure blue.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('per-effect blend mode (gear options row)', () => {
  jest.setTimeout(60000);

  it('gear reveals the blend selector; Multiply multiplies the chain', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('setup', d => {
        d.sketches['sk_blend'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'source.solid_color', instance_key: 'red@0' },
            { type: 'module', module_type: 'source.solid_color', instance_key: 'blue@0' },
          ],
          instances: {
            'red@0':  { module_type: 'source.solid_color', state: { color: [1, 0, 0] } },
            'blue@0': { module_type: 'source.solid_color', state: { color: [0, 0, 1] } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_blend');
    })()`);
    await new Promise(r => setTimeout(r, 2500));

    const monitorRGB = async () => page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let monitor = null;
      for (const el of walk(document)) { if (el.tagName === 'SKETCH-MONITOR') { monitor = el; break; } }
      let canvas = null;
      if (monitor?.shadowRoot) {
        for (const el of walk(monitor.shadowRoot)) { if (el.tagName === 'CANVAS') { canvas = el; break; } }
      }
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
      return { r: r / n, g: g / n, b: b / n };
    })()`) as Promise<{ r: number; g: number; b: number } | null>;

    // Baseline: Normal — final output is pure blue.
    const normal = await monitorRGB();
    expect(normal).not.toBeNull();
    expect(normal!.b).toBeGreaterThan(200);
    expect(normal!.r).toBeLessThan(30);

    // Find the SECOND effect card's (chain idx 1 = blue@0) gear button and
    // click it. Match through the owning .effect-card — a bare index over all
    // device-gear-btn elements would also count the column-level gear.
    const gearClicked = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let gear = null;
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('device-gear-btn')
            && el.closest('.effect-card')?.dataset?.chainIdx === '1') { gear = el; break; }
      }
      if (!gear) return { ok: false };
      gear.click();
      return { ok: true };
    })()`) as { ok: boolean };
    expect(gearClicked.ok).toBe(true);
    await new Promise(r => setTimeout(r, 400));

    // The options row is revealed — it holds the `__blend__` tab bar and the
    // `__xfade_shape__` crossfade-shape curve. Pick Multiply (mode 2) by
    // clicking its tab segment.
    const modeSet = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let bar = null, curve = null;
      for (const el of walk(document)) {
        if (el.tagName === 'FIELD-TAB-BAR' && el.fieldPath === '__blend__') bar = el;
        if (el.tagName === 'XFADE-CURVE' && el.fieldPath === '__xfade_shape__') curve = el;
      }
      if (!bar || !curve) return { ok: false, bar: !!bar, curve: !!curve };
      const btn = [...bar.shadowRoot.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Multiply');
      if (!btn) return { ok: false, bar: true, curve: true };
      btn.click();
      return { ok: true, bar: true, curve: true };
    })()`) as { ok: boolean; bar: boolean; curve: boolean };
    expect(modeSet).toEqual({ ok: true, bar: true, curve: true });
    await new Promise(r => setTimeout(r, 1500));

    // The reserved key landed in instance state...
    const stored = await page.evaluate(
      `window.appState.database.sketches['sk_blend']?.instances?.['blue@0']?.state?.__blend__`);
    expect(stored).toBe(2);

    // ...and the pixels multiplied: red × blue = black.
    const mul = await monitorRGB();
    expect(mul).not.toBeNull();
    expect(mul!.r).toBeLessThan(20);
    expect(mul!.g).toBeLessThan(20);
    expect(mul!.b).toBeLessThan(20);
  });
});
