/**
 * The Effects (store) tab.
 *
 * A catalog of every effect as a card grid, with thumbnails baked on the
 * store's own preview engine (each effect's preview scenario), live previews
 * on hover, sticky view settings and emoji reactions, and two ways to place an
 * effect: with a breadcrumb target from the type editor's Browse…, or straight
 * into the current sketch.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

const WALK = `function* walk(root){for(const el of root.querySelectorAll('*')){yield el; if(el.shadowRoot) yield* walk(el.shadowRoot);}}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`${BASE}/resolume/index.html?playground`, { waitUntil: 'networkidle0' });
  await sleep(2500);
}

/** Start from nothing cached and a default store view. */
async function resetStore() {
  await page.evaluate(`(async () => {
    const ac = window.appController;
    ac.setActiveTab('edit');  // unmount a store left open by an earlier test
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((res) => { const r = indexedDB.deleteDatabase('nano-effect-thumbs'); r.onsuccess = r.onerror = () => res(); });
    ac.setUserSetting('effectStore', { collection: 'category', show: 'all', size: 'm', showDebug: false, filtersOpen: false, query: '' });
    ac.setUserSetting('effectReactions', {});
  })()`);
}

async function openStore() {
  await page.evaluate(`window.appController.setActiveTab('store')`);
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const n = await page.evaluate(`(() => { ${WALK} let n = 0; for (const el of walk(document)) if (el.tagName === 'EFFECT-STORE-CARD') n++; return n; })()`);
    if ((n as number) > 0) return;
  }
  const why = await page.evaluate(`JSON.stringify({ tab: window.appState.local.activeTab, view: window.appState.local.userSettings.effectStore })`);
  throw new Error('store never listed any effects: ' + why);
}

async function setQuery(q: string) {
  await page.evaluate(`(() => {
    const ac = window.appController;
    ac.setUserSetting('effectStore', { ...window.appState.local.userSettings.effectStore, query: ${JSON.stringify(q)} });
  })()`);
  await sleep(300);
}

/** Card ids in the grid, in order. */
const cardIds = `(() => { ${WALK} const out = []; for (const el of walk(document)) if (el.tagName === 'EFFECT-STORE-CARD') out.push(el.effect.id); return out; })()`;

/** Wait for `effectId`'s card to show a baked thumbnail; returns pixel stats. */
async function thumbStats(effectId: string): Promise<{ kind: string; distinct: number; mean: number } | null> {
  for (let i = 0; i < 120; i++) {
    const r = await page.evaluate(`(async () => { ${WALK}
      for (const el of walk(document)) {
        if (el.tagName !== 'EFFECT-STORE-CARD' || el.effect.id !== ${JSON.stringify(effectId)}) continue;
        const v = el.thumbs && el.thumbs.views.get(${JSON.stringify(effectId)});
        if (!v) return null;
        const img = new Image(); img.src = v.url; await img.decode();
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set(); let sum = 0, n = 0;
        for (let p = 0; p < d.length; p += 4 * 53) { seen.add((d[p] >> 3) + ',' + (d[p+1] >> 3) + ',' + (d[p+2] >> 3)); sum += d[p] + d[p+1] + d[p+2]; n++; }
        return { kind: v.kind, distinct: seen.size, mean: sum / n / 3 };
      }
      return null;
    })()`);
    if (r) return r as any;
    await sleep(250);
  }
  return null;
}

describe('Effects store', () => {
  jest.setTimeout(120000);

  it('lists effects, narrows by query, and keeps its view settings', async () => {
    await boot();
    await resetStore();
    await openStore();
    await setQuery('bright');
    const ids = await page.evaluate(cardIds) as string[];
    expect(ids[0]).toBe('color.tone.brightness_contrast');

    // A path query narrows to a folder, grouped.
    await setQuery('composite.');
    const comp = await page.evaluate(cardIds) as string[];
    expect(comp.length).toBeGreaterThan(0);
    expect(comp.every((id) => id.startsWith('composite.'))).toBe(true);

    // Pick a collection and a sort through the UI (both live under Settings &
    // filters); they survive a reload.
    const clickButton = (text: string) => page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) if (el.tagName === 'BUTTON' && el.textContent.trim() === ${JSON.stringify(text)}) { el.click(); return true; }
      return false; })()`);
    expect(await clickButton('Bundle')).toBe(false); // collapsed
    expect(await clickButton('Settings & filters')).toBe(true);
    await sleep(100);
    expect(await clickButton('Bundle')).toBe(true);
    await sleep(100);
    expect(await clickButton('Newest')).toBe(true);
    await sleep(800); // debounced settings save
    await boot();
    const after = await page.evaluate(`JSON.parse(JSON.stringify({ tab: window.appState.local.activeTab, view: window.appState.local.userSettings.effectStore }))`) as any;
    expect(after.tab).toBe('store');
    expect(after.view.collection).toBe('bundle');
    expect(after.view.sort).toBe('newest');
    expect(after.view.query).toBe('composite.');
  });

  it('bakes thumbnails from each effect’s preview scenario', async () => {
    await boot();
    await resetStore();
    await openStore();

    await setQuery('color.tone.brightness');
    const bc = await thumbStats('color.tone.brightness_contrast');
    expect(bc).not.toBeNull();
    expect(bc!.kind).toBe('image');
    expect(bc!.distinct).toBeGreaterThan(20); // the gradient input, not a flat/blank frame

    // Blend needs its scenario's second picture wired into tex_b; without one
    // it renders nothing (a transparent checkerboard: 2 colours).
    await setQuery('composite.blend');
    const blend = await thumbStats('composite.blend');
    expect(blend).not.toBeNull();
    expect(blend!.distinct).toBeGreaterThan(20);

    // A modulation effect is shown as a graph of its output.
    await setQuery('mod.source.lfo');
    const lfo = await thumbStats('mod.source.lfo');
    expect(lfo).not.toBeNull();
    expect(lfo!.kind).toBe('graph');

    // They're cached under a key, so a revisit doesn't bake again.
    const cached = await page.evaluate(`new Promise((res) => {
      const r = indexedDB.open('nano-effect-thumbs');
      r.onsuccess = () => {
        const g = r.result.transaction('thumbs').objectStore('thumbs').getAll();
        g.onsuccess = () => res(g.result.map((x) => x.effectId).sort());
      };
    })`) as string[];
    expect(cached).toEqual(expect.arrayContaining(['color.tone.brightness_contrast', 'composite.blend', 'mod.source.lfo']));
  });

  it('runs a card live while hovered', async () => {
    await boot();
    await resetStore();
    await openStore();
    await setQuery('color.tone.brightness');
    await thumbStats('color.tone.brightness_contrast');
    const pt = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) if (el.tagName === 'EFFECT-STORE-CARD' && el.effect.id === 'color.tone.brightness_contrast') {
        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 30 }; }
      return null; })()`) as { x: number; y: number };
    await page.mouse.move(pt.x, pt.y);
    const sample = `(() => { ${WALK}
      for (const el of walk(document)) if (el.tagName === 'EFFECT-STORE-CARD' && el.effect.id === 'color.tone.brightness_contrast') {
        const c = el.shadowRoot.querySelector('canvas.live');
        if (!c || !c.width) return null;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let h = 0; for (let p = 0; p < d.length; p += 4 * 97) h = (h * 31 + d[p] + d[p+1] * 7 + d[p+2] * 13) | 0;
        return h;
      }
      return null; })()`;
    let a: number | null = null;
    for (let i = 0; i < 40 && a === null; i++) { await sleep(150); a = await page.evaluate(sample) as number | null; }
    expect(a).not.toBeNull();
    let b = a;
    for (let i = 0; i < 20 && b === a; i++) { await sleep(150); b = await page.evaluate(sample) as number | null; }
    expect(b).not.toBe(a); // frames keep arriving: it is animating

    // Leaving the card stops it.
    await page.mouse.move(5, 5);
    await sleep(600);
    const live = await page.evaluate(sample);
    expect(live).toBeNull();
  });

  it('reactions toggle, persist, and collect under Favs', async () => {
    await boot();
    await resetStore();
    await openStore();
    await setQuery('color.tone.brightness');
    const card = `(() => { ${WALK}
      for (const el of walk(document)) if (el.tagName === 'EFFECT-STORE-CARD' && el.effect.id === 'color.tone.brightness_contrast') return el;
      return null; })()`;
    // No reactions yet: the card spends no room on them.
    expect(await page.evaluate(`!!${card}.shadowRoot.querySelector('.reactions')`)).toBe(false);
    // The floating button opens the compact quick row; its "+" expands it into
    // the full picker, which keeps the quick row on top.
    const pickerState = `(() => { const p = ${card}.shadowRoot.querySelector('emoji-picker');
      return p && { quick: p.shadowRoot.querySelectorAll('.quick button:not(.more)').length,
        more: !!p.shadowRoot.querySelector('.quick .more'), search: !!p.shadowRoot.querySelector('input') }; })()`;
    await page.evaluate(`${card}.shadowRoot.querySelector('.react-btn').click()`);
    await sleep(100);
    expect(await page.evaluate(pickerState)).toEqual({ quick: 6, more: true, search: false });
    await page.evaluate(`${card}.shadowRoot.querySelector('emoji-picker').shadowRoot.querySelector('.quick .more').click()`);
    await sleep(100);
    expect(await page.evaluate(pickerState)).toEqual({ quick: 6, more: false, search: true });
    const reacted = await page.evaluate(`(() => {
      const picker = ${card}.shadowRoot.querySelector('emoji-picker');
      const b = picker && picker.shadowRoot.querySelector('.quick button');
      if (!b) return null;
      b.click();
      return b.textContent.trim();
    })()`) as string;
    expect(reacted).toBeTruthy();
    await sleep(100);
    const after = await page.evaluate(`(() => { const r = ${card}.shadowRoot;
      return { picker: !!r.querySelector('emoji-picker'), chips: [...r.querySelectorAll('.reactions .reaction')].map((c) => c.textContent.trim()) }; })()`) as any;
    expect(after).toEqual({ picker: false, chips: [reacted] });
    await sleep(800);
    await boot();
    const s = await page.evaluate(`JSON.parse(JSON.stringify(window.appState.local.userSettings))`) as any;
    expect(s.effectReactions['color.tone.brightness_contrast']).toEqual([reacted]);
    expect(s.recentEmoji[0]).toBe(reacted);
    await page.evaluate(`window.appController.setUserSetting('effectStore', { ...window.appState.local.userSettings.effectStore, query: '', collection: 'favs' })`);
    await openStore().catch(() => {}); // Favs lists just the one card
    await sleep(500);
    expect(await page.evaluate(cardIds)).toEqual(['color.tone.brightness_contrast']);
  });
});

describe('Effects store: placing effects', () => {
  jest.setTimeout(120000);

  async function seedSketch() {
    await page.evaluate(`(() => {
      const ac = window.appController;
      const types = ['color.tone.brightness_contrast', 'color.tone.levels'];
      ac.mutate('seed', (d) => {
        d.sketches['sk_store'] = {
          anchor: null,
          chain: types.map((t, i) => ({ type: 'module', module_type: t, instance_key: 'e' + i })),
          instances: Object.fromEntries(types.map((t, i) => ['e' + i, { module_type: t, state: {} }])),
        };
      });
      ac.setActiveTab('edit');
      ac.editSketch('sk_store');
    })()`);
    await sleep(1500);
  }
  const chainTypes = `JSON.parse(JSON.stringify(window.appState.database.sketches['sk_store'].chain.map((e) => e.module_type)))`;
  const undoDepth = `window.appController.history.history.length`;
  const floatMonitor = `(() => { ${WALK} for (const el of walk(document)) if (el.tagName === 'DEVICES-FLOAT-MONITOR') return true; return false; })()`;

  async function clickCardAction(effectId: string, label: string) {
    const ok = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) if (el.tagName === 'EFFECT-STORE-CARD' && el.effect.id === ${JSON.stringify(effectId)}) {
        for (const b of el.shadowRoot.querySelectorAll('.actions button')) if (b.textContent.trim() === ${JSON.stringify(label)}) { b.click(); return true; }
      }
      return false; })()`);
    expect(ok).toBe(true);
    await sleep(400);
  }

  it('Browse… from the type editor: Preview hot-swaps uncommitted, Use commits and returns', async () => {
    await boot();
    await resetStore();
    await seedSketch();

    // Open the type editor on card 1 and press Browse….
    const opened = await page.evaluate(`(async () => { ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('effect-card-name') && el.textContent.includes('Levels')) {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
          await new Promise((r) => setTimeout(r, 400));
          for (const b of walk(document)) if (b.classList && b.classList.contains('type-browse')) { b.click(); return true; }
        }
      }
      return false; })()`);
    expect(opened).toBe(true);
    await sleep(300);
    expect(await page.evaluate(`window.appState.local.activeTab`)).toBe('store');
    await openStore();
    await setQuery('composite.blend');

    const before = await page.evaluate(undoDepth) as number;
    await clickCardAction('composite.blend', 'Preview');
    expect(await page.evaluate(chainTypes)).toEqual(['color.tone.brightness_contrast', 'composite.blend']);
    expect(await page.evaluate(undoDepth)).toBe(before);          // uncommitted
    expect(await page.evaluate(floatMonitor)).toBe(true);          // the output pops out

    await clickCardAction('composite.blend', 'Use here');
    expect(await page.evaluate(chainTypes)).toEqual(['color.tone.brightness_contrast', 'composite.blend']);
    expect(await page.evaluate(undoDepth)).toBe(before + 1);      // one undo point
    expect(await page.evaluate(`window.appState.local.activeTab`)).toBe('edit');
  });

  it('Back drops the preview, and with no target Insert lands after the selection', async () => {
    await boot();
    await resetStore();
    await seedSketch();

    // Back: a breadcrumb retype, previewed, then abandoned.
    await page.evaluate(`(async () => { ${WALK}
      for (const el of walk(document)) {
        if (el.classList && el.classList.contains('effect-card-name') && el.textContent.includes('Brightness')) {
          el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
          await new Promise((r) => setTimeout(r, 400));
          for (const b of walk(document)) if (b.classList && b.classList.contains('type-browse')) { b.click(); return; }
        }
      } })()`);
    await openStore();
    await setQuery('color.tone.levels');
    await clickCardAction('color.tone.levels', 'Preview');
    expect(await page.evaluate(chainTypes)).toEqual(['color.tone.levels', 'color.tone.levels']);
    const back = await page.evaluate(`(() => { ${WALK}
      for (const el of walk(document)) if (el.tagName === 'BUTTON' && el.textContent.trim() === 'Back') { el.click(); return true; }
      return false; })()`);
    expect(back).toBe(true);
    await sleep(400);
    expect(await page.evaluate(chainTypes)).toEqual(['color.tone.brightness_contrast', 'color.tone.levels']);
    expect(await page.evaluate(`window.appState.local.activeTab`)).toBe('edit');

    // No target: select card 0, then Insert twice — each lands after the last.
    await page.evaluate(`window.appController.select('effect/sk_store/0/0')`);
    await page.evaluate(`window.appController.setActiveTab('store')`);
    await openStore();
    await setQuery('composite.blend');
    await clickCardAction('composite.blend', 'Insert');
    expect(await page.evaluate(chainTypes)).toEqual(['color.tone.brightness_contrast', 'composite.blend', 'color.tone.levels']);
    expect(await page.evaluate(`window.appState.local.activeTab`)).toBe('store'); // stays
    await clickCardAction('composite.blend', 'Insert');
    expect(await page.evaluate(chainTypes)).toEqual(
      ['color.tone.brightness_contrast', 'composite.blend', 'composite.blend', 'color.tone.levels']);
  });
});
