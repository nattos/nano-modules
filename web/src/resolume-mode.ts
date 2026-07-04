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

/** sessionStorage keys recording a dismissed mode-switch offer (per tab —
 *  the offer returns on a fresh session, but never nags within one). */
export const OFFER_PLAYGROUND_DISMISSED_KEY = 'nano.offerPlayground.dismissed';
export const OFFER_LIVE_DISMISSED_KEY = 'nano.offerLive.dismissed';

export type BannerOffer = 'offer-playground' | 'offer-live' | null;

/**
 * Which mode-switch offer (if any) the shell should show. Pure so the
 * banner logic is unit-testable; the component supplies the time-derived
 * `graceElapsed` (connection continuously not-open past the grace window)
 * and the per-mode sessionStorage `dismissed` flag.
 */
export function bannerOffer(opts: {
  barrelMode: boolean;
  connection: 'connecting' | 'open' | 'closed';
  graceElapsed: boolean;
  barrelDetected: boolean;
  dismissed: boolean;
}): BannerOffer {
  if (opts.dismissed) return null;
  if (opts.barrelMode) {
    return opts.connection !== 'open' && opts.graceElapsed ? 'offer-playground' : null;
  }
  return opts.barrelDetected ? 'offer-live' : null;
}
