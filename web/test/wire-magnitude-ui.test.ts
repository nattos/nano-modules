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

  it('shows a Magnitude control; Remap appears only in absolute mode', async () => {
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
      let magVal = null, hasMag = false, hasRemap = false;
      for (const el of walk(document)) {
        if (el.tagName === 'FIELD-TAB-BAR' && el.fieldPath === 'magnitude') {
          hasMag = true;
          const active = el.shadowRoot.querySelector('button[active]');
          magVal = active ? active.textContent.trim() : null;
        }
        if (el.tagName === 'FIELD-TOGGLE' && el.label === 'Remap') hasRemap = true;
      }
      return { hasMag, magVal, hasRemap };
    })()`) as Promise<{ hasMag: boolean; magVal: string | null; hasRemap: boolean }>;

    // Default auto: control present, no manual Remap.
    const a = await probe();
    expect(a.hasMag).toBe(true);
    expect(a.magVal).toBe('auto');
    expect(a.hasRemap).toBe(false);

    // Switch to absolute → the manual Remap toggle appears, control reflects it.
    await page.evaluate(`window.appController.updateWire('sk_wm','w0',{ magnitude:'absolute' })`);
    await new Promise(r => setTimeout(r, 400));
    const b = await probe();
    expect(b.magVal).toBe('absolute');
    expect(b.hasRemap).toBe(true);

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
