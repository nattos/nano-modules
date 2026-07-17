/**
 * Wire panel QoL E2E (resolume shell, playground mode).
 *
 * 1. Reconnect: the field inspector's wire rows carry a "reconnect" button that
 *    re-arms click-to-connect; the next field clicked takes over that wire END
 *    in place (same wire id, mod settings survive) instead of a new wire being
 *    created.
 * 2. MIDI labels: a `midi:<uuid>` wire source renders as
 *    `midi:<endpoint> [Device Name]`, not the raw uuid key.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

/** Deep-walk every shadow root under `document`. Serialized into the page. */
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('wire panel: reconnect + midi labels', () => {
  jest.setTimeout(50000);

  async function boot(wires: string) {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_rc'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0' },
            { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
          ],
          wires: ${wires},
          instances: {
            'lfo@0': { module_type: 'mod.source.lfo', state: {} },
            'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 1, contrast: 0.25 } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_rc');
      ac.setTappingMode(true);   // field ports only render in wires mode
      ac.selectField('sk_rc/0/1/brightness');
    })()`);
    await new Promise(r => setTimeout(r, 1500));
  }

  /** Text of the floating field card (the selected field's inspector). */
  const fieldCardText = () => page.evaluate(`(() => {
    ${WALK}
    for (const el of walk(document)) {
      if (el.tagName === 'TAPS-OVERLAY') {
        const c = el.shadowRoot.querySelector('.field-card');
        return c ? c.textContent.replace(/\\s+/g, ' ').trim() : null;
      }
    }
    return null;
  })()`);

  it('reconnect re-points a wire end in place, keeping id + mod settings', async () => {
    await boot(`[{ id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
                   dest: { instanceKey: 'bc@0', field: 'brightness' },
                   combine: 'add', mod: { scale: 0.5 } }]`);

    // The brightness inspector lists the wire with a reconnect button.
    expect(await fieldCardText()).toContain('lfo.output');
    const clickedReconnect = await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.matches?.('button[title^="Reconnect"]')) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
      }
      return false;
    })()`);
    expect(clickedReconnect).toBe(true);
    await new Promise(r => setTimeout(r, 300));

    // Click-to-connect is armed: land it on bc@0.contrast's field port.
    const clickedTarget = await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.matches?.('.tap-overlay-hit[data-field-path="contrast"]')) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
      }
      return false;
    })()`);
    expect(clickedTarget).toBe(true);
    await new Promise(r => setTimeout(r, 400));

    // Same wire, patched in place: dest moved, id/mod/combine survive.
    const wires = await page.evaluate(
      `JSON.parse(JSON.stringify(window.appState.database.sketches['sk_rc'].wires))`);
    expect(wires).toHaveLength(1);
    expect(wires[0].id).toBe('w0');
    expect(wires[0].src).toEqual({ instanceKey: 'lfo@0', field: 'output' });
    expect(wires[0].dest).toEqual({ instanceKey: 'bc@0', field: 'contrast' });
    expect(wires[0].mod).toEqual({ scale: 0.5 });
    expect(wires[0].combine).toBe('add');
  });

  it('midi wire sources display as midi:<endpoint> [Device Name], not the uuid', async () => {
    await boot('[]');

    // Fork a real library instance (MFT template), then wire one of its
    // encoders into brightness — src instanceKey is `midi:<uuid>`.
    const dev = await page.evaluate(`(() => {
      const inst = window.midiController.ensureInstanceForEdit('com.nano.midi.mft');
      window.appController.mutate('midi wire', d => {
        d.sketches['sk_rc'].wires = [{
          id: 'wm', src: { instanceKey: 'midi:' + inst.id, field: 'b0/e14/turn' },
          dest: { instanceKey: 'bc@0', field: 'brightness' }, combine: 'add',
        }];
      });
      return { id: inst.id, name: inst.name };
    })()`) as { id: string; name: string };
    // Re-select to make sure the card re-renders with the wire present.
    await page.evaluate(`window.appController.selectField(null),
      window.appController.selectField('sk_rc/0/1/brightness')`);
    await new Promise(r => setTimeout(r, 500));

    const text = await fieldCardText();
    expect(text).toContain(`midi:b0/e14/turn [${dev.name}]`);
    expect(text).not.toContain(dev.id);   // raw uuid stays out of the visible label
  });
});
