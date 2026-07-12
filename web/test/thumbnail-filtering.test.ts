/**
 * Thumbnail downsample filtering (resolume shell, playground mode).
 *
 * An Instances-tab card renders a 128x72 thumbnail of a sketch that is drawn at
 * full resolution — a large minification. It used to do that in ONE bilinear
 * pass, and a bilinear tap is only 2x2, so at that ratio it read a handful of
 * every few hundred source texels and effectively point-sampled. On an image with
 * pixel-level detail that aliases straight through: the thumbnail comes out
 * crunchy and boils frame to frame, instead of resolving to the image's average.
 *
 * White noise is the sharpest probe for it. Downsampled with a filter that
 * actually integrates the footprint, per-pixel noise averages towards mid-grey
 * and the thumbnail's spread COLLAPSES; point-sampled, each thumbnail pixel is
 * just some surviving source pixel and the spread survives nearly intact.
 *
 * So this measures the standard deviation of the thumbnail against the standard
 * deviation of the same noise rendered at full size. Filtering shows up as a
 * large drop; point sampling shows up as no drop at all.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

/** Mean + standard deviation of a canvas's luminance. */
const STATS_FN = `(canvas) => {
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const lum = [];
  for (let i = 0; i < d.length; i += 4) lum.push(0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]);
  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const varr = lum.reduce((a, b) => a + (b - mean) ** 2, 0) / lum.length;
  return { mean, sd: Math.sqrt(varr), w: canvas.width, h: canvas.height };
}`;

describe('texture trace thumbnails filter when downsampling', () => {
  jest.setTimeout(90000);

  it('white noise averages out in a thumbnail instead of aliasing', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // One instance: full-frame white noise, the worst case for a naive downscale.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const a = ac.createPlaygroundInstance();
      ac.mutate('seed noise', d => {
        d.sketches[a].chain.push(
          { type: 'module', module_type: 'source.noise', instance_key: 'noise@1' },
        );
        d.sketches[a].instances['noise@1'] = {
          module_type: 'source.noise',
          // White noise, no colour: a fresh independent value per pixel.
          state: { algorithm: 0, scale: 0.0, contrast: 0.0, color: 0.0, speed: 0.0 },
        };
      });
      ac.selectBarrelInstance(a);
      ac.setActiveTab('edit');
    })()`);
    await new Promise(r => setTimeout(r, 3500));

    // The edit tab's monitor renders the sketch at (near) full size — this is the
    // spread of the noise BEFORE any meaningful reduction, our reference.
    const full = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let canvas = null;
      for (const el of walk(document)) {
        if (el.tagName === 'SKETCH-MONITOR' && el.shadowRoot) {
          for (const c of walk(el.shadowRoot)) if (c.tagName === 'CANVAS') { canvas = c; break; }
        }
        if (canvas) break;
      }
      return canvas ? (${STATS_FN})(canvas) : null;
    })()`) as { mean: number; sd: number; w: number; h: number } | null;

    expect(full).not.toBeNull();
    // Sanity: this really is noise, not a flat fill — otherwise the whole
    // comparison below would pass vacuously.
    expect(full!.sd).toBeGreaterThan(30);

    // Now the Instances tab, whose cards carry the 128x72 thumbnails.
    await page.evaluate(`window.appController.setActiveTab('organize')`);
    await new Promise(r => setTimeout(r, 3000));

    const thumb = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.tagName === 'TEXTURE-MONITOR' && el.shadowRoot) {
          for (const c of walk(el.shadowRoot)) {
            if (c.tagName === 'CANVAS' && c.width > 0 && c.width <= 320) {
              return (${STATS_FN})(c);
            }
          }
        }
      }
      return null;
    })()`) as { mean: number; sd: number; w: number; h: number } | null;

    expect(thumb).not.toBeNull();

    // The thumbnail really is a large reduction (that's the premise).
    expect(thumb!.w).toBeLessThan(full!.w / 2);

    // Filtered: every source texel contributes, so the noise averages towards its
    // own mean and the spread collapses. Point-sampled, the thumbnail would just
    // be a sparse SAMPLE of the noise and keep essentially the source's spread —
    // which is exactly the crunch. Half the source spread is a generous bar; a
    // proper box/Lanczos reduction lands far below it.
    expect(thumb!.sd).toBeLessThan(full!.sd * 0.5);

    // It's averaging, not collapsing to black/white: the mean survives.
    expect(Math.abs(thumb!.mean - full!.mean)).toBeLessThan(25);
  });
});
