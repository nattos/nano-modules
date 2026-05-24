/**
 * Effect IDE entry point. Mounted at /index.html (the new default page).
 *
 * Boots the shared engine, mounts <effect-ide-app>. The IDE shell is responsible
 * for synthesizing default projects and selecting one to render — there are no
 * resolume-style auto-instantiations here.
 */

import { boot } from './boot';
import { appState } from './state/app-state';
import { appController } from './state/controller';

// Import the root IDE component (self-registering)
import './views/effect-ide/effect-ide-app';

// Dev-only WASM HMR listener (no-op in production).
import './wasm-hmr-client';

import 'line-awesome/dist/line-awesome/css/line-awesome.css';

async function main() {
  // Boot the engine at 1920x1080 — the IDE is a development testbed for
  // effects, so we want the chain to render at full resolution by default.
  // (Resolume's entry stays at the smaller default for performance.)
  await boot(1920, 1080);

  // The IDE renders only the currently-selected project. Other user
  // projects and template copies stay in `appState.database.sketches` so
  // the explorer can list them, but they aren't pushed to the engine and
  // therefore don't run on the GPU. The filter reads `selectedProjectId`
  // fresh on every sketch sync; controller methods that change selection
  // are responsible for triggering a re-sync (they already do).
  appController.setEngineSketchFilter(
    (id) => id === appState.local.userSettings.selectedProjectId,
  );

  // The IDE loads the shipping effect bundles. `testonly` is intentionally
  // not loaded here — it's reserved for integration tests.
  appController.loadModule('com.nattos.core');
  appController.loadModule('com.nattos.nano');
  appController.loadModule('com.nattos.testonly');
  appController.loadModule('com.nano.lights');
}

main();
