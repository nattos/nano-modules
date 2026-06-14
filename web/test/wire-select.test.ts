/**
 * Wire interaction E2E (resolume shell, local mode).
 *
 * Wires are easy to delete by accident, so a single click SELECTS a wire
 * (highlights it) and a double click BREAKS it. Delete/Backspace also breaks a
 * selected wire. This drives the real overlay hit paths.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('wire select / break', () => {
  jest.setTimeout(50000);

  it('single click selects a wire; double click breaks it', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_w'] = {
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
      ac.editSketch('sk_w');
      ac.setTappingMode(true);   // wire arcs only draw in wire mode
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    const findHit = `(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'TAPS-OVERLAY') {
          return el.shadowRoot.querySelector('.wire-hit');
        }
      }
      return null;
    })()`;

    const wireCount = () => page.evaluate(`(window.appState.database.sketches['sk_w'].wires || []).length`);
    const selectedPath = () => page.evaluate(`window.appState.local.selection?.path ?? null`);
    // The right-panel inspector header text (the selected Selectable's label).
    const inspectorHeader = () => page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'EDIT-TAB') {
          const h = el.shadowRoot.querySelector('.right-panel .section-header');
          return h ? h.textContent.trim() : null;
        }
      }
      return null;
    })()`);

    // Sanity: the wire + its hit path exist.
    expect(await wireCount()).toBe(1);
    expect(await page.evaluate(`!!(${findHit})`)).toBe(true);

    // Single click → selects (Selectable path), does NOT delete.
    await page.evaluate(`(${findHit}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await new Promise(r => setTimeout(r, 400));
    expect(await wireCount()).toBe(1);                       // still there
    expect(await selectedPath()).toBe('wire/sk_w/w0');       // selected as a Selectable
    // Inspector shows the DEST field's content (delegated): header is the wire's label.
    expect(await inspectorHeader()).toBe('Wire → brightness');

    // Double click → breaks.
    await page.evaluate(`(${findHit}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await new Promise(r => setTimeout(r, 400));
    expect(await wireCount()).toBe(0);              // gone
    expect(await selectedPath()).toBeNull();        // selection cleared
  });
});
