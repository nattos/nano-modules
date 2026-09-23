/**
 * Electron-side probe for test/desktop-media.test.ts. Runs in the MAIN
 * process: boots the real electron/main.cjs (MAIN_CJS) with its own profile
 * (PROFILE), waits for the arrangement page, runs the page script named by
 * PHASE against the project folder PROJ, and prints `PROBE <json>`.
 */
const { app, BrowserWindow } = require('electron');
app.setPath('userData', process.env.PROFILE);
require(process.env.MAIN_CJS);
const PROJ = process.env.PROJ;
const PAGE = {
  // Save: a desktop clip outside any library, in a nested document.
  save: `(async () => {
    const P = window.__paths, S = window.arrangementStore, WB = window.__workspaceBackend, MS = window.__mediaStore;
    const CLIP = ${JSON.stringify(process.env.PROJ + '/media/clip.mp4')};
    const out = {};
    const url = P.mediaUrlForPath(CLIP);
    const r = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    out.page = { status: r.status, cr: r.headers.get('content-range'), len: (await r.arrayBuffer()).byteLength, type: r.headers.get('content-type') };
    const w = new Worker(URL.createObjectURL(new Blob([
      "onmessage=async e=>{try{const r=await fetch(e.data,{headers:{Range:'bytes=10-19'}});postMessage([r.status,(await r.arrayBuffer()).byteLength])}catch(err){postMessage(String(err))}}"])));
    out.worker = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage(url); });
    const dir = await P.getHandleFromAbsPath(${JSON.stringify(PROJ)});
    const be = new WB.DirectoryBackend(dir, 'proj');
    await S.mountWorkspace(be);
    await S.createArrangement(be, 'acts/show');
    const fh = await P.getHandleFromAbsPath(CLIP);
    const linked = await MS.linkMedia(fh);
    const m = await window.__dropImport.importMedia(linked.media, linked.sourceKey);
    out.import = { url: m.url, frames: m.frameCount, w: m.width, dur: m.durationSec };
    const trk = S.addTrack();
    S.addVideoClip(trk, 0, { sourceKey: m.sourceKey, url: m.url, frameCount: m.frameCount, fps: m.fps,
      label: m.label, width: m.width, height: m.height,
      ...(linked.docRef ? { ref: linked.docRef } : {}), ...(linked.docFile ? { file: linked.docFile } : {}) }, 4);
    await S.saveNow();
    const saved = JSON.parse(await (await (await (await dir.getDirectoryHandle('acts')).getFileHandle('show.nano-arr')).getFile()).text());
    const clips = saved.composition.tracks.flatMap((t) => t.clips).filter((c) => c.source);
    out.saved = clips.map((c) => c.source);
    return out;
  })()`,
  // Reopen from a FRESH profile (empty IndexedDB): only the document can locate the media.
  reopen: `(async () => {
    const P = window.__paths, S = window.arrangementStore, WB = window.__workspaceBackend;
    const dir = await P.getHandleFromAbsPath(${JSON.stringify(PROJ)});
    const be = new WB.DirectoryBackend(dir, 'proj');
    await S.mountWorkspace(be);
    await S.openArrangement(be, 'acts/show');
    await S.relinkMedia();
    const clips = [];
    for (const t of S.composition.tracks) for (const c of t.clips) if (c.source) clips.push(c.source);
    const src = clips[0];
    const out = { url: src && src.url, file: src && JSON.parse(JSON.stringify(src.file ?? null)), missing: S.sourceMissing(src && src.sourceKey), shown: S.mediaRelPaths[src && src.sourceKey] };
    // The <video> path the playback cursor uses (crossOrigin: a GPU upload of a tainted frame throws).
    out.video = await new Promise((res) => {
      const v = document.createElement('video'); v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'auto';
      v.onloadeddata = async () => {
        try {
          const a = await navigator.gpu.requestAdapter(); const d = await a.requestDevice();
          const tex = d.createTexture({ size: [v.videoWidth, v.videoHeight], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
          d.queue.copyExternalImageToTexture({ source: v }, { texture: tex }, [v.videoWidth, v.videoHeight]);
          res({ w: v.videoWidth, dur: v.duration, gpuUpload: 'ok' });
        } catch (e) { res({ w: v.videoWidth, dur: v.duration, gpuUpload: String(e) }); }
      };
      v.onerror = () => res({ error: v.error && v.error.message });
      v.src = src.url;
    });
    return out;
  })()`,
  adopt: `(async () => {
    const P = window.__paths, S = window.arrangementStore, WB = window.__workspaceBackend, L = window.__libraryPaths;
    const dir = await P.getHandleFromAbsPath(${JSON.stringify(PROJ)});
    const be = new WB.DirectoryBackend(dir, 'proj');
    await S.mountWorkspace(be);
    // Two web-made documents: only a library ref, a foreign id, a label.
    const docFor = (name) => ({ format: 'nano-arr', engineVersion: [0,0,0], composition: { meta: {}, tracks: [{ id: 't1', name: 't', kind: 'track', parentId: null,
      sketch: { devices: [] }, automation: [], clips: [{ id: 'c-' + name, name: 'clip', startBeat: 0, lengthBeat: 4, kind: 'video',
        sketch: { devices: [{ id: 'd-' + name, moduleType: 'source.video.file', name: 'clip', capabilities: ['source'] }] },
        source: { label: 'clip.mp4', durationFrames: 55, sourceKey: 'web:' + name, fps: 30,
          ref: { libraryId: 'web-profile-uuid', libraryLabel: 'Footage', path: ['clip.mp4'] } },
        loop: { mode: 'time', startSec: 0, speed: 1, direction: 'forward' }, automation: [], exports: [], warps: [] }] }], rails: [] } });
    for (const n of ['web1', 'web2']) {
      const fh = await dir.getFileHandle(n + '.nano-arr', { create: true });
      const w = await fh.createWritable(); await w.write(JSON.stringify(docFor(n))); await w.close();
    }
    const state = () => { const src = S.composition.tracks.flatMap((t) => t.clips).find((c) => c.source).source;
      return { missing: S.sourceMissing(src.sourceKey), url: (src.url || '').slice(0, 20), file: JSON.parse(JSON.stringify(src.file ?? null)) }; };
    const out = {};
    await S.openArrangement(be, 'web1'); await S.relinkMedia();
    out.before = { ...state(), unknown: JSON.parse(JSON.stringify(S.unknownLibraries)) };
    await L.adopt('web-profile-uuid', await P.getHandleFromAbsPath(${JSON.stringify(PROJ + '/media')}), 'Footage');
    await S.relinkMedia();
    out.afterAdopt = { ...state(), unknown: JSON.parse(JSON.stringify(S.unknownLibraries)) };
    await S.openArrangement(be, 'web2'); await S.relinkMedia();
    out.secondDoc = state();
    return out;
  })()`,
};
app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const win = BrowserWindow.getAllWindows()[0];
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { if (await win.webContents.executeJavaScript('!!window.arrangementStore && !!window.__paths')) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 1500));
  let probe;
  try { probe = await win.webContents.executeJavaScript(PAGE[process.env.PHASE]); }
  catch (e) { probe = { error: String(e) }; }
  probe.mode = win.webContents.getURL();
  console.log('PROBE ' + JSON.stringify(probe));
  setTimeout(() => app.exit(0), 200);
});
