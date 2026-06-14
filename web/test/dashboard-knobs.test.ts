/**
 * util.dashboard E2E (resolume shell, local mode).
 *
 * The dashboard is a distinct KIND of effect (no WASM module): a fixed bank of 8
 * knobs in `state.knobs[]`, each a wire source/sink. This guards: it's offered
 * by the picker as kind 'dashboard', seeds 8 knobs, renders a custom knob-row
 * editor, knob drags write the right array slot, and the knobs register as wire
 * endpoints (tap-overlay hits) so they can be connected.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('util.dashboard knob bank', () => {
  jest.setTimeout(50000);

  it('registers as a dashboard kind, seeds 8 knobs, and edits them', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    const setup = await page.evaluate(`(async () => {
      const ac = window.appController, as = window.appState;
      const eff = as.local.availableEffects.find(e => e.id === 'util.dashboard');
      ac.mutate('s', d => {
        d.sketches['sk_dash'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'generator.solid_color', instance_key: 'sc@0',
                    params: { color: [0.1,0.1,0.1] } }],
          instances: { 'sc@0': { module_type: 'generator.solid_color', state: { color:[0.1,0.1,0.1] } } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_dash');
      ac.addEffectToChain('sk_dash', 0, 1, 'util.dashboard');  // tapping OFF: knobs editable
      const inst = Object.values(as.database.sketches['sk_dash'].instances)
        .find(v => v.module_type === 'util.dashboard');
      return { kind: eff ? eff.kind : null, knobCount: inst ? Object.keys(inst.state.knobs).length : 0 };
    })()`) as { kind: string | null; knobCount: number };

    // Registered as a distinct kind, seeded with 8 knobs.
    expect(setup.kind).toBe('dashboard');
    expect(setup.knobCount).toBe(8);

    await new Promise(r => setTimeout(r, 1500));

    const probeKnob2 = async () => page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      let editors = 0, knobs = 0, knob2 = null, tapHit = false;
      for (const el of walk(document)) {
        if (el.tagName === 'DASHBOARD-EDITOR') editors++;
        if (el.tagName === 'SCALAR-KNOB') {
          knobs++;
          if (el.fieldPath === 'knob_2') {
            const c = el.shadowRoot.querySelector('.dial');
            if (c) { const r = c.getBoundingClientRect(); knob2 = { x:r.x, y:r.y, w:r.width, h:r.height }; }
          }
        }
        if (el.classList && el.classList.contains('tap-overlay-hit') && el.dataset.fieldPath === 'knob_2') tapHit = true;
      }
      return { editors, knobs, knob2, tapHit };
    })()`) as Promise<any>;

    const dom = await probeKnob2();
    // Custom editor with exactly 8 knobs.
    expect(dom.editors).toBe(1);
    expect(dom.knobs).toBe(8);
    expect(dom.knob2).not.toBeNull();

    // With tapping OFF, dragging knob_2 up edits its slot (and only it).
    const cx = dom.knob2.x + dom.knob2.w / 2, cy = dom.knob2.y + dom.knob2.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(cx, cy - i * 8); await new Promise(r => setTimeout(r, 16)); }
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 200));

    const after = await page.evaluate(`(() => {
      const inst = Object.values(window.appState.database.sketches['sk_dash'].instances)
        .find(v => v.module_type === 'util.dashboard');
      return inst.state.knobs;
    })()`) as Record<number, number>;
    expect(after[2]).toBeGreaterThan(0.2);   // dragged up ~64px / 160px range
    expect(after[0]).toBe(0);                // others untouched
    expect(after[5]).toBe(0);

    // In tapping mode, each knob becomes a wire endpoint (drag-to-connect hit-box).
    await page.evaluate(`window.appController.setTappingMode(true)`);
    await new Promise(r => setTimeout(r, 600));
    const tapping = await probeKnob2();
    expect(tapping.tapHit).toBe(true);
  });
});
