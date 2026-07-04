/**
 * Instances-tab grid E2E (resolume shell, playground mode).
 *
 * Two playground instances render different solid colors simultaneously; the
 * Instances tab shows a card grid where each card carries a live
 * `sketch_output` thumbnail of ITS OWN instance (trace id embeds the instance
 * key). Asserts each card's canvas is dominated by that instance's color —
 * proving per-instance trace routing, not just "some pixels arrived".
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('instances tab thumbnail grid', () => {
  jest.setTimeout(90000);

  it('shows each instance rendering its own color on its card', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // Clean playground, then two instances: A solid green, B solid red.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const a = ac.createPlaygroundInstance();
      const b = ac.createPlaygroundInstance();
      ac.mutate('seed grid colors', d => {
        d.sketches[a].chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'green@1' });
        d.sketches[a].instances['green@1'] =
          { module_type: 'source.solid_color', state: { color: [0.1, 0.9, 0.1, 1] } };
        d.sketches[b].chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'red@1' });
        d.sketches[b].instances['red@1'] =
          { module_type: 'source.solid_color', state: { color: [0.9, 0.1, 0.1, 1] } };
      });
      ac.setActiveTab('organize');
    })()`);
    await new Promise(r => setTimeout(r, 3500));

    // Each card: its label + the mean RGB of its thumbnail canvas.
    const cards = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let tab = null;
      for (const el of walk(document)) { if (el.tagName === 'ORGANIZE-TAB') { tab = el; break; } }
      if (!tab?.shadowRoot) return null;
      const out = [];
      for (const card of tab.shadowRoot.querySelectorAll('.instance-card')) {
        const name = card.querySelector('.card-name')?.textContent?.trim() ?? '';
        const mon = card.querySelector('texture-monitor');
        const canvas = mon?.shadowRoot?.querySelector('canvas');
        if (!canvas || !canvas.width) { out.push({ name, r: -1, g: -1, b: -1 }); continue; }
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
        out.push({ name, r: r / n, g: g / n, b: b / n });
      }
      return out;
    })()`) as Array<{ name: string; r: number; g: number; b: number }> | null;

    expect(cards).not.toBeNull();
    expect(cards!.length).toBe(2);
    const byName: Record<string, { r: number; g: number; b: number }> = {};
    for (const c of cards!) byName[c.name] = c;

    const green = byName['Instance 1'];
    const red = byName['Instance 2'];
    expect(green).toBeDefined();
    expect(red).toBeDefined();
    // Green card: green dominates both other channels.
    expect(green.g - green.r).toBeGreaterThan(60);
    expect(green.g - green.b).toBeGreaterThan(60);
    // Red card: red dominates — proves the two cards show DIFFERENT sketches.
    expect(red.r - red.g).toBeGreaterThan(60);
    expect(red.r - red.b).toBeGreaterThan(60);

    // Cleanup for reruns/other suites.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    await new Promise(r => setTimeout(r, 800));
  });
});
