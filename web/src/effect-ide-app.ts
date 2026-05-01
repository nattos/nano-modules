/**
 * Effect IDE entry point. Mounted at /index.html (the new default page).
 *
 * Boots the shared engine, mounts <effect-ide-app>. The IDE shell is responsible
 * for synthesizing default projects and selecting one to render — there are no
 * resolume-style auto-instantiations here.
 */

import { boot } from './boot';
import { appController } from './state/controller';

// Import the root IDE component (self-registering)
import './views/effect-ide/effect-ide-app';

// Dev-only WASM HMR listener (no-op in production).
import './wasm-hmr-client';

async function main() {
  await boot();
  appController.loadModule('com.nattos.nano_effects');
}

main();
