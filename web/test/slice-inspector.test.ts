/**
 * Custom-inspector E2E for mod.shaper.slice (resolume shell, playground mode).
 *
 * Two things this pins that a unit test can't:
 *
 *  - the card renders exactly as many LANES and as many OUTPUT TRACE PIPS as
 *    the count says. The pips come from a different code path than the lanes
 *    (column-group's collectModuleOutputs, off the schema) and the hidden ones
 *    reappeared once already, resurrected under their raw field names by the
 *    legacy `plugin.io` fallback.
 *  - the live readouts are wired to the running engine: with the input parked
 *    inside lane 2's window, lane 2 publishes its curve's value and the other
 *    lanes publish 0.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('mod.shaper.slice custom inspector', () => {
  jest.setTimeout(60000);

  it('renders one lane + one pip per output, and reads back live', async () => {
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3500));   // boot + bundle discovery

    // Four lanes over quarters, lane 2 carrying a curve that peaks at its
    // midpoint, and the input parked at 0.42 — inside lane 2, past its peak.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_slice'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'util.dashboard', instance_key: 'dash@0' },
            { type: 'module', module_type: 'mod.shaper.slice', instance_key: 'sl@0' },
          ],
          wires: [{ id: 'w_in', src: { instanceKey: 'dash@0', field: 'knob_0' },
                    dest: { instanceKey: 'sl@0', field: 'input' }, combine: 'replace' }],
          instances: {
            'dash@0': { module_type: 'util.dashboard', state: { knob_0: 0.42 } },
            'sl@0': { module_type: 'mod.shaper.slice', state: {
              input_count: 4,
              start_1: 0, end_1: 0.25, start_2: 0.25, end_2: 0.5,
              start_3: 0.5, end_3: 0.75, start_4: 0.75, end_4: 1,
              curve_2: '[0,0,0,0.5,1,0,1,0,0]',
            } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_slice');
    })()`);
    await new Promise(r => setTimeout(r, 3000));   // mount + rAF draw + a few engine frames

    const info = await page.evaluate(`(() => {
      ${WALK}
      let insp = null, lanes = 0, bands = 0, playhead = false, drawn = 0;
      const values = [], pips = [];
      for (const el of walk(document)) {
        if (el.tagName === 'SLICE-INSPECTOR') insp = el;
        if (el.tagName === 'ENVELOPE-FIELD') lanes++;
        // The output trace rows. A hidden lane that slipped through the schema
        // pass comes back as its raw field name, so match both spellings.
        const t = (el.textContent || '').trim();
        if (/^(Out \\d|out_\\d)$/.test(t)) pips.push(t);
      }
      if (insp) {
        bands = insp.shadowRoot.querySelectorAll('.band').length;
        playhead = !!insp.shadowRoot.querySelector('.playhead');
        for (const el of insp.shadowRoot.querySelectorAll('.lane-val')) {
          values.push(el.textContent.trim());
        }
        for (const el of walk(insp.shadowRoot)) {
          if (el.tagName === 'CANVAS' && el.width > 0) {
            const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
            let lit = 0;
            for (let i = 0; i < d.length; i += 4) {
              if (d[i] + d[i+1] + d[i+2] > 90 && d[i+3] > 40) lit++;
            }
            if (lit > 50) drawn++;
          }
        }
      }
      return { insp: !!insp, lanes, bands, playhead, drawn, values,
               pips: [...new Set(pips)].sort() };
    })()`) as any;

    expect(info.insp).toBe(true);
    expect(info.lanes).toBe(4);            // one envelope graph per active lane
    expect(info.drawn).toBe(4);            // …each actually drawing its curve
    expect(info.bands).toBe(4);            // the overview strip agrees
    expect(info.playhead).toBe(true);
    // Exactly the four active lanes' pips — no out_5..out_8 under any spelling.
    expect(info.pips).toEqual(['Out 1', 'Out 2', 'Out 3', 'Out 4']);

    // Live: 0.42 sits at t = 0.68 across lane 2's [0.25,0.5] window, and the
    // peak curve reads 0.64 there. Everyone else is outside their window (Gate).
    // eslint-disable-next-line no-console
    console.log('[slice inspector] lane values:', info.values);
    expect(info.values.length).toBe(4);
    expect(Number(info.values[1])).toBeCloseTo(0.64, 1);
    expect(Number(info.values[0])).toBe(0);
    expect(Number(info.values[2])).toBe(0);
    expect(Number(info.values[3])).toBe(0);
  });
});
