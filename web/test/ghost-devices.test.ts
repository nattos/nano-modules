/**
 * Ghost MIDI devices E2E (resolume shell, playground).
 *
 * Wires referencing device uuids no library instance answers to must surface
 * as "missing device" cards in the Devices tab, grouped per uuid with
 * wire/control/sketch counts. Selecting one opens the details panel with the
 * two adopt actions — BOTH revive the mappings with ZERO sketch edits:
 *   - adopt-as-new: a library instance is created whose id IS the ghost uuid;
 *   - "this is my X": the uuid joins an existing instance's knownAs aliases.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;

describe('ghost devices', () => {
  jest.setTimeout(60000);

  it('shows grouped missing-device cards; adopt + alias revive without wire edits', async () => {
    page.removeAllListeners('console');
    await page.setViewport({ width: 1600, height: 1000 });
    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // Two instances; wires reference TWO ghost uuids (and no live device).
    const setup = await page.evaluate(`(async () => {
      const ac = window.appController;
      const idA = ac.createPlaygroundInstance();
      const idB = ac.createPlaygroundInstance();
      const chain = (key) => ([{ type: 'module', module_type: 'util.dashboard', instance_key: key }]);
      ac.mutate('seed', d => {
        d.sketches[idA].chain = chain('da@0');
        d.sketches[idA].instances = { 'da@0': { module_type: 'util.dashboard', state: {} } };
        d.sketches[idA].wires = [
          { id: 'g1a', src: { instanceKey: 'midi:ghost-uuid-one', field: 'b0/e05/turn' },
            dest: { instanceKey: 'da@0', field: 'knob_3' }, combine: 'add', mod: { scale: 0.5 } },
          { id: 'g1b', src: { instanceKey: 'midi:ghost-uuid-one', field: 'b0/e05/press' },
            dest: { instanceKey: 'da@0', field: 'knob_1' }, combine: 'add' },
          { id: 'g2a', src: { instanceKey: 'midi:ghost-uuid-two', field: 'b1/e08/turn' },
            dest: { instanceKey: 'da@0', field: 'knob_2' }, combine: 'add' },
        ];
        d.sketches[idB].chain = chain('db@0');
        d.sketches[idB].instances = { 'db@0': { module_type: 'util.dashboard', state: {} } };
        d.sketches[idB].wires = [
          { id: 'g1c', src: { instanceKey: 'midi:ghost-uuid-one', field: 'b2/e00/turn' },
            dest: { instanceKey: 'db@0', field: 'knob_7' }, combine: 'add' },
        ];
      });
      ac.editSketch(idA);
      ac.setActiveTab('devices');
      return { idA, idB,
               wiresBefore: JSON.stringify([d => d].map(() => [
                 window.appState.database.sketches[idA].wires,
                 window.appState.database.sketches[idB].wires])) };
    })()`) as { idA: string; idB: string; wiresBefore: string };
    await new Promise(r => setTimeout(r, 1500));

    // Two missing-device cards, grouped per uuid, with counts.
    const cards = await page.evaluate(`(() => {
      ${WALK}
      const out = [];
      for (const el of walk(document)) {
        if (el.tagName === 'DEVICE-CARD' && el.status === 'missing') {
          out.push({ name: el.name, subtitle: el.subtitle.replace(/\\s+/g, ' ').trim() });
        }
      }
      return out;
    })()`) as { name: string; subtitle: string }[];
    expect(cards).toHaveLength(2);
    const one = cards.find(c => c.subtitle.startsWith('ghost-uu') && c.subtitle.includes('3 wires'))!;
    expect(one).toBeTruthy();
    expect(one.subtitle).toContain('2 controls');   // b0/e05 + b2/e00
    expect(one.subtitle).toContain('2 sketches');
    const two = cards.find(c => c.subtitle.includes('1 wire '))!;
    expect(two).toBeTruthy();
    expect(two.subtitle).toContain('1 sketch');

    // Select ghost-one's card → details panel shows adopt actions + controls.
    await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.tagName === 'DEVICE-CARD' && el.status === 'missing'
            && el.subtitle.includes('3 wires')) { el.click(); return; }
      }
    })()`);
    await new Promise(r => setTimeout(r, 600));

    // Adopt as new MFT: library gains an instance whose id IS the ghost uuid.
    const adopted = await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'DEVICE-CONTROL-DETAILS') continue;
        const btns = [...el.shadowRoot.querySelectorAll('.ghost-btn')];
        const adopt = btns.find(b => b.textContent.includes('Adopt as new'));
        if (!adopt) return { found: false, texts: btns.map(b => b.textContent.trim()) };
        adopt.click();
        return { found: true };
      }
      return null;
    })()`) as any;
    expect(adopted?.found).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    const lib1 = await page.evaluate(`JSON.parse(JSON.stringify(
      window.appState.local.midi.library.map(i => ({ id: i.id, knownAs: i.knownAs ?? [] }))))`) as any[];
    expect(lib1.map(i => i.id)).toContain('ghost-uuid-one');

    // Ghost-one's card is gone; ghost-two remains. Alias it onto the adopted
    // device via its details panel.
    await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.tagName === 'DEVICE-CARD' && el.status === 'missing') { el.click(); return; }
      }
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const aliased = await page.evaluate(`(() => {
      ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'DEVICE-CONTROL-DETAILS') continue;
        const btns = [...el.shadowRoot.querySelectorAll('.ghost-btn')];
        const mine = btns.find(b => b.textContent.includes('This is my'));
        if (!mine) return { found: false };
        mine.click();
        return { found: true };
      }
      return null;
    })()`) as any;
    expect(aliased?.found).toBe(true);
    await new Promise(r => setTimeout(r, 600));

    const after = await page.evaluate(`JSON.parse(JSON.stringify({
      lib: window.appState.local.midi.library.map(i => ({ id: i.id, knownAs: i.knownAs ?? [] })),
      missing: (() => { ${WALK}
        let n = 0;
        for (const el of walk(document)) if (el.tagName === 'DEVICE-CARD' && el.status === 'missing') n++;
        return n; })(),
      wiresA: window.appState.database.sketches[${JSON.stringify(setup.idA)}].wires,
      wiresB: window.appState.database.sketches[${JSON.stringify(setup.idB)}].wires,
    }))`) as any;
    // Alias recorded on the adopted instance; no missing cards left.
    const adoptedInst = after.lib.find((i: any) => i.id === 'ghost-uuid-one');
    expect(adoptedInst.knownAs).toContain('ghost-uuid-two');
    expect(after.missing).toBe(0);
    // THE core contract: no sketch wire was modified by either action.
    expect(after.wiresA.map((w: any) => w.src.instanceKey)).toEqual(
      ['midi:ghost-uuid-one', 'midi:ghost-uuid-one', 'midi:ghost-uuid-two']);
    expect(after.wiresA[0].mod).toEqual({ scale: 0.5 });
    expect(after.wiresB[0].src.instanceKey).toBe('midi:ghost-uuid-one');
  });
});
