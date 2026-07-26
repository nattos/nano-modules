/**
 * Electron main process — the desktop shell for the arrangement app.
 *
 * The point of running under Electron is the FILESYSTEM: the renderer gets real
 * `fs` and real absolute paths, which is the only way a library path can carry
 * the `absolutePath` the native executor resolves media with (see
 * web/src/state/paths.ts and web/src/state/library-paths.ts).
 *
 * Deliberately loads the VITE DEV SERVER rather than a built bundle. Shader
 * translation (SPIR-V → WGSL) runs through `/__naga/wgsl`, which is a
 * dev-server-only Vite plugin that spawns the `naga` CLI — a packaged build
 * would have no shader pipeline at all. Packaging is a separate problem; see
 * the plan's "known follow-ups". Point NANO_URL elsewhere to override.
 *
 * Plain CJS with no build step, so it can't drift out of sync with a compile
 * pipeline. Run it with `npm run electron` (from web/), with `npm run dev`
 * already serving.
 */

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');

const URL = process.env.NANO_URL || 'http://localhost:5173/arrangement.html';

/** WebGPU is not optional here — the whole renderer is dead without it. */
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    backgroundColor: '#111111',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // `fs` straight from the renderer, as nano-player does. That's what
      // state/paths.ts reaches through window.require — it deliberately never
      // imports 'fs', because Vite has no electron-renderer target and would
      // try to resolve the specifier at build time.
      nodeIntegration: true,
      contextIsolation: false,
      // Media is read through fs into a Blob, so this isn't needed for the
      // decode path; it's here so a file:// asset in a dev page doesn't trip
      // the origin check while we're pointed at http://localhost.
      webSecurity: false,
    },
  });

  mainWindow.loadURL(URL);
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[electron] failed to load ${URL}: ${desc} (${code})`);
    console.error('[electron] is the Vite dev server running? (cd web && npm run dev)');
  });
  // Report the GPU situation early — a renderer without WebGPU looks like a
  // hang, not an error.
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const ok = await mainWindow.webContents.executeJavaScript('!!navigator.gpu');
      if (!ok) console.error('[electron] navigator.gpu is missing — WebGPU unavailable');
    } catch { /* window closed mid-check */ }
  });
  // External links open in the real browser, not a chrome-less app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * The native directory picker. Returns an ABSOLUTE PATH — unlike the browser's
 * `showDirectoryPicker`, which hands back an opaque handle. This is the whole
 * reason the desktop build exists.
 */
ipcMain.handle('paths.showDirectoryPicker', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? undefined : filePaths[0];
});

ipcMain.handle('paths.showItemInFolder', (_e, absPath) => shell.showItemInFolder(absPath));

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
