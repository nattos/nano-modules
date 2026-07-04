/**
 * Playground instances E2E (resolume shell, playground mode).
 *
 * The playground is a local stand-in for the shared NanoBarrel server: fake
 * instances (one sketch each) that ALL run simultaneously in the worker,
 * persisted in their own IndexedDB store. This drives the real UI-adjacent
 * paths: create two instances, give each a distinct effect, assert both are
 * live in the engine at once, reload and assert they persisted — and that
 * the effect-IDE `projects` store never saw any of it.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('playground instances', () => {
  jest.setTimeout(90000);

  it('creates, runs simultaneously, persists across reload; projects untouched', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // Start from a clean playground (previous runs may have left instances).
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    await new Promise(r => setTimeout(r, 800));

    // Create two instances and give each a solid_color chain.
    const created = await page.evaluate(`(async () => {
      const ac = window.appController;
      const a = ac.createPlaygroundInstance();
      const b = ac.createPlaygroundInstance();
      ac.mutate('seed colors', d => {
        d.sketches[a].chain.push({ type: 'module', module_type: 'source.solid_color', instance_key: 'solid_a@1' });
        d.sketches[a].instances['solid_a@1'] = { module_type: 'source.solid_color', state: { color: [1, 0, 0, 1] } };
        d.sketches[b].chain.push({ type: 'module', module_type: 'source.solid_color', instance_key: 'solid_b@1' });
        d.sketches[b].instances['solid_b@1'] = { module_type: 'source.solid_color', state: { color: [0, 1, 0, 1] } };
      });
      return { a, b, labels: window.appState.local.barrelInstances.map(i => i.label) };
    })()`);
    expect((created as any).labels).toEqual(['Instance 1', 'Instance 2']);

    // Both instances' sketches AND their effect instances are live in the
    // worker at the same time (the whole point of the playground).
    await new Promise(r => setTimeout(r, 2500));
    const dump = await page.evaluate(`window.debugDumpEngineState()`);
    const { a, b } = created as any;
    expect(Object.keys((dump as any).sketches)).toEqual(expect.arrayContaining([a, b]));
    expect((dump as any).instances['solid_a@1']?.exists).toBe(true);
    expect((dump as any).instances['solid_b@1']?.exists).toBe(true);

    // Let the debounced persistence flush, then reload and check everything
    // came back — and that the effect-IDE projects store stayed silent.
    await new Promise(r => setTimeout(r, 1200));
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    const after = await page.evaluate(`(async () => {
      const idb = await window.debugDumpIdb();
      return {
        labels: window.appState.local.barrelInstances.map(i => i.label).sort(),
        keys: window.appState.local.barrelInstances.map(i => i.key).sort(),
        sketchIds: Object.keys(window.appState.database.sketches).sort(),
        pgProjectRecords: idb.projects.filter(p => p.id.startsWith('pg:')).length,
      };
    })()`);
    expect((after as any).labels).toEqual(['Instance 1', 'Instance 2']);
    expect((after as any).keys).toEqual([a, b].sort());
    expect((after as any).sketchIds).toEqual(expect.arrayContaining([a, b]));
    // The playground must never write into the effect-IDE projects store.
    expect((after as any).pgProjectRecords).toBe(0);

    // Cleanup so reruns and other suites start from an empty playground.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    await new Promise(r => setTimeout(r, 800));
  });
});
