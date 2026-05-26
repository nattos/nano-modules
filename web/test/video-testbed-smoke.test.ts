/**
 * Smoke test for video-testbed.html — just confirms the page loads,
 * boots WebGPU + the playback service, and exits its boot path without
 * runtime errors. UI interactions (drop, scrub, playhead) are not
 * exercised here; the underlying service has its own E2E coverage.
 */

const URL = 'http://localhost:5173/video-testbed.html';

describe('Video testbed smoke', () => {
  jest.setTimeout(30_000);

  it('boots without runtime errors', async () => {
    const errors: string[] = [];
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('pageerror', err => errors.push(String(err)));
    page.on('console', msg => {
      const t = msg.text();
      if (msg.type() !== 'error') return;
      // Browser logs a generic "Failed to load resource" for any 404
      // (favicon etc.). Filter those — they're benign and don't carry
      // the URL in the console message.
      if (t.includes('Failed to load resource')) return;
      errors.push(`[console] ${t}`);
    });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    // Give the inline module a moment to settle through its top-level
    // awaits (WebGPU adapter request).
    await new Promise(r => setTimeout(r, 800));
    // Drop zone should still be visible (no clip dropped) — proves we
    // reached the steady waiting state.
    const dropDisplay = await page.evaluate(() => {
      const el = document.getElementById('drop');
      return el ? window.getComputedStyle(el).display : null;
    });
    expect(dropDisplay).toBe('block');
    expect(errors.filter(e => !e.includes('favicon'))).toEqual([]);
  });
});
