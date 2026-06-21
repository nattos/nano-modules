/**
 * Delayed-wire rendering E2E (resolume shell, local mode).
 *
 * A 1-frame-delayed (feedback) wire — source at/below its dest in the stack — is
 * drawn differently: output-pip red, split into two bezier halves that animate
 * ALTERNATELY (a relay), with a dot at the midpoint. A same-frame wire stays a
 * single blue arc. This guards the two-segment + dot structure and the
 * alternating animation hookup.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('delayed wire rendering', () => {
  jest.setTimeout(50000);

  it('renders a delayed wire as two alternating halves with a midpoint dot', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // bc ABOVE lfo, wire lfo.output -> bc.brightness: source is below dest -> delayed.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_d'] = {
          anchor: null,
          chain: [
            { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
            { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0' },
          ],
          wires: [{ id: 'wd', src: { instanceKey: 'lfo@0', field: 'output' },
                    dest: { instanceKey: 'bc@0', field: 'brightness' } }],
          instances: {
            'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 1, contrast: 0.25 } },
            'lfo@0': { module_type: 'mod.source.lfo', state: {} },
          },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_d');
      ac.setTappingMode(true);
    })()`);
    await new Promise(r => setTimeout(r, 1800));   // let the rAF position the arcs

    const r = await page.evaluate(`(() => {
      function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}
      let ov = null;
      for (const el of walk(document)) { if (el.tagName === 'TAPS-OVERLAY') { ov = el; break; } }
      if (!ov) return { found: false };
      const root = ov.shadowRoot;
      const segA = root.querySelector('.wire-arc.delayed.seg-a');
      const segB = root.querySelector('.wire-arc.delayed.seg-b');
      const dot = root.querySelector('circle.wire-dot');
      const cs = el => el ? getComputedStyle(el) : null;
      return {
        found: true,
        segA: !!segA, segB: !!segB, dot: !!dot,
        aAnim: cs(segA)?.animationName, bAnim: cs(segB)?.animationName,
        aD: segA?.getAttribute('d') || '',
        bD: segB?.getAttribute('d') || '',
        dotCx: dot?.getAttribute('cx'), dotCy: dot?.getAttribute('cy'),
        aStroke: cs(segA)?.stroke,
      };
    })()`) as any;

    expect(r.found).toBe(true);
    // Two distinct halves + a dot.
    expect(r.segA).toBe(true);
    expect(r.segB).toBe(true);
    expect(r.dot).toBe(true);
    // Each half is a positioned bezier (M…C…), and the dot sits between them.
    expect(r.aD).toMatch(/^M .* C /);
    expect(r.bD).toMatch(/^M .* C /);
    expect(r.aD).not.toBe(r.bD);
    expect(Number.isFinite(parseFloat(r.dotCx))).toBe(true);
    expect(Number.isFinite(parseFloat(r.dotCy))).toBe(true);
    // Alternating animations (the relay).
    expect(r.aAnim).toBe('wire-relay-a');
    expect(r.bAnim).toBe('wire-relay-b');
    // Output-pip red, not the same-frame blue (rgb(65,105,225)).
    expect(r.aStroke).not.toContain('65, 105, 225');
  });
});
