/**
 * Per-effect blend mode E2E (resolume shell, playground mode).
 *
 * The effect-card header gains a gear toggle right of the opacity slider; it
 * reveals an options row below the header with the `__blend__` selector (the
 * composite.blend mode vocabulary). Selecting a mode writes the reserved key
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

    // Find the SECOND effect card's gear button and click it.
    const gearClicked = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      const gears = [];
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('device-gear-btn')) gears.push(el);
      }
      if (gears.length < 2) return { ok: false, count: gears.length };
      gears[1].click();
      return { ok: true, count: gears.length };
    })()`) as { ok: boolean; count: number };
    expect(gearClicked.ok).toBe(true);
    await new Promise(r => setTimeout(r, 400));

    // The options row is revealed — pick Multiply (mode 2) in its field-select.
    const modeSet = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let select = null;
      for (const el of walk(document)) {
        if (el.tagName === 'FIELD-SELECT' && el.fieldPath === '__blend__') {
          select = el.shadowRoot?.querySelector('select') ?? null;
          if (select) break;
        }
      }
      if (!select) return false;
      select.value = '2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`) as boolean;
    expect(modeSet).toBe(true);
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
