/**
 * Drives the mode-switch "offer" snackbar from `resolume-mode.ts`'s pure
 * `bannerOffer()` decision logic — replaces the old disruptive top banner.
 * Installed on EVERY surface (Effect Dev, Playground, Live) so any of them
 * can offer switching, once the barrel-remote probe runs everywhere (see
 * `barrel-probe.ts`).
 *
 * A plain MobX `autorun` rather than a Lit component: nothing here owns a
 * shadow DOM, it only calls `snackbars.show(...)`.
 */

import { autorun, observable, runInAction } from 'mobx';
import { appState } from './state/app-state';
import { appController } from './state/controller';
import { snackbars } from './widgets/snackbars';
import {
  bannerOffer, switchMode,
  OFFER_PLAYGROUND_DISMISSED_KEY, OFFER_LIVE_DISMISSED_KEY,
} from './resolume-mode';

/** Not-open for this long, continuously, before offering the playground
 *  fallback — a momentary reconnect blip must not flash the offer. */
const GRACE_MS = 4000;

export function installModeOffers() {
  // A MobX observable (not a plain field): the grace timer flips this from
  // OUTSIDE the autorun, so it must be a tracked read for that to re-run it.
  const graceElapsed = observable.box(false);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastOffer: 'offer-playground' | 'offer-live' | null = null;

  const trackGrace = (connection: string) => {
    if (connection === 'open') {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (graceElapsed.get()) runInAction(() => graceElapsed.set(false));
      return;
    }
    if (graceElapsed.get() || graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      // Only latch if still not open when the grace window closes.
      if (appState.local.barrelConnection !== 'open') runInAction(() => graceElapsed.set(true));
    }, GRACE_MS);
  };

  autorun(() => {
    const barrelMode = appState.local.barrelMode;
    const connection = appState.local.barrelConnection;
    const barrelDetected = appState.local.barrelDetected;
    trackGrace(barrelMode ? connection : 'open');

    const dismissKey = barrelMode ? OFFER_PLAYGROUND_DISMISSED_KEY : OFFER_LIVE_DISMISSED_KEY;
    let dismissed = false;
    try { dismissed = !!sessionStorage.getItem(dismissKey); } catch { /* ignore */ }

    const offer = bannerOffer({
      barrelMode, connection, graceElapsed: graceElapsed.get(), barrelDetected, dismissed,
    });
    // Show once per rising edge, not on every re-evaluation — a snackbar
    // that resets its own timer on each unrelated churn would never
    // auto-dismiss while the underlying condition persists.
    if (offer === lastOffer) return;
    lastOffer = offer;
    if (!offer) return;

    const dismiss = () => { try { sessionStorage.setItem(dismissKey, '1'); } catch { /* ignore */ } };

    if (offer === 'offer-playground') {
      snackbars.show({
        message: "Can't reach Resolume (the shared NanoBarrel server isn't answering).",
        timeoutMs: 5000,
        dedupeKey: 'mode-offer',
        actions: [
          { label: 'Switch to Playground', run: () => switchMode('playground') },
          { label: 'Stay', run: dismiss },
        ],
      });
    } else {
      snackbars.show({
        message: 'Resolume detected — a shared NanoBarrel server is up.',
        timeoutMs: 5000,
        dedupeKey: 'mode-offer',
        actions: [
          { label: 'Switch to Live', run: () => { void appController.switchAppMode('live'); } },
          { label: 'Stay offline', run: dismiss },
        ],
      });
    }
  });
}
