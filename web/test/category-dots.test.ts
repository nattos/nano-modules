/**
 * Per-category accent dots render in effect-card headers with the colour mapped
 * from each effect's taxonomy domain (the first id segment). Verifies the
 * style.css var → category-color helper → inline style wiring resolves.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('effect-card category dots', () => {
  jest.setTimeout(60000);

  it('colours each header dot by the effect domain', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_dots'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'source.solid_color', instance_key: 'sc@0' },
            { type: 'module', module_type: 'color.invert', instance_key: 'inv@0' },
            { type: 'module', module_type: 'composite.blend', instance_key: 'bl@0' },
          ],
          wires: [],
          instances: {
            'sc@0': { module_type: 'source.solid_color', state: {} },
            'inv@0': { module_type: 'color.invert', state: {} },
            'bl@0': { module_type: 'composite.blend', state: {} },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_dots');
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    const dotColors = await page.evaluate(`(() => {
      ${WALK}
      const out = [];
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('effect-cat-dot')) {
          out.push({ title: el.getAttribute('title'), bg: getComputedStyle(el).backgroundColor });
        }
      }
      return out;
    })()`) as Array<{ title: string; bg: string }>;

    const byDomain: Record<string, string> = {};
    for (const d of dotColors) byDomain[d.title] = d.bg.replace(/\s+/g, '');

    // style.css: --app-cat-source #5BC8A0, --app-cat-color #E3B341, --app-cat-composite #E06B9A
    expect(byDomain['source']).toBe('rgb(91,200,160)');
    expect(byDomain['color']).toBe('rgb(227,179,65)');
    expect(byDomain['composite']).toBe('rgb(224,107,154)');
  });
});
