/**
 * Drives the testbed page end-to-end via the __testbed hook and dumps a
 * screenshot. Not strictly a "test" — used to verify the page actually
 * renders something useful, and to capture an image for documentation.
 */
import * as fs from 'fs';

const URL = (process.env.GPU_TEST_BASE_URL || 'http://localhost:5173') + '/video-testbed.html';
const VIDEO = process.env.TESTBED_VIDEO || '/media/test_dxv.mov';
const OUT_PATH = process.env.TESTBED_OUT || '/tmp/gpu-test-dumps/video-testbed.png';

describe('Video testbed screenshot', () => {
  jest.setTimeout(45_000);

  it('loads a clip, runs the loop, and captures a screenshot', async () => {
    page.removeAllListeners('pageerror');
    page.removeAllListeners('console');
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('Failed to load resource')) return;
      if (t.includes('Synchronous XMLHttpRequest')) return;
      // eslint-disable-next-line no-console
      console.log(`[browser:${msg.type()}] ${t}`);
    });

    await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: 2 });
    await page.goto(URL, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => (window as any).__testbed?.service, { timeout: 30_000 });

    // Drive the load: fetch the test fixture in-page, wrap in a File,
    // hand to loadClip(). Mirrors what the drop handler does.
    await page.evaluate(async (video) => {
      const res = await fetch(video);
      const buf = await res.arrayBuffer();
      const name = video.split('/').pop() || 'clip';
      const type = name.endsWith('.mp4') ? 'video/mp4'
                 : name.endsWith('.webm') ? 'video/webm'
                 : 'video/quicktime';
      const file = new File([buf], name, { type });
      await (window as any).__testbed.loadClip(file);
    }, VIDEO);

    // Exercise a Loop mode for ~2 seconds so the timeline gets some
    // cached entries to visualize.
    await page.evaluate(() => {
      const t = (window as any).__testbed;
      t.setController('loop');
    });
    await new Promise(r => setTimeout(r, 2500));

    fs.mkdirSync('/tmp/gpu-test-dumps', { recursive: true });
    await page.screenshot({ path: OUT_PATH, fullPage: false });
    // eslint-disable-next-line no-console
    console.log(`[testbed] screenshot → ${OUT_PATH}`);

    // Basic assertion: a clip is loaded and the cache has entries.
    const info = await page.evaluate(() => {
      const t = (window as any).__testbed;
      return t.service.inspect(t.clip);
    });
    expect(info.cachedFrameIndices.length).toBeGreaterThan(0);
  });
});
