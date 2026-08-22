/**
 * The tab rail's mode pills — `W` (wires) and `C` (canvas).
 *
 * They are toggles, not tabs: they don't change what the left panel renders,
 * they change how the surface behaves. So each test drives the pill and then
 * checks the MODE, not just the pill's own attribute — a button that lights up
 * without engaging anything is the failure worth catching.
 *
 * Each pill is also the twin of a bare-key shortcut, so both directions are
 * pinned: the pill drives the setting, and a key press drives the pill.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

/** Walk every shadow root — the rail's buttons live inside <app-tab-bar>. */
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

/** Every mode pill in the rail, in render order, with geometry and lit state. */
const pills = `(() => { ${WALK}
  for (const el of walk(document)) {
    if (el.tagName !== 'APP-TAB-BAR') continue;
    return Array.from(el.shadowRoot.querySelectorAll('.mode-btn')).map(b => {
      const r = b.getBoundingClientRect();
      return { letter: b.textContent.trim(), active: b.hasAttribute('active'),
               color: getComputedStyle(b).color, right: r.right,
               x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  }
  return null;
})()`;

/** How many field rows are currently offering themselves as wire ports. */
const tapHits = `(() => { ${WALK}
  let n = 0;
  for (const el of walk(document)) if (el.matches && el.matches('.tap-overlay-hit')) n++;
  return n;
})()`;

const countOf = (sel: string) => `(() => { ${WALK}
  let n = 0;
  for (const el of walk(document)) if (el.matches && el.matches(${JSON.stringify(sel)})) n++;
  return n;
})()`;

/** A two-effect sketch with a wire, both modes OFF — the pills have to turn them on. */
async function seed(page: any) {
  await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(`(async () => {
    const ac = window.appController;
    ac.mutate('s', d => {
      d.sketches['sk_rail'] = {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0' },
          { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
            canvas: { x: 60, y: 40 } },
        ],
        wires: [{ id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
                  dest: { instanceKey: 'bc@0', field: 'brightness' } }],
        instances: {
          'src@0': { module_type: 'source.solid_color', state: {} },
          'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 0, contrast: 0 } },
          'lfo@0': { module_type: 'mod.source.lfo', state: {} },
        },
        execOrder: ['src@0', 'lfo@0', 'bc@0'],
      };
    });
    ac.setActiveTab('edit');
    ac.editSketch('sk_rail');
    ac.setTappingMode(false);
    ac.setSketchCanvasOpen(false);
  })()`);
  await new Promise(r => setTimeout(r, 2000));
}

const settle = () => new Promise(r => setTimeout(r, 800));

describe('tab rail mode pills', () => {
  jest.setTimeout(60000);

  it('renders W then C, both fitting inside the 48px rail', async () => {
    await seed(page);
    const p = await page.evaluate(pills) as any[];
    expect(p).not.toBeNull();
    expect(p.map(b => b.letter)).toEqual(['W', 'C']);
    // Overhanging the rail would put them under the left panel's edge.
    for (const b of p) expect(b.right).toBeLessThanOrEqual(48);
    expect(p.every(b => !b.active)).toBe(true);
  });

  it('W turns wires mode on, lighting orange and opening the field ports', async () => {
    await seed(page);
    // Nothing is offering a wire port while the mode is off.
    expect(await page.evaluate(tapHits)).toBe(0);

    const w = (await page.evaluate(pills) as any[])[0];
    await page.mouse.click(w.x, w.y);
    await settle();

    expect(await page.evaluate(`window.appState.local.tappingMode`)).toBe(true);
    // The whole point: the pill engaged the MODE, not just its own highlight.
    expect(await page.evaluate(tapHits)).toBeGreaterThan(0);

    const lit = (await page.evaluate(pills) as any[])[0];
    expect(lit.active).toBe(true);
    // The arrangement transport's wires accent — one mode across surfaces, so
    // it must not drift into a second colour here.
    expect(lit.color).toBe('rgb(255, 140, 0)');

    // The `W` key drives the same mode, so the pill has to follow it back off.
    await page.keyboard.press('w');
    await settle();
    expect((await page.evaluate(pills) as any[])[0].active).toBe(false);
    expect(await page.evaluate(tapHits)).toBe(0);
  });

  it('C opens the sidecar canvas, lighting blue', async () => {
    await seed(page);
    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(0);

    const c = (await page.evaluate(pills) as any[])[1];
    await page.mouse.click(c.x, c.y);
    await settle();

    expect(await page.evaluate(`window.appState.local.userSettings.sketchCanvasOpen`)).toBe(true);
    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(1);

    const lit = (await page.evaluate(pills) as any[])[1];
    expect(lit.active).toBe(true);
    // The rail's own accent, NOT the W pill's orange — a surface, not a mode.
    expect(lit.color).toBe('rgb(65, 105, 225)');

    await page.keyboard.press('c');
    await settle();
    expect((await page.evaluate(pills) as any[])[1].active).toBe(false);
    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(0);
  });

  it('lights the two modes independently', async () => {
    await seed(page);
    const [w, c] = await page.evaluate(pills) as any[];
    await page.mouse.click(w.x, w.y);
    await settle();
    await page.mouse.click(c.x, c.y);
    await settle();
    const both = await page.evaluate(pills) as any[];
    expect(both.map(b => b.active)).toEqual([true, true]);
    // Wires stay on across the canvas opening — the canvas is a wiring surface.
    expect(await page.evaluate(`window.appState.local.tappingMode`)).toBe(true);
  });

  it('keeps W on Devices but drops C — that tab already owns the right panel', async () => {
    await seed(page);
    expect((await page.evaluate(pills) as any[]).map(b => b.letter)).toEqual(['W', 'C']);

    // Devices is where W-mode wires drag between a device control and an editor
    // field, so it keeps the pill; the canvas has nowhere to open there.
    await page.evaluate(`window.appController.setActiveTab('devices')`);
    await settle();
    expect((await page.evaluate(pills) as any[]).map(b => b.letter)).toEqual(['W']);

    // A tab that hosts neither shows neither.
    await page.evaluate(`window.appController.setActiveTab('settings')`);
    await settle();
    expect(await page.evaluate(pills)).toEqual([]);

    await page.evaluate(`window.appController.setActiveTab('edit')`);
    await settle();
    expect((await page.evaluate(pills) as any[]).map(b => b.letter)).toEqual(['W', 'C']);
  });
});
