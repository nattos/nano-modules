/**
 * Multi-select effect cards E2E (resolume shell, playground mode).
 *
 * Exercises the whole group-selection surface through real UI gestures:
 * Cmd+A select-all, cmd-click toggle, shift-click range, group copy (payload
 * carries the group's INTERNAL wire), group paste (fresh instance keys, wire
 * remapped onto them, contiguous block, one undo point), and group delete
 * (one undo point). The copy round-trips through the OS clipboard as JSON
 * when the browser grants permission — the same transport that carries a
 * group between surfaces (effect IDE / playground / live Resolume tabs).
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('multi-select effect cards', () => {
  jest.setTimeout(90000);

  it('select-all / toggle / copy / paste / delete operate on the group', async () => {
    page.removeAllListeners('console');
    // Let copy/paste round-trip the OS clipboard (falls back to the in-app
    // clipboard when denied, so this is best-effort).
    try {
      await browser.defaultBrowserContext()
        .overridePermissions(BASE, ['clipboard-read', 'clipboard-write']);
    } catch { /* older puppeteer/chrome — in-app clipboard covers the test */ }

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // One playground instance: solid → lfo → brightness_contrast, with a wire
    // lfo.output → bc.brightness (internal to a [lfo, bc] group).
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const id = ac.createPlaygroundInstance();
      ac.mutate('seed multi-select chain', d => {
        const sk = d.sketches[id];
        sk.chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'solid@1' },
          { type: 'module', module_type: 'mod.source.lfo', instance_key: 'lfo@1' },
          { type: 'module', module_type: 'color.tone.brightness_contrast', instance_key: 'bc@1' });
        sk.instances['solid@1'] =
          { module_type: 'source.solid_color', state: { color: [0.1, 0.9, 0.1, 1] } };
        sk.instances['lfo@1'] = { module_type: 'mod.source.lfo', state: {} };
        sk.instances['bc@1'] =
          { module_type: 'color.tone.brightness_contrast', state: { brightness: 1, contrast: 0.25 } };
        sk.wires = [{ id: 'w0', src: { instanceKey: 'lfo@1', field: 'output' },
                      dest: { instanceKey: 'bc@1', field: 'brightness' } }];
      });
      ac.setActiveTab('edit');
      window.__msTestSketchId = id;
    })()`);
    await new Promise(r => setTimeout(r, 2500));

    // Shared probes.
    const probe = () => page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      const cards = [];
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('effect-card')) {
          cards.push({ idx: el.dataset.chainIdx, selected: el.hasAttribute('selected') });
        }
      }
      const sk = window.appState.database.sketches[window.__msTestSketchId];
      return {
        cards,
        multi: [...window.appState.local.multiSelection],
        primary: window.appState.local.selection ? window.appState.local.selection.path
          : window.appState.local.queuedSelectionPath,
        chain: sk.chain.map(e => ({ type: e.module_type, key: e.instance_key })),
        wires: (sk.wires ?? []).map(w => ({
          id: w.id, src: { ...w.src }, dest: { ...w.dest } })),
        instances: JSON.parse(JSON.stringify(sk.instances)),
      };
    })()`) as Promise<any>;
    const pressKey = (key: string, mods: Record<string, boolean> = {}) => page.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown',
         Object.assign({ key: ${JSON.stringify(key)}, bubbles: true }, ${JSON.stringify(mods)})))`);
    const clickHeader = (chainIdx: number, mods: Record<string, boolean> = {}) => page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('effect-card')
            && el.dataset.chainIdx === '${chainIdx}') {
          const header = el.querySelector('.effect-card-header');
          const init = Object.assign({ bubbles: true, composed: true }, ${JSON.stringify(mods)});
          header.dispatchEvent(new PointerEvent('pointerdown', init));
          header.dispatchEvent(new PointerEvent('pointerup', init));
          return true;
        }
      }
      return false;
    })()`);

    let s = await probe();
    expect(s.cards.length).toBe(3);

    // -- Cmd+A selects every card. --
    await pressKey('a', { metaKey: true });
    await new Promise(r => setTimeout(r, 400));
    s = await probe();
    expect(s.multi.length).toBe(3);
    expect(s.cards.every((c: any) => c.selected)).toBe(true);

    // -- Cmd-click card 0 toggles it OUT of the group. --
    expect(await clickHeader(0, { metaKey: true })).toBe(true);
    await new Promise(r => setTimeout(r, 400));
    s = await probe();
    expect(s.multi.length).toBe(2);
    expect(s.cards.find((c: any) => c.idx === '0').selected).toBe(false);
    expect(s.cards.find((c: any) => c.idx === '1').selected).toBe(true);
    expect(s.cards.find((c: any) => c.idx === '2').selected).toBe(true);

    // -- Cmd+C copies the group WITH its internal wire. --
    await pressKey('c', { metaKey: true });
    await new Promise(r => setTimeout(r, 400));
    const clip = await page.evaluate(
      `JSON.parse(JSON.stringify(window.appState.local.clipboard))`) as any;
    expect(clip.kind).toBe('effects');
    expect(clip.items.map((i: any) => i.moduleType)).toEqual(
      ['mod.source.lfo', 'color.tone.brightness_contrast']);
    expect(clip.wires.length).toBe(1);
    expect(clip.wires[0].src.field).toBe('output');
    expect(clip.wires[0].dest.field).toBe('brightness');

    // -- Cmd+V pastes a contiguous block on fresh keys, wire remapped. --
    await pressKey('v', { metaKey: true });
    await new Promise(r => setTimeout(r, 800));
    s = await probe();
    expect(s.chain.length).toBe(5);
    expect(s.chain.map((e: any) => e.type)).toEqual([
      'source.solid_color', 'mod.source.lfo', 'color.tone.brightness_contrast',
      'mod.source.lfo', 'color.tone.brightness_contrast']);
    const pastedLfo = s.chain[3].key, pastedBc = s.chain[4].key;
    expect(pastedLfo).not.toBe('lfo@1');
    expect(pastedBc).not.toBe('bc@1');
    // Param state rode along.
    expect(s.instances[pastedBc].state.brightness).toBe(1);
    expect(s.instances[pastedBc].state.contrast).toBe(0.25);
    // The internal wire was duplicated ONTO THE PASTED KEYS (original intact).
    expect(s.wires.length).toBe(2);
    const pastedWire = s.wires.find((w: any) => w.id !== 'w0');
    expect(pastedWire.src).toEqual({ instanceKey: pastedLfo, field: 'output' });
    expect(pastedWire.dest).toEqual({ instanceKey: pastedBc, field: 'brightness' });
    // The pasted block ends up multi-selected.
    expect(s.multi.length).toBe(2);

    // -- Delete removes the pasted group; ONE undo restores all of it. --
    await pressKey('Backspace');
    await new Promise(r => setTimeout(r, 400));
    s = await probe();
    expect(s.chain.length).toBe(3);
    expect(s.wires.length).toBe(1);
    await pressKey('z', { metaKey: true });
    await new Promise(r => setTimeout(r, 400));
    s = await probe();
    expect(s.chain.length).toBe(5);
    expect(s.wires.length).toBe(2);

    // -- Shift-click extends a contiguous range from the primary. --
    // (Plain-select the anchor via the controller: a synthetic no-modifier
    // pointerdown would also start the card-drag op, which needs a real
    // pointer for its capture/release. Modifier clicks skip the drag path.)
    await page.evaluate(
      `window.appController.select('effect/' + window.__msTestSketchId + '/0/0')`);
    await new Promise(r => setTimeout(r, 300));
    await clickHeader(2, { shiftKey: true });
    await new Promise(r => setTimeout(r, 300));
    s = await probe();
    expect(s.multi.length).toBe(3);
    expect(s.cards.filter((c: any) => c.selected).map((c: any) => c.idx).sort())
      .toEqual(['0', '1', '2']);

    // Cleanup for other suites.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.select(null);
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    await new Promise(r => setTimeout(r, 500));
  });
});
