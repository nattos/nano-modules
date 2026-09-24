/**
 * The per-user data root — the JS half of nano_paths::dataRootPath()
 * (native/src/platform/paths.h). KEEP THE TWO IN STEP: the desktop apps and the
 * FFGL plugin read and write the same files here, and a disagreement means two
 * copies of the user's settings.
 *
 *   <appData>/Nano Modules/
 *     Modules/     effect bundles (module-dirs.cjs seeds the extras)
 *     Settings/    one JSON file per surface, plus the shared ones
 *                  (see src/state/settings-files.ts and DESKTOP.md)
 *     install.json where the packaged app lives (resources.cjs)
 *
 * NANO_DATA_DIR overrides the root — every test sets it, so no run touches the
 * real folder.
 *
 * Plain node (no electron import), because the vite dev server uses it too.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The platform's per-user app-data directory — what Electron calls
 *  app.getPath('appData'), computed without Electron. */
function appDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function dataRoot() {
  return process.env.NANO_DATA_DIR || path.join(appDataDir(), 'Nano Modules');
}

function settingsDir() {
  return path.join(dataRoot(), 'Settings');
}

/**
 * Keep Settings/README.md — what each file holds and how edits apply, for the
 * person or agent who opens the folder — in step with this build. Rewritten
 * only when it differs; best-effort (a read-only home must not stop the app).
 */
function writeSettingsReadme() {
  try {
    const text = fs.readFileSync(path.join(__dirname, 'settings-readme.md'), 'utf8');
    const file = path.join(settingsDir(), 'README.md');
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    if (current === text) return;
    fs.mkdirSync(settingsDir(), { recursive: true });
    fs.writeFileSync(file, text);
  } catch (err) {
    console.warn('[electron] could not write the settings README:', err.message);
  }
}

module.exports = { appDataDir, dataRoot, settingsDir, writeSettingsReadme };
