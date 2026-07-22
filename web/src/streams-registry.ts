// streams-registry.ts — the web twin of the native seekable-streams registry
// (native/src/sketch/comp/streams_table.h — LOCK-STEP: enum values, event
// tuples, and the per-kind evaluators must answer identically on both hosts).
//
// The STATIC registry is mirrored from executor.wasm's `comp_streams_json`
// readback on doc-epoch change ONLY; the per-frame transport sample arrives as
// 6 flat doubles (`comp_streams_frame`); content positions evaluate lazily
// through the shared clip-time math. Nothing stream-shaped crosses any
// boundary per frame.
//
// Effects (WasmHost instances) read this through the `streams.*` import module
// (wasm-host.ts); a null registry there answers as the session-clock-only
// world.

import { clipSourceTimeAt } from './views/arrangement/engine/clip-time';
import type { ClipLoopConfig } from './views/arrangement/model/composition';

// ── Enum twins (values are ABI — streams.h / streams_table.h) ──────────────

export const StreamKind = {
  Invalid: 0,
  SessionClock: 1,
  Timeline: 2,
  TimelineTrack: 3,
  SceneTrack: 4,
  VideoContent: 5,
  SequenceContent: 6,
  LiveInput: 7,
} as const;

export const StreamAxis = { Seconds: 0, Beats: 1, Ordinal: 2 } as const;

export const StreamFlags = {
  SeekInstant: 1 << 0,
  SeekSlow: 1 << 1,
  LiveOnly: 1 << 2,
  HasEvents: 1 << 3,
  Finite: 1 << 4,
  TriggerOnSeek: 1 << 5,
  Driven: 1 << 6,
} as const;

export const STREAM_INVALID = 0n;
export const STREAM_SESSION_CLOCK = 1n;
export const STREAM_TIMELINE = 2n;

/** One event — the 5-double wire record, parsed. Content streams: time is on
 *  the ELAPSED axis (elapsed(); beats for beat-sync clips) and 'looped'
 *  records carry the 1-based pass count in clipOrdinal. */
export interface StreamEventRec {
  time: number;
  kind: number; // 0 = start, 1 = stop, 2 = looped, 3 = ended
  clipOrdinal: number;
  idHash48: number;
  channel: number; // NaN for non-scene streams
}

/** streams_table.h fnv1a64 low-48 twin (BigInt; clip ids are ASCII). */
function clipIdHash48(id: string): number {
  let h = 14695981039346656037n;
  for (let i = 0; i < id.length; i++) {
    h ^= BigInt(id.charCodeAt(i) & 0xff);
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  return Number(h & 0xffffffffffffn);
}

export interface StreamRec {
  handle: bigint;
  kind: number;
  flags: number;
  axis: number;
  frameCount: number;
  index: number;
  clipCount: number;
  durationPrimary: number;
  durationSec: number;
  bpm: number;
  fps: number;
  name: string;
  ownerId: string;
  events: StreamEventRec[];
  /** Track streams: clipId → [ordinal, lengthBeat, stdDurationSec, gridSlot]
   *  (older payloads may carry only the first two — read defensively). */
  clipsById: Map<string, number[]>;
  /** Track streams: ordinal → clipId (seek translation; inverted at load). */
  byOrdinalClipId: string[];
  // Content streams: the lazy position-eval context.
  loop: ClipLoopConfig | null;
  anchorBeat: number;
  /** SHIPPED seconds-at-anchor (never recomputed — the native table's double,
   *  so elapsed subtractions are bit-identical on both hosts). */
  anchorSec: number;
  lengthBeat: number;
  videoDurSec: number;
  seed: number;
  // Scene tracks: launched-scene state (synced from comp_scene_states_json).
  liveOrdinal: number; // NaN = nothing playing
  liveAnchorBeat: number;
  liveLengthBeat: number;
  /** Per-stream event-generator revision (streams.rev). A per-host change
   *  token — bumps on reload/(re)launch/stop/declaration change, never merely
   *  because time passed. */
  eventRev: number;
  // Content streams: controller-declared future (driven clips).
  declared: boolean;
  declNextEnd: number; // absolute elapsed; -1 = none
  declLoopCount: number;
  dynEvents: StreamEventRec[];
}

export class StreamsRegistry {
  docRev = 0;
  enumCount = 0;
  streams: StreamRec[] = [];
  byHandle = new Map<bigint, StreamRec>();
  parentByClipId = new Map<string, bigint>();
  contentByClipId = new Map<string, bigint>();
  trackByTrackId = new Map<string, bigint>();

  /** Per-frame transport sample (comp_streams_frame's 6 doubles). */
  frame = {
    posBeat: 0, posSec: 0, playing: 0,
    loopEnabled: 0, loopStartBeat: 0, loopEndBeat: 0,
  };

  /** Transport-controller content-time overrides (clipId → content seconds). */
  appliedContentSec = new Map<string, number>();

  /** Queued streams.seek/stop write verbs from effect imports; drained by
   *  executor-host after the transport pre-pass (translated to
   *  comp_launch_scene/comp_stop_scene). One-frame-latency, like triggers. */
  pendingOps: { kind: 'seek' | 'stop'; handle: bigint; t: number }[] = [];

  /** Warp-aware beat→seconds map, rebuilt with the document (makeWarpClock). */
  secondsAt: (beat: number) => number = (beat) => beat * 0.5;

  /** Replace the static registry from a parsed comp_streams_json payload. */
  loadStatic(json: any, secondsAt: (beat: number) => number): void {
    this.secondsAt = secondsAt;
    this.docRev = json?.docRev ?? 0;
    this.enumCount = json?.enumCount ?? 0;
    this.streams = [];
    this.byHandle.clear();
    this.parentByClipId.clear();
    this.contentByClipId.clear();
    this.trackByTrackId.clear();
    for (const s of json?.streams ?? []) {
      const rec: StreamRec = {
        handle: BigInt(s.handle ?? '0'),
        kind: s.kind ?? 0,
        flags: s.flags ?? 0,
        axis: s.axis ?? 0,
        frameCount: s.frameCount ?? 0,
        index: s.index ?? -1,
        clipCount: s.clipCount ?? 0,
        durationPrimary: s.durationPrimary ?? -1,
        durationSec: s.durationSec ?? -1,
        bpm: s.bpm ?? 120,
        fps: s.fps ?? 0,
        name: s.name ?? '',
        ownerId: s.ownerId ?? '',
        events: (s.events ?? []).map((e: any[]): StreamEventRec => ({
          time: e[0], kind: e[1], clipOrdinal: e[2], idHash48: e[3],
          channel: e[4] === null || e[4] === undefined ? NaN : e[4],
        })),
        clipsById: new Map(Object.entries(s.clipsById ?? {}).map(
          ([clipId, ref]) => [clipId, ref as number[]])),
        byOrdinalClipId: [],
        loop: s.loop ?? null,
        anchorBeat: s.anchorBeat ?? 0,
        anchorSec: s.anchorSec ?? 0,
        lengthBeat: s.lengthBeat ?? 0,
        videoDurSec: s.videoDurSec ?? 0,
        seed: s.seed ?? 0,
        liveOrdinal: NaN,
        liveAnchorBeat: 0,
        liveLengthBeat: 0,
        eventRev: s.eventRev ?? (json?.docRev ?? 0),
        declared: false,
        declNextEnd: -1,
        declLoopCount: 0,
        dynEvents: [],
      };
      for (const [clipId, ref] of rec.clipsById) rec.byOrdinalClipId[ref[0]] = clipId;
      this.byHandle.set(rec.handle, rec);
      this.streams.push(rec);
    }
    for (const [clipId, h] of Object.entries(json?.parentByClipId ?? {}))
      this.parentByClipId.set(clipId, BigInt(h as string));
    for (const [clipId, h] of Object.entries(json?.contentByClipId ?? {}))
      this.contentByClipId.set(clipId, BigInt(h as string));
    for (const [trackId, h] of Object.entries(json?.trackByTrackId ?? {}))
      this.trackByTrackId.set(trackId, BigInt(h as string));
    // A doc reload rebuilds every StreamRec (live scene state resets to NaN),
    // but the ENGINE's launch map survives reloads (healed, not cleared) and
    // the scenes channel only re-ships ON CHANGE — re-apply the last-known
    // launches so live-scene positions survive routine doc reloads exactly
    // like the native table (rebuildStreamsTable re-anchors + per-frame sync).
    this.syncSceneLaunches(this.lastLaunches);
  }

  /** The last launch map applied (re-applied after loadStatic — see above). */
  private lastLaunches: Record<string, { sceneId: string; launchBeat: number; launchSec?: number }> = {};

  /** Mirror the launch map (comp_scene_states_json: {trackId: {sceneId,
   *  launchBeat, launchSec}}) into the scene-track streams — the twin of the
   *  native sampleStreamsFrame sync. Also re-anchors launched scenes' content
   *  streams (launchScene's anchor rebase) using the SHIPPED launchSec, and
   *  bumps event revs on actual launch changes (launchScene/stopScene twins). */
  syncSceneLaunches(launches: Record<string, { sceneId: string; launchBeat: number; launchSec?: number }>): void {
    const prev = this.lastLaunches;
    this.lastLaunches = launches ?? {};
    for (const s of this.streams) {
      if (s.kind === StreamKind.SceneTrack) s.liveOrdinal = NaN;
    }
    for (const [trackId, l] of Object.entries(launches ?? {})) {
      const th = this.trackByTrackId.get(trackId);
      const s = th !== undefined ? this.byHandle.get(th) : undefined;
      if (!s || s.kind !== StreamKind.SceneTrack) continue;
      const ref = s.clipsById.get(l.sceneId);
      if (!ref) continue;
      s.liveOrdinal = ref[0];
      s.liveAnchorBeat = l.launchBeat;
      s.liveLengthBeat = ref[1];
      const ch = this.contentByClipId.get(l.sceneId);
      const content = ch !== undefined ? this.byHandle.get(ch) : undefined;
      const p = prev[trackId];
      const changed = !p || p.sceneId !== l.sceneId || p.launchBeat !== l.launchBeat;
      if (content) {
        content.anchorBeat = l.launchBeat;
        content.anchorSec = l.launchSec ?? this.secondsAt(l.launchBeat);
        if (changed) {
          content.dynEvents = [];
          content.declLoopCount = 0;
          content.eventRev++;
        }
      }
      if (changed) s.eventRev++;
    }
    // Stops: a track that had a launch and lost it bumps its rev too.
    for (const [trackId, p] of Object.entries(prev)) {
      if ((launches ?? {})[trackId]) continue;
      const th = this.trackByTrackId.get(trackId);
      const s = th !== undefined ? this.byHandle.get(th) : undefined;
      if (s) s.eventRev++;
      const ch = this.contentByClipId.get(p.sceneId);
      const content = ch !== undefined ? this.byHandle.get(ch) : undefined;
      if (content) content.eventRev++;
    }
  }

  find(h: bigint): StreamRec | undefined {
    // Handles cross the wasm boundary as SIGNED i64 bigints (MSB-tagged ⇒
    // negative), while the registry keys the unsigned decimal the native
    // serializer emitted — normalize at the lookup.
    return this.byHandle.get(BigInt.asUintN(64, h));
  }

  /** streams_table.h clipIdForInstanceKey: resolve the clip that owns an
   *  executing effect from its "clip_<clipId>_<suffix>" instance key. Clip ids
   *  may contain '_', so match the known id set (longest wins). */
  clipIdForInstanceKey(key: string): string | null {
    if (!key.startsWith('clip_')) return null;
    let best: string | null = null;
    for (const clipId of this.parentByClipId.keys()) {
      if (key.length <= 5 + clipId.length + 1) continue;
      if (key[5 + clipId.length] !== '_') continue;
      if (!key.startsWith(clipId, 5)) continue;
      if (!best || clipId.length > best.length) best = clipId;
    }
    return best;
  }

  parentOf(instanceKey: string): bigint {
    const clipId = this.clipIdForInstanceKey(instanceKey);
    if (clipId !== null) {
      const h = this.parentByClipId.get(clipId);
      if (h !== undefined) return h;
    }
    return STREAM_SESSION_CLOCK;
  }

  contentOf(instanceKey: string): bigint {
    const clipId = this.clipIdForInstanceKey(instanceKey);
    if (clipId !== null) {
      const h = this.contentByClipId.get(clipId);
      if (h !== undefined) return h;
    }
    return STREAM_INVALID;
  }

  // ── Per-kind evaluators (LOCK-STEP: streams_table.h streamPos/PosSec/
  // Playing/Loop + contentPosSec) ──

  /** Content-stream position: the applied override, else the lazy clip-time
   *  mapping. NaN = transparent/undefined. */
  contentPosSec(s: StreamRec): number {
    const applied = this.appliedContentSec.get(s.ownerId);
    if (applied !== undefined) return applied;
    const vt = clipSourceTimeAt(s.loop ?? ({} as ClipLoopConfig), {
      startBeat: s.anchorBeat,
      lengthBeat: s.lengthBeat,
      videoDurSec: s.videoDurSec,
      secondsAt: this.secondsAt,
      seed: s.seed,
    }, this.frame.posBeat);
    return vt === null ? NaN : vt;
  }

  pos(s: StreamRec, sessionSec: number): number {
    switch (s.kind) {
      case StreamKind.SessionClock:
        return sessionSec;
      case StreamKind.Timeline:
      case StreamKind.TimelineTrack:
        return this.frame.posBeat;
      case StreamKind.SceneTrack: {
        if (Number.isNaN(s.liveOrdinal)) return s.liveOrdinal;
        const len = Math.max(1e-9, s.liveLengthBeat);
        // Strictly < 1 (lock-step with streams_table.h): a long-playing scene
        // must floor() to ITS ordinal, never the next cell's. 1e-9, not an
        // ulp: the margin must survive `ordinal + frac` (a 1-ulp margin
        // rounds away for ordinal >= 2).
        const frac = Math.min(1 - 1e-9,
                              Math.max(0, (this.frame.posBeat - s.liveAnchorBeat) / len));
        return s.liveOrdinal + frac;
      }
      case StreamKind.VideoContent:
        return this.contentPosSec(s);
      default:
        return NaN;
    }
  }

  posSec(s: StreamRec, sessionSec: number): number {
    switch (s.kind) {
      case StreamKind.SessionClock:
        return sessionSec;
      case StreamKind.Timeline:
      case StreamKind.TimelineTrack:
        return this.frame.posSec;
      case StreamKind.SceneTrack:
        if (Number.isNaN(s.liveOrdinal)) return s.liveOrdinal;
        return this.frame.posSec - this.secondsAt(s.liveAnchorBeat);
      case StreamKind.VideoContent:
        return this.contentPosSec(s);
      default:
        return NaN;
    }
  }

  playing(s: StreamRec): number {
    switch (s.kind) {
      case StreamKind.SessionClock:
        return 1;
      case StreamKind.SceneTrack:
        return Number.isNaN(s.liveOrdinal) ? 0 : this.frame.playing;
      default:
        return this.frame.playing;
    }
  }

  /** Active loop region on the primary axis, or null. */
  loopRegion(s: StreamRec): [number, number] | null {
    switch (s.kind) {
      case StreamKind.Timeline:
      case StreamKind.TimelineTrack:
        if (!this.frame.loopEnabled) return null;
        return [this.frame.loopStartBeat, this.frame.loopEndBeat];
      case StreamKind.VideoContent: {
        const mode = s.loop?.mode ?? 'time';
        if (mode !== 'time' && mode !== 'beat-sync') return null;
        return [s.loop?.startSec ?? 0, s.loop?.endSec ?? s.videoDurSec];
      }
      default:
        return null;
    }
  }

  /** streams.clip_duration: the standard clip duration (seconds) of ordinal N
   *  on a track stream (precomputed native-side; see streams_table.h). */
  clipDuration(s: StreamRec, ordinal: number): number {
    const clipId = s.byOrdinalClipId[ordinal];
    const ref = clipId !== undefined ? s.clipsById.get(clipId) : undefined;
    return ref?.[2] ?? NaN;
  }

  /** streams.clip_grid: the grid slot of ordinal N (group contiguity). */
  clipGrid(s: StreamRec, ordinal: number): number {
    const clipId = s.byOrdinalClipId[ordinal];
    const ref = clipId !== undefined ? s.clipsById.get(clipId) : undefined;
    return ref?.[3] ?? NaN;
  }

  /** streams.seek/stop: queue a write verb (validated per the same rules as
   *  the native import — seek needs TriggerOnSeek, stop a scene track). */
  queueSeek(h: bigint, t: number): boolean {
    const s = this.find(h);
    if (!s || !(s.flags & StreamFlags.TriggerOnSeek)) return false;
    this.pendingOps.push({ kind: 'seek', handle: BigInt.asUintN(64, h), t });
    return true;
  }

  queueStop(h: bigint): boolean {
    const s = this.find(h);
    if (!s || s.kind !== StreamKind.SceneTrack) return false;
    this.pendingOps.push({ kind: 'stop', handle: BigInt.asUintN(64, h), t: 0 });
    return true;
  }

  /** First event index with time >= t (event_lower_bound). Content streams
   *  route through the virtual timeline (contentEventLowerBound). */
  eventLowerBound(s: StreamRec, t: number): number {
    if (isContentStream(s)) return this.contentEventLowerBound(s, t);
    let lo = 0, hi = s.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.events[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // ── Content event timeline (LOCK-STEP: streams_table.h contentEventGen/
  // Count/At/LowerBound + streamElapsed) — see that header's contract notes. ──

  /** "Now" on the stream's EVENT axis (streams.elapsed). */
  elapsed(s: StreamRec, sessionSec: number): number {
    switch (s.kind) {
      case StreamKind.SessionClock:
        return sessionSec;
      case StreamKind.Timeline:
      case StreamKind.TimelineTrack:
        return this.frame.posSec;
      case StreamKind.SceneTrack:
        return Number.isNaN(s.liveOrdinal) ? s.liveOrdinal : this.frame.posSec;
      case StreamKind.VideoContent:
      case StreamKind.SequenceContent:
        if (s.loop?.mode === 'beat-sync') return this.frame.posBeat - s.anchorBeat;
        return this.frame.posSec - s.anchorSec;
      default:
        return NaN;
    }
  }

  private contentEventGen(s: StreamRec): { mode: number; firstTime: number; period: number } {
    const g = { mode: 0, firstTime: 0, period: 0 };
    const loop = s.loop;
    const speedAbs = Math.max(1e-6, Math.abs(loop?.speed ?? 1));
    const mode = loop?.mode ?? 'time'; // ClipLoopConfig's native default
    if (mode === 'one-shot') {
      const sliceSec = loop?.endSec != null ? loop.endSec - (loop.startSec ?? 0) : s.videoDurSec;
      if (sliceSec > 0) {
        g.mode = 1;
        g.firstTime = sliceSec / speedAbs; // == standardClipDurationSec
      }
      return g;
    }
    if (mode === 'random') return g;
    const loopStart = loop?.startSec ?? 0;
    const loopEnd = loop?.endSec ?? s.videoDurSec;
    const loopLen = loopEnd - loopStart;
    if (loopLen <= 1e-9) return g;
    const playStart = loop?.playStartSec ?? loopStart;
    let c1 = loop?.direction === 'reverse' ? playStart - loopStart : loopEnd - playStart;
    if (c1 <= 1e-9) c1 = loopLen;
    if (mode === 'beat-sync') {
      const videoBeats = loop?.syncUseBpm ? loopLen * ((loop?.syncBpm ?? 120) / 60)
                                          : loop?.syncBeats ?? 4;
      if (videoBeats <= 1e-9) return g;
      g.mode = 2;
      g.firstTime = (c1 / loopLen) * videoBeats; // BEAT axis (matches elapsed)
      g.period = videoBeats;
      return g;
    }
    g.mode = 2;
    g.firstTime = c1 / speedAbs;
    g.period = loopLen / speedAbs;
    return g;
  }

  contentEventCount(s: StreamRec, nowElapsed: number): number {
    if (s.declared) return s.dynEvents.length + (s.declNextEnd >= 0 ? 1 : 0);
    const g = this.contentEventGen(s);
    if (g.mode === 0) return 0;
    if (g.mode === 1) return 1;
    const past = Math.floor((nowElapsed - g.firstTime) / g.period) + 1;
    return Math.max(0, past) + CONTENT_EVENT_HORIZON;
  }

  contentEventAt(s: StreamRec, i: number): StreamEventRec {
    if (s.declared) {
      if (i < s.dynEvents.length) return s.dynEvents[i];
      return { time: s.declNextEnd, kind: 3, clipOrdinal: 0,
               idHash48: clipIdHash48(s.ownerId), channel: NaN };
    }
    const g = this.contentEventGen(s);
    if (g.mode === 1) {
      return { time: g.firstTime, kind: 3, clipOrdinal: 0,
               idHash48: clipIdHash48(s.ownerId), channel: NaN };
    }
    return { time: g.firstTime + i * g.period, kind: 2, clipOrdinal: i + 1,
             idHash48: clipIdHash48(s.ownerId), channel: NaN };
  }

  contentEventLowerBound(s: StreamRec, t: number): number {
    const n = this.contentEventCount(s, this.elapsed(s, 0));
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.contentEventAt(s, mid).time < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Fold one driven row's declaration (comp_transport_decls) into the clip's
   *  content stream — LOCK-STEP with CompExecutor::transportResolve's fold:
   *  remaining → absolute elapsed quantized to 10 ms (rev churns only on real
   *  revisions); integer loop-count increments append 'looped' edges. */
  foldDecl(clipId: string, nextEndSec: number, loopCount: number): void {
    const ch = this.contentByClipId.get(clipId);
    const s = ch !== undefined ? this.byHandle.get(ch) : undefined;
    if (!s) return;
    if (!s.declared) {
      s.declared = true;
      s.eventRev++;
    }
    const nowElapsed = this.elapsed(s, 0);
    const absEnd = nextEndSec >= 0 ? Math.round((nowElapsed + nextEndSec) * 100) / 100 : -1;
    if (absEnd !== s.declNextEnd) {
      s.declNextEnd = absEnd;
      s.eventRev++;
    }
    const k = Math.floor(loopCount);
    if (k < s.declLoopCount) { // controller restarted its count
      s.dynEvents = [];
      s.declLoopCount = 0;
      s.eventRev++;
    }
    while (s.declLoopCount < k) {
      s.declLoopCount += 1;
      s.dynEvents.push({ time: nowElapsed, kind: 2, clipOrdinal: s.declLoopCount,
                         idHash48: clipIdHash48(s.ownerId), channel: NaN });
    }
  }

  /** Streams whose controller vanished revert to the built-in analytics. */
  pruneDecls(liveClipIds: Set<string>): void {
    for (const s of this.streams) {
      if (s.declared && !liveClipIds.has(s.ownerId)) {
        s.declared = false;
        s.declNextEnd = -1;
        s.declLoopCount = 0;
        s.dynEvents = [];
        s.eventRev++;
      }
    }
  }
}

export function isContentStream(s: StreamRec): boolean {
  return s.kind === StreamKind.VideoContent || s.kind === StreamKind.SequenceContent;
}

/** streams_table.h kContentEventHorizon — future entries past "now". */
export const CONTENT_EVENT_HORIZON = 4;
