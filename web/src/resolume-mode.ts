/**
 * URL-override + pure routing helpers for the single unified entry
 * (`main.ts`) and the Resolume sketch editor's Instances-tab live
 * thumbnails.
 *
 * Kept in its own module (rather than `boot-resolume.ts`, which boots the
 * app on import) so it can be unit-tested and shared with the mode-switch UI.
 */

import type { TracePoint } from './engine-types';

/** Fixed shared-server port the barrel listens on, absent a `?barrel=` override. */
export const DEFAULT_BARREL_URL = 'ws://localhost:8081';

/**
 * The three top-level surfaces. Which one boots is normally decided by the
 * persisted `appMode` setting (read from IndexedDB before anything else —
 * see `main.ts`), NOT by the URL. `?playground` / `?barrel[=ws://host:port]`
 * remain as a boot-time OVERRIDE purely for deep-link/e2e convenience: if
 * present, `main.ts` boots that mode for this load and persists it (via
 * `boot.ts`'s existing appMode recording) so a later plain reload remembers
 * it too. Returns null when neither is present — the normal path, defer
 * entirely to the persisted setting.
 */
export type AppMode = 'effect-dev' | 'playground' | 'live';

export function modeOverrideFromUrl(search: string): { mode: AppMode; barrelUrl?: string } | null {
  const params = new URLSearchParams(search);
  if (params.has('playground')) return { mode: 'playground' };
  if (params.has('barrel')) return { mode: 'live', barrelUrl: params.get('barrel') || undefined };
  return null;
}

/** sessionStorage keys recording a dismissed mode-switch offer (per tab —
 *  the offer returns on a fresh session, but never nags within one). */
export const OFFER_PLAYGROUND_DISMISSED_KEY = 'nano.offerPlayground.dismissed';
export const OFFER_LIVE_DISMISSED_KEY = 'nano.offerLive.dismissed';

/**
 * sessionStorage flag forcing Live mode to boot straight into offline
 * editing (a local, Playground-like simulation sourced from the `liveCache`
 * store — see `boot-resolume.ts`'s `bootLiveOffline`) instead of attempting
 * the barrel connection. Set when the user accepts a "reconnect failed —
 * edit offline?" offer; cleared by any explicit "try reconnecting"/"switch
 * to Live" action. A boot-time-only decision (the engine worker's
 * barrel/local-simulation mode can't be toggled after construction — see
 * `boot-resolume.ts`), so going offline or reconnecting always reloads.
 */
export const LIVE_OFFLINE_KEY = 'nano.liveOffline';

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
// Preview fan-out transport (binary plane)
//
// The barrel never sends pixel frames on the main bridge socket. It advertises
// N auxiliary WebSocket ports in /global/preview_transport; the client opens
// them all and reassembles the NBPC-chunked NBPV frames that arrive striped
// across the lanes.
// ---------------------------------------------------------------------------

/** Shape of the /global/preview_transport doc the native barrel publishes. */
export interface PreviewTransportDoc {
  version: number;
  ports: number[];
  chunk_bytes?: number;
}

/** Extract the advertised lane ports (defensively) from the transport doc. */
export function previewTransportPorts(doc: unknown): number[] {
  if (!doc || typeof doc !== 'object') return [];
  const ports = (doc as PreviewTransportDoc).ports;
  if (!Array.isArray(ports)) return [];
  return ports.filter((p): p is number => typeof p === 'number' && p > 0 && p < 65536);
}

/** URL for a lane socket: same scheme + host as the main bridge URL, new port. */
export function laneUrl(mainUrl: string, port: number): string {
  const u = new URL(mainUrl);
  u.port = String(port);
  return u.toString();
}

/**
 * Reassembles NBPC chunk envelopes back into whole NBPV frames. Chunks of one
 * frame arrive across DIFFERENT lane sockets, unordered; they share a u32
 * sequence id. Envelope layout (little-endian, mirrors barrel_runtime.mm):
 *   [0..3] "NBPC"  [4..7] u32 seq  [8..9] u16 idx  [10..11] u16 count
 *   [12..] payload slice
 * Non-NBPC buffers pass through unchanged (a whole NBPV frame is valid input).
 */
export class NbpcReassembler {
  private partials = new Map<number, { chunks: (Uint8Array | undefined)[]; got: number }>();

  /** Feed one binary WS message; returns a complete frame or null. */
  ingest(buf: ArrayBuffer): ArrayBuffer | null {
    if (buf.byteLength < 12) return buf;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 0x4e || dv.getUint8(1) !== 0x42 ||  // 'N' 'B'
        dv.getUint8(2) !== 0x50 || dv.getUint8(3) !== 0x43) {  // 'P' 'C'
      return buf;
    }
    const seq = dv.getUint32(4, true);
    const idx = dv.getUint16(8, true);
    const cnt = dv.getUint16(10, true);
    if (cnt === 0 || idx >= cnt) return null;  // malformed — drop
    let p = this.partials.get(seq);
    if (!p) {
      p = { chunks: new Array(cnt), got: 0 };
      this.partials.set(seq, p);
      // A lost chunk (lane drop/reconnect) would otherwise leak its partial
      // forever. Newer seqs supersede: evict oldest beyond a small window.
      if (this.partials.size > 32) {
        const oldest = this.partials.keys().next().value;
        if (oldest !== undefined) this.partials.delete(oldest);
      }
    }
    if (p.chunks.length !== cnt) { this.partials.delete(seq); return null; }
    if (!p.chunks[idx]) {
      p.chunks[idx] = new Uint8Array(buf, 12);
      p.got++;
    }
    if (p.got < cnt) return null;
    this.partials.delete(seq);
    const total = p.chunks.reduce((a, c) => a + (c ? c.byteLength : 0), 0);
    // Reuse one output buffer across same-size frames instead of allocating a
    // fresh Uint8Array every frame — at full-res 1080p@30 that alloc+free is
    // ~250 MB/s of GC churn. Safe because the consumer copies the bytes out
    // synchronously (queue.writeTexture) before the next frame is reassembled;
    // JS is single-threaded so no completed frame overlaps another in flight.
    if (!this.out || this.out.byteLength !== total) this.out = new Uint8Array(total);
    const full = this.out;
    let off = 0;
    for (const c of p.chunks) {
      if (!c) return null;  // unreachable given got === cnt; defensive
      full.set(c, off);
      off += c.byteLength;
    }
    return full.buffer;
  }

  /** Reused reassembly output (see ingest) — sized to the current frame. */
  private out: Uint8Array | null = null;
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
