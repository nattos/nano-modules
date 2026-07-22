import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
page.on('console', (m) => { const t = m.text(); if (t.includes('[inj]')) console.log(t.slice(0, 150)); });

await page.goto('http://localhost:5173/arrangement.html', { waitUntil: 'networkidle0' });
await page.waitForFunction(() => !!window.arrangementStore && !!customElements.get('arrangement-app'), { timeout: 20000 });
await page.waitForFunction(() => !!window.arrangementStore.enginePlugins['core.transport.follow'], { timeout: 30000 });

const ids = await page.evaluate(async () => {
  const store = window.arrangementStore;
  const resp = await fetch('/media/test_dxv.mov');
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const st = store.addSceneTrack();
  const bpb = store.composition.meta.timeSignature[0];
  const mk = (bar, endSec) => {
    const path = store.addVideoClip(st, bar * bpb,
      { sourceKey: `gl:${bar}`, url, frameCount: 55, fps: 30, label: 'dxv' }, 4);
    const cId = path.split('/')[2];
    const clip = store.trackById(st).clips.find((c) => c.id === cId);
    clip.loop = { mode: 'time', startSec: 0, endSec, speed: 1, direction: 'forward' };
    const devId = store.insertClipTransportDeviceAt(st, cId, 0, 'core.transport.follow');
    store.setClipTransportDeviceField(st, cId, devId, 'followAfter', 2);
    store.setClipTransportDeviceField(st, cId, devId, 'followSec', 1.2);
    return cId;
  };
  const a = mk(0, 55 / 30);
  const b = mk(1, 1.0);
  store.docRev++;
  store.positionBeat = 0;
  return { st, a, b, mode: store.transportMode };
});
console.log('scenario', JSON.stringify(ids));

const bbox = await page.evaluate(() => {
  const cs = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS') cs.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  cs.sort((x, y) => (y.width * y.height) - (x.width * x.height));
  const r = cs[0].getBoundingClientRect();
  return { x: r.x, y: r.y, width: Math.min(320, r.width), height: Math.min(180, r.height) };
});

const t0 = Date.now();
await page.evaluate((x) => {
  const store = window.arrangementStore;
  window.__tl = [];
  window.__t0 = performance.now();
  const tick = () => {
    const l = store.sceneLaunchState[x.st];
    window.__tl.push({ t: performance.now() - window.__t0, s: l?.sceneId === x.a ? 'A' : l?.sceneId === x.b ? 'B' : '-' });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  store.playing = true;
  store.launchScene(x.st, x.a);
}, ids);
const shots = [];
while (Date.now() - t0 < 15000) {
  const buf = await page.screenshot({ clip: bbox, type: 'png' });
  shots.push({ t: Date.now() - t0, size: buf.length });
}
const sizes = shots.map((s) => s.size).sort((a, b) => a - b);
const thr = Math.max(sizes[0] * 1.3, sizes[(sizes.length / 2) | 0] * 0.35);
const spans = [];
let cur = null;
for (const s of shots) {
  const blank = s.size < thr;
  if (!cur || cur.blank !== blank) { if (cur) spans.push(cur); cur = { blank, from: s.t, n: 0 }; }
  cur.n++; cur.to = s.t;
}
if (cur) spans.push(cur);
console.log(`shots=${shots.length} blanks:`, spans.filter((s) => s.blank).map((s) => `${s.from}-${s.to}ms(${s.n})`).join(' ') || 'NONE');
// Scene changes observed (sanity: the ping-pong ran).
const changes = await page.evaluate((x) => {
  const store = window.arrangementStore;
  return store.sceneLaunchState[x.st]?.sceneId ?? null;
}, ids);
console.log('final scene:', changes === ids.a ? 'A' : changes === ids.b ? 'B' : changes);
const tl = await page.evaluate(() => {
  const out = [];
  let cur = null;
  for (const e of window.__tl) {
    if (!cur || cur.s !== e.s) { if (cur) out.push(cur); cur = { s: e.s, from: Math.round(e.t) }; }
    cur.to = Math.round(e.t);
  }
  if (cur) out.push(cur);
  return out;
});
console.log('scene timeline:', JSON.stringify(tl.map((e) => `${e.s}@${e.from}`)));
await browser.close();
