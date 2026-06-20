/**
 * Regression: changing an effect's TYPE must swap its custom inspector. The
 * "add effect" flow inserts a default video.brightness_contrast and then changes
 * the type (reusing the instanceKey); the inspector cache was keyed only on
 * instanceKey, so a newly-added mod.envelope/mod.spectral/data.spectral_lfo kept
 * showing the brightness_contrast widget until a reload. Drives the real effects
 * IDE through add → change-type and asserts the correct inspector mounts live.
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

  it('add default brightness_contrast → change to mod.envelope shows the envelope graph', async () => {
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

    // "Add effect" inserts the default brightness_contrast.
    await page.evaluate(`window.appController.addEffectToChain('proj_tc', 0, 0, 'video.brightness_contrast')`);
    await new Promise(r => setTimeout(r, 1200));
    expect(await hasTag('BC-INSPECTOR')).toBe(true);          // default widget shown
    expect(await hasTag('ENVELOPE-GRAPH')).toBe(false);

    // Change the type to mod.envelope (same instanceKey).
    await page.evaluate(`window.appController.changeEffectType('proj_tc', 0, 0, 'mod.envelope')`);
    await new Promise(r => setTimeout(r, 1500));

    // The inspector must swap live — envelope graph in, brightness_contrast out.
    expect(await hasTag('ENVELOPE-GRAPH')).toBe(true);
    expect(await hasTag('BC-INSPECTOR')).toBe(false);
  });

  it('also swaps to mod.spectral (custom inspector reused from spectral_lfo)', async () => {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3500));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => { d.sketches['proj_tc2'] = { anchor: null, chain: [], wires: [], instances: {} }; });
      ac.selectProject('proj_tc2');
      ac.setUserSetting('ideLeftTab', 'project_editor');
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    await page.evaluate(`window.appController.addEffectToChain('proj_tc2', 0, 0, 'video.brightness_contrast')`);
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(`window.appController.changeEffectType('proj_tc2', 0, 0, 'mod.spectral')`);
    await new Promise(r => setTimeout(r, 1800));

    expect(await hasTag('MOD-SPECTRAL-INSPECTOR')).toBe(true);
    expect(await hasTag('BC-INSPECTOR')).toBe(false);
  });
});
