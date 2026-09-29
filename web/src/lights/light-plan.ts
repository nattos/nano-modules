/**
 * The light PLAN: what the compositor needs to drive a show's lights, resolved
 * from the show (its light placements + per-slot layout) and this machine's
 * library (rigs, types, addresses). Pure — the arrangement's light controller
 * builds it and hands it to the engine (`comp_lights`); native
 * lights/light_map.h parses it. The compositor never sees a rig or a type,
 * only fixtures: an address and one footprint per pixel.
 *
 * Where a light SAMPLES (the main output, or a route's source) is not in the
 * plan: that's the document's routes, resolved by the engine's builder.
 */

import type { Composition, DevicePlacement } from '../views/arrangement/model/composition';
import {
  AUTO_NETWORK, AUTO_NETWORK_ID, resolveNetworkDest, slotChannels, slotFootprints,
  type LightFormat, type LightNetwork, type LightRig, type LightRow, type LightType, type SlotRect,
} from './light-types';

export interface LightPlanFixture {
  slotId: string;
  universe: number;
  channel: number;
  /** Where it goes — the slot's destination with its network's patches applied. */
  dest: string;
  /** The interface it's sent from; '' = auto. */
  iface: string;
  format: LightFormat;
  gamma: number;
  footprints: [number, number, number, number][];
}

export interface LightPlanOutput {
  placementId: string;
  enabled: boolean;
  fixtures: LightPlanFixture[];
}

export interface LightPlan {
  outputs: LightPlanOutput[];
}

export interface LightWarning {
  rigId: string;
  slotId?: string;
  message: string;
}

export function libraryType(library: readonly LightRow[], id: string): LightType | undefined {
  const r = library.find((x) => x.id === id);
  return r?.kind === 'type' ? r : undefined;
}

/** A slot's network: Auto for none, else the library's (undefined when that
 *  network is gone or deleted — the plan then sends on Auto, and warns). */
export function libraryNetwork(library: readonly LightRow[], id: string | undefined): LightNetwork | undefined {
  if (!id || id === AUTO_NETWORK_ID) return AUTO_NETWORK;
  const r = library.find((x) => x.id === id);
  return r?.kind === 'network' && !r.deleted ? r : undefined;
}

export function libraryRig(library: readonly LightRow[], id: string): LightRig | undefined {
  const r = library.find((x) => x.id === id);
  return r?.kind === 'rig' ? r : undefined;
}

/** Where a slot samples in a show: the placement's rect, else the rig's. */
export function slotRectIn(p: DevicePlacement | undefined, slot: { id: string; layout: SlotRect }): SlotRect {
  return p?.layout?.[slot.id] ?? slot.layout;
}

/** The fixtures a rig's slots become, laid out for one show (or at the rig's
 *  defaults when `placement` is omitted). A slot whose type is missing is
 *  skipped. */
export function rigFixtures(rig: LightRig, library: readonly LightRow[],
                            placement?: DevicePlacement): LightPlanFixture[] {
  const out: LightPlanFixture[] = [];
  for (const slot of rig.slots) {
    const type = libraryType(library, slot.typeId);
    if (!type) continue;
    const net = libraryNetwork(library, slot.address.network) ?? AUTO_NETWORK;
    out.push({
      slotId: slot.id,
      universe: slot.address.universe,
      channel: slot.address.channel,
      dest: resolveNetworkDest(slot.address.dest || 'broadcast', net),
      iface: net.iface,
      format: type.format,
      gamma: type.gamma,
      footprints: slotFootprints(slotRectIn(placement, slot), type.pixels, type.vertical !== false, !!slot.reverse),
    });
  }
  return out;
}

export function buildLightPlan(comp: Composition, library: readonly LightRow[]): LightPlan {
  const outputs: LightPlanOutput[] = [];
  for (const p of comp.devices ?? []) {
    if (p.kind !== 'light') continue;
    const rig = libraryRig(library, p.deviceId);
    // A rig this machine doesn't have is an unplugged cable: nothing to send.
    if (!rig || rig.deleted) continue;
    outputs.push({ placementId: p.id, enabled: p.enabled !== false, fixtures: rigFixtures(rig, library, p) });
  }
  return { outputs };
}

/**
 * Address problems in a rig: a slot running past channel 512 (its tail is
 * dropped, never spilled into the next universe), two slots sharing channels,
 * a slot whose type or network is gone.
 */
export function rigWarnings(rig: LightRig, library: readonly LightRow[]): LightWarning[] {
  const out: LightWarning[] = [];
  const spans: { slotId: string; key: string; from: number; to: number }[] = [];
  rig.slots.forEach((slot, i) => {
    const type = libraryType(library, slot.typeId);
    if (!type) {
      out.push({ rigId: rig.id, slotId: slot.id, message: `Slot ${i + 1}: its type is missing` });
      return;
    }
    if (!libraryNetwork(library, slot.address.network)) {
      out.push({ rigId: rig.id, slotId: slot.id,
        message: `Slot ${i + 1}: its network is gone — it's sent on Auto` });
    }
    const from = slot.address.channel;
    const to = from + slotChannels(type) - 1;
    if (to > 512) {
      out.push({ rigId: rig.id, slotId: slot.id,
        message: `Slot ${i + 1} runs past channel 512 (ends at ${to}); the pixels past it aren't sent` });
    }
    spans.push({ slotId: slot.id, key: `${slot.address.network ?? ''}/${slot.address.dest || 'broadcast'}/${slot.address.universe}`, from, to });
  });
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i], b = spans[j];
      if (a.key === b.key && a.from <= b.to && b.from <= a.to) {
        out.push({ rigId: rig.id, slotId: b.slotId,
          message: `Slots ${i + 1} and ${j + 1} share channels ${Math.max(a.from, b.from)}–${Math.min(a.to, b.to)}` });
      }
    }
  }
  return out;
}
