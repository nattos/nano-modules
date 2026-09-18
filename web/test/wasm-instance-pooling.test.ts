/**
 * WASM instance pooling — capacity E2E (resolume shell, playground mode).
 *
 * Chrome hard-caps LIVE WebAssembly memories at 100 per RENDERER PROCESS: a
 * count cap, shared by the main thread and every worker, that no declared
 * memory maximum moves. With one WASM instance per chain entry, any session
 * past ~90 live effects fell over with
 *
 *   RangeError: WebAssembly.instantiate(): Out of memory:
 *   Cannot allocate Wasm memory for new instance
 *
 * which is exactly what the offline engine hits — it simulates every cached
 * instance at once, so the budget is summed across all of them.
 *
 * This stands up FAR more concurrent effect instances than that budget (12
 * playground instances × 12 effects = 144, all rendering every frame) and
 * asserts (a) nothing failed to instantiate and (b) the sketches actually
 * render, rather than silently degrading to the create-failure passthrough.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const SKETCHES = 24;
const PER_SKETCH = 16;

describe('WASM instance pooling', () => {
  jest.setTimeout(180000);

  it('runs far more concurrent effect instances than Chrome\'s 100-memory cap', async () => {
    page.removeAllListeners('console');
    const errors: string[] = [];
    page.on('console', (m: any) => {
      const t = m.text();
      if (/instance create failed|Out of memory|Cannot allocate Wasm memory/.test(t)) errors.push(t);
    });

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    const built = await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const keys = [];
      for (let i = 0; i < ${SKETCHES}; i++) keys.push(ac.createPlaygroundInstance());
      // A mix of types, so this exercises BOTH axes: many instances of one type
      // sharing a pool, and many distinct types each holding one.
      // Colour-preserving on purpose: the chain must still read green at the
      // end, so a silently-dead instance can't hide behind a plausible tint.
      const types = [
        'color.tone.brightness_contrast', 'color.exposure', 'color.space',
        'mod.source.lfo', 'mod.shaper.curve', 'util.sidechannel_out',
      ];
      ac.mutate('seed pooling load', d => {
        for (let s = 0; s < keys.length; s++) {
          const sk = d.sketches[keys[s]];
          sk.chain.push({ type: 'module', module_type: 'source.solid_color',
                          instance_key: 'src@' + s });
          sk.instances['src@' + s] = { module_type: 'source.solid_color',
                                       state: { color: [0.1, 0.9, 0.1, 1] } };
          for (let e = 0; e < ${PER_SKETCH} - 1; e++) {
            const mt = types[(s + e) % types.length];
            const key = 'fx' + s + '_' + e;
            sk.chain.push({ type: 'module', module_type: mt, instance_key: key });
            sk.instances[key] = { module_type: mt, state: {} };
          }
        }
      });
      ac.selectBarrelInstance(keys[0]);
      ac.setActiveTab('edit');
      return { keys, wanted: keys.length * ${PER_SKETCH} };
    })()`) as { keys: string[]; wanted: number };

    // Let every sketch instantiate and render a few frames. Instance creation is
    // async (one WebAssembly.instantiate per pool), so this needs real time.
    await new Promise(r => setTimeout(r, 30000));

    expect(errors).toEqual([]);

    // The edit preview must still show the source green at the END of a
    // 12-deep chain — the transparent passthrough a failed instance falls back
    // to shows the monitor's flat grey checkerboard instead.
    const mean = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let monitor = null;
      for (const el of walk(document)) { if (el.tagName === 'SKETCH-MONITOR') { monitor = el; break; } }
      let canvas = null;
      if (monitor?.shadowRoot) {
        for (const el of walk(monitor.shadowRoot)) { if (el.tagName === 'CANVAS') { canvas = el; break; } }
      }
      if (!canvas) return null;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
      return n ? { r: r / n, g: g / n, b: b / n, n } : null;
    })()`) as { r: number; g: number; b: number; n: number } | null;

    console.log(`[pooling] ${built.wanted} concurrent effect instances across `
      + `${built.keys.length} sketches; preview mean = ${JSON.stringify(mean)}`);
    // Tear the load back down BEFORE asserting: jest-puppeteer shares one page
    // across suites, and leaving 384 effects rendering starves whatever runs
    // next (it shows up as unrelated suites timing out on fixed waits).
    await page.evaluate(`(() => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    // ...and unload the app entirely, so the engine worker, its GPU device and
    // every pooled WASM instance are gone before the next suite boots. Without
    // this the load bleeds into whatever runs next, which shows up as unrelated
    // fixed-wait UI suites timing out.
    await page.goto('about:blank');
    await new Promise(r => setTimeout(r, 1500));

    expect(mean).not.toBeNull();
    // Flat grey (r ≈ g ≈ b) is the transparent checkerboard — i.e. the chain
    // died. Green dominance proves every stage really ran.
    expect(mean!.g - mean!.r).toBeGreaterThan(60);
    expect(mean!.g - mean!.b).toBeGreaterThan(60);
  });
});
