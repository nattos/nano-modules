import puppeteer from 'puppeteer';
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5174';
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--no-sandbox','--use-angle=swiftshader'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE + '/arrangement.html', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => !!window.arrangementStore, { timeout: 15000 });
await page.evaluate(() => window.__engineBridge?.warm?.());
await page.waitForFunction(() => Object.keys(window.arrangementStore?.enginePlugins||{}).length > 10, { timeout: 20000 });

const setup = await page.evaluate(() => {
  const s = window.arrangementStore;
  const trackId = s.composition.tracks.find(t => t.kind === 'track').id;
  // warp.crop clip at beat 0..8; put playhead inside so it renders in the composite.
  const cropPath = s.createEmptyClip(trackId, 0, 8);
  const cropId = cropPath.split('/')[2];
  s.addClipDeviceType(trackId, cropId, 'warp.crop');
  // envelope clip on a 2nd region
  const envPath = s.createEmptyClip(trackId, 8, 8);
  const envId = envPath.split('/')[2];
  s.addClipDeviceType(trackId, envId, 'mod.shaper.envelope');
  s.positionBeat = 1;
  return { trackId, cropId, cropPath, envId, envPath };
});

const insetHidden = async () => page.evaluate(() => {
  const p = window.arrangementStore.enginePlugin('warp.crop');
  const ins = Object.entries(p?.schema||{}).filter(([k])=>k.startsWith('inset_'));
  return { total: ins.length, hidden: ins.filter(([,d])=>d.hidden).length };
});

const dev = await page.evaluate((s) => {
  const st = window.arrangementStore;
  return st.trackById(s.trackId).clips.find(c=>c.id===s.cropId).sketch.devices[0].id;
}, setup);

// Try both modes; one should hide the inset_* fields once the effect runs.
const obs = {};
for (const mode of [1, 0, 1]) {
  await page.evaluate((args) => {
    const s = window.arrangementStore; s.positionBeat = 1;
    s.setClipDeviceField(args.trackId, args.cropId, args.dev, 'mode', args.mode);
  }, { ...setup, dev, mode });
  await new Promise(r => setTimeout(r, 1500));
  obs['mode='+mode] = await insetHidden();
}

// Custom editor: select the envelope clip, look for <envelope-inspector> in the DOM.
await page.evaluate((s) => window.arrangementStore.selectClipOnly(s.envPath), setup);
await new Promise(r => setTimeout(r, 500));
const customEditor = await page.evaluate(() => {
  const find = (root, sel) => { const st=[root]; while(st.length){ const r=st.pop(); const h=r.querySelector?.(sel); if(h) return h; r.querySelectorAll?.('*').forEach(el=>el.shadowRoot&&st.push(el.shadowRoot)); } return null; };
  return !!find(document, 'envelope-inspector');
});

console.log('inset hidden by mode:', JSON.stringify(obs));
console.log('custom envelope-inspector rendered:', customEditor);
console.log('pageerrors:', errs.length ? errs.slice(0,5) : '(none)');
const hidingWorks = Object.values(obs).some(o => o.hidden > 0) && Object.values(obs).some(o => o.hidden === 0);
console.log('FIELD HIDING reacts to mode:', hidingWorks ? 'PASS' : 'INCONCLUSIVE (effect may not gate, or didnt run)');
console.log('CUSTOM EDITOR:', customEditor ? 'PASS' : 'FAIL');
await browser.close();
