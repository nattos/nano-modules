/**
 * Mode-switch offer snackbars E2E (resolume shell).
 *
 * Requires nothing listening on the barrel port (ws://localhost:8081) — true
 * in CI/dev unless a real NanoBarrel is up, in which case these assertions
 * are meaningless anyway.
 *
 * - Barrel/Live mode with no server: the "switch to Playground?" offer
 *   appears after the 4s grace window, and dismissing it sticks for the
 *   session. (Live mode ALSO shows its own separate "edit offline?" offer
 *   around 5s — see `resolume-app.ts`'s 5s connect timeout — so these checks
 *   target the specific "Can't reach Resolume" snackbar by text rather than
 *   asserting no snackbar exists at all.)
 * - Playground with no server: no "switch to Playground" offer at all
 *   (guards inverted logic) — Playground has no connect-timeout offer either.
 *
 * Uses `?barrel`/`?playground` boot-time overrides (see `modeOverrideFromUrl`
 * in `resolume-mode.ts`) rather than a bare URL, since mode is now decided by
 * the persisted `appMode` setting absent an override — a bare URL on a fresh
 * profile would boot Effect Dev, not Live.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

/** All snackbar-bar texts currently shown, across every open snackbar. */
const snackbarTexts = `(() => {
  function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
  for (const el of walk(document)) {
    if (el.tagName === 'SNACKBAR-HOST') {
      return [...el.shadowRoot.querySelectorAll('.bar')]
        .map(b => b.textContent.replace(/\\s+/g, ' ').trim());
    }
  }
  return [];
})()`;

/** Click the close (✕) button of the bar containing `needle`, if any. */
const dismissSnackbarContaining = (needle: string) => `(() => {
  function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
  for (const el of walk(document)) {
    if (el.tagName === 'SNACKBAR-HOST') {
      for (const bar of el.shadowRoot.querySelectorAll('.bar')) {
        if (bar.textContent.includes(${JSON.stringify(needle)})) {
          bar.querySelector('.close').click();
          return true;
        }
      }
    }
  }
  return false;
})()`;

describe('connection offer snackbars', () => {
  jest.setTimeout(60000);

  it('barrel/Live mode offers the playground when the server is unreachable; dismiss sticks', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html?barrel`, { waitUntil: 'networkidle0' });

    // Inside the grace window: no offer yet.
    const early = await page.evaluate(snackbarTexts);
    expect(early.some((t: string) => t.includes("isn't answering"))).toBe(false);

    // Past the 4s grace window: the offer shows. Matched on text unique to
    // THIS offer — the separate 5s connect-timeout "edit offline?" snackbar
    // (state/live-reconcile.ts flow) also starts with "Can't reach Resolume"
    // and may appear alongside it, but is a distinct, independently-tracked
    // snackbar this test doesn't touch.
    await new Promise(r => setTimeout(r, 4500));
    const offered = await page.evaluate(snackbarTexts);
    const offerText = offered.find((t: string) => t.includes("isn't answering"));
    expect(offerText).toContain('Switch to Playground');

    // Dismiss → gone, and stays gone (sessionStorage) — regardless of the
    // separate 5s "edit offline?" offer also being up by then.
    await page.evaluate(dismissSnackbarContaining("isn't answering"));
    await new Promise(r => setTimeout(r, 300));
    expect((await page.evaluate(snackbarTexts)).some((t: string) => t.includes("isn't answering"))).toBe(false);
    await new Promise(r => setTimeout(r, 5000));
    expect((await page.evaluate(snackbarTexts)).some((t: string) => t.includes("isn't answering"))).toBe(false);
  });

  it('playground shows no offer when no server is up', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 6000));
    expect((await page.evaluate(snackbarTexts)).some((t: string) => t.includes("isn't answering"))).toBe(false);
  });
});
