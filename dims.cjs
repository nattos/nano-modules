const puppeteer = require('puppeteer');
(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 760 });
  const errs=[]; p.on('pageerror', e=>errs.push(String(e)));
  await p.goto('http://localhost:5174/arrangement.html', { waitUntil: 'networkidle2' });
  await p.waitForFunction(() => !!window.arrangementStore, { timeout: 15000 });
  const out = await p.evaluate(() => {
    const s = window.arrangementStore;
    const t = s.composition.tracks.find(x=>x.kind==='track');
    const path = s.createEmptyClip(t.id, 0, 8); const clipId = path.split('/')[2];
    s.setClipSource(t.id, clipId, { sourceKey:'k', url:'blob:fake', frameCount:100, fps:30, label:'V', width:0, height:0 });
    let threw = null, after = null;
    try { s.noteClipSourceDims(clipId, 1280, 720); }
    catch (e) { threw = String(e); }
    const c = s.clipByPath(`track/${t.id}/${clipId}`)?.clip;
    after = { width: c?.source?.width, height: c?.source?.height };
    return { threw, after };
  });
  console.log(JSON.stringify({ out, errs: errs.slice(0,3) }, null, 2));
  await b.close();
})();
