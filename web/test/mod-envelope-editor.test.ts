/**
 * Custom-inspector E2E for mod.shaper.envelope (resolume shell, local mode).
 *
 * Verifies the registered envelope inspector mounts on the effect card, the
 * graph draws the curve, and the headline interactions actually edit the `curve`
 * field: double-clicking the curve ADDS a node, and dragging a segment BENDS its
 * exponential easing.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('mod.shaper.envelope custom inspector', () => {
  jest.setTimeout(60000);

  const openEnvelope = async (sketchId: string) => {
    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['${sketchId}'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'mod.shaper.envelope', instance_key: 'env@0' }],
          wires: [],
          instances: { 'env@0': { module_type: 'mod.shaper.envelope', state: {} } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('${sketchId}');
    })()`);
    await new Promise(r => setTimeout(r, 2000));   // mount + rAF draw
  };

  // Locate the envelope-graph canvas geometry + how much was painted, and read
  // the current `curve` string off the inspector's binding.
  const probe = () => page.evaluate(`(() => {
    ${WALK}
    let graph = null, inspector = null;
    for (const el of walk(document)) {
      if (el.tagName === 'ENVELOPE-GRAPH') graph = el;
      if (el.tagName === 'ENVELOPE-INSPECTOR') inspector = el;
    }
    if (!graph || !inspector) return { found: false };
    const canvas = graph.shadowRoot.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    let drawn = 0;
    if (canvas.width > 0) {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) drawn++;
    }
    const curve = inspector.binding ? inspector.binding.getValue('curve') : null;
    return { found: true, drawn, canvasW: canvas.width,
             curve, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  })()`) as any;

  // Parse a committed curve string → array of numbers (null if not a string yet:
  // the schema default isn't surfaced through getValue for string fields, so the
  // field reads as 0/default until the first edit writes the serialized curve).
  const nums = (curve: any): number[] | null => {
    try { const a = JSON.parse(curve); return Array.isArray(a) ? a : null; } catch { return null; }
  };

  it('renders the curve and double-click adds a node', async () => {
    await openEnvelope('sk_env_add');
    const before = await probe();
    expect(before.found).toBe(true);
    expect(before.canvasW).toBeGreaterThan(0);
    expect(before.drawn).toBeGreaterThan(50);          // the curve/fill/grid is painted (identity)

    // Double-click near the middle of the curve → add a node. (Starts from the
    // default identity = 2 nodes, so the committed curve should now have 3.)
    const mx = before.rect.x + before.rect.w * 0.5;
    const my = before.rect.y + before.rect.h * 0.5;
    await page.mouse.click(mx, my, { clickCount: 2 });
    await new Promise(r => setTimeout(r, 400));

    const after = await probe();
    const a = nums(after.curve);
    expect(a).toBeTruthy();
    expect(a!.length / 3).toBe(3);                     // a node was inserted (2 → 3)
  });

  it('drag on a segment bends its exponential easing', async () => {
    await openEnvelope('sk_env_bend');
    const before = await probe();
    expect(before.found).toBe(true);

    // Drag vertically on the segment around x≈0.3 (away from the endpoint nodes).
    const sx = before.rect.x + before.rect.w * 0.3;
    const sy = before.rect.y + before.rect.h * 0.5;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx, sy - 35, { steps: 6 });   // drag up → bulge up (ease > 0)
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 400));

    const after = await probe();
    const a = nums(after.curve);
    expect(a).toBeTruthy();
    expect(a!.length / 3).toBe(2);                      // no node added — still identity's 2
    const eases = a!.filter((_: number, i: number) => i % 3 === 2);
    expect(eases.some((e: number) => Math.abs(e) > 0.05)).toBe(true);   // a segment got eased
  });

  it('shows the input field editor and scrubbing it sets `input`', async () => {
    await openEnvelope('sk_env_input');

    // The inspector exposes a scalar-slider for the modulation `input` so it can
    // be wired (port) or scrubbed by hand for testing — even though it auto-
    // connects when a generator precedes it.
    const slider = await page.evaluate(`(() => {
      ${WALK}
      let insp = null;
      for (const el of walk(document)) { if (el.tagName === 'ENVELOPE-INSPECTOR') { insp = el; break; } }
      if (!insp) return { found: false };
      let s = null;
      for (const el of walk(insp.shadowRoot)) {
        if (el.tagName === 'SCALAR-SLIDER' && el.fieldPath === 'input') { s = el; break; }
      }
      if (!s) return { found: false };
      const ctrl = s.shadowRoot.querySelector('.control');
      const r = ctrl.getBoundingClientRect();
      return { found: true, before: s.binding ? s.binding.getValue('input') : null,
               rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`) as any;

    expect(slider.found).toBe(true);                    // the input editor is shown

    // Drag the slider toward the right → input rises well above 0.
    const y = slider.rect.y + slider.rect.h * 0.5;
    await page.mouse.move(slider.rect.x + slider.rect.w * 0.1, y);
    await page.mouse.down();
    await page.mouse.move(slider.rect.x + slider.rect.w * 0.8, y, { steps: 6 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 300));

    const val = await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.tagName === 'SCALAR-SLIDER' && el.fieldPath === 'input' && el.binding) {
          return el.binding.getValue('input');
        }
      }
      return null;
    })()`) as any;
    expect(typeof val).toBe('number');
    expect(val).toBeGreaterThan(0.5);                   // scrubbing set the input value
  });
});
