/**
 * The math shapers' input count, end to end in the real editor.
 *
 * Arity is a value, not a schema shape, so three separate pieces have to agree:
 * the effect folds only the first N inputs, the card renders only the first N
 * rows (resolved synchronously from the document — see
 * src/state/field-visibility.ts), and the count control lives in the card's GEAR
 * panel under blend + crossfade rather than among the parameter rows.
 *
 * The "no engine round trip" guarantee itself is pinned by the unit tests in
 * src/state/input-count.test.ts, which resolve the field set with no live
 * instance at all; this suite covers the integration.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

/** Walk every shadow root — the card lives several roots deep. */
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

/**
 * Field paths of the rendered parameter rows on the add card, in order.
 *
 * Deliberately does NOT descend into <input-count-options>: the gear widget's
 * own tab bar is bound to `input_count`, which would otherwise read as a body
 * row and defeat the point of the check.
 */
const inputRows = `(() => {
  function* rowWalk(root){
    for(const el of root.querySelectorAll('*')){
      if (el.matches && el.matches('input-count-options')) continue;
      yield el;
      if (el.shadowRoot) yield* rowWalk(el.shadowRoot);
    }
  }
  const out = [];
  for (const el of rowWalk(document)) {
    const fp = el.fieldPath;
    if (typeof fp === 'string' && fp.startsWith('input_')) out.push(fp);
  }
  return out;
})()`;

/** The gear panel's input-count bar: its label and its option buttons. */
const countBar = `(() => { ${WALK}
  for (const el of walk(document)) {
    if (!el.matches || !el.matches('input-count-options')) continue;
    const bar = el.shadowRoot && el.shadowRoot.querySelector('field-tab-bar');
    if (!bar) return { found: true, bar: false };
    const btns = Array.from(bar.shadowRoot.querySelectorAll('button')).map(b => b.textContent.trim());
    return { found: true, bar: true, label: bar.label, options: btns };
  }
  return { found: false };
})()`;

const clickCount = (n: number) => `(() => { ${WALK}
  for (const el of walk(document)) {
    if (!el.matches || !el.matches('input-count-options')) continue;
    const bar = el.shadowRoot.querySelector('field-tab-bar');
    for (const b of bar.shadowRoot.querySelectorAll('button')) {
      if (b.textContent.trim() === ${JSON.stringify(String(n))}) { b.click(); return true; }
    }
  }
  return false;
})()`;

const wireIds = `(() => (window.appState.database.sketches['sk_math'].wires || []).map(w => w.id))()`;

async function seed(page: any, count: number) {
  await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(`(async () => {
    const ac = window.appController;
    ac.mutate('s', d => {
      d.sketches['sk_math'] = {
        anchor: null,
        chain: [
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@0' },
          { type: 'module', module_type: 'mod.shaper.add', instance_key: 'add@0' },
          { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@0' },
        ],
        wires: [
          { id: 'w_in2', src: { instanceKey: 'lfo@0', field: 'output' },
            dest: { instanceKey: 'add@0', field: 'input_2' } },
          { id: 'w_in5', src: { instanceKey: 'lfo@0', field: 'output' },
            dest: { instanceKey: 'add@0', field: 'input_5' } },
          { id: 'w_out', src: { instanceKey: 'add@0', field: 'output' },
            dest: { instanceKey: 'bc@0', field: 'brightness' } },
        ],
        instances: {
          'lfo@0': { module_type: 'mod.source.lfo', state: {} },
          'add@0': { module_type: 'mod.shaper.add', state: { input_count: ${count} } },
          'bc@0': { module_type: 'color.tone.brightness_contrast', state: { brightness: 0, contrast: 0 } },
        },
      };
    });
    ac.setActiveTab('edit');
    ac.editSketch('sk_math');
  })()`);
  await new Promise(r => setTimeout(r, 2500));
}

/** Open the add card's gear options row. */
async function openGear(page: any) {
  await page.evaluate(`(() => { ${WALK}
    for (const el of walk(document)) {
      if (el.matches && el.matches('column-group') && el.effectOptionsOpen) {
        el.effectOptionsOpen.add('add@0');
        el.requestUpdate();
      }
    }
  })()`);
  await new Promise(r => setTimeout(r, 600));
}

describe('math shaper input count', () => {
  jest.setTimeout(60000);

  it('renders exactly the stored number of input rows, and no input_count row', async () => {
    await seed(page, 5);
    const rows = await page.evaluate(inputRows);
    expect(rows).toEqual(['input_1', 'input_2', 'input_3', 'input_4', 'input_5']);
    // input_count changes the card's SHAPE, so it belongs in the gear panel —
    // never as a body row among the inputs it governs. (The gear is closed here,
    // so this holds even without the probe's gear-widget exclusion.)
    expect(rows).not.toContain('input_count');
  });

  it('defaults to two inputs when the sketch stores no count', async () => {
    await seed(page, 2);
    expect(await page.evaluate(inputRows)).toEqual(['input_1', 'input_2']);
  });

  it('puts the count control in the gear panel, spanning the schema range', async () => {
    await seed(page, 3);
    // Not rendered until the gear is open.
    expect((await page.evaluate(countBar)).found).toBe(false);
    await openGear(page);
    const bar = await page.evaluate(countBar);
    expect(bar.found).toBe(true);
    expect(bar.bar).toBe(true);
    expect(bar.label).toBe('Inputs');
    expect(bar.options).toEqual(['2', '3', '4', '5', '6', '7', '8']);
  });

  it('lowering the count removes the rows AND the wires onto them, in one undo', async () => {
    await seed(page, 5);
    await openGear(page);
    expect(await page.evaluate(wireIds)).toEqual(['w_in2', 'w_in5', 'w_out']);

    expect(await page.evaluate(clickCount(3))).toBe(true);
    await new Promise(r => setTimeout(r, 600));

    expect(await page.evaluate(inputRows)).toEqual(['input_1', 'input_2', 'input_3']);
    // input_5's wire is gone; input_2's and the output wire are untouched.
    expect(await page.evaluate(wireIds)).toEqual(['w_in2', 'w_out']);

    await page.evaluate(`window.appController.undo()`);
    await new Promise(r => setTimeout(r, 600));
    expect(await page.evaluate(inputRows)).toEqual(
      ['input_1', 'input_2', 'input_3', 'input_4', 'input_5']);
    expect(await page.evaluate(wireIds)).toEqual(['w_in2', 'w_in5', 'w_out']);
  });

  it('raising the count reveals rows without disturbing any wire', async () => {
    await seed(page, 2);
    await openGear(page);
    expect(await page.evaluate(clickCount(7))).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    expect(await page.evaluate(inputRows)).toHaveLength(7);
    expect(await page.evaluate(wireIds)).toEqual(['w_in2', 'w_in5', 'w_out']);
  });
});
