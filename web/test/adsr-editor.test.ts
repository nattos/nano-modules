/**
 * Custom-inspector E2E for data.adsr (resolume shell, local mode).
 *
 * Verifies the registered inspector mounts: the <adsr-graph> envelope editor
 * (which must DRAW the ADSR shape) plus the mode tab-bar, the phase/slope
 * sliders, and the trigger surface (gate toggle + trigger button).
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('data.adsr custom inspector', () => {
  jest.setTimeout(60000);

  it('mounts the envelope graph + controls and draws the curve', async () => {
    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3500));   // boot + nano bundle discovery

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_adsr'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'data.adsr', instance_key: 'adsr@0' }],
          wires: [],
          instances: { 'adsr@0': { module_type: 'data.adsr', state: { mode: 0, decay: 0.4 } } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_adsr');
    })()`);
    await new Promise(r => setTimeout(r, 2500));   // mount + rAF draw

    const info = await page.evaluate(`(() => {
      ${WALK}
      let insp = null, graph = null, tabbar = null, sliders = 0, toggle = false, trigger = false;
      for (const el of walk(document)) {
        if (el.tagName === 'ADSR-INSPECTOR') insp = el;
        if (el.tagName === 'ADSR-GRAPH') graph = el;
        if (el.tagName === 'FIELD-TAB-BAR') tabbar = el;
        if (el.tagName === 'SCALAR-SLIDER') sliders++;
        if (el.tagName === 'FIELD-TOGGLE') toggle = true;
        if (el.tagName === 'FIELD-TRIGGER') trigger = true;
      }
      let curvePixels = 0;
      if (graph) {
        const canvas = graph.shadowRoot.querySelector('canvas');
        if (canvas && canvas.width > 0) {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          // background is ~ rgba(0,0,0,0.25) over the panel; count clearly-lit pixels
          // (the accent curve stroke + fill).
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] + data[i + 1] + data[i + 2] > 90 && data[i + 3] > 40) curvePixels++;
          }
        }
      }
      return { insp: !!insp, graph: !!graph, tabbar: !!tabbar, sliders, toggle, trigger, curvePixels };
    })()`) as any;

    expect(info.insp).toBe(true);          // the custom inspector mounted
    expect(info.graph).toBe(true);         // the envelope graph mounted
    expect(info.tabbar).toBe(true);        // mode selector
    expect(info.sliders).toBeGreaterThanOrEqual(8);  // phase + slope + voices + auto_rate
    expect(info.toggle).toBe(true);        // gate
    expect(info.trigger).toBe(true);       // trigger button
    expect(info.curvePixels).toBeGreaterThan(50);    // the ADSR shape is drawn
  });
});
