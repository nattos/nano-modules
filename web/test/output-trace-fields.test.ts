/**
 * Per-output texture thumbnails on an effect card.
 *
 * An effect card shows one trace thumbnail per output. The texture ones used
 * to all trace the chain entry's output — the stage's PRIMARY texture — so a
 * second texture output previewed the primary's pixels. Each non-primary
 * output now names its field in the trace target.
 *
 * `debug.secondary_output` (testonly) makes the mix-up visible: its primary is
 * solid red, its `side_out` solid blue.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

/** Centre pixel of each output card's thumbnail, keyed by output field. */
const thumbs = `(() => { ${WALK}
  const out = {};
  for (const el of walk(document)) {
    if (el.tagName !== 'OUTPUT-TRACE-CARD') continue;
    let canvas = null;
    for (const c of walk(el.shadowRoot)) if (c.tagName === 'CANVAS') { canvas = c; break; }
    const ctx = canvas && canvas.width > 0 ? canvas.getContext('2d') : null;
    const px = ctx ? Array.from(ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data) : null;
    out[el.fieldPath] = { px, field: el.traceTarget ? el.traceTarget.field ?? null : null };
  }
  return out;
})()`;

describe('output trace thumbnails', () => {
  jest.setTimeout(60000);

  it('previews each texture output from its own field, not the primary', async () => {
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(`(() => {
      const ac = window.appController;
      ac.mutate('seed', d => {
        d.sketches['sk_outs'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'debug.secondary_output', instance_key: 'so@0' }],
          instances: { 'so@0': { module_type: 'debug.secondary_output', state: {} } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_outs');
      ac.setTappingMode(false);
    })()`);

    // Poll until both thumbnails show their colours: the first frames can
    // still be blank while the instance comes up.
    let t: any = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      t = await page.evaluate(thumbs);
      if (t?.tex_out?.px?.[0] > 200 && t?.side_out?.px?.[2] > 200) break;
    }
    expect(t?.tex_out?.px).toBeTruthy();
    expect(t?.side_out?.px).toBeTruthy();

    // The primary traces the chain entry itself; the other output names its field.
    expect(t.tex_out.field).toBeNull();
    expect(t.side_out.field).toBe('side_out');

    const [r0, g0, b0] = t.tex_out.px;
    expect(r0).toBeGreaterThan(200);
    expect(g0).toBeLessThan(40);
    expect(b0).toBeLessThan(40);
    // The regression: this showed the primary's red.
    const [r1, g1, b1] = t.side_out.px;
    expect(b1).toBeGreaterThan(200);
    expect(r1).toBeLessThan(40);
    expect(g1).toBeLessThan(40);
  });
});
