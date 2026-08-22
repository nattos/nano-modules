/**
 * Art-Net lowering — builds the executor's injected-scalar table
 * (`executor_set_injected_scalars`) from the sketches' `control.artnet`
 * instances + the bridge's current channel tables.
 *
 * The counterpart of `midi/wire-lowering.ts`, and pure for the same reason:
 * it takes plain sketch docs and a lookup, so it unit-tests without a socket,
 * a worker or appState.
 *
 * The difference from the MIDI path is worth stating, because it is what let
 * this feature skip an entire UI: a MIDI device is OUT of chain, so its values
 * arrive as external scalars addressed by a `midi:` instance key that the wire
 * itself carries. A `control.artnet` card is IN the chain — an ordinary effect
 * with ordinary outputs — so nothing new appears in the wire vocabulary. We
 * just hand the executor values for fields that already exist.
 */

import type { Sketch } from '../sketch-types';
import { sketchChain } from '../sketch-types';
import { universeKey } from './artnet-packet';

/** The module type whose channels the host drives. */
export const ARTNET_MODULE_TYPE = 'control.artnet';
/** Schema ceiling — `channel_count` selects how many are live. */
export const ARTNET_MAX_FIELDS = 16;

/** One card's Art-Net address, as read from its own state. */
export interface ArtnetRequest {
  sketchId: string;
  instanceKey: string;
  net: number;
  subnet: number;
  universe: number;
  /** 1-based DMX address of `ch_0`. */
  baseChannel: number;
  count: number;
}

function intField(state: Record<string, any> | undefined,
                  name: string, fallback: number,
                  lo: number, hi: number): number {
  const raw = state?.[name];
  const n = typeof raw === 'number' ? Math.round(raw) : fallback;
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : fallback));
}

/**
 * Every `control.artnet` card across the composition, with the universe it
 * wants. Reads each instance's OWN state — two cards on different universes
 * must resolve independently (a schema is per module type; the address is a
 * per-instance value).
 */
export function collectArtnetRequests(
  sketches: Record<string, Sketch | undefined>,
): ArtnetRequest[] {
  const out: ArtnetRequest[] = [];
  for (const [sketchId, sketch] of Object.entries(sketches)) {
    if (!sketch) continue;
    for (const entry of sketchChain(sketch)) {
      if (!entry || entry.type !== 'module') continue;
      if (entry.module_type !== ARTNET_MODULE_TYPE) continue;
      const state = sketch.instances?.[entry.instance_key]?.state;
      out.push({
        sketchId,
        instanceKey: entry.instance_key,
        net: intField(state, 'net', 0, 0, 127),
        subnet: intField(state, 'subnet', 0, 0, 15),
        universe: intField(state, 'universe', 1, 0, 15),
        baseChannel: intField(state, 'base_channel', 1, 1, 512),
        count: intField(state, 'channel_count', 4, 1, ARTNET_MAX_FIELDS),
      });
    }
  }
  return out;
}

/**
 * The injected-scalar JSON (`{"<instanceKey>": {"ch_0": 0.42, …}}`).
 *
 * `channels` resolves a universe key (`net.subnet.universe`) to its current
 * 0..255 bytes, or undefined when that universe has never been heard — in
 * which case the instance is OMITTED entirely rather than filled with zeros.
 * An absent entry leaves the card's authored values standing, which is the
 * same dormant-source semantics the native host uses and the reason a missing
 * feed reads as "untouched" rather than as a blackout.
 *
 * Keys are emitted in a stable order so identical states produce identical
 * JSON and callers can dedupe pushes by string compare.
 */
export function buildInjectedScalars(
  sketches: Record<string, Sketch | undefined>,
  channels: (key: string) => Uint8Array | undefined,
): string {
  const requests = collectArtnetRequests(sketches);
  const out: Record<string, Record<string, number>> = {};
  for (const req of requests.sort((a, b) => a.instanceKey.localeCompare(b.instanceKey))) {
    const bytes = channels(universeKey(req.net, req.subnet, req.universe));
    if (!bytes) continue;                       // never heard → dormant
    const entry: Record<string, number> = {};
    for (let i = 0; i < req.count; i++) {
      const ch = req.baseChannel + i;           // 1-based DMX
      entry[`ch_${i}`] = ch >= 1 && ch <= bytes.length ? bytes[ch - 1] / 255 : 0;
    }
    out[req.instanceKey] = entry;
  }
  return JSON.stringify(out);
}
