/**
 * Lights in the arrangement — binds the light controller (the per-machine
 * library of types and rigs) to THIS page's show and engine:
 *
 *   - the plan (show placements + layout, resolved against the library) goes
 *     to the engine; the native compositor transmits it, the worker engine
 *     ignores it;
 *   - it is re-resolved after each document ship (a layout drag, a placement,
 *     an undo) — an explicit call, never a reaction — and after each library
 *     edit (light-controller.ts).
 */

import { engineBridge } from '../engine/engine-bridge';
import { lightController } from './light-controller';

let booted = false;

export async function bootArrangementLights(): Promise<void> {
  if (booted) return;
  booted = true;
  lightController.bindEngine({
    plan: (plan) => engineBridge.setLightPlan(plan),
    test: (placementId, slotId, pattern) => engineBridge.lightTest(placementId, slotId, pattern),
  });
  engineBridge.addDocShippedListener(() => lightController.pushPlan());
  try {
    await lightController.load();
  } catch (err) {
    console.warn('[arr-lights] failed to load the light library', err);
  }
}
