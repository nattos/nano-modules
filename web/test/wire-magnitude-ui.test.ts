/**
 * Wire magnitude UI E2E (resolume shell, local mode).
 *
 * Selecting a scalar wire shows the dest field's inspector, including the wire
 * mod controls. This guards: a Magnitude control renders and reflects/patches
 * `wire.magnitude`, and the manual Remap controls appear only in 'absolute' mode.
 * (Generic-inspector selects render as <field-tab-bar>: active button = value.)
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('wire magnitude UI', () => {
  jest.setTimeout(50000);

  it('shows a Magnitude control; Scale + Remap are always available', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_wm'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'data.lfo', instance_key: 'lfo@0' },
            { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0' },
          ],
          wires: [{ id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
                    dest: { instanceKey: 'bc@0', field: 'brightness' } }],
          instances: {
            'lfo@0': { module_type: 'data.lfo', state: {} },
            'bc@0': { module_type: 'video.brightness_contrast', state: { brightness: 1, contrast: 0.25 } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_wm');
      ac.setTappingMode(true);
    })()`);
    await new Promise(r => setTimeout(r, 1200));

    await page.evaluate(`window.appController.select('wire/sk_wm/w0')`);
    await new Promise(r => setTimeout(r, 600));

    const probe = () => page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      let magVal = null, hasMag = false, hasScale = false, hasRemap = false, hasInMin = false;
      for (const el of walk(document)) {
        if (el.tagName === 'FIELD-TAB-BAR' && el.fieldPath === 'magnitude') {
          hasMag = true;
          const active = el.shadowRoot.querySelector('button[active]');
          magVal = active ? active.textContent.trim() : null;
        }
        if (el.tagName === 'SCALAR-SLIDER' && el.fieldPath === 'scale') hasScale = true;
        if (el.tagName === 'FIELD-TOGGLE' && el.label === 'Remap') hasRemap = true;
        if (el.tagName === 'SCALAR-SLIDER' && el.fieldPath === 'remap.inMin') hasInMin = true;
      }
      return { hasMag, magVal, hasScale, hasRemap, hasInMin };
    })()`) as Promise<{ hasMag: boolean; magVal: string | null; hasScale: boolean; hasRemap: boolean; hasInMin: boolean }>;

    // Default auto: Magnitude + Scale + Remap toggle all present (Remap is NOT
    // absolute-only — it shapes the raw input before the range adjustment).
    const a = await probe();
    expect(a.hasMag).toBe(true);
    expect(a.magVal).toBe('auto');
    expect(a.hasScale).toBe(true);
    expect(a.hasRemap).toBe(true);
    expect(a.hasInMin).toBe(false);   // collapsed until enabled

    // Enabling Remap (in auto mode) reveals the remap sliders.
    await page.evaluate(`window.appController.updateWire('sk_wm','w0',{ mod:{ remap:{ inMin:0, inMax:1, outMin:0, outMax:1 } } })`);
    await new Promise(r => setTimeout(r, 400));
    const b = await probe();
    expect(b.hasInMin).toBe(true);

    // Click the 'signed' tab → patches wire.magnitude.
    await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'FIELD-TAB-BAR' && el.fieldPath === 'magnitude') {
          for (const b of el.shadowRoot.querySelectorAll('button')) {
            if (b.textContent.trim() === 'signed') { b.click(); return; }
          }
        }
      }
    })()`);
    await new Promise(r => setTimeout(r, 400));
    const mag = await page.evaluate(`window.appState.database.sketches['sk_wm'].wires[0].magnitude`);
    expect(mag).toBe('signed');
  });
});
