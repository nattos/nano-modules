/**
 * Instances-tab grid E2E (resolume shell, playground mode).
 *
 * Two playground instances render different solid colors simultaneously; the
 * Instances tab shows a card grid where each card carries a live
 * `sketch_output` thumbnail of ITS OWN instance (trace id embeds the instance
 * key). Asserts each card's canvas is dominated by that instance's color —
 * proving per-instance trace routing, not just "some pixels arrived".
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('instances tab thumbnail grid', () => {
  jest.setTimeout(90000);

  it('shows each instance rendering its own color on its card', async () => {
    page.removeAllListeners('console');

    await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 3000));

    // The icon font must be registered at document level in this entry —
    // <ui-icon> shadow CSS alone can't load @font-face, so a missing global
    // import renders every glyph as a blank box.
    // (The `las` glyph class uses weight 900; load() forces the lazy fetch —
    // check() alone reads false until some on-screen glyph triggers it.)
    const fontLoaded = await page.evaluate(
      `document.fonts.load('900 16px "Line Awesome Free"').then(faces => faces.length > 0)`);
    expect(fontLoaded).toBe(true);

    // Clean playground, then two instances: A solid green (+ a sidechannel
    // send on channel 2, for the sidechannel card grid below), B solid red.
    await page.evaluate(`(async () => {
      const ac = window.appController;
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
      const a = ac.createPlaygroundInstance();
      const b = ac.createPlaygroundInstance();
      ac.mutate('seed grid colors', d => {
        d.sketches[a].chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'green@1' },
          { type: 'module', module_type: 'util.sidechannel_out', instance_key: 'send@1' });
        d.sketches[a].instances['green@1'] =
          { module_type: 'source.solid_color', state: { color: [0.1, 0.9, 0.1, 1] } };
        d.sketches[a].instances['send@1'] =
          { module_type: 'util.sidechannel_out', state: { channel: 2 } };
        d.sketches[b].chain.push(
          { type: 'module', module_type: 'source.solid_color', instance_key: 'red@1' });
        d.sketches[b].instances['red@1'] =
          { module_type: 'source.solid_color', state: { color: [0.9, 0.1, 0.1, 1] } };
      });
      ac.setActiveTab('organize');
    })()`);
    await new Promise(r => setTimeout(r, 3500));

    // Each card: its label + the mean RGB of its thumbnail canvas.
    const cards = await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let tab = null;
      for (const el of walk(document)) { if (el.tagName === 'ORGANIZE-TAB') { tab = el; break; } }
      if (!tab?.shadowRoot) return null;
      const out = [];
      for (const card of tab.shadowRoot.querySelectorAll('.instance-card')) {
        const name = card.querySelector('.card-name')?.textContent?.trim() ?? '';
        const mon = card.querySelector('texture-monitor');
        const canvas = mon?.shadowRoot?.querySelector('canvas');
        if (!canvas || !canvas.width) { out.push({ name, w: 0, h: 0, r: -1, g: -1, b: -1 }); continue; }
        const ctx = canvas.getContext('2d');
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
        out.push({ name, w: canvas.width, h: canvas.height, r: r / n, g: g / n, b: b / n });
      }
      return out;
    })()`) as Array<{ name: string; w: number; h: number; r: number; g: number; b: number }> | null;

    expect(cards).not.toBeNull();
    expect(cards!.length).toBe(2);
    // Thumbnails register size-less → the trace controller's fixed LOW_RES
    // capture (128×72), NOT display size × dpr — the per-frame IPC/WS byte
    // cap. A regression to sized registrations shows up here as 192+.
    for (const c of cards!) {
      expect(c.w).toBe(128);
      expect(c.h).toBe(72);
    }
    const byName: Record<string, { r: number; g: number; b: number }> = {};
    for (const c of cards!) byName[c.name] = c;

    const green = byName['Instance 1'];
    const red = byName['Instance 2'];
    expect(green).toBeDefined();
    expect(red).toBeDefined();
    // Green card: green dominates both other channels.
    expect(green.g - green.r).toBeGreaterThan(60);
    expect(green.g - green.b).toBeGreaterThan(60);
    // Red card: red dominates — proves the two cards show DIFFERENT sketches.
    expect(red.r - red.g).toBeGreaterThan(60);
    expect(red.r - red.b).toBeGreaterThan(60);

    // -- Sidechannel cards: one per active channel, live thumbnail,
    //    selectable, renamable. --

    // The section sits below the instance grid — off-screen in the test
    // viewport, where the visibility gate correctly keeps its trace
    // unregistered. Scroll it into view and give the trace a beat to arrive.
    await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('sc-section')) {
          el.scrollIntoView();
          return;
        }
      }
    })()`);
    await new Promise(r => setTimeout(r, 1500));

    const scProbe = () => page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      let tab = null;
      for (const el of walk(document)) { if (el.tagName === 'ORGANIZE-TAB') { tab = el; break; } }
      if (!tab?.shadowRoot) return null;
      const cards = [...tab.shadowRoot.querySelectorAll('.sc-card')].map(c => {
        let thumb = null;
        const canvas = c.querySelector('texture-monitor')?.shadowRoot?.querySelector('canvas');
        if (canvas && canvas.width) {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
          thumb = { w: canvas.width, h: canvas.height, r: r / n, g: g / n, b: b / n };
        }
        return {
          name: c.querySelector('.sc-card-name')?.textContent?.trim() ?? '',
          info: c.querySelector('.sc-card-info')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
          selected: c.hasAttribute('selected'),
          thumb,
        };
      });
      // Scope to the SIDECHANNEL rename field (#sc-name) — the instance
      // inspector renders its own '.name-row editable-text' (#inst-name),
      // and an instance is selected by default.
      const et = tab.shadowRoot.querySelector('.name-row editable-text#sc-name');
      return { cards, inputValue: et ? et.value : null };
    })()`) as Promise<{
      cards: Array<{ name: string; info: string; selected: boolean;
                     thumb: { w: number; h: number; r: number; g: number; b: number } | null }>;
      inputValue: string | null;
    } | null>;

    const sc = await scProbe();
    expect(sc).not.toBeNull();
    expect(sc!.cards.length).toBe(1);
    expect(sc!.cards[0].name).toBe('2 — Instance 1');   // default label
    expect(sc!.cards[0].info).toContain('from Instance 1');
    expect(sc!.inputValue).toBeNull();                   // nothing selected yet
    // Live low-res thumbnail carrying the channel content (A's green).
    expect(sc!.cards[0].thumb).not.toBeNull();
    expect(sc!.cards[0].thumb!.w).toBe(128);
    expect(sc!.cards[0].thumb!.h).toBe(72);
    expect(sc!.cards[0].thumb!.g - sc!.cards[0].thumb!.r).toBeGreaterThan(60);
    expect(sc!.cards[0].thumb!.g - sc!.cards[0].thumb!.b).toBeGreaterThan(60);

    // Click the card → selected + the rename inspector appears (default "#").
    await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('sc-card')) { el.click(); return; }
      }
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const scSel = await scProbe();
    expect(scSel!.cards[0].selected).toBe(true);
    expect(scSel!.inputValue).toBe('#');

    // Rename with a "#" template → the card shows the expanded label.
    // (editable-text commits on Enter/blur of its inner control.)
    await page.evaluate(`(() => {
      function* walk(root) { for (const el of root.querySelectorAll('*')) { yield el; if (el.shadowRoot) yield* walk(el.shadowRoot); } }
      for (const el of walk(document)) {
        if (el.tagName === 'EDITABLE-TEXT' && el.id === 'sc-name') {
          const control = el.shadowRoot.querySelector('.control');
          control.focus();
          control.value = 'Drums #';
          control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return;
        }
      }
    })()`);
    await new Promise(r => setTimeout(r, 600));
    const scNamed = await scProbe();
    expect(scNamed!.cards[0].name).toBe('Drums 2 — Instance 1');

    // Cleanup for reruns/other suites (the name override persists in user
    // settings — reset it or later suites see "Drums …" in dropdowns).
    await page.evaluate(`(async () => {
      const ac = window.appController;
      ac.setSidechannelDisplayName('2', '#');
      ac.selectSidechannel(null);
      for (const inst of [...window.appState.local.barrelInstances]) {
        ac.deletePlaygroundInstanceById(inst.key);
      }
    })()`);
    await new Promise(r => setTimeout(r, 800));
  });
});
