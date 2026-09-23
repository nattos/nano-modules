/**
 * Electron main process — the desktop shell.
 *
 * One shell, TWO PRODUCTS. Which one this is comes from NANO_PRODUCT (dev) or
 * the `nanoProduct` field electron-builder injects into package.json per
 * config (electron-builder.{arrangement,remote}.yml):
 *
 *   - `arrangement` — NanoModules: `arrangement.html`, the video editor.
 *   - `remote`      — NanoModules Remote Control: `index.html`, restricted to
 *                     Remote Control (the `live` app mode) and Playground, and
 *                     the owner of the bundled FFGL plugin.
 *
 * They used to be one app with a window per surface, to share one copy of the
 * wasm and fonts. That saved little (the payload is mostly fonts) and cost a
 * confusing app, so each product now ships its own resource root and gets ONE
 * window. The renderer learns the product through the preload
 * (`window.nanoProduct`, see src/product.ts).
 *
 * Two ways to load, in priority order:
 *
 *   1. NANO_URL, or an unpackaged tree with a dev server reachable — the
 *      supported development path, unchanged: `npm run dev` then
 *      `npm run electron`. HMR, the cpp-build plugin and the naga bridge all
 *      keep working.
 *   2. The shared resource root over `nano://app/` — what a packaged app does.
 *      See app-protocol.cjs for why it is a custom scheme and not file:// or a
 *      localhost server.
 *
 * The renderer needs REAL FILESYSTEM ACCESS: a library path can only carry the
 * `absolutePath` the native executor resolves media with if the renderer can
 * see actual paths (state/paths.ts, state/library-paths.ts). That is what
 * nodeIntegration is for here.
 *
 * Plain CJS with no build step, so it can't drift out of sync with a compile
 * pipeline.
 */

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const appProtocol = require('./app-protocol.cjs');
const moduleDirs = require('./module-dirs.cjs');
const { resolveResourceRoot, writeInstallRecord, ffglPluginPath } = require('./resources.cjs');

/** WebGPU is not optional here — the whole renderer is dead without it. */
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');

// MUST happen before whenReady(): Chromium reads the scheme registry during
// startup and ignores a later registration, with no error.
appProtocol.registerScheme();

const DEV_URL = process.env.NANO_URL || null;
const DEV_SERVER = 'http://localhost:5173';

let resourceRoot = null;
/** 'dev' (a Vite server) or 'packaged' (the nano:// scheme). */
let loadMode = 'packaged';

/** The products, keyed by `nanoProduct`. */
const PRODUCTS = {
  arrangement: { file: 'arrangement.html', title: 'NanoModules', width: 1600, height: 1000 },
  remote: { file: 'index.html', title: 'NanoModules Remote Control', width: 1600, height: 1000 },
};

function resolveProduct() {
  let fromPackage = null;
  try { fromPackage = require('../package.json').nanoProduct; } catch { /* no package.json */ }
  const p = process.env.NANO_PRODUCT || fromPackage || 'remote';
  if (!PRODUCTS[p]) throw new Error(`unknown NANO_PRODUCT '${p}' (expected arrangement or remote)`);
  return p;
}
const PRODUCT = resolveProduct();

/** The one window; re-focus rather than open a second. */
let mainWindow = null;

function urlFor(search = '') {
  const { file } = PRODUCTS[PRODUCT];
  const base = loadMode === 'dev'
    ? `${DEV_URL ? new URL(DEV_URL).origin : DEV_SERVER}/${file}`
    : `${appProtocol.ORIGIN}/${file}`;
  return base + search;
}

/** Is a dev server actually answering? Avoids an unpackaged launch hanging on
 *  a blank window when the developer forgot `npm run dev`. */
async function devServerReachable(origin) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(origin, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status === 404;  // answering at all is enough
  } catch {
    return false;
  }
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }
  const spec = PRODUCTS[PRODUCT];
  const win = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    title: spec.title,
    backgroundColor: '#111111',
    // The page owns the frame; <app-titlebar> draws the strip and marks it
    // `-webkit-app-region: drag` so the window can be moved at all.
    //
    // 'hiddenInset' is macOS-only — everywhere else it means 'hidden', which on
    // Windows is a window with NO minimise/maximise/close at all unless
    // titleBarOverlay asks for them back. So: inset traffic lights on macOS,
    // native overlay buttons on Windows, and <app-titlebar> keeps a gutter
    // clear for whichever it is.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {
      // Pin the traffic lights rather than inheriting the inset default, which
      // is positioned for a full-height title bar and hangs below a 28px one.
      // Keep this in step with --app-titlebar-h in widgets/app-titlebar.ts.
      trafficLightPosition: { x: 16, y: 7 },
    } : {
      titleBarOverlay: { color: '#1a1a1a', symbolColor: '#b0b0b0', height: 28 },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // The preload reads this back and sets window.nanoProduct.
      additionalArguments: [`--nano-product=${PRODUCT}`],
      // `fs` straight from the renderer, as nano-player does. That's what
      // state/paths.ts reaches through window.require — it deliberately never
      // imports 'fs', because Vite has no electron-renderer target and would
      // try to resolve the specifier at build time.
      //
      // Kept on deliberately: isElectron() (state/paths.ts) is a bare `require`
      // probe, so turning this off silently removes the absolute-path feature
      // rather than breaking loudly. We only ever load our own content, from
      // our own scheme. Tightening it means moving fs + the pickers behind
      // contextBridge in preload.cjs, which that file is already marked for.
      nodeIntegration: true,
      contextIsolation: false,
      // Only needed against a dev server on a different origin. Under
      // nano://app/ everything is same-origin and the default applies.
      webSecurity: loadMode !== 'dev',
    },
  });

  const url = urlFor();
  win.loadURL(url);

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[electron] failed to load ${url}: ${desc} (${code})`);
    if (loadMode === 'dev') {
      console.error('[electron] is the Vite dev server running? (cd web && npm run dev)');
    } else {
      console.error(`[electron] resource root: ${resourceRoot}`);
    }
  });
  // Report the GPU situation early — a renderer without WebGPU looks like a
  // hang, not an error. This is the single most likely thing to go wrong on a
  // machine whose driver stack can't give Dawn an adapter.
  win.webContents.once('did-finish-load', async () => {
    try {
      const ok = await win.webContents.executeJavaScript('!!navigator.gpu');
      if (!ok) console.error('[electron] navigator.gpu is missing — WebGPU unavailable');
    } catch { /* window closed mid-check */ }
  });
  // External links open in the real browser, not a chrome-less app window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.on('closed', () => { mainWindow = null; });

  mainWindow = win;
  return win;
}

function buildMenu() {
  // Only Remote Control carries (and advertises) the plugin.
  const plugin = PRODUCT === 'remote' ? ffglPluginPath(resourceRoot) : null;
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        ...(plugin ? [
          {
            // Pointing Resolume at the plugin is otherwise a hunt through an
            // opaque app bundle (or, on Windows, through Program Files).
            label: process.platform === 'darwin'
              ? 'Reveal FFGL Plugin in Finder'
              : 'Show FFGL Plugin in Explorer',
            click: () => shell.showItemInFolder(plugin),
          },
        ] : []),
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The native directory picker. Returns an ABSOLUTE PATH — unlike the browser's
 * showDirectoryPicker, which hands back an opaque handle. This is the whole
 * reason the desktop build exists.
 */
ipcMain.handle('paths.showDirectoryPicker', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? undefined : filePaths[0];
});

ipcMain.handle('paths.showItemInFolder', (_e, absPath) => shell.showItemInFolder(absPath));

/** Let the renderer find the bundles/fonts without guessing at layout. */
ipcMain.handle('nano.resourceRoot', () => resourceRoot);

// -- Effect module directories (module-dirs.cjs) ---------------------------
// The renderer asks which bundles exist and where to fetch them; Settings
// reads and edits the mapped directories. The same module_paths.json is what
// the native barrel reads at startup.
ipcMain.handle('nano.listModules', () => ({
  bundles: moduleDirs.resolveBundles(resourceRoot ? path.join(resourceRoot, 'wasm') : null),
  defaultDir: moduleDirs.defaultModulesDir(),
  paths: moduleDirs.readModulePaths(),
}));
ipcMain.handle('nano.setModulePaths', (_e, rows) => {
  const written = moduleDirs.writeModulePaths(Array.isArray(rows) ? rows : []);
  watchModuleDirs();
  return written;
});

/**
 * Hot reload for module directories, in a PACKAGED app. (Against a dev server
 * the vite plugin already watches them and fires the same event over HMR.) A
 * changed `.wasm` is sent to the renderer as `nano:wasm-reload` with the URL it
 * is served at; src/wasm-hmr-client.ts forwards it to the engine worker.
 */
const moduleWatchers = new Map();
const reloadTimers = new Map();
function watchModuleDirs() {
  if (loadMode !== 'packaged') return;
  const dirs = moduleDirs.servedDirs();
  for (const [dir, w] of moduleWatchers) {
    if (!dirs.includes(dir)) { w.close(); moduleWatchers.delete(dir); }
  }
  for (const dir of dirs) {
    if (moduleWatchers.has(dir) || !fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, (_event, name) => {
        if (!name || !String(name).endsWith('.wasm')) return;
        const file = path.join(dir, String(name));
        // A build writes the file in several steps; settle before reloading.
        clearTimeout(reloadTimers.get(file));
        reloadTimers.set(file, setTimeout(() => {
          reloadTimers.delete(file);
          const url = moduleDirs.urlForModuleFile(file);
          if (url && fs.existsSync(file) && mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('nano:wasm-reload', { url });
          }
        }, 250));
      });
      moduleWatchers.set(dir, w);
    } catch (err) {
      console.warn(`[electron] cannot watch ${dir}: ${err.message}`);
    }
  }
}

app.whenReady().then(async () => {
  resourceRoot = resolveResourceRoot();

  const devOrigin = DEV_URL ? new URL(DEV_URL).origin : DEV_SERVER;
  if (process.env.NANO_FORCE_PACKAGED === '1') {
    // Exercise the shipping path from a source tree — a dev server is usually
    // running on this machine, and without this there is no way to test the
    // nano:// scheme short of building an installer.
    loadMode = 'packaged';
  } else if (DEV_URL) {
    loadMode = 'dev';
  } else if (!app.isPackaged && await devServerReachable(devOrigin)) {
    // Unpackaged with a server up: prefer it, so HMR and the C++ rebuild
    // plugin keep working during development.
    loadMode = 'dev';
  } else {
    loadMode = 'packaged';
  }

  if (loadMode === 'packaged') {
    if (!resourceRoot) {
      dialog.showErrorBox(
        'Missing resources',
        'Could not find the shared resource root (wasm bundles and fonts).\n\n' +
        'In a development tree, build them with native/wasm_modules/build_all.sh ' +
        'and the web app with `npm run build`, or start the dev server and ' +
        'relaunch.');
      app.quit();
      return;
    }
    appProtocol.serve(resourceRoot);
  }

  // Tell a copied-out FFGL plugin where we are. Packaged builds only, and
  // deliberately ranked LAST on the native side — see resources.cjs.
  // Seed the per-user modules directory with the bundles the package carries
  // but doesn't load itself (module-dirs.cjs). Packaged only — a dev tree
  // already has them in build/wasm, and must not write into the user's folder.
  if (app.isPackaged || process.env.NANO_SEED_MODULES === '1') {
    try {
      const seeded = moduleDirs.seedDefaultModules(
        resourceRoot && path.join(resourceRoot, 'extra-modules'), app.getVersion());
      if (seeded.length) console.log(`[electron] seeded ${seeded.length} module file(s) into ${moduleDirs.defaultModulesDir()}`);
    } catch (err) {
      console.warn('[electron] could not seed the modules directory:', err.message);
    }
  }

  // Remote Control only: it owns the plugin, and two apps writing one record
  // would repoint a copied-out plugin at whichever launched last.
  const record = PRODUCT === 'remote' ? writeInstallRecord(resourceRoot) : null;
  console.log(`[electron] product=${PRODUCT} mode=${loadMode} root=${resourceRoot ?? '(none)'}` +
              (record ? ` record=${record}` : ''));

  buildMenu();
  watchModuleDirs();
  createWindow();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
