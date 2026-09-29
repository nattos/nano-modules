/**
 * Displays in the arrangement — binds the display controller (this machine's
 * display slots) to THIS page's show and engine:
 *
 *   - the plan (show placements + fit, resolved against the library) goes to
 *     the engine; the native compositor puts it on screens, the worker engine
 *     ignores it;
 *   - it is re-resolved after each document ship (a placement, a fit, an
 *     undo) — an explicit call, never a reaction — and after each library
 *     edit (display-controller.ts).
 */

import { engineBridge } from '../engine/engine-bridge';
import { displayController } from './display-controller';

let booted = false;

export async function bootArrangementDisplays(): Promise<void> {
  if (booted) return;
  booted = true;
  displayController.bindEngine({
    plan: (plan) => engineBridge.setDisplayPlan(plan),
    identify: (msg) => engineBridge.identifyDisplay(msg),
  });
  engineBridge.addDocShippedListener(() => displayController.pushPlan());
  try {
    await displayController.load();
  } catch (err) {
    console.warn('[arr-displays] failed to load the display library', err);
  }
}
