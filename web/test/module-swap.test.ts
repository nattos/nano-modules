/**
 * The engine swaps a bundle when its winning copy moves (Settings → Modules: a
 * dev folder checked or unchecked), and forgets one no folder provides.
 *
 * Before: the worker cached bundles by URL and skipped any bundle id it already
 * had, so checking a dev folder loaded its copy only for NEW instances, and
 * unchecking it changed nothing until restart. Now `loadModule` with the same
 * id at a different URL swaps in place and republishes that bundle's WHOLE
 * effect list (the picker drops what the new copy lacks), and `unloadModule`
 * removes it.
 *
 * Driven at the worker directly, with two URLs of the testonly bundle standing
 * in for "the deployed copy" and "the dev copy" of one bundle id (every other
 * real bundle is already loaded at boot, under its own id) — so it never
 * touches the machine's real module-paths.json, which the dev server's
 * /__nano/modules endpoint would write.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const effectsOf = (bundle: string) => page.evaluate(
  (b) => (window as any).appState.local.availableEffects
    .filter((e: any) => e.bundle === b).map((e: any) => e.id).sort(),
  bundle) as Promise<string[]>;

const send = (cmd: object) => page.evaluate(
  (c) => { (window as any).appController.engine.send(c); }, cmd as any);

async function waitFor<T>(probe: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  let v = await probe();
  while (!ok(v) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 200));
    v = await probe();
  }
  return v;
}

describe('module swap: one bundle id, its winning copy moves', () => {
  jest.setTimeout(90000);

  it('swaps the loaded copy, republishes its effects, and unloads it', async () => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));

    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => (window as any).appState?.local?.availableEffects?.length > 0,
      { timeout: 30000 });

    const ID = 'com.nano.swaptest';
    // "Deployed": the testonly bundle under an id nothing else uses.
    await send({ type: 'loadModule', moduleType: ID, url: '/wasm/testonly.wasm' });
    const deployed = await waitFor(() => effectsOf(ID), (v) => v.length > 0);
    expect(deployed).toContain('debug.clear_copy_test');

    // "Dev folder checked": same id, another copy.
    const DEV = '/wasm/testonly.wasm?copy=dev';
    await send({ type: 'loadModule', moduleType: ID, url: DEV });
    await waitFor(async () => logs.some((l) => l.includes(`✔ reloaded ${DEV}`)), (v) => v);
    expect(logs.some((l) => l.includes(`swapping /wasm/testonly.wasm for ${DEV}`))).toBe(true);
    expect(await effectsOf(ID)).toEqual(deployed);

    // "Unchecked": back to the deployed copy.
    await send({ type: 'loadModule', moduleType: ID, url: '/wasm/testonly.wasm' });
    await waitFor(async () => logs.some((l) => l.includes(`swapping ${DEV} for /wasm/testonly.wasm`)),
      (v) => v);
    expect(await effectsOf(ID)).toEqual(deployed);

    // Asking again for the copy it already has is a no-op, not a reload.
    const swapsBefore = logs.filter((l) => l.includes('[wasm-hmr] worker swapping')).length;
    await send({ type: 'loadModule', moduleType: ID, url: '/wasm/testonly.wasm' });
    await new Promise(r => setTimeout(r, 800));
    expect(logs.filter((l) => l.includes('[wasm-hmr] worker swapping')).length).toBe(swapsBefore);

    // No folder provides it any more: gone from the picker.
    await page.evaluate((id) => (window as any).appController.unloadModule(id), ID);
    expect(await waitFor(() => effectsOf(ID), (v) => v.length === 0)).toEqual([]);

    expect(errors).toEqual([]);
  });
});
