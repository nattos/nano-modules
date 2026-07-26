/**
 * Preload — deliberately almost empty.
 *
 * With `nodeIntegration: true` / `contextIsolation: false` the renderer already
 * has `require`, so `state/paths.ts` reaches `fs` and `ipcRenderer` directly and
 * needs nothing bridged here. This file exists to mark the seam: if we ever
 * tighten the sandbox (contextIsolation on), the fs + picker surface that
 * `paths.ts` uses is what has to move behind `contextBridge` here.
 *
 * The one thing worth doing eagerly is making the Electron-ness obvious in logs,
 * since `isElectron()` is just a `require` probe.
 */

process.once('loaded', () => {
  console.log(`[electron] renderer running with node integration (electron ${process.versions.electron})`);
});
