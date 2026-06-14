/**
 * Main sketch monitor E2E (resolume shell, local mode).
 *
 * The monitor's `edit_preview` trace is owned by edit-tab and registered for the
 * tab's whole lifetime, re-targeted reactively: it shows the selected
 * selectable's texture if it has one, otherwise the sketch's FINAL output. The
 * registration is never dropped on deselect — which is the regression this
 * guards: previously a selection-scoped monitor's unmount unregistered the
 * shared `edit_preview` id, so the monitor went blank/checkerboard on deselect.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('main sketch monitor fallback', () => {
  jest.setTimeout(50000);

  it('follows the selected target and falls back to final output on deselect', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // Build a 2-module sketch and open it in the edit tab (local mode → worker renders).
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('setup', d => {
        d.sketches['sk_mon'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'generator.solid_color', instance_key: 'sc@0',
              params: { color: [0.9, 0.2, 0.5] } },
            { type: 'module', module_type: 'video.brightness_contrast', instance_key: 'bc@0' },
          ],
          instances: {
            'sc@0': { module_type: 'generator.solid_color', state: { color: [0.9, 0.2, 0.5] } },
            'bc@0': { module_type: 'video.brightness_contrast', state: { brightness: 1, contrast: 1 } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_mon');
    })()`);
    await new Promise(r => setTimeout(r, 2500));

    const probe = async () => page.evaluate(`(async () => {
      const { traceController } = await import('/src/state/trace-controller.ts');
      const reg = traceController.registrations.get('edit_preview');
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let canvas = null;
      for (const el of walk(document)) { if (el.id === 'preview-canvas') { canvas = el; break; } }
      let nonBlank = false;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 8 || data[i+1] > 8 || data[i+2] > 8) { nonBlank = true; break; }
        }
      }
      return { target: reg ? reg.target.type : null, nonBlank };
    })()`) as Promise<{ target: string | null; nonBlank: boolean }>;

    // No selection → final output, painted.
    const initial = await probe();
    expect(initial.target).toBe('sketch_output');
    expect(initial.nonBlank).toBe(true);

    // Select an effect → monitor follows it to that effect's output texture.
    await page.evaluate(`window.appController.select('effect/sk_mon/0/0')`);
    await new Promise(r => setTimeout(r, 1200));
    const selected = await probe();
    expect(selected.target).toBe('chain_entry');
    expect(selected.nonBlank).toBe(true);

    // Deselect → falls back to final output, still registered + painted (the bug).
    await page.evaluate(`window.appController.select(null)`);
    await new Promise(r => setTimeout(r, 1200));
    const deselected = await probe();
    expect(deselected.target).toBe('sketch_output');
    expect(deselected.nonBlank).toBe(true);
  });
});
