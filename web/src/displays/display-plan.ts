/**
 * The display plan: the show's display placements resolved against this
 * machine's library — what the native compositor needs to put each one on a
 * screen (comp_displays; bridge/comp_displays.h parseDisplayPlan). Which
 * screen is resolved THERE (it knows the screens, and a hotplug re-binds at
 * once); the plan carries the binding and the fallback ordinal.
 *
 * Pure: the page pushes it after each document ship and each library edit
 * (display-controller.ts), never from a reaction.
 */

import type { Composition } from '../views/arrangement/model/composition';
import { displayOrdinal, librarySlot, type DisplayFit, type DisplaySlot, type WindowFrame } from './display-types';

export interface DisplayPlanOutput {
  placementId: string;
  slotId: string;
  name: string;
  enabled: boolean;
  /** This machine's remembered screen ('' = automatic). */
  screenUuid: string;
  /** Display N: the automatic binding's N. */
  ordinal: number;
  window: boolean;
  windowFrame?: WindowFrame;
  fit: DisplayFit;
}

export interface DisplayPlan {
  /** The master output switch (output-master.ts): off, nothing shows. */
  armed: boolean;
  outputs: DisplayPlanOutput[];
}

export function buildDisplayPlan(comp: Composition, library: readonly DisplaySlot[],
                                 armed: boolean): DisplayPlan {
  const outputs: DisplayPlanOutput[] = [];
  for (const p of comp.devices ?? []) {
    if (p.kind !== 'display') continue;
    const slot = librarySlot(library, p.deviceId, p.label);
    if (!slot) continue;
    outputs.push({
      placementId: p.id,
      slotId: slot.id,
      name: slot.name,
      enabled: p.enabled !== false,
      screenUuid: slot.screen?.uuid ?? '',
      ordinal: displayOrdinal(slot.id),
      window: slot.window === true,
      ...(slot.windowFrame ? { windowFrame: { ...slot.windowFrame } } : {}),
      fit: p.fit ?? 'fit',
    });
  }
  return { armed, outputs };
}
