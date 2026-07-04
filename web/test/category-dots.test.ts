/**
 * Per-category accent colours render in effect-card headers, mapped from each
 * effect's taxonomy domain (the first id segment). Since the per-effect picker
 * glyph ABI (2026-07), every effect declares an icon, so the header glyph is a
 * category-TINTED <ui-icon> (`--icon-color`) rather than the old plain colour
 * dot — the dot remains only as the fallback for icon-less effects. This
 * verifies the style.css var → category-color helper → inline tint wiring.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('effect-card category accents', () => {
  jest.setTimeout(60000);

  it('tints each header glyph by the effect domain', async () => {
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

    const accents = await page.evaluate(`(() => {
      ${WALK}
      const out = [];
      for (const el of walk(document)) {
        if (!el.classList) continue;
        if (el.classList.contains('effect-glyph')) {
          // <ui-icon> glyph: the accent rides the --icon-color inline style as
          // a var(--app-cat-<domain>) reference; read the COMPUTED custom
          // property so the var chain resolves to the actual colour.
          out.push({ title: el.getAttribute('title'),
                     color: getComputedStyle(el).getPropertyValue('--icon-color').trim() });
        } else if (el.classList.contains('effect-cat-dot')) {
          // Fallback dot for icon-less effects: accent is the background.
          out.push({ title: el.getAttribute('title'),
                     color: getComputedStyle(el).backgroundColor.replace(/\\s+/g, '') });
        }
      }
      return out;
    })()`) as Array<{ title: string; color: string }>;

    const byDomain: Record<string, string> = {};
    for (const a of accents) byDomain[a.title] = a.color.toLowerCase();

    // style.css: --app-cat-source #5BC8A0, --app-cat-color #E3B341, --app-cat-composite #E06B9A
    const norm = (c: string) => c.replace(/\s+/g, '').toLowerCase();
    expect([norm('#5BC8A0'), 'rgb(91,200,160)']).toContain(byDomain['source']);
    expect([norm('#E3B341'), 'rgb(227,179,65)']).toContain(byDomain['color']);
    expect([norm('#E06B9A'), 'rgb(224,107,154)']).toContain(byDomain['composite']);
  });
});
