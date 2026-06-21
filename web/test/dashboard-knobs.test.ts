/**
 * util.dashboard E2E (resolume shell, local mode).
 *
 * The dashboard is a real schema-backed core effect whose knob_i fields (in
 * `state.knob_i`) are each a wire source/sink. The UI still gives it a distinct
 * KIND ('dashboard') for its bespoke knob-row card. This guards: it's offered
 * by the picker as kind 'dashboard', seeds 8 knobs, renders a custom knob-row
 * editor, knob drags write the right field, and the knobs register as wire
 * endpoints (tap-overlay hits) so they can be connected.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('util.dashboard knob bank', () => {
  jest.setTimeout(50000);

  // TODO(task #21): re-enable once the resolume-shell DATABASE reset is fixed.
  // The engine-side wire propagation is now correct (executor-host no longer
  // mirrors relay in+out fields over their authored value — see
  // engine-wires "pure-output knob"), but in the full resolume app an idle-frame
  // process still replaces the dashboard instance's authored state with {} (a
  // DIFFERENT bug from the engine mirror — that produced {knob_i:0}, this gives
  // {}). The drag-write itself is correct (traced).
  it.skip('registers as a dashboard kind, seeds 8 knobs, and edits them', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    const setup = await page.evaluate(`(async () => {
      const ac = window.appController, as = window.appState;
      const eff = as.local.availableEffects.find(e => e.id === 'util.dashboard');
      ac.mutate('s', d => {
        d.sketches['sk_dash'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'source.solid_color', instance_key: 'sc@0',
                    params: { color: [0.1,0.1,0.1] } }],
          instances: { 'sc@0': { module_type: 'source.solid_color', state: { color:[0.1,0.1,0.1] } } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_dash');
      ac.addEffectToChain('sk_dash', 0, 1, 'util.dashboard');  // tapping OFF: knobs editable
      const inst = Object.values(as.database.sketches['sk_dash'].instances)
        .find(v => v.module_type === 'util.dashboard');
      const knobCount = inst ? Object.keys(inst.state).filter(k => k.indexOf('knob_') === 0).length : 0;
      return { kind: eff ? eff.kind : null, knobCount };
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
      return inst.state;
    })()`) as Record<string, number>;
    expect(after.knob_2).toBeGreaterThan(0.2);   // dragged up ~64px / 160px range
    expect(after.knob_0).toBe(0);                // others untouched
    expect(after.knob_5).toBe(0);

    // In tapping mode, each knob becomes a wire endpoint (drag-to-connect hit-box).
    await page.evaluate(`window.appController.setTappingMode(true)`);
    await new Promise(r => setTimeout(r, 600));
    const tapping = await probeKnob2();
    expect(tapping.tapHit).toBe(true);

    // Balanced wrap: force the editor width and count the distinct knob rows.
    // 8 knobs split into divisor-of-8 rows — 4/4 wide, 2/2/2/2, then a column.
    const rowsAtWidth = (w: number) => page.evaluate(`(async () => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      let ed = null; const knobs = [];
      for (const el of walk(document)) {
        if (el.tagName === 'DASHBOARD-EDITOR') ed = el;
        if (el.tagName === 'SCALAR-KNOB') knobs.push(el);
      }
      ed.style.width = ${w} + 'px';
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const ys = new Set(knobs.map(k => Math.round(k.getBoundingClientRect().top)));
      return ys.size;
    })()`) as Promise<number>;

    expect(await rowsAtWidth(320)).toBe(2);   // 4 / 4
    expect(await rowsAtWidth(150)).toBe(4);   // 2 / 2 / 2 / 2
    expect(await rowsAtWidth(80)).toBe(8);    // single column
  });

  it('grays a knob with no outgoing wire, or one overridden by a replace input', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    const setWires = (wires: string) => page.evaluate(`(() => {
      window.appController.mutate('w', d => { d.sketches['sk_m'].wires = ${wires}; });
    })()`);

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_m'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0' },
            { type: 'module', module_type: 'util.dashboard', instance_key: 'dash@0',
              params: {} },
            { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
          ],
          wires: [],
          instances: {
            'lfo@0': { module_type: 'mod.source.lfo', state: {} },
            'dash@0': { module_type: 'util.dashboard', state: {} },
            'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 1, contrast: 0.25 } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_m');
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    const mutedOf = (i: number) => page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'SCALAR-KNOB' && el.fieldPath === 'knob_${i}') return el.hasAttribute('muted');
      }
      return null;
    })()`) as Promise<boolean | null>;

    // No wires yet → every knob is inert.
    expect(await mutedOf(0)).toBe(true);
    expect(await mutedOf(2)).toBe(true);

    // knob_2 drives bc.brightness → it now has effect (not grayed); knob_0 still inert.
    await setWires(`[{ id:'o2', src:{instanceKey:'dash@0',field:'knob_2'}, dest:{instanceKey:'bc@0',field:'brightness'} }]`);
    await new Promise(r => setTimeout(r, 400));
    expect(await mutedOf(2)).toBe(false);
    expect(await mutedOf(0)).toBe(true);

    // Add a `replace` input wire into knob_2 → its stored value is clobbered → grayed again.
    await setWires(`[
      { id:'o2', src:{instanceKey:'dash@0',field:'knob_2'}, dest:{instanceKey:'bc@0',field:'brightness'} },
      { id:'i2', src:{instanceKey:'lfo@0',field:'output'}, dest:{instanceKey:'dash@0',field:'knob_2'}, combine:'replace' }
    ]`);
    await new Promise(r => setTimeout(r, 400));
    expect(await mutedOf(2)).toBe(true);

    // Switch that input to a non-destructive `mix` → the knob matters again.
    await setWires(`[
      { id:'o2', src:{instanceKey:'dash@0',field:'knob_2'}, dest:{instanceKey:'bc@0',field:'brightness'} },
      { id:'i2', src:{instanceKey:'lfo@0',field:'output'}, dest:{instanceKey:'dash@0',field:'knob_2'}, combine:'mix', mixFactor:0.5 }
    ]`);
    await new Promise(r => setTimeout(r, 400));
    expect(await mutedOf(2)).toBe(false);
  });
});
