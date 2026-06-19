/**
 * Custom-inspector E2E for data.spectral_lfo (resolume shell, local mode).
 *
 * Verifies the registered inspector mounts on the effect card, the XY-pad
 * renders its t-SNE scatter canvas + handle, and dragging the pad writes
 * morph_x / morph_y (one continuous multi-field edit, like the *_fold pads).
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('spectral_lfo custom inspector', () => {
  jest.setTimeout(50000);

  it('mounts the XY-pad with a scatter backdrop and drag writes morph_x/y', async () => {
    page.removeAllListeners('console');
    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_se'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'data.spectral_lfo', instance_key: 'slfo@0' },
          ],
          wires: [],
          instances: {
            'slfo@0': { module_type: 'data.spectral_lfo', state: { morph_x: 0.5, morph_y: 0.5 } },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_se');
    })()`);
    await new Promise(r => setTimeout(r, 2000));   // let the inspector mount + rAF draw

    // Locate the XY pad across nested shadow roots; report its geometry + that
    // the scatter canvas actually has backing pixels.
    const padInfo = await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      let pad = null;
      for (const el of walk(document)) { if (el.tagName === 'SPECTRAL-LFO-XY-PAD') { pad = el; break; } }
      if (!pad) return { found: false };
      const root = pad.shadowRoot;
      const padEl = root.querySelector('.pad');
      const canvas = root.querySelector('canvas.scatter');
      const handle = root.querySelector('.handle');
      const r = padEl.getBoundingClientRect();
      // Count non-transparent canvas pixels (scatter dots).
      let drawn = 0;
      if (canvas && canvas.width > 0) {
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) { drawn++; }
      }
      return { found: true, hasCanvas: !!canvas, canvasW: canvas?.width || 0,
               drawnPixels: drawn, hasHandle: !!handle,
               rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    })()`) as any;

    expect(padInfo.found).toBe(true);
    expect(padInfo.hasCanvas).toBe(true);
    expect(padInfo.canvasW).toBeGreaterThan(0);
    expect(padInfo.drawnPixels).toBeGreaterThan(100);   // the manifold scatter is painted
    expect(padInfo.hasHandle).toBe(true);

    // The envelope preview renders the morphed curve (needs the fetched data
    // asset). Count pixels that differ from the #111122 background.
    const previewInfo = await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      let pv = null;
      for (const el of walk(document)) { if (el.tagName === 'SPECTRAL-LFO-PREVIEW') { pv = el; break; } }
      if (!pv) return { found: false };
      const canvas = pv.shadowRoot.querySelector('canvas');
      if (!canvas || canvas.width === 0) return { found: true, canvasW: canvas?.width || 0, curvePixels: 0 };
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let curve = 0;
      for (let i = 0; i < data.length; i += 4) {
        // bg is (17,17,34); count clearly-different pixels (the curve strokes).
        if (Math.abs(data[i]-17) + Math.abs(data[i+1]-17) + Math.abs(data[i+2]-34) > 60) curve++;
      }
      return { found: true, canvasW: canvas.width, curvePixels: curve };
    })()`) as any;

    expect(previewInfo.found).toBe(true);
    expect(previewInfo.canvasW).toBeGreaterThan(0);
    expect(previewInfo.curvePixels).toBeGreaterThan(50);   // the envelope is drawn

    // Drag from center toward the top-left corner → morph_x down, morph_y up.
    const cx = padInfo.rect.x + padInfo.rect.w * 0.5;
    const cy = padInfo.rect.y + padInfo.rect.h * 0.5;
    const tx = padInfo.rect.x + padInfo.rect.w * 0.2;
    const ty = padInfo.rect.y + padInfo.rect.h * 0.2;   // screen-up = morph_y up
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 300));

    // Read the live values through the pad's own binding (the source of truth
    // it drives; stored state may omit values that equal the schema default).
    const vals = await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      for (const el of walk(document)) {
        if (el.tagName === 'SPECTRAL-LFO-XY-PAD' && el.binding) {
          return { x: el.binding.getValue('morph_x'), y: el.binding.getValue('morph_y') };
        }
      }
      return null;
    })()`) as any;

    expect(vals).toBeTruthy();
    expect(typeof vals.x).toBe('number');
    expect(vals.x).toBeLessThan(0.45);   // moved left of center
    expect(vals.y).toBeGreaterThan(0.55); // moved up from center
  });
});
