/**
 * Preload — deliberately almost empty.
 *
 * With `nodeIntegration: true` / `contextIsolation: false` the renderer already
 * has `require`, so `state/paths.ts` reaches `fs` and `ipcRenderer` directly and
 * needs nothing bridged here. This file exists to mark the seam: if we ever
 * tighten the sandbox (contextIsolation on), the fs + picker surface that
 * `paths.ts` uses is what has to move behind `contextBridge` here.
 *
 * It also hands the page the product identity (below). The other thing worth doing eagerly is making the Electron-ness obvious in logs,
 * since `isElectron()` is just a `require` probe.
 */

// Which product this is (electron/main.cjs passes it as an argument). Read by
// src/product.ts. contextIsolation is off, so this IS the page's window.
const productArg = process.argv.find((a) => a.startsWith('--nano-product='));
window.nanoProduct = productArg ? productArg.slice('--nano-product='.length) : undefined;

process.once('loaded', () => {
  console.log(`[electron] renderer running with node integration (electron ${process.versions.electron})`);
});
