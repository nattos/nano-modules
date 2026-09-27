/**
 * The mouse wheel scrolls the editor even while the pointer is over a wire.
 *
 * Wires are drawn by <taps-overlay>, a layer ABOVE the effects list and a
 * sibling of its scroll container — so a wheel over a wire's hit path went to
 * the overlay and never reached the list, which stopped scrolling whenever the
 * pointer crossed a wire. The overlay now hands the wheel to what's beneath.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

/** A visible point ON a wire's hit path, inside the editor panel. */
const wirePoint = `(() => { ${WALK}
  for (const el of walk(document)) {
    if (el.tagName !== 'TAPS-OVERLAY') continue;
    for (const p of el.shadowRoot.querySelectorAll('path.wire-hit.fine')) {
      const len = p.getTotalLength();
      if (!(len > 0)) continue;
      const m = p.getScreenCTM();
      for (let f = 0.5; f > 0.05; f -= 0.1) {
        const pt = p.getPointAtLength(len * f).matrixTransform(m);
        if (pt.y < 60 || pt.y > innerHeight - 60) continue;
        // Must actually hit the wire, or the test proves nothing.
        let hit = document.elementFromPoint(pt.x, pt.y);
        while (hit && hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(pt.x, pt.y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        if (hit && hit.classList && hit.classList.contains('wire-hit')) return { x: pt.x, y: pt.y };
      }
    }
  }
  return null;
})()`;

/** The effects list's scroll offset (its one vertically scrollable box). */
const listScroll = `(() => { ${WALK}
  for (const el of walk(document)) {
    if (el.tagName !== 'COLUMNS-VIEW') continue;
    for (const s of [el, ...walk(el.shadowRoot)]) {
      const cs = getComputedStyle(s);
      if (/(auto|scroll)/.test(cs.overflowY) && s.scrollHeight > s.clientHeight + 20) return s.scrollTop;
    }
  }
  return null;
})()`;

describe('wheel over a wire', () => {
  jest.setTimeout(60000);

  it('scrolls the effects list beneath it', async () => {
    await page.setViewport({ width: 1400, height: 800 });
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));
    // Enough cards to scroll, and a wire from the LFO near the top to a card
    // far below, so its arc crosses the visible list.
    await page.evaluate(`(() => {
      const ac = window.appController;
      const types = ['source.solid_color', 'mod.source.lfo'];
      for (let i = 0; i < 6; i++) types.push('color.tone.brightness_contrast');
      ac.mutate('seed', d => {
        d.sketches['sk_wheel'] = {
          anchor: null,
          chain: types.map((t, i) => ({ type: 'module', module_type: t, instance_key: 'e' + i })),
          instances: Object.fromEntries(types.map((t, i) => ['e' + i, { module_type: t, state: {} }])),
          wires: [{ id: 'w0', src: { instanceKey: 'e1', field: 'output' },
                    dest: { instanceKey: 'e4', field: 'brightness' } }],
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_wheel');
      ac.setSketchCanvasOpen(false);
      ac.setTappingMode(true);
    })()`);
    await new Promise(r => setTimeout(r, 2500));

    const before = await page.evaluate(listScroll) as number | null;
    expect(before).not.toBeNull();
    const pt = await page.evaluate(wirePoint) as { x: number; y: number } | null;
    expect(pt).not.toBeNull();

    await page.mouse.move(pt!.x, pt!.y);
    await page.mouse.wheel({ deltaY: 240 });
    await new Promise(r => setTimeout(r, 500));

    const after = await page.evaluate(listScroll) as number;
    expect(after).toBeGreaterThan(before! + 100);
  });
});
