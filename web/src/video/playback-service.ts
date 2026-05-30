/**
 * VideoPlaybackService — single entry point sinks use to pull video frames.
 *
 * Wires together:
 *   • A `FrameSource` (DXV today; WebCodecs adapter slots in next).
 *   • A `FrameCache` (GPU textures, LRU + pinned).
 *   • A `CostTracker` for source-side decoding/seek timing.
 *   • An `AccessClassifier` that infers Sequential / Reverse / Strided /
 *     Loop / Hotspots / Scrub / Random from the live pull stream.
 *   • Persistence to IndexedDB via `ProfileStore` so a clip that looped
 *     last session is hot the moment it's reopened.
 *
 * Sinks just call `pull(clip, frameIdx)`; the service decides what to
 * pre-decode, what to pin in cache, and what hints to surface.
 */

import { GPUHost } from '../gpu-host';
import {
  arrayBufferBytesSource, blobBytesSource, type BytesSource,
} from '../dxv-decoder';
import type { FrameSource } from './frame-source';
import { DxvFrameSource } from './dxv-frame-source';
import { VideoElementFrameSource } from './video-element-frame-source';
import { FrameCache, type FrameCacheStats } from './frame-cache';
import { CostTracker, type CostSnapshot } from './cost-tracker';
import { AccessClassifier, type AccessMode, type ClassifierSnapshot } from './access-classifier';
import { computeReadAheadTargets } from './read-ahead';
import {
  CoalescingWriter, deriveSourceKey,
  readSourceProfile, writeSourceProfile,
  readClipProfile, writeClipProfile,
  buildSourceProfileRecord, buildClipProfileRecord,
  type SourceProfileRecord, type ClipProfileRecord,
} from './profile-store';

export interface PlaybackHints {
  costClass: CostSnapshot['costClass'];
  accessMode: AccessMode;
  expectedFrameLatencyMs: number;
  /** Human-readable summary for UI surfaces ("loop pinned" / "scrub:
   *  seek-heavy, expect jitter"). */
  suggestion: string;
}

export interface ProfileSnapshot {
  sourceKey: string;
  salt: string;
  cost: CostSnapshot;
  access: ClassifierSnapshot;
  cache: FrameCacheStats;
  codec: string;
  width: number;
  height: number;
  frameCount: number;
  /** Native frame rate of the source — consumers should drive playback
   *  at this rate (see FrameSource.fps). */
  fps: number;
  /** Frame indices currently resident in cache (any set). For UI viz. */
  cachedFrameIndices: number[];
  /** Frame indices currently in the pinned set. */
  pinnedFrameIndices: number[];
}

/** Per-pull read-ahead depth for ring-shaped modes (Sequential / Reverse
 *  / Strided). Sized to roughly cover the gap between consecutive pulls
 *  on a 30 fps timeline. */
const READAHEAD_DEPTH = 5;

interface ClipState {
  sourceKey: string;
  salt: string;
  clipKey: string;
  source: FrameSource;
  cache: FrameCache;
  cost: CostTracker;
  classifier: AccessClassifier;
  sourceFlusher: CoalescingWriter<SourceProfileRecord>;
  clipFlusher: CoalescingWriter<ClipProfileRecord>;
  handle?: FileSystemFileHandle;

  /** Tracks the last frame index requested (for stride calc). */
  lastFrameIdx: number;
  /** Sign of the most recent non-zero motion (+1 forward, −1 backward).
   *  Read-ahead in Sequential/Reverse modes follows THIS, not the mode's
   *  nominal direction, so an oscillating pattern (ping-pong, LFO) keeps
   *  pre-caching ahead of the playhead even when the classified mode
   *  lags the actual turn. Defaults to +1 until the first move. */
  lastMotionDir: number;
  /** What we last wrote to IDB so we can detect drift. */
  lastModeFlushed: AccessMode | null;
  lastCostClassFlushed: CostSnapshot['costClass'] | null;
  lastProfileFlushMs: number;
  /** Decode chain — serializes pulls + prefetches behind a single
   *  in-flight FrameSource.decode() call. */
  decodeChain: Promise<unknown>;
  /** Prefetches we've scheduled but not yet completed; skip duplicates. */
  pendingPrefetches: Set<number>;
  /** In-flight cache decodes keyed by frameIdx, so a pull that catches up
   *  to a queued prefetch awaits the same decode instead of seeking the
   *  source a second time. Resolves to the cache handle plus the true
   *  source.decode() duration (ms), excluding time queued behind the
   *  serialized chain. */
  pendingDecodes: Map<number, Promise<{ handle: number; decodeMs: number }>>;
  /** For streaming sources only: a single reused texture the live frame
   *  is decoded into each pull. No cache, no read-ahead — sampling the
   *  natively-looping <video>'s current frame. 0 for random-access. */
  streamTexHandle: number;
  /** The source's play-forward-vs-seekable verdict, persisted into the
   *  source profile so re-opens skip the seek probe. */
  videoStreaming: boolean;
}

/** The opaque ClipHandle that sinks pass back to the service. Just an
 *  index into the service's internal table so callers can't poke at
 *  ClipState directly. */
export class ClipHandle {
  constructor(public readonly id: number) {}
}

export class VideoPlaybackService {
  private gpuHost: GPUHost;
  private budgetBytes: number;
  private clips = new Map<number, ClipState>();
  private nextClipId = 1;
  /** Optional override for the dxv_decoder.wasm URL (paths differ
   *  between test runners). */
  private dxvWasmUrl: string | undefined;

  constructor(gpuHost: GPUHost, opts?: { budgetBytes?: number; dxvWasmUrl?: string }) {
    this.gpuHost = gpuHost;
    this.budgetBytes = opts?.budgetBytes ?? 256 * 1024 * 1024;
    this.dxvWasmUrl = opts?.dxvWasmUrl;
  }

  /** Open a clip backed by `handle` (file picker / drop) or an in-memory
   *  blob/ArrayBuffer (tests). `salt` differentiates instances of the
   *  same source — typically the graph-node ID. */
  async open(
    source: FileSystemFileHandle | File | Blob | ArrayBuffer,
    salt: string,
  ): Promise<ClipHandle> {
    // Derive source identity + a BytesSource (for DXV) and a Blob (for
    // the browser-decoder fallback) from whatever the caller handed us.
    let sourceKey: string;
    let bytesSource: BytesSource;
    let blob: Blob;
    let handle: FileSystemFileHandle | undefined;
    if (source instanceof ArrayBuffer) {
      // Anonymous binary blob — derive a synthetic key from byte length.
      sourceKey = `arraybuffer|${source.byteLength}`;
      bytesSource = arrayBufferBytesSource(source);
      blob = new Blob([source]);
    } else if (source instanceof Blob && !(source instanceof File)) {
      sourceKey = `blob|${source.size}|${source.type}`;
      bytesSource = blobBytesSource(source);
      blob = source;
    } else {
      const { sourceKey: k, file } = await deriveSourceKey(source);
      sourceKey = k;
      bytesSource = blobBytesSource(file);
      blob = file;
      if (!(source instanceof File)) handle = source;
    }
    const clipKey = `${sourceKey}::${salt}`;
    const now = Date.now();
    const persistedSource = await readSourceProfile(sourceKey, now);

    // Pick the codec backend. DXV first (it parses any ISO-BMFF and
    // self-rejects non-DXV via NotDxvError); anything the DXV path can't
    // own goes to the browser's own decoders through a <video> element,
    // which emits the same RGBA8 GPUTexture and the same FrameSource API.
    // For <video>, pass the persisted seek-strategy verdict so we skip
    // re-probing a source we've classified before.
    let frameSource: FrameSource;
    try {
      frameSource = await DxvFrameSource.create(this.gpuHost, bytesSource, this.dxvWasmUrl);
    } catch (dxvErr) {
      try {
        frameSource = await VideoElementFrameSource.create(
          this.gpuHost, blob, { streaming: persistedSource?.videoStreaming });
      } catch (videoErr) {
        throw new Error(
          `could not open clip — not DXV (${(dxvErr as Error).message}) `
          + `and <video> rejected it (${(videoErr as Error).message})`);
      }
    }
    const cache = new FrameCache(this.gpuHost, this.budgetBytes);
    const cost = new CostTracker();
    const classifier = new AccessClassifier();

    // Warmup: the FIRST decode of any session triggers lazy WASM-side
    // scratch allocation, GPU pipeline build, and WGSL compile — easily
    // 30–80 ms on Chromium, atypical of steady-state. Pay it now,
    // outside the cost tracker, so we don't poison the EWMAs.
    try {
      const warmHandle = cache.reserve(
        0, frameSource.width, frameSource.height, frameSource.formatCode);
      await frameSource.decode(0, warmHandle);
    } catch {
      // Warmup is best-effort; failure here will surface again on the
      // first real pull where we can report it properly.
    }
    cache.clear();
    cost.reset();
    classifier.reset();

    // Seed from persisted profiles if any (cold-start prime). The source
    // profile was already read above (for the seek-strategy hint).
    if (persistedSource) {
      cost.seedFromPersisted({
        meanFrameDecodeMs: persistedSource.meanFrameDecodeMs,
        seekDecodeMs: persistedSource.seekDecodeMs,
        seekPenaltyMs: Math.max(0, persistedSource.seekDecodeMs - persistedSource.meanFrameDecodeMs),
        firstByteLatencyMs: persistedSource.firstByteLatencyMs,
        payloadBytesPerFrame: persistedSource.payloadBytesPerFrame,
        samples: persistedSource.samples,
        costClass: persistedSource.costClass,
      });
    }
    const persistedClip = await readClipProfile(clipKey);
    if (persistedClip) {
      classifier.seedFromPersisted({
        mode: persistedClip.mode,
        confidence: persistedClip.modeConfidence,
        loopRange: persistedClip.loopRange,
        hotFrames: persistedClip.hotFrames,
        stride: persistedClip.stride,
      });
    }

    const state: ClipState = {
      sourceKey, salt, clipKey,
      source: frameSource, cache, cost, classifier,
      sourceFlusher: new CoalescingWriter<SourceProfileRecord>(r => writeSourceProfile(r)),
      clipFlusher: new CoalescingWriter<ClipProfileRecord>(r => writeClipProfile(r)),
      handle,
      lastFrameIdx: -1,
      lastMotionDir: 1,
      lastModeFlushed: persistedClip?.mode ?? null,
      lastCostClassFlushed: persistedSource?.costClass ?? null,
      lastProfileFlushMs: now,
      decodeChain: Promise.resolve(),
      pendingPrefetches: new Set(),
      pendingDecodes: new Map(),
      streamTexHandle: frameSource.streaming
        ? this.gpuHost.createTexture(frameSource.width, frameSource.height, frameSource.formatCode)
        : 0,
      videoStreaming: frameSource.streaming,
    };

    // Streaming sources play live — skip the cache-priming + prefetch
    // machinery below entirely.
    if (frameSource.streaming) {
      const id = this.nextClipId++;
      this.clips.set(id, state);
      return new ClipHandle(id);
    }

    // Apply pinning from the persisted mode so the cache is hot before
    // the first pull arrives.
    this.applyPinning(state);

    // Pre-decode the pinned set (best-effort — kicks off in background).
    if (state.cache.isPinned(0) /* trivially false; placeholder for non-empty pinned sets */) {
      // no-op
    }
    // Real pre-decode: walk the pinned set and prefetch each.
    if (classifier.snapshot().mode === 'Loop' && persistedClip?.loopRange) {
      const [a, b] = persistedClip.loopRange;
      for (let i = a; i <= b; i++) this.schedulePrefetch(state, i);
    } else if (classifier.snapshot().mode === 'Hotspots' && persistedClip?.hotFrames) {
      for (const f of persistedClip.hotFrames) this.schedulePrefetch(state, f);
    }

    const id = this.nextClipId++;
    this.clips.set(id, state);
    return new ClipHandle(id);
  }

  /** Decode (or fetch from cache) the requested frame. Returns the
   *  GPUHost texture handle that the caller can sample THIS draw. The
   *  handle is borrow-only — do not retain past the next pull. */
  async pull(clip: ClipHandle, frameIdx: number): Promise<number> {
    const state = this.requireClip(clip);
    if (frameIdx < 0 || frameIdx >= state.source.frameCount) {
      throw new Error(`frameIdx ${frameIdx} out of range [0, ${state.source.frameCount})`);
    }

    // Streaming source: sample the live, natively-looping frame into the
    // reused texture. No cache (frames are live), no read-ahead (which
    // would push the <video> ahead of consumption and break the loop).
    if (state.streamTexHandle) {
      await this.chainDecode(state, frameIdx, state.streamTexHandle);
      return state.streamTexHandle;
    }

    const monoNow = performance.now();
    const stride = state.lastFrameIdx < 0 ? 0 : frameIdx - state.lastFrameIdx;
    // Track the live motion direction (ignore zero-stride duplicate pulls).
    if (stride > 0) state.lastMotionDir = 1;
    else if (stride < 0) state.lastMotionDir = -1;

    // Cache hit — record and run the after-pull bookkeeping.
    const cached = state.cache.lookup(frameIdx);
    if (cached >= 0) {
      state.classifier.recordPull(frameIdx, monoNow);
      this.afterPull(state, frameIdx);
      return cached;
    }

    // Miss — drive the decode through the chain (which reserves the
    // texture just before decoding it).
    const { handle, decodeMs } = await this.cachedDecode(state, frameIdx);

    state.cost.recordPull({ stride, decodeMs });
    state.classifier.recordPull(frameIdx, performance.now());
    this.afterPull(state, frameIdx);
    return handle;
  }

  /** Snapshot the service's expectations — for UI surfaces. */
  hints(clip: ClipHandle): PlaybackHints {
    const state = this.requireClip(clip);
    const cost = state.cost.snapshot();
    const access = state.classifier.snapshot();
    const cacheStats = state.cache.stats();
    const expected = access.mode === 'Random'
      ? Math.max(cost.seekDecodeMs, cost.meanFrameDecodeMs)
      // cache hit is ~0; miss costs decodeMs. Weight by current hit rate.
      : (1 - cacheStats.hitRate) * cost.meanFrameDecodeMs;
    return {
      costClass: cost.costClass,
      accessMode: access.mode,
      expectedFrameLatencyMs: expected,
      suggestion: this.summarize(cost, access, cacheStats),
    };
  }

  /** Full debug snapshot — combines cost, access, cache, and codec info. */
  inspect(clip: ClipHandle): ProfileSnapshot {
    const state = this.requireClip(clip);
    return {
      sourceKey: state.sourceKey,
      salt: state.salt,
      cost: state.cost.snapshot(),
      access: state.classifier.snapshot(),
      cache: state.cache.stats(),
      codec: state.source.codec,
      width: state.source.width,
      height: state.source.height,
      frameCount: state.source.frameCount,
      fps: state.source.fps,
      cachedFrameIndices: state.cache.cachedFrameIndices(),
      pinnedFrameIndices: state.cache.pinnedFrameIndices(),
    };
  }

  /** Close and persist a clip. Flushes pending profile writes. */
  async close(clip: ClipHandle): Promise<void> {
    const state = this.clips.get(clip.id);
    if (!state) return;
    // Force one last write of the latest state.
    state.sourceFlusher.schedule(buildSourceProfileRecord(
      state.sourceKey, state.cost.snapshot(), state.handle, Date.now(), state.videoStreaming));
    state.clipFlusher.schedule(buildClipProfileRecord(
      state.clipKey, state.classifier.snapshot(), state.cache.stats().hitRate));
    await state.sourceFlusher.flush();
    await state.clipFlusher.flush();
    state.cache.clear();
    if (state.streamTexHandle) this.gpuHost.release(state.streamTexHandle);
    state.source.dispose();
    this.clips.delete(clip.id);
  }

  // --- Internal ---

  private requireClip(clip: ClipHandle): ClipState {
    const s = this.clips.get(clip.id);
    if (!s) throw new Error(`ClipHandle ${clip.id} is not open`);
    return s;
  }

  /** Serialize FrameSource.decode() calls behind a single in-flight chain
   *  so concurrent pulls / prefetches don't race. Used directly by the
   *  streaming path (re-samples the live frame each pull). */
  private chainDecode(state: ClipState, frameIdx: number, outHandle: number): Promise<void> {
    const p = state.decodeChain.then(() => state.source.decode(frameIdx, outHandle));
    // Don't poison the chain on a single failure.
    state.decodeChain = p.catch(() => {});
    return p;
  }

  /** Decode `frameIdx` into a freshly-reserved cache texture, then mark
   *  the entry ready so it can be served. Dedups concurrent requests for
   *  the same frame (a pull catching up to a queued prefetch) onto one
   *  decode, so the slow <video> seek path never re-seeks a frame already
   *  in flight.
   *
   *  The texture is reserved INSIDE the chain, immediately before its
   *  decode — not eagerly — so at most one not-ready entry exists at a
   *  time. (Eager reservation would let a burst of read-ahead prefetches
   *  allocate their whole depth's worth of textures up front; since
   *  not-ready entries can't be evicted, that would blow the byte budget.)
   *
   *  Resolves with the cache handle and the time spent in `source.decode()`
   *  itself — NOT the wall-clock wait, which includes time queued behind
   *  the chain and would inflate the cost EWMAs during read-ahead bursts. */
  private cachedDecode(state: ClipState, frameIdx: number): Promise<{ handle: number; decodeMs: number }> {
    const existing = state.pendingDecodes.get(frameIdx);
    if (existing) return existing;
    const tracked = state.decodeChain.then(async () => {
      const handle = state.cache.reserve(
        frameIdx, state.source.width, state.source.height, state.source.formatCode);
      const t = performance.now();
      await state.source.decode(frameIdx, handle);
      const decodeMs = performance.now() - t;
      state.cache.markReady(frameIdx);
      return { handle, decodeMs };
    });
    // Don't poison the chain on a single failure.
    state.decodeChain = tracked.catch(() => {});
    const wrapped = tracked.finally(() => { state.pendingDecodes.delete(frameIdx); });
    state.pendingDecodes.set(frameIdx, wrapped);
    return wrapped;
  }

  private afterPull(state: ClipState, frameIdx: number): void {
    state.lastFrameIdx = frameIdx;
    this.applyPinning(state);
    this.scheduleReadAhead(state, frameIdx);
    this.maybeFlushProfiles(state);
  }

  /** Compute the read-ahead set for the current access mode and queue
   *  prefetches via the decode chain. */
  private scheduleReadAhead(state: ClipState, frameIdx: number): void {
    const targets = this.readAheadTargets(state, frameIdx);
    for (const t of targets) this.schedulePrefetch(state, t);
  }

  private readAheadTargets(state: ClipState, frameIdx: number): number[] {
    const m = state.classifier.snapshot();
    return computeReadAheadTargets({
      mode: m.mode,
      frameIdx,
      frameCount: state.source.frameCount,
      motionDir: state.lastMotionDir,
      depth: READAHEAD_DEPTH,
      stride: m.stride,
    });
  }

  private schedulePrefetch(state: ClipState, frameIdx: number): void {
    if (state.pendingPrefetches.has(frameIdx)) return;
    // Use has() not lookup() — a prefetch peek is internal bookkeeping,
    // not a sink request, so it must not count toward hit/miss stats.
    if (state.cache.has(frameIdx)) return;             // already cached
    state.pendingPrefetches.add(frameIdx);
    queueMicrotask(async () => {
      // Re-check at execution time — a later pull may have caught us up.
      if (state.cache.has(frameIdx)) {
        state.pendingPrefetches.delete(frameIdx);
        return;
      }
      try {
        const { decodeMs } = await this.cachedDecode(state, frameIdx);
        // Prefetches contribute to the cost EWMAs at "seek" rate (their
        // stride is not the live one, and we don't want them dominating
        // the contiguous-decode bucket).
        state.cost.recordPull({ stride: 0, decodeMs });
      } catch {
        // best-effort — drop silently
      } finally {
        state.pendingPrefetches.delete(frameIdx);
      }
    });
  }

  /** Refresh the cache's pinned set to match the current access mode. */
  private applyPinning(state: ClipState): void {
    const m = state.classifier.snapshot();
    let pinned: number[] = [];
    if (m.mode === 'Loop' && m.loopRange) {
      const [a, b] = m.loopRange;
      for (let i = a; i <= b; i++) pinned.push(i);
    } else if (m.mode === 'Hotspots' && m.hotFrames) {
      pinned = m.hotFrames.slice();
    }
    state.cache.setPinned(pinned);
  }

  /** Persist profiles when mode or cost class changes, or periodically. */
  private maybeFlushProfiles(state: ClipState): void {
    const cost = state.cost.snapshot();
    const access = state.classifier.snapshot();
    const now = Date.now();

    const modeChanged = access.mode !== state.lastModeFlushed;
    const costChanged = cost.costClass !== state.lastCostClassFlushed;
    const tickPassed = now - state.lastProfileFlushMs > 10_000;

    if (modeChanged || costChanged || tickPassed) {
      state.sourceFlusher.schedule(buildSourceProfileRecord(
        state.sourceKey, cost, state.handle, now, state.videoStreaming));
      state.clipFlusher.schedule(buildClipProfileRecord(
        state.clipKey, access, state.cache.stats().hitRate, now));
      state.lastModeFlushed = access.mode;
      state.lastCostClassFlushed = cost.costClass;
      state.lastProfileFlushMs = now;
    }
  }

  private summarize(
    cost: CostSnapshot, access: ClassifierSnapshot, cache: FrameCacheStats,
  ): string {
    const bits: string[] = [];
    bits.push(`${access.mode.toLowerCase()}`);
    if (cost.costClass === 'SlowSeek') bits.push('seek-heavy');
    if (cost.costClass === 'SlowDecode') bits.push('slow decode');
    if (access.mode === 'Loop' && access.loopRange) {
      bits.push(`loop ${access.loopRange[0]}-${access.loopRange[1]} pinned`);
    }
    if (access.mode === 'Random' && cost.costClass !== 'FastRandom') {
      bits.push('expect jitter');
    }
    if (cache.pinnedEvicted) bits.push('memory-bound');
    return bits.join('; ');
  }
}
