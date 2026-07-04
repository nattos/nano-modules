/**
 * URL → app-mode resolution for the Resolume sketch editor (/resolume/),
 * plus the pure routing helpers behind the Instances-tab live thumbnails.
 *
 * Kept in its own module (rather than resolume-app.ts, which boots the app on
 * import) so it can be unit-tested and shared with the mode-switch UI.
 */

import type { TracePoint } from './engine-types';

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

// ---------------------------------------------------------------------------
// Instances-tab live thumbnails
//
// Each instance card on the Instances tab registers a `sketch_output` trace
// whose id embeds the instance key. In the playground the worker resolves the
// target per sketch id directly; in barrel mode the id's embedded key is what
// routes the request to that instance's own /preview_requests subtree (the
// native side keys captures per instance and ignores the target's sketchId)
// and routes the returned NBPV frame past the selected-instance filter.
// ---------------------------------------------------------------------------

export const INSTANCE_THUMB_PREFIX = 'inst_thumb:';

/** Trace-registration id for an instance card's live thumbnail. */
export function instanceThumbTraceId(instanceKey: string): string {
  return INSTANCE_THUMB_PREFIX + instanceKey;
}

/** The instance key embedded in a thumbnail trace id, or null for any other id. */
export function instanceKeyFromThumbTraceId(traceId: string): string | null {
  return traceId.startsWith(INSTANCE_THUMB_PREFIX)
    ? traceId.slice(INSTANCE_THUMB_PREFIX.length)
    : null;
}

export const SIDECHANNEL_THUMB_PREFIX = 'sc_thumb:';

/** Trace-registration id for a sidechannel card's live thumbnail. */
export function sidechannelThumbTraceId(channel: string): string {
  return SIDECHANNEL_THUMB_PREFIX + channel;
}

/** True for sidechannel-thumbnail trace ids. In barrel mode their NBPV frames
 *  arrive keyed by the channel's WRITER instance (whichever that is), so the
 *  ingest filter admits them by id rather than by key. */
export function isSidechannelThumbTraceId(traceId: string): boolean {
  return traceId.startsWith(SIDECHANNEL_THUMB_PREFIX);
}

/** One /preview_requests entry, as the native barrel parses it. */
export interface BarrelPreviewRequest {
  target:
    | { type: 'sketch_output'; sketchId: string }
    | { type: 'chain_entry'; sketchId: string; colIdx: number; chainIdx: number; side: string }
    | { type: 'sidechannel'; channel: string };
  width: number;
  height: number;
}

/**
 * Split one trace-controller flush into per-instance /preview_requests maps.
 * Thumbnail registrations go to the instance their id embeds; sidechannel
 * targets to the channel's WRITER instance (`sidechannelWriters` — the bus is
 * process-global native-side, but only the writer is guaranteed alive and
 * rendering, and its frame publishes right after the bus copy); everything
 * else (the edit preview, chain-entry monitors) to the instance currently
 * wired for editing (`currentKey` — dropped when no instance is wired).
 * `plugin_output` targets are skipped (not supported in barrel mode).
 */
export function groupPreviewRequests(
  tracePoints: TracePoint[],
  currentKey: string | null,
  sidechannelWriters: Record<string, string> = {},
): Map<string, Record<string, BarrelPreviewRequest>> {
  const groups = new Map<string, Record<string, BarrelPreviewRequest>>();
  for (const tp of tracePoints) {
    const target = tp.target;
    let serialized: BarrelPreviewRequest['target'] | null = null;
    let destKey: string | null = null;
    if (target.type === 'sketch_output') {
      serialized = { type: 'sketch_output', sketchId: target.sketchId };
    } else if (target.type === 'chain_entry') {
      serialized = {
        type: 'chain_entry',
        sketchId: target.sketchId,
        colIdx: target.colIdx,
        chainIdx: target.chainIdx,
        side: target.side,
      };
    } else if (target.type === 'sidechannel') {
      serialized = { type: 'sidechannel', channel: target.channel };
      destKey = sidechannelWriters[target.channel] ?? null;
      if (!destKey) continue;  // unwritten channel — nothing to capture yet
    } else {
      continue;  // plugin_output not yet supported in barrel mode
    }
    if (!destKey) destKey = instanceKeyFromThumbTraceId(tp.id) ?? currentKey;
    if (!destKey) continue;
    let requests = groups.get(destKey);
    if (!requests) {
      requests = {};
      groups.set(destKey, requests);
    }
    requests[tp.id] = {
      target: serialized,
      width: tp.size?.width ?? 0,
      height: tp.size?.height ?? 0,
    };
  }
  return groups;
}
