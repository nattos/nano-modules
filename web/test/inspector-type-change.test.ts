/**
 * Regression: changing an effect's TYPE must swap its inspector live (no reload).
 * The "add effect" flow inserts a default color.tone.brightness_contrast (which uses
 * the GENERIC inspector — it has no custom widget) and the user then changes the
 * type; the inspector cache was keyed only on instanceKey, so a custom inspector
 * could persist across a type change. Drives the real effects IDE through
 * add → change-type (including a custom→custom swap) and asserts the correct
 * inspector mounts live.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

const hasTag = (tag: string) => page.evaluate(`(() => {
  ${WALK}
  for (const el of walk(document)) if (el.tagName === '${tag}') return true;
  return false;
})()`) as Promise<boolean>;

describe('effect type-change swaps the custom inspector (no reload)', () => {
  jest.setTimeout(60000);

  it('add default brightness_contrast → change type swaps inspectors live', async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3500));

    // Empty project, opened in the project editor.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['proj_tc'] = { anchor: null, chain: [], wires: [], instances: {} };
      });
      ac.selectProject('proj_tc');
      ac.setUserSetting('ideLeftTab', 'project_editor');
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    // "Add effect" inserts the default brightness_contrast — generic inspector,
    // no custom widget for either effect type yet.
    await page.evaluate(`window.appController.addEffectToChain('proj_tc', 0, 0, 'color.tone.brightness_contrast')`);
    await new Promise(r => setTimeout(r, 1200));
    expect(await hasTag('ENVELOPE-GRAPH')).toBe(false);
    expect(await hasTag('MOD-SPECTRAL-INSPECTOR')).toBe(false);

    // Change the type to mod.shaper.envelope (same instanceKey) → its custom graph mounts.
    await page.evaluate(`window.appController.changeEffectType('proj_tc', 0, 0, 'mod.shaper.envelope')`);
    await new Promise(r => setTimeout(r, 1500));
    expect(await hasTag('ENVELOPE-GRAPH')).toBe(true);

    // Change again to mod.shaper.spectral — a custom→custom swap, the exact cache bug:
    // the envelope graph must go out and the spectral inspector come in.
    await page.evaluate(`window.appController.changeEffectType('proj_tc', 0, 0, 'mod.shaper.spectral')`);
    await new Promise(r => setTimeout(r, 1800));
    expect(await hasTag('MOD-SPECTRAL-INSPECTOR')).toBe(true);
    expect(await hasTag('ENVELOPE-GRAPH')).toBe(false);
  });
});
