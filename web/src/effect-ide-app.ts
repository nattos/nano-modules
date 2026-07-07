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
import { EFFECT_BUNDLES } from './effect-bundles';
import { DEFAULT_BARREL_URL } from './resolume-mode';
import { startBarrelProbe } from './barrel-probe';
import { installModeOffers } from './live-offers';

// Import the root IDE component (self-registering)
import './views/effect-ide/effect-ide-app';

// Dev-only WASM HMR listener (no-op in production).
import './wasm-hmr-client';

import 'line-awesome/dist/line-awesome/css/line-awesome.css';

async function main() {
  // Boot the engine at 1920x1080 — the IDE is a development testbed for
  // effects, so we want the chain to render at full resolution by default.
  // (Resolume's entry stays at the smaller default for performance.)
  await boot({ width: 1920, height: 1080 });

  // The IDE renders only the currently-selected project. Other user
  // projects and template copies stay in `appState.database.sketches` so
  // the explorer can list them, but they aren't pushed to the engine and
  // therefore don't run on the GPU. The filter reads `selectedProjectId`
  // fresh on every sketch sync; controller methods that change selection
  // are responsible for triggering a re-sync (they already do).
  appController.setEngineSketchFilter(
    (id) => id === appState.local.userSettings.selectedProjectId,
  );

  // The IDE loads the shipping effect bundles (shared list; `testonly` excluded).
  for (const bundle of EFFECT_BUNDLES) appController.loadModule(bundle);

  // Effect Dev has no barrel connection of its own, but still watches for
  // Resolume coming up (and drives the resulting offer) so it can offer
  // switching to Live — same as the Playground surface.
  installModeOffers();
  startBarrelProbe(DEFAULT_BARREL_URL);
}

main();
