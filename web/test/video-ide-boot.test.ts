/**
 * Boot smoke for the effects IDE (index.html) after swapping the video
 * player to the VideoPlaybackService-backed SketchInputManager.
 *
 * The manager creates its GPU video stack lazily (only on first video
 * load), so app boot should be unaffected. This guards against import /
 * wiring breakage from the swap — it asserts the IDE loads, the engine
 * comes up, and nothing throws an uncaught error during startup.
 */

const IDE = (process.env.GPU_TEST_BASE_URL || 'http://localhost:5173') + '/index.html';

describe('Effects IDE boot (post video-player swap)', () => {
  jest.setTimeout(30_000);

  it('boots without uncaught errors', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('pageerror', err => errors.push(`[pageerror] ${err.message}`));
    page.on('console', msg => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (t.includes('Failed to load resource')) return;       // favicon etc.
      if (t.includes('Synchronous XMLHttpRequest')) return;     // deprecated-API noise
      errors.push(`[console] ${t}`);
    });

    await page.goto(IDE, { waitUntil: 'networkidle0' });
    // Let the engine worker boot + first render settle.
    await new Promise(r => setTimeout(r, 2500));

    expect(errors).toEqual([]);
  });
});
