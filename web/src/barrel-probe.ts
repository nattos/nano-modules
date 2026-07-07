/**
 * Background "is Resolume up" probe. Runs from Effect Dev and Playground
 * (any non-Live surface) so either can offer switching to Live — one
 * lightweight WebSocket attempt every 10s (NOT a `WsBridgeClient` — its
 * infinite exponential backoff and logging are wrong for probing).
 *
 * Self-gates on `userSettings.barrelRemoteEnabled` on every tick (not just at
 * start): the loop keeps ticking regardless, but only actually attempts a
 * connection while the setting is on, so toggling it in Settings takes effect
 * within one interval with no restart wiring needed. Stops attempting once
 * detected, or once the user dismisses the offer (recorded in sessionStorage).
 */

import { appState } from './state/app-state';
import { appController } from './state/controller';
import { OFFER_LIVE_DISMISSED_KEY } from './resolume-mode';

const PROBE_INTERVAL_MS = 10000;

export function startBarrelProbe(url: string) {
  const attempt = () => {
    if (!appState.local.userSettings.barrelRemoteEnabled) { setTimeout(attempt, PROBE_INTERVAL_MS); return; }
    if (appState.local.barrelDetected) return;
    if (sessionStorage.getItem(OFFER_LIVE_DISMISSED_KEY)) return;
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch { setTimeout(attempt, PROBE_INTERVAL_MS); return; }
    let settled = false;
    const settle = (up: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      if (up) appController.setBarrelDetected(true);
      else setTimeout(attempt, PROBE_INTERVAL_MS);
    };
    ws.onopen = () => settle(true);
    ws.onerror = () => settle(false);
    ws.onclose = () => settle(false);
  };
  attempt();
}
