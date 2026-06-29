// Headless smoke for multi-edit phase 1: verifies that selecting 2+ clips flips
// the inspector to the multi panel (header "N clips" + a mounted <column-group>
// over the reconciled common chain) against the REAL store/build — no errors.
// The per-field "many" rendering is covered by the field-mixed.test.ts DOM tests
// (engine schema discovery is flaky/absent headless, so it's best-effort here).
import puppeteer from 'puppeteer';

const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5174';
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--no-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(BASE + '/arrangement.html', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => !!window.arrangementStore, { timeout: 15000 });
await page.evaluate(() => window.__engineBridge?.warm?.());

// Best-effort: wait up to 8s for an effect type to be discovered (optional).
const sharedType = await page.evaluate(async () => {
  const deadline = Date.now() + 8000;
  const toList = (eff) => {
    if (!eff) return [];
    if (Array.isArray(eff)) return eff;
    if (typeof eff.values === 'function') return [...eff.values()];
    return Object.values(eff);
  };
  while (Date.now() < deadline) {
    try {
      const t = toList(window.arrangementStore?.enginePlugins)
        .map((p) => p?.type).find((t) => t && !t.startsWith('source.'));
      if (t) return t;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
});

const result = await page.evaluate((type) => {
  const s = window.arrangementStore;
  const trackId = s.composition.tracks.find((t) => t.kind === 'track')?.id;
  const p1 = s.createEmptyClip(trackId, 0, 8);
  const p2 = s.createEmptyClip(trackId, 8, 8);
  const id1 = p1.split('/')[2];
  const id2 = p2.split('/')[2];
  let floatField = null;
  if (type) {
    s.addClipDeviceType(trackId, id1, type);
    s.addClipDeviceType(trackId, id2, type);
    const dev1 = s.trackById(trackId).clips.find((c) => c.id === id1).sketch.devices[0];
    const dev2 = s.trackById(trackId).clips.find((c) => c.id === id2).sketch.devices[0];
    const cat = s.enginePlugin(type);
    floatField = Object.entries(cat?.schema || {}).find(([, d]) => ((d.io ?? 0) & 1))?.[0] || Object.keys(cat?.schema || {})[0];
    if (dev1 && dev2 && floatField) {
      s.setClipDeviceField(trackId, id1, dev1.id, floatField, 0.1);
      s.setClipDeviceField(trackId, id2, dev2.id, floatField, 0.9);
    }
  }
  s.setSelection([p1, p2]);
  return { trackId, type, floatField, selSize: s.selection.size };
}, sharedType);

await new Promise((r) => setTimeout(r, 400));

const panel = await page.evaluate(() => {
  // Deep-find <arr-inspector> through nested shadow roots.
  const find = (root, sel) => {
    const stack = [root];
    while (stack.length) {
      const r = stack.pop();
      const hit = r.querySelector?.(sel);
      if (hit) return hit;
      r.querySelectorAll?.('*').forEach((el) => { if (el.shadowRoot) stack.push(el.shadowRoot); });
    }
    return null;
  };
  const insp = find(document, 'arr-inspector');
  if (!insp?.shadowRoot) return { error: 'no inspector' };
  const header = insp.shadowRoot.querySelector('.section-header')?.textContent?.trim();
  const colGroup = !!insp.shadowRoot.querySelector('column-group');
  let many = 0;
  const walk = (root) => {
    root.querySelectorAll('*').forEach((el) => {
      if (el.classList?.contains('value-display') && el.textContent?.trim() === 'many') many++;
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(insp.shadowRoot);
  return { header, colGroup, many };
});

// Ignore resource-load 404s (unrelated assets / optional bundles); only gate on
// real JS errors from our render path.
const errors = logs.filter((l) =>
  (l.startsWith('[error]') || l.startsWith('[pageerror]')) && !/Failed to load resource/.test(l));
console.log('SCENARIO:', JSON.stringify(result));
console.log('PANEL:', JSON.stringify(panel));
console.log('mixed "many" cells:', panel.many, sharedType ? '' : '(engine not warmed → editors absent, expected)');
const ok = !!panel.header && /clips/i.test(panel.header) && panel.colGroup && errors.length === 0;
console.log(ok ? 'SMOKE: PASS' : 'SMOKE: FAIL');
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));

await browser.close();
process.exit(ok ? 0 : 1);
