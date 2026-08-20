/**
 * Sidecar canvas E2E (resolume shell, playground mode).
 *
 * The canvas is a second <column-group> over the SAME sketch, rendering the
 * chain's canvas partition at stored placements while the list renders the rest.
 * These drive the real shell/panel/overlay paths: the partition split, the
 * cross-panel wire layer, the scroll link, and the proxy pips that stand in for
 * canvas cards while the canvas is closed.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

/** Walk every shadow root — the canvas lives several roots deep. */
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;
const findAll = (sel: string) => `(() => { ${WALK}
  const out = [];
  for (const el of walk(document)) if (el.matches && el.matches(${JSON.stringify(sel)})) out.push(el);
  return out;
})()`;
const countOf = (sel: string) => `${findAll(sel)}.length`;

async function seed(page: any, canvasOpen: boolean, tapping = true) {
  await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(`(async () => {
    const ac = window.appController;
    ac.mutate('s', d => {
      d.sketches['sk_cv'] = {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'source.solid_color', instance_key: 'src@0' },
          { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0',
            canvas: { x: 60, y: 40 } },
        ],
        wires: [{ id: 'w0', src: { instanceKey: 'lfo@0', field: 'output' },
                  dest: { instanceKey: 'bc@0', field: 'brightness' } }],
        instances: {
          'src@0': { module_type: 'source.solid_color', state: {} },
          'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 0, contrast: 0 } },
          'lfo@0': { module_type: 'mod.source.lfo', state: {} },
        },
        execOrder: ['src@0', 'lfo@0', 'bc@0'],
      };
    });
    ac.setActiveTab('edit');
    ac.editSketch('sk_cv');
    ac.setTappingMode(${tapping});
    ac.setSketchCanvasOpen(${canvasOpen});
  })()`);
  await new Promise(r => setTimeout(r, 2000));
}

describe('sidecar canvas', () => {
  jest.setTimeout(60000);

  it('splits the chain: the list shows linear cards, the canvas shows placed ones', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    // Two surfaces, disjoint sets of cards, and the canvas card keeps its TRUE
    // chain index (2) — that global index is what keeps every anchor and
    // mutation path working across both.
    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(1);
    expect(await page.evaluate(
      `${findAll('.canvas-card')}.map(c => c.dataset.chainIdx)`)).toEqual(['2']);
    expect(await page.evaluate(
      `${findAll('.canvas-card')}[0].style.left`)).toBe('60px');
    // The list renders only the two linear entries.
    expect(await page.evaluate(
      `${findAll('.effect-card')}.filter(c => !c.closest('.canvas-card')).length`)).toBe(2);
    // The monitor pops out to the floating overlay while the canvas owns the area.
    expect(await page.evaluate(countOf('devices-float-monitor'))).toBe(1);
  });

  it('draws the canvas card s ports, and a wire arc spanning both panels', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    // Always-on ports (the canvas IS the wiring surface — no wires-mode gate).
    expect(await page.evaluate(countOf('.canvas-pip'))).toBeGreaterThan(0);
    expect(await page.evaluate(countOf('.canvas-pip.output'))).toBeGreaterThan(0);

    // The arc runs from the canvas (right panel) into the list (left panel), so
    // its endpoints straddle the panel boundary.
    const arc = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName === 'TAPS-OVERLAY') {
          const p = el.shadowRoot.querySelector('path.wire-arc');
          if (!p) continue;
          const b = p.getBBox();
          return { d: p.getAttribute('d') || '', shown: p.style.display !== 'none',
                   width: Math.round(b.width) };
        }
      }
      return null;
    })()`);
    expect(arc).not.toBeNull();
    expect(arc.shown).toBe(true);
    expect(arc.d.length).toBeGreaterThan(0);
    // A same-panel wire would be narrow; a cross-panel one spans hundreds of px.
    expect(arc.width).toBeGreaterThan(200);
  });

  it('scrolls with the effects list at default zoom', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    const tops = await page.evaluate(`(() => { ${WALK}
      let cv = null, canvas = null;
      for (const el of walk(document)) {
        if (el.tagName === 'COLUMNS-VIEW') cv = el.shadowRoot.querySelector('.scroll-container');
        if (el.tagName === 'SKETCH-CANVAS-VIEW') canvas = el.shadowRoot.querySelector('.viewport');
      }
      if (!cv || !canvas) return null;
      cv.scrollTop = 140;
      cv.dispatchEvent(new Event('scroll'));
      return new Promise(res => setTimeout(
        () => res({ list: cv.scrollTop, canvas: canvas.scrollTop }), 400));
    })()`);
    expect(tops).not.toBeNull();
    expect(tops.canvas).toBe(tops.list);
  });

  it('stands wires into a CLOSED canvas at a proxy pip that opens it', async () => {
    page.removeAllListeners('console');
    await seed(page, false);

    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(0);
    expect(await page.evaluate(countOf('.wire-proxy-pip'))).toBe(1);

    await page.evaluate(
      `${findAll('.wire-proxy-pip')}[0].dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true }))`);
    await new Promise(r => setTimeout(r, 1200));

    // Clicking it opens the canvas and selects the card the wire runs to...
    expect(await page.evaluate(
      `window.appState.local.userSettings.sketchCanvasOpen === true`)).toBe(true);
    expect(await page.evaluate(
      `window.appState.local.selection?.path ?? null`)).toBe('effect/sk_cv/0/2');
    // ...and the pip retires, since both ends now have real anchors.
    expect(await page.evaluate(countOf('.wire-proxy-pip'))).toBe(0);
  });

  it('draws wires with wire-mode OFF while the canvas is open', async () => {
    page.removeAllListeners('console');
    await seed(page, true, /*tapping=*/false);

    // The canvas is itself a wiring surface, so W stops gating the arcs: the
    // list<->canvas wire has to stay visible for the canvas to be readable.
    expect(await page.evaluate(`window.appState.local.tappingMode`)).toBe(false);
    const arcs = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'TAPS-OVERLAY') continue;
        const ps = [...el.shadowRoot.querySelectorAll('path.wire-arc')]
          .filter(p => p.style.display !== 'none' && (p.getAttribute('d') || '').startsWith('M '));
        if (ps.length) return ps.length;
      }
      return 0;
    })()`);
    expect(arcs).toBeGreaterThan(0);
  });

  it('starts click-to-connect straight from a canvas pip', async () => {
    page.removeAllListeners('console');
    await seed(page, true, /*tapping=*/false);

    // A canvas pip is a PORT, not a selection handle — one click picks the field
    // up. (It also has to WIN that click: the fixed wire layer sits above the
    // cards, so its hit path is trimmed clear of both endpoints.)
    const pip = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('canvas-pip') &&
            el.dataset.isOutput === 'true') {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    })()`) as any;
    expect(pip).not.toBeNull();

    await page.mouse.click(pip.x, pip.y);
    await new Promise(r => setTimeout(r, 300));
    await page.mouse.move(pip.x - 220, pip.y + 140);   // rubber-band follows
    await new Promise(r => setTimeout(r, 300));

    const state = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'TAPS-OVERLAY') continue;
        const line = el.shadowRoot.querySelector('line.connect-line');
        if (!line) continue;
        return { card: !!el.shadowRoot.querySelector('.field-card'),
                 connecting: getComputedStyle(line).display !== 'none' };
      }
      return null;
    })()`) as any;
    // No options popup — a live connect gesture instead.
    expect(state.card).toBe(false);
    expect(state.connecting).toBe(true);
  });

  it('anchors a clicked wire s popup at the click point', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    // The wire spans two panels; anchoring its card to the DEST field s column
    // put it far from where the user clicked.
    const pt = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'TAPS-OVERLAY') continue;
        const p = el.shadowRoot.querySelector('path.wire-hit');
        if (!p || !(p.getAttribute('d') || '').startsWith('M ')) continue;
        const m = p.getPointAtLength(p.getTotalLength() / 2);
        const b = el.shadowRoot.querySelector('svg.lines').getBoundingClientRect();
        return { x: b.left + m.x, y: b.top + m.y };
      }
      return null;
    })()`) as any;
    expect(pt).not.toBeNull();

    await page.mouse.click(pt.x, pt.y);
    await new Promise(r => setTimeout(r, 600));

    const card = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'TAPS-OVERLAY') continue;
        const c = el.shadowRoot.querySelector('.field-card');
        if (!c) continue;
        const r = c.getBoundingClientRect();
        return { left: r.left, top: r.top, bottom: r.bottom,
                 vis: getComputedStyle(c).visibility };
      }
      return null;
    })()`) as any;
    expect(await page.evaluate(
      `window.appState.local.selection?.path ?? null`)).toBe('wire/sk_cv/w0');
    expect(card).not.toBeNull();
    expect(card.vis).toBe('visible');
    // Beside the pointer, not beside the linear column: its left edge sits just
    // right of the click and it straddles the click s row.
    expect(card.left).toBeGreaterThan(pt.x);
    expect(card.left - pt.x).toBeLessThan(40);
    expect(card.top).toBeLessThanOrEqual(pt.y);
    expect(card.bottom).toBeGreaterThanOrEqual(pt.y);
  });

  it('moves a card between the list and the canvas, keeping its wires', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    const summary = () => page.evaluate(`(() => {
      const sk = window.appState.database.sketches['sk_cv'];
      return { chain: sk.chain.map(e => e.instance_key + (e.canvas ? '@c' : '')),
               wires: (sk.wires || []).map(w => w.src.instanceKey + '->' + w.dest.instanceKey) };
    })()`);

    await page.evaluate(`window.appController.moveEffectToCanvas('sk_cv', 1, { x: 300, y: 200 })`);
    await new Promise(r => setTimeout(r, 500));
    // bc@0 leaves the linear list for the canvas TAIL — its wire is untouched,
    // because wires address instances, not positions.
    expect(await summary()).toEqual({
      chain: ['src@0', 'lfo@0@c', 'bc@0@c'], wires: ['lfo@0->bc@0'] });

    await page.evaluate(`window.appController.moveEffectToLinear('sk_cv', 2, 1)`);
    await new Promise(r => setTimeout(r, 500));
    expect(await summary()).toEqual({
      chain: ['src@0', 'bc@0', 'lfo@0@c'], wires: ['lfo@0->bc@0'] });
  });
});
