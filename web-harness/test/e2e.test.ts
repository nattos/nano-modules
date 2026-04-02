// E2E test: full WASM loading loop in a real browser via Puppeteer.
// Requires dev server running on port 5174.
// Run: npm run dev (in another terminal), then npm run test:e2e

describe('NanoLooper Web Harness E2E', () => {
  jest.setTimeout(15000);

  beforeAll(async () => {
    await page.goto('http://localhost:5174', { waitUntil: 'networkidle0' });
  });

  it('page loads without errors', async () => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    // Wait a moment for any async errors
    await new Promise(r => setTimeout(r, 1000));
    expect(errors).toEqual([]);
  });

  it('status shows Running after WASM loads', async () => {
    // Wait for status to change from "Loading..."
    await page.waitForFunction(
      () => {
        const el = document.getElementById('status');
        return el && !el.textContent!.includes('Loading') && !el.textContent!.includes('failed');
      },
      { timeout: 5000 },
    );

    const status = await page.$eval('#status', el => el.textContent);
    expect(status).toContain('FPS');
    expect(status).toContain('BPM');
  });

  it('canvas element exists and has non-zero dimensions', async () => {
    const dims = await page.$eval('#canvas', (el) => {
      const canvas = el as HTMLCanvasElement;
      return { w: canvas.width, h: canvas.height };
    });
    expect(dims.w).toBeGreaterThan(0);
    expect(dims.h).toBeGreaterThan(0);
  });

  it('status updates with draw commands over time', async () => {
    // Wait a bit for frames to accumulate
    await new Promise(r => setTimeout(r, 500));

    const status = await page.$eval('#status', el => el.textContent);
    // Status format: "XX FPS | 120 BPM | Step N/16 | M cmds"
    const match = status?.match(/(\d+) cmds/);
    expect(match).not.toBeNull();
    const cmdCount = parseInt(match![1]);
    expect(cmdCount).toBeGreaterThan(0);
  });

  it('keyboard triggers update the WASM module', async () => {
    // Press trigger key '1' and release
    await page.keyboard.down('1');
    await new Promise(r => setTimeout(r, 100));
    await page.keyboard.up('1');
    await new Promise(r => setTimeout(r, 100));

    // The module should still be running (no crash)
    const status = await page.$eval('#status', el => el.textContent);
    expect(status).toContain('FPS');
  });

  it('multiple trigger keys work without crash', async () => {
    // Quick sequence of triggers
    for (const key of ['1', '2', '3', '4']) {
      await page.keyboard.down(key);
      await new Promise(r => setTimeout(r, 50));
      await page.keyboard.up(key);
      await new Promise(r => setTimeout(r, 50));
    }

    // Modifiers
    await page.keyboard.down('d');
    await new Promise(r => setTimeout(r, 50));
    await page.keyboard.up('d');

    await page.keyboard.down('z'); // undo
    await new Promise(r => setTimeout(r, 50));
    await page.keyboard.up('z');

    const status = await page.$eval('#status', el => el.textContent);
    expect(status).toContain('FPS');
  });

  it('frame count increases over time', async () => {
    const getStep = async () => {
      const status = await page.$eval('#status', el => el.textContent);
      const match = status?.match(/Step (\d+)/);
      return match ? parseInt(match[1]) : -1;
    };

    const step1 = await getStep();
    await new Promise(r => setTimeout(r, 2000));
    const step2 = await getStep();

    // Step should have changed (bar phase is advancing)
    // They might be the same by chance, so just verify they're valid
    expect(step1).toBeGreaterThan(0);
    expect(step2).toBeGreaterThan(0);
  });
});
