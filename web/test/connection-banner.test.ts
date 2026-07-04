/**
 * Mode-switch offer banners E2E (resolume shell).
 *
 * Requires nothing listening on the barrel port (ws://localhost:8081) — true
 * in CI/dev unless a real NanoBarrel is up, in which case these assertions
 * are meaningless anyway.
 *
 * - Barrel mode with no server: the "switch to Playground?" offer appears
 *   after the 4s grace window, and dismissing it sticks for the session.
 * - Playground with no server: no offer at all (guards inverted logic).
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const findBanner = `(() => {
  function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
  for (const el of walk(document)) {
    if (el.tagName === 'SKETCH-APP') {
      const b = el.shadowRoot.querySelector('.offer-banner');
      return b ? b.textContent.replace(/\\s+/g, ' ').trim() : null;
    }
  }
  return null;
})()`;

describe('connection offer banners', () => {
  jest.setTimeout(60000);

  it('barrel mode offers the playground when the server is unreachable; dismiss sticks', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });

    // Inside the grace window: no banner yet.
    const early = await page.evaluate(findBanner);
    expect(early).toBeNull();

    // Past the 4s grace window: the offer shows.
    await new Promise(r => setTimeout(r, 6000));
    const offered = await page.evaluate(findBanner);
    expect(offered).toContain("Can't reach Resolume");
    expect(offered).toContain('Switch to Playground');

    // Dismiss → gone, and stays gone (sessionStorage).
    await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'SKETCH-APP') {
          el.shadowRoot.querySelector('.offer-banner .dismiss').click();
        }
      }
    })()`);
    await new Promise(r => setTimeout(r, 300));
    expect(await page.evaluate(findBanner)).toBeNull();
    await new Promise(r => setTimeout(r, 5000));
    expect(await page.evaluate(findBanner)).toBeNull();
  });

  it('playground shows no offer when no server is up', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 6000));
    expect(await page.evaluate(findBanner)).toBeNull();
  });
});
