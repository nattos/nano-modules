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

/** Push a second canvas node into the seeded sketch, at a stored placement. */
async function addCanvasCard(page: any, key: string, x: number, y: number,
                             moduleType = 'mod.source.lfo') {
  await page.evaluate((k: string, px: number, py: number, mt: string) => {
    (window as any).appController.mutate('add', (d: any) => {
      const sk = d.sketches['sk_cv'];
      sk.chain.push({ type: 'module', module_type: mt,
                      instance_key: k, canvas: { x: px, y: py } });
      sk.instances[k] = { module_type: mt, state: {} };
    });
  }, key, x, y, moduleType);
  await new Promise(r => setTimeout(r, 600));
}

/** Every canvas output pip, with its row's label (null when unlabelled). */
const outPortGeom = `(() => { ${WALK}
  const rows = [];
  for (const el of walk(document)) {
    if (!el.matches || !el.matches('.canvas-out-row')) continue;
    const lab = el.querySelector('.canvas-out-label');
    const pip = el.querySelector('.canvas-pip');
    const mid = (n) => { const r = n.getBoundingClientRect();
                         return { cy: Math.round(r.top + r.height / 2), x: Math.round(r.left) }; };
    rows.push({ label: lab ? mid(lab) : null, text: lab ? lab.textContent : null,
                pip: pip ? mid(pip) : null });
  }
  return rows;
})()`;

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

  it('connects a canvas port to a linear param with wire mode OFF', async () => {
    page.removeAllListeners('console');
    await seed(page, true, /*tapping=*/false);
    await page.evaluate(`window.appController.mutate('clear', d => {
      d.sketches['sk_cv'].wires = []; })`);
    await new Promise(r => setTimeout(r, 400));

    // The list's field hit-boxes are W-gated (they cover whole rows, so
    // always-on ones would make every slider undraggable) — but they open for
    // the DURATION of a connect gesture, which is what lets a canvas port reach
    // a linear param without the editor being held in wire mode.
    expect(await page.evaluate(countOf('.tap-overlay-hit'))).toBe(0);

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
    await page.mouse.click(pip.x, pip.y);
    await new Promise(r => setTimeout(r, 400));

    const target = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('tap-overlay-hit') &&
            el.dataset.fieldPath === 'brightness') {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    })()`) as any;
    expect(target).not.toBeNull();     // the list opened up for the gesture
    await page.mouse.click(target.x, target.y);
    await new Promise(r => setTimeout(r, 600));

    expect(await page.evaluate(`(() => {
      const w = (window.appState.database.sketches['sk_cv'].wires || [])[0];
      return w ? w.src.instanceKey + '.' + w.src.field + '->' +
                 w.dest.instanceKey + '.' + w.dest.field : null;
    })()`)).toBe('lfo@0.output->bc@0.brightness');
    // ...and the list closes again the moment the gesture ends.
    expect(await page.evaluate(countOf('.tap-overlay-hit'))).toBe(0);
  });

  it('snaps a dragged canvas card to a linear card s edge', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    const geom = await page.evaluate(`(() => { ${WALK}
      let card = null;
      for (const el of walk(document)) if (el.classList && el.classList.contains('canvas-card')) { card = el; break; }
      const app = document.querySelector('sketch-app').shadowRoot
        .querySelector('app-shell').shadowRoot;
      const cg = app.querySelector('.left-panel sketch-column-editor').shadowRoot
        .querySelector('columns-view').shadowRoot.querySelector('column-group');
      const lin = [...cg.shadowRoot.querySelectorAll('.effect-card')]
        .map(e => e.getBoundingClientRect().top);
      const hr = card.querySelector('.effect-card-header').getBoundingClientRect();
      return { hx: hr.left + hr.width / 2, hy: hr.top + hr.height / 2,
               cardTop: card.getBoundingClientRect().top, lin };
    })()`) as any;
    expect(geom.lin.length).toBeGreaterThan(1);

    // Aim the canvas card's top 5px PAST the second list card's top — inside
    // the snap tolerance, so it should land exactly on it.
    const want = geom.lin[1];
    const dy = (want + 5) - geom.cardTop;
    await page.mouse.move(geom.hx, geom.hy);
    await page.mouse.down();
    await page.mouse.move(geom.hx, geom.hy + 8, { steps: 3 });   // pass the threshold
    await page.mouse.move(geom.hx, geom.hy + dy, { steps: 8 });
    await new Promise(r => setTimeout(r, 300));
    // The guide is showing while the snap holds.
    expect(await page.evaluate(countOf('.guide.h'))).toBe(1);
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 500));

    const landed = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) if (el.classList && el.classList.contains('canvas-card'))
        return el.getBoundingClientRect().top;
      return null;
    })()`) as any;
    expect(Math.abs(landed - want)).toBeLessThan(1);
    expect(await page.evaluate(countOf('.guide.h'))).toBe(0);
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

  it('rubber-bands a region of the canvas into a multi-selection', async () => {
    page.removeAllListeners('console');
    await seed(page, true);
    await addCanvasCard(page, 'lfo@1', 60, 320);

    const rects = await page.evaluate(`(() => { ${WALK}
      const out = [];
      for (const el of walk(document)) if (el.classList && el.classList.contains('canvas-card')) {
        const r = el.getBoundingClientRect();
        out.push({ idx: el.dataset.chainIdx, left: r.left, top: r.top,
                   right: r.right, bottom: r.bottom });
      }
      return out;
    })()`) as any;
    expect(rects.length).toBe(2);

    // Band from empty space above-left of the first card down past the second.
    const x0 = rects[0].left - 20, y0 = rects[0].top - 20;
    const x1 = Math.max(rects[0].right, rects[1].right) + 10;
    const y1 = Math.max(rects[0].bottom, rects[1].bottom) + 10;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 10, y0 + 10, { steps: 3 });
    await page.mouse.move(x1, y1, { steps: 8 });
    await new Promise(r => setTimeout(r, 200));
    // The band is drawn, and both cards are already highlighted mid-gesture.
    expect(await page.evaluate(countOf('.marquee'))).toBe(1);
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 300));

    expect(await page.evaluate(countOf('.marquee'))).toBe(0);
    expect(await page.evaluate(
      `[...window.appState.local.multiSelection].sort()`))
      .toEqual(['effect/sk_cv/0/2', 'effect/sk_cv/0/3']);
    // Both cards paint as selected — the multi-selection reaches the canvas
    // <column-group> through the same adapter the list uses.
    expect(await page.evaluate(
      `${findAll('.canvas-card .effect-card[selected]')}.length`)).toBe(2);

    // A click on empty canvas clears it again (no band, no drag).
    await page.mouse.click(x0, y0);
    await new Promise(r => setTimeout(r, 300));
    expect(await page.evaluate(`window.appState.local.multiSelection.length`)).toBe(0);
  });

  it('drags a rubber-banded group as one, in one undo step', async () => {
    page.removeAllListeners('console');
    await seed(page, true);
    await addCanvasCard(page, 'lfo@1', 60, 320);

    // Select both directly — the band gesture itself is covered above.
    await page.evaluate(`window.appController.selectEffectGroup(
      ['effect/sk_cv/0/2', 'effect/sk_cv/0/3'], 'effect/sk_cv/0/2')`);
    await new Promise(r => setTimeout(r, 300));

    const hr = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) if (el.classList && el.classList.contains('canvas-card')) {
        const r = el.querySelector('.effect-card-header').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    })()`) as any;

    const posOf = () => page.evaluate(
      `window.appState.database.sketches['sk_cv'].chain.filter(e => e.canvas)
         .map(e => e.canvas.x + ',' + e.canvas.y)`);
    expect(await posOf()).toEqual(['60,40', '60,320']);

    // Drag far enough right that no snap line is in reach, so the delta is exact.
    await page.mouse.move(hr.x, hr.y);
    await page.mouse.down();
    await page.mouse.move(hr.x + 10, hr.y, { steps: 3 });
    await page.mouse.move(hr.x + 200, hr.y, { steps: 8 });
    await new Promise(r => setTimeout(r, 200));
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 500));

    // Both moved by the SAME delta — the group keeps its arrangement.
    expect(await posOf()).toEqual(['260,40', '260,320']);

    // ...and it lands as a single undo point, restoring both.
    await page.evaluate(`window.appController.undo()`);
    await new Promise(r => setTimeout(r, 500));
    expect(await posOf()).toEqual(['60,40', '60,320']);
  });

  it('labels canvas outputs only when there is more than one, pips on one line', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    // The seeded canvas card is an LFO: one output, so no label — what the one
    // output of a card is, is obvious, and the name would just float in space.
    let rows = await page.evaluate(outPortGeom);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBeNull();

    // mod.source.time declares two (output + value), which DO need telling
    // apart. Each pip centres on its own label's line — the dot is an absolute
    // ::after, so an unpositioned pip strands every dot at the column's
    // midpoint — and they all share one x, however long the names run.
    await addCanvasCard(page, 'time@0', 300, 40, 'mod.source.time');
    rows = await page.evaluate(outPortGeom);
    const labelled = rows.filter((r: any) => r.label);
    expect(labelled.length).toBeGreaterThan(1);
    for (const r of labelled) expect(Math.abs(r.pip.cy - r.label.cy)).toBeLessThanOrEqual(1);
    expect(new Set(labelled.map((r: any) => r.pip.x)).size).toBe(1);
  });

  it('moves a card s port pips with its fields when the gear panel opens', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    // A canvas card is absolutely positioned inside a fixed-size surface, so
    // growing it resizes NOTHING the layout manager observes. Pip offsets are
    // computed while RENDERING — against the layout that render is about to
    // replace — so without a post-commit re-measure they sit at the old rows
    // until some unrelated render happens by.
    //
    // The invariant, before and after: every port dot is centred on the row it
    // belongs to. Each pip is checked against its OWN anchor (the field editor
    // the layout manager holds for its key, or the header control for the two
    // engine-reserved ports), so nothing here depends on guessing how far the
    // gear panel pushes things down.
    const misaligned = `(() => { ${WALK}
      const reserved = { __enable__: '.device-bypass-btn', __opacity__: '.device-opacity-slider' };
      let lm = null;
      for (const el of walk(document)) {
        if (el.tagName === 'COLUMN-GROUP' && el.layoutMode === 'canvas') lm = el.layoutManager;
      }
      if (!lm) return ['no canvas column-group'];
      const mid = (n) => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; };
      const bad = [];
      let seen = 0;
      for (const el of walk(document)) {
        if (!el.matches || !el.matches('.canvas-in-ports .canvas-pip')) continue;
        seen++;
        const fieldPath = el.dataset.fieldPath;
        const anchor = reserved[fieldPath]
          ? el.closest('.effect-card-inner').querySelector(reserved[fieldPath])
          : lm.entries.get(el.dataset.fieldKey)?.element;
        if (!anchor) { bad.push(fieldPath + ':no-anchor'); continue; }
        const off = mid(el) - mid(anchor);
        if (Math.abs(off) > 1) bad.push(fieldPath + ':' + Math.round(off));
      }
      if (!seen) return ['no input pips'];
      return bad;
    })()`;

    expect(await page.evaluate(misaligned)).toEqual([]);

    const gear = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (!el.matches || !el.matches('.canvas-card .device-gear-btn')) continue;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    })()`) as any;
    expect(gear).not.toBeNull();

    // Open the gear panel — the card grows and every field row slides down.
    await page.mouse.click(gear.x, gear.y);
    await new Promise(r => setTimeout(r, 400));
    expect(await page.evaluate(misaligned)).toEqual([]);

    // ...and closing it again puts them back.
    await page.mouse.click(gear.x, gear.y);
    await new Promise(r => setTimeout(r, 400));
    expect(await page.evaluate(misaligned)).toEqual([]);
  });

  it('keeps a selected canvas card opaque', async () => {
    page.removeAllListeners('console');
    await seed(page, true);

    const innerBg = `(() => { ${WALK}
      for (const el of walk(document)) {
        if (!el.matches || !el.matches('.canvas-card .effect-card-inner')) continue;
        const cs = getComputedStyle(el);
        return { color: cs.backgroundColor, image: cs.backgroundImage,
                 selected: !!el.closest('.effect-card[selected]') };
      }
      return null;
    })()`;

    const plain = await page.evaluate(innerBg) as any;
    expect(plain.selected).toBe(false);

    await page.evaluate(`window.appController.select('effect/sk_cv/0/2')`);
    await new Promise(r => setTimeout(r, 400));

    const sel = await page.evaluate(innerBg) as any;
    expect(sel.selected).toBe(true);
    // The selection tint LAYERS over the card body rather than replacing it —
    // replacing it made a canvas card see-through, since unlike a list card it
    // has the wire layer and the canvas surface behind it.
    expect(sel.color).toBe(plain.color);
    expect(sel.color).not.toMatch(/rgba\(.*0\.\d+\)/);
    expect(sel.image).toContain('gradient');
  });

  it('opens field hit-boxes on canvas cards while a connect gesture is live', async () => {
    page.removeAllListeners('console');
    await seed(page, true, /*tapping=*/false);

    const canvasHits = `${findAll('.tap-overlay-hit')}.filter(h => h.closest('.canvas-card')).length`;
    // Wires mode is OFF and nothing is in flight: only the always-on port dots.
    expect(await page.evaluate(canvasHits)).toBe(0);

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
    await page.mouse.click(pip.x, pip.y);
    await new Promise(r => setTimeout(r, 400));

    // Picked up: every input row on the canvas card is now a target, so a drop
    // doesn't demand 10px of aim at the pip.
    expect(await page.evaluate(canvasHits)).toBeGreaterThan(0);

    const hit = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) {
        if (!el.matches || !el.matches('.tap-overlay-hit')) continue;
        if (!el.closest('.canvas-card')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    })()`) as any;
    expect(hit).not.toBeNull();

    await page.mouse.move(hit.x, hit.y);
    await new Promise(r => setTimeout(r, 300));
    expect(await page.evaluate(
      `${countOf('.tap-overlay-hit[tap-drop-target]')}`)).toBe(1);

    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 400));
    // Gesture over — the rows fold back away and leave the sliders draggable.
    expect(await page.evaluate(canvasHits)).toBe(0);
  });
  it('toggles the canvas from the tab rail C pill', async () => {
    // Seeded CLOSED — the pill has to be the thing that opens it.
    await seed(page, false);

    const pill = `(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'APP-TAB-BAR') continue;
        const b = el.shadowRoot.querySelector('.mode-btn');
        if (!b) return { bar: true, btn: false };
        const r = b.getBoundingClientRect();
        return { bar: true, btn: true, text: b.textContent.trim(),
                 active: b.hasAttribute('active'),
                 color: getComputedStyle(b).color,
                 x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return { bar: false };
    })()`;

    const off = await page.evaluate(pill) as any;
    expect(off.bar).toBe(true);
    expect(off.btn).toBe(true);
    expect(off.text).toBe('C');
    expect(off.active).toBe(false);
    // It has to FIT the 48px rail, or it overhangs the panel edge.
    expect(off.x).toBeLessThan(48);

    await page.mouse.click(off.x, off.y);
    await new Promise(r => setTimeout(r, 800));
    const on = await page.evaluate(pill) as any;
    expect(on.active).toBe(true);
    // Lit blue — the rail's own accent, NOT the arrangement W pill's orange.
    expect(on.color).toBe('rgb(65, 105, 225)');
    expect(await page.evaluate(
      `window.appState.local.userSettings.sketchCanvasOpen`)).toBe(true);
    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(1);

    // And back. The pill and the `C` key drive the same setting, so the pill
    // must reflect a change it didn't make.
    await page.keyboard.press('c');
    await new Promise(r => setTimeout(r, 800));
    expect((await page.evaluate(pill) as any).active).toBe(false);
    expect(await page.evaluate(countOf('sketch-canvas-view'))).toBe(0);
  });

  it('drops the C pill on tabs that cannot host the canvas', async () => {
    await seed(page, true);
    const pillCount = `(() => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName === 'APP-TAB-BAR') return el.shadowRoot.querySelectorAll('.mode-btn').length;
      }
      return -1;
    })()`;
    expect(await page.evaluate(pillCount)).toBe(1);
    // Devices already owns the right panel, so C would mean nothing there.
    await page.evaluate(`window.appController.setActiveTab('devices')`);
    await new Promise(r => setTimeout(r, 800));
    expect(await page.evaluate(pillCount)).toBe(0);
    await page.evaluate(`window.appController.setActiveTab('edit')`);
    await new Promise(r => setTimeout(r, 800));
    expect(await page.evaluate(pillCount)).toBe(1);
  });
});
