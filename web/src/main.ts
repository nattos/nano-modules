/**
 * Single unified entry point for all three top-level surfaces (Effect Dev,
 * Playground, Live). Reads the persisted `appMode` setting from IndexedDB
 * and waits for it to load before deciding which surface to boot — the URL
 * carries no mode semantics of its own.
 *
 * `?playground` / `?barrel[=ws://host:port]` remain as a boot-time OVERRIDE
 * (for deep links and the e2e suite, which navigates straight to a known
 * mode) — see `resolume-mode.ts`'s `modeOverrideFromUrl`. When present, the
 * override decides THIS boot and gets persisted (via `boot.ts`'s existing
 * appMode recording) so a later plain reload remembers it. Absent either,
 * the persisted setting decides.
 */

// Global (document-level) Line Awesome load: <ui-icon> inlines the CSS into
// its shadow root, but @font-face only registers at document level — without
// this import every glyph renders as a blank box.
import 'line-awesome/dist/line-awesome/css/line-awesome.css';

import { loadUserSettings } from './state/user-settings';
import { DEFAULT_BARREL_URL, modeOverrideFromUrl } from './resolume-mode';

async function main() {
  // Only used to decide which surface to boot — `boot()` (called from
  // whichever surface module below) does its own load + apply to appState,
  // so this stays a read-only lookup, not a second source of truth.
  const settings = await loadUserSettings();

  const override = modeOverrideFromUrl(location.search);
  const mode = override?.mode ?? settings.appMode;
  const barrelUrl = override?.barrelUrl ?? DEFAULT_BARREL_URL;

  if (mode === 'effect-dev') {
    const { bootEffectDev } = await import('./boot-effect-dev');
    await bootEffectDev();
  } else {
    const { bootResolume } = await import('./boot-resolume');
    await bootResolume(mode === 'live' ? 'barrel' : 'playground', barrelUrl);
  }
}

main();
