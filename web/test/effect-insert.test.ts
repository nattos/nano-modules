/**
 * Effect insertion via the column-group insert tab (resolume shell, edit mode).
 *
 * Double-clicking an insert tab drops a placeholder brightness_contrast and
 * opens the smart-input EMPTY. The whole insertion is one continuous edit:
 *   - Escape / click-away cancels it → the placeholder vanishes, NO undo point
 *   - typing a type + Enter commits it → exactly ONE undo point
 * This drives the real DOM (CodeMirror keystrokes, blur) that the controller
 * unit test (src/state/insert-effect.test.ts) can't reach.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';
const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('effect insertion via the insert tab', () => {
  jest.setTimeout(60000);

  it('opens empty, cancels with no undo, commits as one undo', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_ins'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'color.invert', instance_key: 'inv@0' }],
          wires: [],
          instances: { 'inv@0': { module_type: 'color.invert', state: {} } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_ins');
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    const chainLen = () => page.evaluate(`window.appState.database.sketches['sk_ins'].chain.length`) as Promise<number>;
    const chainTypes = () => page.evaluate(`window.appState.database.sketches['sk_ins'].chain.map(e => e.module_type)`) as Promise<string[]>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

    const dblClickFirstTab = `(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('tab-area')) {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        }
      }
      return false;
    })()`;

    // smart-input's editor text, or null if no editor is open.
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

    // Baseline: one effect, record the undo depth.
    expect(await chainLen()).toBe(1);
    const undo0 = await undoLen();

    // ---- Insert, then cancel with Escape ----
    expect(await page.evaluate(dblClickFirstTab)).toBe(true);
    await new Promise(r => setTimeout(r, 700));

    // Placeholder is in the chain and the smart-input is open but NOT pre-filled
    // with the placeholder effect's name (it shows CodeMirror's empty-state
    // "Search effects..." prompt, proving the doc is empty).
    expect(await chainLen()).toBe(2);
    const openText = await page.evaluate(smartInputText);
    expect(openText).not.toBeNull();
    expect(openText).not.toContain('brightness');

    await page.evaluate(focusSmartInput);
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 700));

    // Cancelled: placeholder gone, editor closed, NO undo point left behind.
    expect(await chainLen()).toBe(1);
    expect(await page.evaluate(smartInputText)).toBeNull();
    expect(await undoLen()).toBe(undo0);

    // ---- Insert, then commit "blend" via typing + Enter ----
    expect(await page.evaluate(dblClickFirstTab)).toBe(true);
    await new Promise(r => setTimeout(r, 700));
    await page.evaluate(focusSmartInput);
    await page.keyboard.type('blend', { delay: 40 });
    await new Promise(r => setTimeout(r, 400));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 700));

    // Committed: blend joined the chain, exactly ONE undo point for it all.
    expect(await chainLen()).toBe(2);
    expect(await chainTypes()).toContain('composite.blend');
    expect(await undoLen()).toBe(undo0 + 1);

    // And it undoes in a single step.
    await page.evaluate(`window.appController.history.undo()`);
    await new Promise(r => setTimeout(r, 500));
    expect(await chainLen()).toBe(1);
    expect(await chainTypes()).not.toContain('composite.blend');
  });

  it('existing effect: Escape reverts the type; empty commit deletes; click-away cancels insertion', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.mutate('s', d => {
        d.sketches['sk_edit'] = {
          anchor: null,
          chain: [{ type: 'module', module_type: 'color.invert', instance_key: 'inv@0' }],
          wires: [],
          instances: { 'inv@0': { module_type: 'color.invert', state: {} } },
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_edit');
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    const chainLen = () => page.evaluate(`window.appState.database.sketches['sk_edit'].chain.length`) as Promise<number>;
    const chainTypes = () => page.evaluate(`window.appState.database.sketches['sk_edit'].chain.map(e => e.module_type)`) as Promise<string[]>;
    const undoLen = () => page.evaluate(`window.appController.history.history.length`) as Promise<number>;

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
    const dblClickFirstTab = `(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('tab-area')) {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          return true;
        }
      }
      return false;
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

    // ---- Existing effect: preview a new type, then Escape → revert ----
    const undo0 = await undoLen();
    expect(await page.evaluate(dblClickEffectName)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(focusSmartInput);
    await page.keyboard.type('blend', { delay: 40 });   // replaces the selected "invert"
    await new Promise(r => setTimeout(r, 400));
    // Live preview swapped the type.
    expect(await chainTypes()).toContain('composite.blend');
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 600));
    // Reverted to the original type, nothing recorded.
    expect(await chainTypes()).toEqual(['color.invert']);
    expect(await undoLen()).toBe(undo0);

    // ---- Existing effect: clear the field + Enter → delete (one undo) ----
    expect(await page.evaluate(dblClickEffectName)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(focusSmartInput);
    await page.keyboard.press('Backspace');             // field opens with all text selected
    await new Promise(r => setTimeout(r, 200));
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 600));
    expect(await chainLen()).toBe(0);
    expect(await undoLen()).toBe(undo0 + 1);

    // Restore one effect for the click-away check.
    await page.evaluate(`window.appController.history.undo()`);
    await new Promise(r => setTimeout(r, 400));
    expect(await chainLen()).toBe(1);
    const undo1 = await undoLen();

    // ---- Insertion: click away (blur) → cancel, placeholder removed ----
    expect(await page.evaluate(dblClickFirstTab)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    expect(await chainLen()).toBe(2);
    expect(await page.evaluate(smartInputOpen)).toBe(true);
    await page.evaluate(blurSmartInput);
    await new Promise(r => setTimeout(r, 500));          // blur cancel is debounced ~150ms
    expect(await chainLen()).toBe(1);
    expect(await page.evaluate(smartInputOpen)).toBe(false);
    expect(await undoLen()).toBe(undo1);
  });
});
