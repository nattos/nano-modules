/**
 * Devices tab — composition-wide wires panel E2E (resolume shell, playground).
 *
 * Selecting a device control pops the details panel; its bottom section must
 * list EVERY wire that control drives across ALL playground instances,
 * grouped per instance with the edited instance first, each row carrying the
 * shared wire-mod inspector and a locate button. Locate on another instance's
 * wire switches the editor to that instance and selects the dest field.
 * Selecting the device CARD shows the device-wide panel.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('device wires panel', () => {
  jest.setTimeout(60000);

  it('lists composition-wide wires per control, locates targets, and shows a device-wide panel', async () => {
    page.removeAllListeners('console');
    // The details panel is bottom-anchored and height-budgeted off the
    // viewport; the default 800×600 clips its scrollable wires list.
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // Two playground instances, each with a dashboard; one MFT device fork;
    // wires from the same control (b0/e05) into BOTH instances, plus one from
    // another control (b0/e06) into A only (device-wide vs per-control cases).
    const setup = await page.evaluate(`(async () => {
      const ac = window.appController, as = window.appState, mc = window.midiController;
      const dev = mc.ensureInstanceForEdit('com.nano.midi.mft');
      const idA = ac.createPlaygroundInstance();
      const idB = ac.createPlaygroundInstance();
      const chain = (key) => ([{ type: 'module', module_type: 'util.dashboard', instance_key: key }]);
      ac.mutate('seed', d => {
        d.sketches[idA].chain = chain('da@0');
        d.sketches[idA].instances = { 'da@0': { module_type: 'util.dashboard', state: { label_3: 'Speed' } } };
        d.sketches[idA].wires = [
          { id: 'wA', src: { instanceKey: 'midi:' + dev.id, field: 'b0/e05/turn' },
            dest: { instanceKey: 'da@0', field: 'knob_3' }, combine: 'add' },
          { id: 'wA2', src: { instanceKey: 'midi:' + dev.id, field: 'b0/e06/turn' },
            dest: { instanceKey: 'da@0', field: 'knob_1' }, combine: 'add' },
        ];
        d.sketches[idB].chain = chain('db@0');
        d.sketches[idB].instances = { 'db@0': { module_type: 'util.dashboard', state: {} } };
        d.sketches[idB].wires = [
          { id: 'wB', src: { instanceKey: 'midi:' + dev.id, field: 'b0/e05/turn' },
            dest: { instanceKey: 'db@0', field: 'knob_7' }, combine: 'add' },
        ];
      });
      ac.editSketch(idA);
      ac.setActiveTab('devices');
      return { devId: dev.id, idA, idB };
    })()`) as { devId: string; idA: string; idB: string };
    await new Promise(r => setTimeout(r, 1500));

    // Click encoder b0/e05 on the device instance's surface → control selected.
    const enc = await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'DEVICE-SURFACE' && el.deviceId === ${JSON.stringify(setup.devId)}) {
          const k = el.shadowRoot.querySelector('[data-control-id="b0/e05"]');
          if (k) { const r = k.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }
        }
      }
      return null;
    })()`) as { x: number; y: number } | null;
    expect(enc).not.toBeNull();
    await page.mouse.click(enc!.x, enc!.y);
    await new Promise(r => setTimeout(r, 600));

    // The details panel's wires section: both instances' wires for THIS
    // control only, edited instance (A) first, with the shared mod inspector.
    const probePanel = `(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName !== 'DEVICE-WIRES-PANEL') continue;
        const sr = el.shadowRoot;
        const heads = [...sr.querySelectorAll('.group-head')].map(h => h.textContent.trim());
        const rows = [...sr.querySelectorAll('.wire-row .name')].map(n => n.textContent.replace(/\\s+/g, ' ').trim());
        const combines = sr.querySelectorAll('field-tab-bar').length;
        const locates = [...sr.querySelectorAll('button[title="Locate the target field"]')]
          .map(b => { b.scrollIntoView({ block: 'center' });
                      const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; });
        return { heads, rows, combines, locates };
      }
      return null;
    })()`;
    const panel = await page.evaluate(probePanel) as any;
    expect(panel).not.toBeNull();
    expect(panel.heads.length).toBe(2);
    expect(panel.heads[0]).toContain('editing');          // instance A leads
    expect(panel.rows.length).toBe(2);                    // b0/e05 wires only
    expect(panel.rows[0]).toContain('dashboard.Speed');   // knob rename honored
    expect(panel.rows[1]).toContain('dashboard.Knob 8');  // schema display name
    expect(panel.combines).toBeGreaterThanOrEqual(4);     // magnitude+combine × 2 rows

    // Locate the OTHER instance's wire → editor switches to B and selects the
    // dest field (dashboard sits at chain index 0).
    await page.mouse.click(panel.locates[1].x, panel.locates[1].y);
    await new Promise(r => setTimeout(r, 1200));
    const located = await page.evaluate(`(() => ({
      editing: window.appState.local.editingSketchId,
      selection: window.appState.local.selection ? window.appState.local.selection.path : null,
      queued: window.appState.local.queuedSelectionPath,
    }))()`) as any;
    expect(located.editing).toBe(setup.idB);
    const wantSel = `field/${setup.idB}/0/0/knob_7`;
    expect([located.selection, located.queued]).toContain(wantSel);

    // Panel regrouped: B is now the edited instance and leads the list.
    const panel2 = await page.evaluate(probePanel) as any;
    expect(panel2.heads[0]).toContain('editing');
    expect(panel2.rows[0]).toContain('dashboard.Knob 8');

    // Device CARD selection: the device-wide panel lists ALL 3 wires with
    // control labels.
    await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'DEVICE-SURFACE' && el.deviceId === ${JSON.stringify(setup.devId)}) {
          el.closest('device-card').click();
          return;
        }
      }
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const cardPanel = await page.evaluate(probePanel) as any;
    expect(cardPanel).not.toBeNull();
    expect(cardPanel.rows.length).toBe(3);
  });

});
