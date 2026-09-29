/**
 * Shared by the light surfaces (the Devices view's cards + details, the
 * timeline's light rows): a rig's slots resolved for drawing — type, where the
 * slot samples in this show, and the colours it is showing now.
 */

import type { LightRig, LightType, SlotRect } from '../../../../lights/light-types';
import { slotRectIn } from '../../../../lights/light-plan';
import { lightController } from '../../state/light-controller';
import { store } from '../../state/store';

export interface DrawSlot {
  index: number;
  slotId: string;
  type: LightType | undefined;
  rect: SlotRect;
  reverse: boolean;
  /** CSS colour per pixel (pixel 0 first), or null when nothing has been
   *  reported (the worker engine, or a light not in the show). */
  colors: string[] | null;
}

/** Width / height of the composition's frame (what light layouts live in). */
export function frameAspect(): number {
  const r = (store.composition.meta as { resolution?: { width: number; height: number } }).resolution;
  return r && r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 9;
}

/** A rig's slots for drawing in this show (`placementId` given) or at the
 *  rig's defaults. Colours come from the engine's report, in plan order (slots
 *  whose type is missing aren't in the plan and consume nothing). */
export function drawSlots(rig: LightRig, placementId?: string): DrawSlot[] {
  const placement = placementId ? store.placementById(placementId) : undefined;
  const bytes = placementId ? lightController.values[placementId] : undefined;
  let off = 0;
  return rig.slots.map((slot, index) => {
    const type = lightController.type(slot.typeId);
    let colors: string[] | null = null;
    if (type && bytes) {
      colors = [];
      for (let i = 0; i < type.pixels; i++, off += 3) {
        colors.push(off + 2 < bytes.length ? `rgb(${bytes[off]},${bytes[off + 1]},${bytes[off + 2]})` : '#000');
      }
    }
    return { index, slotId: slot.id, type, rect: slotRectIn(placement, slot), reverse: !!slot.reverse, colors };
  });
}

/** Pixel cells of a slot rect along its long axis, in drawing order (pixel 0
 *  first — at the far end when reversed). Units are the rect's own. */
export function pixelCells(r: SlotRect, pixels: number, reverse: boolean): SlotRect[] {
  const out: SlotRect[] = [];
  const tall = r.h >= r.w;
  for (let i = 0; i < pixels; i++) {
    const k = reverse ? pixels - 1 - i : i;
    out.push(tall
      ? { x: r.x, y: r.y + (r.h * k) / pixels, w: r.w, h: r.h / pixels }
      : { x: r.x + (r.w * k) / pixels, y: r.y, w: r.w / pixels, h: r.h });
  }
  return out;
}

export const UNLIT = 'rgba(255,255,255,0.14)';
