/**
 * Electron-side probe for test/desktop-settings.test.ts. Runs in the MAIN
 * process: boots the real electron/main.cjs (MAIN_CJS) with its own profile
 * (PROFILE) and the settings folder under NANO_DATA_DIR, runs the steps named
 * by PHASE — page scripts through executeJavaScript, file edits from here, as
 * an outside tool would make them — and prints `PROBE <json>`.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.setPath('userData', process.env.PROFILE);
require(process.env.MAIN_CJS);

const SETTINGS = path.join(process.env.NANO_DATA_DIR, 'Settings');
const file = (n) => path.join(SETTINGS, n);
const readJson = (n) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return null; } };
const readText = (n) => { try { return fs.readFileSync(file(n), 'utf8'); } catch { return null; } };
/** An outside edit, the way an editor saves: write a temp file, rename it over. */
const edit = (n, doc) => {
  fs.mkdirSync(SETTINGS, { recursive: true });
  fs.writeFileSync(file(n) + '.agent', JSON.stringify(doc, null, 2));
  fs.renameSync(file(n) + '.agent', file(n));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
const page = (js) => win.webContents.executeJavaScript(js);
/** Poll a page expression until it's truthy (or time out → last value). */
async function until(js, ms = 5000) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    try { v = await page(js); } catch { v = undefined; }
    if (v) return v;
    await sleep(100);
  }
  return v;
}

const PHASES = {
  // The arrangement app writes its layout, applies an outside edit live, and
  // doesn't write that edit back.
  async arrangement() {
    await until('!!window.arrangementStore');
    await sleep(1000);   // restoreLayout → saves enabled
    const out = {};
    await page('window.arrangementStore.setSidePanelWidth(333), window.arrangementStore.requestLayoutSave(0), 1');
    await sleep(800);
    out.saved = readJson('arrangement.json')?.layout?.sidePanelWidth ?? null;
    out.readme = (readText('README.md') || '').startsWith('# Nano Modules settings');

    const doc = readJson('arrangement.json');
    doc.layout.sidePanelWidth = 222;
    doc.agentNote = 'kept';
    edit('arrangement.json', doc);
    const before = readText('arrangement.json');
    out.applied = await until('window.arrangementStore.sidePanelWidth === 222 && 222');
    await sleep(1200);   // any echo would have landed by now
    out.untouched = readText('arrangement.json') === before;
    // A later in-app change keeps the key an outside tool added.
    await page('window.arrangementStore.setSidePanelWidth(250), window.arrangementStore.requestLayoutSave(0), 1');
    await sleep(800);
    const after = readJson('arrangement.json');
    out.afterInApp = { width: after.layout.sidePanelWidth, agentNote: after.agentNote };
    return out;
  },

  // A fresh profile (no IndexedDB) restores from the file alone.
  async relaunch() {
    await until('!!window.arrangementStore');
    await sleep(1000);
    return { width: await page('window.arrangementStore.sidePanelWidth') };
  },

  // Settings → Engine: the file's `engine` picks the engine at boot (the test
  // wrote 'native' before launch), the Settings tab's button writes it, and a
  // reload applies it.
  async engine() {
    await until('!!window.arrangementStore');
    // By capability, not class name (the packaged build is minified): only
    // the native engine decodes video for itself.
    const engineName = () => until(
      `window.__engineBridge && window.__engineBridge.engine &&
       (window.__engineBridge.engine.ownsVideoPump ? 'native' : 'browser')`,
      30000);
    const out = { booted: await engineName() };
    await page('window.arrangementStore.setRightTab("settings"), 1');
    await sleep(500);
    out.clicked = await page(`(() => {
      const app = document.querySelector('arrangement-app');
      const insp = app && app.shadowRoot && app.shadowRoot.querySelector('arr-inspector');
      const btn = insp && [...insp.shadowRoot.querySelectorAll('button.segbtn')]
        .find((b) => b.textContent.trim() === 'browser');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(300);
    out.written = readJson('arrangement.json')?.engine ?? null;
    out.offersReload = await page(`(() => {
      const insp = document.querySelector('arrangement-app').shadowRoot.querySelector('arr-inspector');
      return [...insp.shadowRoot.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Reload now');
    })()`);
    await page('location.reload(), 1');
    await sleep(1000);
    await until('!!window.arrangementStore');
    out.reloaded = await engineName();
    return out;
  },

  // Remote Control: user settings and the MIDI device library, both live.
  async remote() {
    await win.loadURL('nano://app/index.html?playground');
    await until('!!(window.appState && window.appState.local && window.appState.local.userSettings)', 30000);
    await sleep(2000);   // boot → enablePersistence → first save
    const out = {};
    out.written = readJson('remote-control.json')?.settings?.targetFps ?? null;

    const doc = readJson('remote-control.json') || {};
    doc.settings = { ...(doc.settings || {}), targetFps: 77 };
    edit('remote-control.json', doc);
    out.fps = await until('window.appState.local.userSettings.targetFps === 77 && 77');

    edit('midi-devices.json', [{
      id: 'agent-device', templateId: 'akai.mpk-mini', name: 'Agent Device',
      forkedAt: 1, updatedAt: 1, identities: [], config: {},
    }]);
    out.midi = await until(
      "JSON.stringify(window.appState.local.midi.library.map(i => i.id)).includes('agent-device') && " +
      'window.appState.local.midi.library.map(i => i.id)');
    return out;
  },
};

app.whenReady().then(async () => {
  await sleep(1500);
  win = BrowserWindow.getAllWindows()[0];
  let probe;
  try { probe = await PHASES[process.env.PHASE](); }
  catch (e) { probe = { error: String(e && e.stack || e) }; }
  console.log('PROBE ' + JSON.stringify(probe));
  setTimeout(() => app.exit(0), 200);
});
