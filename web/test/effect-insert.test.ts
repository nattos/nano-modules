/**
 * Effect insertion via a category chip (column-group's insert-header,
 * `.cat-chip`) and effect retyping via double-clicking a card's name.
 *
 * Clicking a category chip drops that category's default effect as a
 * placeholder and opens the smart-input drilled into "<category>." so the
 * user can immediately pick the exact effect within it. The whole insertion
 * rides one continuous edit:
 *   - Escape backs it out entirely → placeholder vanishes, NO undo point
 *   - clicking away (blur) ACCEPTS whatever type is currently set (even the
 *     untouched category default) → exactly ONE undo point
 *   - typing a pick + Enter commits it → exactly ONE undo point
 * This drives the real DOM (CodeMirror keystrokes, blur) that the controller
 * unit test (src/state/insert-effect.test.ts) can't reach.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

async function setupSketch(sketchId: string) {
  await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 3000));
  await page.evaluate(`(async () => {
    const ac = window.appController;
    ac.mutate('s', d => {
      d.sketches['${sketchId}'] = {
        anchor: null,
        chain: [{ type: 'module', module_type: 'color.invert', instance_key: 'inv@0' }],
        wires: [],
        instances: { 'inv@0': { module_type: 'color.invert', state: {} } },
      };
    });
    ac.setActiveTab('edit');
    ac.editSketch('${sketchId}');
  })()`);
  await new Promise(r => setTimeout(r, 1500));
}

// Clicks the "filter" category chip (a plain click — no drag — inserts at the
// default point, below the selected card / at the end). The chip lives
// inside <column-group>'s shadow root, and its drag machinery listens on
// `window` for pointerup — so the synthetic event needs `composed: true` to
// cross the shadow boundary (real browser pointer events are composed by
// default; constructed ones are not unless told to be).
const clickFilterChip = `(() => {
  ${WALK}
  for (const el of walk(document)) {
    if (el.classList && el.classList.contains('cat-chip') && el.textContent.trim() === 'filter') {
      const opts = { bubbles: true, composed: true, button: 0, clientX: 0, clientY: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      return true;
    }
  }
  return false;
})()`;

const smartInputText = `(() => {
  ${WALK}
  for (const el of walk(document)) {
    if (el.tagName === 'SMART-INPUT') {
      const c = el.shadowRoot.querySelector('.cm-content');
      return c ? c.textContent : '';
    }
  }
  return null;
})()`;

const focusSmartInput = `(() => {
  ${WALK}
  for (const el of walk(document)) {
    if (el.tagName === 'SMART-INPUT') {
      const c = el.shadowRoot.querySelector('.cm-content');
      if (c) { c.focus(); return true; }
    }
  }
  return false;
})()`;

const blurSmartInput = `(() => {
  ${WALK}
  for (const el of walk(document)) {
    if (el.tagName === 'SMART-INPUT') {
      const c = el.shadowRoot.querySelector('.cm-content');
      if (c) { c.blur(); return true; }
    }
  }
  return false;
})()`;

const smartInputOpen = `(() => {
  ${WALK}
  for (const el of walk(document)) if (el.tagName === 'SMART-INPUT') return true;
  return false;
})()`;

// Only the part after the category is pre-selected on open now (see the
// dedicated selection test below) — select the whole field first when a
// test wants to replace the type wholesale, across categories.
async function selectAllSmartInput() {
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
}

const dblClickEffectName = `(() => {
  ${WALK}
  for (const el of walk(document)) {
    if (el.classList && el.classList.contains('effect-card-name')) {
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    }
  }
  return false;
})()`;

describe('effect insertion via a category chip', () => {
  jest.setTimeout(60000);

  it('opens drilled into the category; Escape backs the whole insertion out with no undo point', async () => {
    page.removeAllListeners('console');
    await setupSketch('sk_chip_esc');

    const chainLen = () => page.evaluate(`window.appState.database.sketches['sk_chip_esc'].chain.length`) as Promise<number>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

    expect(await chainLen()).toBe(1);
    const undo0 = await undoLen();

    expect(await page.evaluate(clickFilterChip)).toBe(true);
    await new Promise(r => setTimeout(r, 700));

    // Placeholder joined the chain and smart-input opened pre-filled with the
    // category, drilled in (ready to pick the exact effect).
    expect(await chainLen()).toBe(2);
    expect(await page.evaluate(smartInputText)).toBe('filter.');

    await page.evaluate(focusSmartInput);
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 600));

    // Backed out: placeholder gone, editor closed, NO undo point left behind.
    expect(await chainLen()).toBe(1);
    expect(await page.evaluate(smartInputOpen)).toBe(false);
    expect(await undoLen()).toBe(undo0);
  });

  it('clicking away accepts the current type — even the untouched category default — as one undo point', async () => {
    page.removeAllListeners('console');
    await setupSketch('sk_chip_blur');

    const chainLen = () => page.evaluate(`window.appState.database.sketches['sk_chip_blur'].chain.length`) as Promise<number>;
    const chainTypes = () => page.evaluate(`window.appState.database.sketches['sk_chip_blur'].chain.map(e => e.module_type)`) as Promise<string[]>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

    const undo0 = await undoLen();
    expect(await page.evaluate(clickFilterChip)).toBe(true);
    await new Promise(r => setTimeout(r, 700));
    expect(await chainLen()).toBe(2);
    const insertedType = (await chainTypes())[1];
    expect(insertedType.startsWith('filter.')).toBe(true);

    await page.evaluate(blurSmartInput);
    await new Promise(r => setTimeout(r, 500)); // blur-accept is debounced ~150ms

    // Accepted (not reverted): the placeholder's type stuck, editor closed,
    // exactly one "Add <type>" undo point.
    expect(await chainLen()).toBe(2);
    expect(await page.evaluate(smartInputOpen)).toBe(false);
    expect(await chainTypes()).toEqual(['color.invert', insertedType]);
    expect(await undoLen()).toBe(undo0 + 1);

    await page.evaluate(`window.appController.history.undo()`);
    await new Promise(r => setTimeout(r, 500));
    expect(await chainLen()).toBe(1);
  });

  it('typing a pick + Enter commits it as one undo point', async () => {
    page.removeAllListeners('console');
    await setupSketch('sk_chip_commit');

    const chainLen = () => page.evaluate(`window.appState.database.sketches['sk_chip_commit'].chain.length`) as Promise<number>;
    const chainTypes = () => page.evaluate(`window.appState.database.sketches['sk_chip_commit'].chain.map(e => e.module_type)`) as Promise<string[]>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

    const undo0 = await undoLen();
    expect(await page.evaluate(clickFilterChip)).toBe(true);
    await new Promise(r => setTimeout(r, 700));
    await page.evaluate(focusSmartInput);
    // Narrow within the drilled-in category to an UNAMBIGUOUS leaf — a query
    // that also happens to be a folder segment (e.g. "blur", since
    // "filter.blur.fast" nests under a "blur/" folder) would have Enter drill
    // into that folder instead of committing, since folder options always
    // outrank leaf effects in the dropdown.
    await page.keyboard.type('height', { delay: 40 });
    await new Promise(r => setTimeout(r, 400));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 700));

    expect(await chainLen()).toBe(2);
    const insertedType = (await chainTypes())[1];
    expect(insertedType.startsWith('filter.')).toBe(true);
    expect(await undoLen()).toBe(undo0 + 1);

    // And it undoes in a single step.
    await page.evaluate(`window.appController.history.undo()`);
    await new Promise(r => setTimeout(r, 500));
    expect(await chainLen()).toBe(1);
    expect(await chainTypes()).not.toContain(insertedType);
  });
});

describe('effect retyping via double-clicking a card name', () => {
  jest.setTimeout(60000);

  it('Escape reverts the type; an empty commit deletes the effect', async () => {
    page.removeAllListeners('console');
    await setupSketch('sk_edit');

    const chainLen = () => page.evaluate(`window.appState.database.sketches['sk_edit'].chain.length`) as Promise<number>;
    const chainTypes = () => page.evaluate(`window.appState.database.sketches['sk_edit'].chain.map(e => e.module_type)`) as Promise<string[]>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

    // ---- Preview a new type, then Escape → revert ----
    // Only "invert" (everything after the category) is pre-selected on open
    // — select the whole field first to replace the type across categories.
    const undo0 = await undoLen();
    expect(await page.evaluate(dblClickEffectName)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(focusSmartInput);
    await selectAllSmartInput();
    await page.keyboard.type('blend', { delay: 40 });
    await new Promise(r => setTimeout(r, 400));
    // Live preview swapped the type.
    expect(await chainTypes()).toContain('composite.blend');
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 600));
    // Reverted to the original type, nothing recorded.
    expect(await chainTypes()).toEqual(['color.invert']);
    expect(await undoLen()).toBe(undo0);

    // ---- Clear the whole field + Enter → delete (one undo) ----
    expect(await page.evaluate(dblClickEffectName)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(focusSmartInput);
    await selectAllSmartInput();
    await page.keyboard.press('Backspace');
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 600));
    expect(await chainLen()).toBe(0);
    expect(await undoLen()).toBe(undo0 + 1);
  });

  it('opens with only the part after the category pre-selected, so one Backspace collapses to the category', async () => {
    page.removeAllListeners('console');
    await setupSketch('sk_edit_sel');

    expect(await page.evaluate(dblClickEffectName)).toBe(true);
    await new Promise(r => setTimeout(r, 600));

    // Before any edit: the dropdown reads like a fresh drill into "color."
    // (folders + every nested color effect), not a query narrowed to just
    // "Invert" — same view as if a category chip had drilled in directly.
    const rowsOnOpen = await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('cm-tooltip-autocomplete')) {
          return [...el.querySelectorAll('li')].map(li => li.textContent.trim());
        }
      }
      return null;
    })()`) as string[] | null;
    expect(rowsOnOpen).not.toBeNull();
    expect(rowsOnOpen!.length).toBeGreaterThan(3);
    expect(rowsOnOpen!.some(r => r.includes('tone'))).toBe(true);

    await page.evaluate(focusSmartInput);
    await page.keyboard.press('Backspace'); // deletes only the pre-selected "invert"
    await new Promise(r => setTimeout(r, 300));
    expect(await page.evaluate(smartInputText)).toBe('color.');
  });

  it('clicking away reverts an in-progress retype (unlike a fresh insertion, which accepts)', async () => {
    page.removeAllListeners('console');
    await setupSketch('sk_edit_blur');

    const chainTypes = () => page.evaluate(`window.appState.database.sketches['sk_edit_blur'].chain.map(e => e.module_type)`) as Promise<string[]>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

    const undo0 = await undoLen();
    expect(await page.evaluate(dblClickEffectName)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(focusSmartInput);
    await selectAllSmartInput();
    await page.keyboard.type('blend', { delay: 40 });
    await new Promise(r => setTimeout(r, 400));
    expect(await chainTypes()).toContain('composite.blend');

    await page.evaluate(blurSmartInput);
    await new Promise(r => setTimeout(r, 500));

    // Retyping an EXISTING effect still reverts on blur — only a fresh
    // insertion (via a category chip) treats blur as an accept.
    expect(await chainTypes()).toEqual(['color.invert']);
    expect(await undoLen()).toBe(undo0);
  });
});
