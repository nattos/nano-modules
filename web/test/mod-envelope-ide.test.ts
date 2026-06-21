/**
 * Regression: the mod.shaper.envelope custom inspector must mount in the EFFECTS IDE
 * (index.html → effect-ide-app), not only the resolume sketch shell. The IDE and
 * the shell registered custom editors via separate import lists, and the IDE's
 * list had drifted — so the envelope graph never appeared there. Both now share
 * editors/all-inspectors.ts. This loads the real IDE and asserts the graph mounts.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('mod.shaper.envelope inspector in the effects IDE', () => {
  jest.setTimeout(60000);

  it('mounts the envelope graph for a mod.shaper.envelope effect', async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3500));   // boot + bundle discovery

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['proj_env'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'mod.shaper.envelope', instance_key: 'env@0' }],
          wires: [],
          instances: { 'env@0': { module_type: 'mod.shaper.envelope', state: {} } },
        };
      });
      ac.selectProject('proj_env');
      ac.setUserSetting('ideLeftTab', 'project_editor');   // explorer does this on click
    })()`);
    await new Promise(r => setTimeout(r, 2500));   // mount + rAF draw

    const info = await page.evaluate(`(() => {
      ${WALK}
      let graph = null, inspector = null;
      for (const el of walk(document)) {
        if (el.tagName === 'ENVELOPE-GRAPH') graph = el;
        if (el.tagName === 'ENVELOPE-INSPECTOR') inspector = el;
      }
      if (!graph) return { graphFound: false, inspectorFound: !!inspector };
      const canvas = graph.shadowRoot.querySelector('canvas');
      let drawn = 0;
      if (canvas && canvas.width > 0) {
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) drawn++;
      }
      return { graphFound: true, inspectorFound: !!inspector,
               canvasW: canvas ? canvas.width : 0, drawn };
    })()`) as any;

    expect(info.inspectorFound).toBe(true);     // the custom inspector mounted
    expect(info.graphFound).toBe(true);         // …and rendered its envelope graph
    expect(info.canvasW).toBeGreaterThan(0);
    expect(info.drawn).toBeGreaterThan(50);     // the curve is painted
  });
});
