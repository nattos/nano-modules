/**
 * URL → app-mode resolution for the Resolume sketch editor (/resolume/).
 *
 * Kept in its own module (rather than resolume-app.ts, which boots the app on
 * import) so it can be unit-tested and shared with the mode-switch UI.
 */

/**
 * Bare `/resolume/` = BARREL against the fixed shared-server port. `?barrel`
 * stays as an explicit form whose value optionally overrides the server URL
 * (`?barrel=ws://host:port`). `?playground` (which wins over `?barrel`)
 * enters the local playground environment instead.
 */
export function decideMode(search: string): { mode: 'barrel' | 'playground'; barrelUrl: string } {
  const params = new URLSearchParams(search);
  const mode = params.has('playground') ? 'playground' : 'barrel';
  const barrelUrl = params.get('barrel') || 'ws://localhost:8081';
  return { mode, barrelUrl };
}

/**
 * Navigate this session into the other environment. Reload-based by design:
 * barrel and playground boot with different stores + engine wiring, so a URL
 * swap is the whole mode switch. Bare URL = barrel (the default); the
 * playground is always the explicit `?playground` form.
 */
export function switchMode(target: 'barrel' | 'playground') {
  const url = new URL(location.href);
  url.search = target === 'playground' ? '?playground' : '';
  location.href = url.toString();
}
