/**
 * Per-component anchors on a vector field (resolume shell, playground mode).
 *
 * A vector field is ONE field with a width, and a wire may drive the whole
 * thing or a single lane. That only works if the two are separately clickable,
 * so this guards the DOM half:
 *
 *  - each component has its own `.tap-overlay-hit`, at its own rect;
 *  - the whole-field box strictly CONTAINS them (the overlay paints
 *    largest-area-first so nested boxes stay clickable — equal areas would tie
 *    and make "the vector" and "its X" impossible to aim at separately);
 *  - the old collision is gone: every component slider used to register the
 *    literal path `value`, so all N shared one anchor and fought any real field
 *    actually named `value`;
 *  - connecting onto a component writes a STRUCTURED lane on the endpoint, not
 *    a suffix on the field name — roughly forty places look a wire's dest up in
 *    a schema, and `translate#1` is in no schema.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

interface Hit { p: string; chain: string; x: number; y: number; w: number; h: number; }

describe('vector field lane anchors', () => {
  jest.setTimeout(60000);

  const seed = async () => {
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 3000));
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_vl'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0' },
            { type: 'module', module_type: 'warp.transform', instance_key: 'tf@0' },
          ],
          wires: [],
          instances: {
            'lfo@0': { module_type: 'mod.source.lfo', state: {} },
            'tf@0': { module_type: 'warp.transform', state: { translate: [0.2, 0.4] } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_vl');
      ac.setTappingMode(true);
    })()`);
    await new Promise((r) => setTimeout(r, 2500));
  };

  const hits = (): Promise<Hit[]> => page.evaluate(`(() => {
    function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
    const out = [];
    for (const el of walk(document)) {
      if (el.classList && el.classList.contains('tap-overlay-hit')) {
        const r = el.getBoundingClientRect();
        out.push({ p: el.dataset.fieldPath, chain: el.dataset.chainIdx,
                   x: r.x, y: r.y, w: r.width, h: r.height });
      }
    }
    return out;
  })()`) as Promise<Hit[]>;

  beforeAll(async () => {
    page.removeAllListeners('console');
    await page.setViewport({ width: 1600, height: 1400 });
  });

  it('gives every component its own anchor, inside the whole-field one', async () => {
    await seed();
    const all = await hits();
    const whole = all.find((h) => h.p === 'translate');
    const x = all.find((h) => h.p === 'translate#0');
    const y = all.find((h) => h.p === 'translate#1');

    expect(whole).toBeDefined();
    expect(x).toBeDefined();
    expect(y).toBeDefined();

    // Distinct rows, not the same rect.
    expect(Math.round(y!.y)).toBeGreaterThan(Math.round(x!.y));
    expect(y!.y).toBeGreaterThanOrEqual(x!.y + x!.h - 1);

    // The whole-field box strictly contains both, and is strictly larger — so
    // the largest-area-first sort puts it underneath instead of tying.
    for (const lane of [x!, y!]) {
      expect(whole!.x).toBeLessThanOrEqual(lane.x);
      expect(whole!.y).toBeLessThanOrEqual(lane.y + 1);
      expect(whole!.x + whole!.w).toBeGreaterThanOrEqual(lane.x + lane.w);
      expect(whole!.w * whole!.h).toBeGreaterThan(lane.w * lane.h);
    }
  });

  it('no longer registers every component under the literal path "value"', async () => {
    const all = await hits();
    expect(all.filter((h) => h.p === 'value')).toHaveLength(0);
  });

  it('connecting onto a component writes a structured lane on the endpoint', async () => {
    const all = await hits();
    const out = all.find((h) => h.p === 'output' && h.chain === '0')!;
    const laneY = all.find((h) => h.p === 'translate#1')!;
    expect(out).toBeDefined();
    expect(laneY).toBeDefined();

    const centre = (h: Hit) => [h.x + h.w / 2, h.y + h.h / 2] as const;
    // Click-to-connect: first click selects the source, the second picks it up,
    // the third lands it on the target.
    const [ox, oy] = centre(out);
    await page.mouse.click(ox, oy);
    await new Promise((r) => setTimeout(r, 400));
    await page.mouse.click(ox, oy);
    await new Promise((r) => setTimeout(r, 400));
    const [lx, ly] = centre(laneY);
    await page.mouse.click(lx, ly);
    await new Promise((r) => setTimeout(r, 600));

    // Read the fields out explicitly: a MobX observable array does not survive
    // page.evaluate's structured clone (it arrives as `{0: {}}`).
    const wires = await page.evaluate(`(() => {
      const ws = window.appState.database.sketches['sk_vl'].wires || [];
      return Array.from(ws).map(w => ({
        src: { instanceKey: w.src.instanceKey, field: w.src.field },
        dest: Object.assign(
          { instanceKey: w.dest.instanceKey, field: w.dest.field },
          w.dest.lane == null ? {} : { lane: w.dest.lane }),
      }));
    })()`) as Array<{
        src: { instanceKey: string; field: string };
        dest: { instanceKey: string; field: string; lane?: number };
      }>;
    expect(wires).toHaveLength(1);
    // The FIELD name is untouched — the lane is its own key.
    expect(wires[0].dest).toEqual({ instanceKey: 'tf@0', field: 'translate', lane: 1 });
    expect(wires[0].src.instanceKey).toBe('lfo@0');
  });
});
